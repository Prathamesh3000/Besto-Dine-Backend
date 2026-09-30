/**
 * Public restaurant landing page.
 *
 *   GET /api/v1/public/restaurants/:slug/landing?branch=<branchSlug>
 *
 * Unauthenticated, cacheable data for the per-restaurant landing page at
 * /<restaurantSlug> (and /<restaurantSlug>/<branchSlug>). Returns ONLY
 * public-safe fields — never legal/tax ids, owner details, plan/billing
 * data or internal ids beyond the restaurant / branch / menu-item ids
 * listed in the response.
 *
 * Tenant scope: public requests may carry no tenant context (or a
 * different one from a stale X-Restaurant-Slug header), so every query
 * here carries an explicit `restaurant` filter resolved from the URL slug
 * and never relies on the scope plugin.
 *
 * Content is edited from Admin → Settings → Landing Page
 * (PATCH /settings/landingPage, see settingsController).
 */
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const Settings = require('../models/settings');
const MenuItem = require('../models/menuItem');
const logger = require('../utils/logger');
const { publicFeaturesOf } = require('../utils/publicFeatureFlags');
const { applyBranchPrice } = require('../utils/priceResolver');
const { computeOpenNow, defaultOperatingHours, isValidTimeZone, DEFAULT_TZ } = require('../utils/openingHours');
const { normalizeLandingPage, MAX_FEATURED_ITEMS } = require('../utils/landingPage');

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;
const ITEM_SELECT = 'name description images basePrice finalPrice offerPercentage offerExpiryDate vegType branchPrices';

const notFound = (res, code, message) => res.status(404).json({ success: false, code, message });

/** Join non-empty address parts, skipping parts already contained in earlier ones. */
function joinAddress(parts) {
    const out = [];
    for (const raw of parts) {
        const part = String(raw || '').trim();
        if (!part) continue;
        const seen = out.join(' ').toLowerCase();
        if (!seen.includes(part.toLowerCase())) out.push(part);
    }
    return out.join(', ');
}

const str = (v) => String(v || '').trim();
const isCoord = (v) => typeof v === 'number' && Number.isFinite(v);

function toLandingItem(item, branchId) {
    const priced = applyBranchPrice({ ...item }, branchId);
    const basePrice = Number(priced.basePrice) || 0;
    const rawFinal = priced.finalPrice;
    const finalPrice = rawFinal !== null && rawFinal !== undefined && Number.isFinite(Number(rawFinal))
        ? Number(rawFinal)
        : basePrice;
    return {
        _id: item._id,
        name: item.name || '',
        description: item.description || '',
        image: (Array.isArray(item.images) && item.images.find(Boolean)) || '',
        basePrice,
        finalPrice: Math.round(finalPrice * 100) / 100,
        offerPercentage: Number(priced.offerPercentage) || 0,
        vegType: item.vegType || 'veg',
    };
}

/**
 * Featured dishes for the landing page, max 8:
 *   1. the admin's chosen landingPage.featuredItems (in their order)
 *   2. else items flagged isFeatured
 *   3. else the tenant's best sellers (orderCount)
 * Only active + in-stock items; with a branch, tenant-wide items plus the
 * branch's own (same rule as the customer menu), priced for that branch.
 */
async function resolveFeaturedItems(restaurantId, branchId, chosenIds) {
    const base = { status: 'active', inStock: { $ne: false } };
    if (branchId) base.$or = [{ branch: null }, { branch: branchId }];

    const validChosen = (chosenIds || []).filter((id) => mongoose.isValidObjectId(id));
    if (validChosen.length > 0) {
        const docs = await MenuItem.find({ ...base, restaurant: restaurantId, _id: { $in: validChosen } })
            .select(ITEM_SELECT).lean();
        if (docs.length > 0) {
            const byId = new Map(docs.map((d) => [String(d._id), d]));
            const ordered = validChosen.map((id) => byId.get(String(id))).filter(Boolean);
            return { source: 'chosen', items: ordered.slice(0, MAX_FEATURED_ITEMS) };
        }
    }

    const flagged = await MenuItem.find({ ...base, restaurant: restaurantId, isFeatured: true })
        .select(ITEM_SELECT)
        .sort({ orderCount: -1, createdAt: -1 })
        .limit(MAX_FEATURED_ITEMS)
        .lean();
    if (flagged.length > 0) return { source: 'featured', items: flagged };

    const popular = await MenuItem.find({ ...base, restaurant: restaurantId })
        .select(ITEM_SELECT)
        .sort({ orderCount: -1, createdAt: -1 })
        .limit(MAX_FEATURED_ITEMS)
        .lean();
    return { source: 'popular', items: popular };
}

/**
 * Resolve the displayed address + optional map coordinates.
 * Branch given → the branch's address. Otherwise the tenant's Cafe
 * Information address → Restaurant.address → the Main branch.
 */
function resolveAddress({ restaurant, branch, general, mainBranch, deliveryOrigin }) {
    let addr;
    let coords = null;
    if (branch) {
        addr = {
            line1: branch.addressLine1, line2: branch.addressLine2, city: branch.city,
            state: branch.state, pincode: branch.postalCode, country: branch.country,
        };
        if (isCoord(branch.latitude) && isCoord(branch.longitude)) {
            coords = { lat: branch.latitude, lng: branch.longitude };
        }
    } else {
        const ad = general.addressDetails || {};
        const ra = restaurant.address || {};
        if (ad.line1 || ad.pincode || ad.state) {
            addr = { ...ad };
        } else if (ra.line1 || ra.pincode || ra.state) {
            addr = {
                line1: ra.line1, line2: ra.line2, city: restaurant.city,
                state: ra.state, pincode: ra.pincode, country: ra.country,
            };
        } else if (mainBranch) {
            addr = {
                line1: mainBranch.addressLine1, line2: mainBranch.addressLine2, city: mainBranch.city,
                state: mainBranch.state, pincode: mainBranch.postalCode, country: mainBranch.country,
            };
        } else {
            addr = { city: restaurant.city };
        }
        if (isCoord(deliveryOrigin?.lat) && isCoord(deliveryOrigin?.lng)) {
            coords = { lat: deliveryOrigin.lat, lng: deliveryOrigin.lng };
        } else if (mainBranch && isCoord(mainBranch.latitude) && isCoord(mainBranch.longitude)) {
            coords = { lat: mainBranch.latitude, lng: mainBranch.longitude };
        }
    }
    const address = {
        line1: str(addr.line1),
        line2: str(addr.line2),
        city: str(addr.city) || str(restaurant.city),
        state: str(addr.state),
        pincode: str(addr.pincode),
        country: str(addr.country) || 'India',
    };
    address.full = joinAddress([address.line1, address.line2, address.city, address.state, address.pincode]);
    return { address, coords };
}

exports.getRestaurantLanding = async (req, res) => {
    try {
        const slug = String(req.params.slug || '').toLowerCase().trim();
        if (!SLUG_REGEX.test(slug)) {
            return notFound(res, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
        }

        // AUDIT-EXEMPT: public tenant resolution by URL slug — this IS the tenant lookup.
        const restaurant = await Restaurant.findOne({ slug })
            .select('name slug city logo status timezone contactPhone address branding.primaryColor subscription.features featureOverrides')
            .lean();
        if (!restaurant) {
            return notFound(res, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
        }
        if (!['active', 'trial'].includes(restaurant.status)) {
            return notFound(res, 'RESTAURANT_UNAVAILABLE', 'This restaurant is currently unavailable');
        }
        const rid = restaurant._id;

        // ── Optional branch (?branch=<branchSlug>) ─────────────────────
        const rawBranch = req.query.branch;
        let branch = null;
        if (rawBranch !== undefined && rawBranch !== '') {
            const branchSlug = typeof rawBranch === 'string' ? rawBranch.toLowerCase().trim() : '';
            if (!branchSlug || branchSlug.length > 60) {
                return notFound(res, 'BRANCH_NOT_FOUND', 'Branch not found');
            }
            branch = await Branch.findOne({ restaurant: rid, slug: branchSlug, isActive: true })
                .select('name slug city addressLine1 addressLine2 state postalCode country contactPhone latitude longitude')
                .lean();
            if (!branch) {
                return notFound(res, 'BRANCH_NOT_FOUND', 'Branch not found');
            }
        }

        const [settings, branches] = await Promise.all([
            Settings.findOne({ restaurant: rid, branch: null })
                .select('general.contactNumber general.email general.addressDetails general.timezone general.logoUrl operatingHours delivery.enabled delivery.origin landingPage')
                .lean(),
            Branch.find({ restaurant: rid, isActive: true })
                .select('name slug city addressLine1 addressLine2 state postalCode country latitude longitude sortOrder')
                .sort({ sortOrder: 1, name: 1 })
                .lean(),
        ]);

        const general = settings?.general || {};
        const landing = normalizeLandingPage(settings?.landingPage);
        if (!landing.accentColor && restaurant.branding?.primaryColor) {
            landing.accentColor = restaurant.branding.primaryColor;
        }
        const features = publicFeaturesOf(restaurant);

        const contact = {
            phone: str(branch?.contactPhone || general.contactNumber || restaurant.contactPhone),
            email: str(general.email),
        };

        const { address, coords } = resolveAddress({
            restaurant,
            branch,
            general,
            mainBranch: branches.find((b) => b.slug === 'main') || null,
            deliveryOrigin: settings?.delivery?.origin,
        });
        const mapQuery = coords ? `${coords.lat},${coords.lng}` : joinAddress([address.full, address.full ? address.country : '']);
        address.mapUrl = landing.social.googleMapsUrl
            || (mapQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}` : '');

        const publicRestaurant = {
            _id: rid,
            name: restaurant.name,
            slug: restaurant.slug,
            logo: restaurant.logo || general.logoUrl || '',
            city: restaurant.city || '',
        };
        const publicBranch = branch ? {
            _id: branch._id,
            name: branch.name,
            slug: branch.slug,
            city: branch.city || '',
            addressLine1: branch.addressLine1 || '',
            addressLine2: branch.addressLine2 || '',
            state: branch.state || '',
            postalCode: branch.postalCode || '',
            contactPhone: branch.contactPhone || '',
            latitude: isCoord(branch.latitude) ? branch.latitude : null,
            longitude: isCoord(branch.longitude) ? branch.longitude : null,
        } : null;

        // Customer actions — plan features (same map getRestaurantBySlug
        // returns) + tenant settings. `delivery` is an added field.
        const actions = {
            menu: true,
            takeaway: features.takeaway === true,
            booking: features.advanceBookingTable === true || features.advanceBookingHall === true,
            delivery: features.takeaway === true && settings?.delivery?.enabled === true,
        };

        // The chosen featured ids are an admin detail — the public page
        // gets the resolved items instead.
        const { featuredItems: _chosenIds, ...landingPublic } = landing;

        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

        if (!landing.enabled) {
            return res.status(200).json({
                success: true,
                data: {
                    restaurant: publicRestaurant,
                    branch: publicBranch,
                    landing: landingPublic,
                    contact,
                    address,
                    operatingHours: [],
                    openNow: null,
                    featuredItems: [],
                    branches: [],
                    actions,
                    features,
                },
            });
        }

        // ── Hours + open-now in the tenant timezone ────────────────────
        const timezone = [general.timezone, restaurant.timezone].find(isValidTimeZone) || DEFAULT_TZ;
        const hoursSource = Array.isArray(settings?.operatingHours) && settings.operatingHours.length > 0
            ? settings.operatingHours
            : defaultOperatingHours();
        const operatingHours = hoursSource.map((h) => ({
            day: h.day,
            start: h.start || '',
            end: h.end || '',
            isOpen: h.isOpen !== false,
        }));
        const openNow = computeOpenNow(operatingHours, timezone);

        const featured = await resolveFeaturedItems(rid, branch?._id || null, landing.featuredItems);

        return res.status(200).json({
            success: true,
            data: {
                restaurant: publicRestaurant,
                branch: publicBranch,
                landing: landingPublic,
                contact,
                address,
                operatingHours,
                openNow,
                timezone,
                featuredItems: featured.items.map((it) => toLandingItem(it, branch?._id || null)),
                featuredSource: featured.source,
                branches: branches.map((b) => ({
                    name: b.name,
                    slug: b.slug,
                    city: b.city || '',
                    addressLine1: b.addressLine1 || '',
                })),
                actions,
                features,
            },
        });
    } catch (err) {
        logger.error('public.getRestaurantLanding error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load restaurant page' });
    }
};

// Exported for unit tests.
exports._internal = { joinAddress, toLandingItem, resolveAddress };
