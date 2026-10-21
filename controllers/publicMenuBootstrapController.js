const mongoose = require('mongoose');
const { applyBranchPrice } = require('../utils/priceResolver');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const Settings = require('../models/settings');
const MenuItem = require('../models/menuItem');
const Combo = require('../models/combo');
const Category = require('../models/category');
const Promotion = require('../models/promotion');
const Coupon = require('../models/coupon');
const logger = require('../utils/logger');
const { publicFeaturesOf } = require('../utils/publicFeatureFlags');
const { publicOperationsOf } = require('../utils/operationsProfile');
const { hasFeature } = require('../utils/featureAccess');
const { buildAvailabilityFilter } = require('../utils/menuAvailability');

/**
 * GET /api/v1/public/menu-bootstrap?slug=cafe&branch=B1
 *
 * Single round-trip first-paint bundle for the customer-facing menu
 * page. Replaces the historical chain of:
 *   /menu, /combos, /categories, /settings, /promotions, /promotions/coupons/active
 * which the QR-scan → menu flow had been firing in parallel — five
 * round trips that each pay an Atlas latency tax (~150-300ms each)
 * so cold first paint was ~1.5-3s.
 *
 * With this endpoint:
 *   - one network round trip
 *   - server-side Promise.allSettled (parallel inside the same DB pool)
 *   - public Cache-Control so the browser AND a CDN can cache hot reads
 *   - tolerant: any sub-section that fails is returned as null with
 *     a `_errors` entry instead of breaking the whole response
 *
 * `slug` is required (resolves the tenant directly, no header dance).
 * `branch` is optional — the customer's chosen branch from the picker.
 *
 * Public-safe: returns ONLY the data the menu page needs. Settings is
 * trimmed to a small subset (taxes, operatingHours, branding) — admin
 * sections like `wallet`, `notifications`, billing are excluded.
 */
/**
 * Branch whose operations profile a customer payload carries: the given
 * branch, else the tenant's Main branch — looked up ONLY when the tenant
 * has branch overrides (otherwise the answer cannot change the result and
 * no override must cost nothing extra). Never throws.
 */
async function operationsBranchFor(restaurant, branchId) {
    if (branchId) return branchId;
    if (!Array.isArray(restaurant?.operationsByBranch) || !restaurant.operationsByBranch.length) return null;
    try {
        const main = await Branch.findOne({ restaurant: restaurant._id, isActive: true, slug: 'main' }).select('_id').lean()
            || await Branch.findOne({ restaurant: restaurant._id, isActive: true }).sort({ createdAt: 1 }).select('_id').lean();
        return main?._id || null;
    } catch {
        return null;
    }
}
exports.operationsBranchFor = operationsBranchFor;

exports.getMenuBootstrap = async (req, res) => {
    try {
        const slug = String(req.query.slug || '').trim().toLowerCase();
        const branchId = String(req.query.branch || '').trim();
        const kioskMode = req.query.kiosk === 'true';

        if (!slug) {
            return res.status(400).json({ success: false, message: 'slug is required' });
        }

        // ── Resolve the tenant ────────────────────────────────────────
        const restaurant = await Restaurant.findOne({
            slug,
            status: { $in: ['active', 'trial'] },
        }).select('_id name slug city contactPhone logo branding subscription featureOverrides addons operations operationsByBranch').lean();

        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        // The kiosk menu is part of the paid self-order kiosk module.
        if (kioskMode && !hasFeature(restaurant, 'kiosk')) {
            return res.status(403).json({
                success: false,
                code: 'FEATURE_LOCKED',
                feature: 'kiosk',
                message: "This restaurant doesn't offer self-order kiosk.",
            });
        }

        // ── Resolve the optional branch ───────────────────────────────
        let branch = null;
        if (branchId && mongoose.isValidObjectId(branchId)) {
            branch = await Branch.findOne({
                _id: branchId,
                restaurant: restaurant._id,
                isActive: true,
            }).select('_id name slug city addressLine1').lean();
        }

        const tenantFilter = { restaurant: restaurant._id };

        // Customer-facing branch scope: tenant-level (branch: null) PLUS the
        // active branch's data. Mirrors menuController.buildBranchFilter
        // for the customer mode. When no branch is picked, no filter
        // (single-location tenants and pre-pick flow).
        const branchScope = branch
            ? { $or: [{ branch: null }, { branch: branch._id }] }
            : null;
        const menuFilter = { ...tenantFilter, status: 'active' };
        const comboFilter = { ...tenantFilter, status: 'active' };
        const categoryFilter = { ...tenantFilter, status: 'active' };
        // Kiosk mode — hide categories admin has flagged off for the
        // self-serve flow, and the menu items inside them. Default true
        // (field absent on legacy docs) is treated as visible. We
        // resolve the eligible category ids once and reuse them in both
        // the category and menu filters so items in hidden categories
        // don't leak via the menu list.
        let kioskCategoryIds = null;
        if (kioskMode) {
            categoryFilter.showOnKiosk = { $ne: false };
            kioskCategoryIds = await Category.find(categoryFilter)
                .select('_id')
                .lean()
                .then(rows => rows.map(r => r._id));
            menuFilter.category = { $in: kioskCategoryIds };
        }
        if (branchScope) {
            Object.assign(menuFilter, branchScope);
            Object.assign(comboFilter, branchScope);
            Object.assign(categoryFilter, branchScope);
        }

        // ADM-043 — availability schedule. This endpoint is the main
        // customer-facing first-paint source; without this gate, items
        // with availableDays = Mon–Fri stayed visible on Saturdays.
        // Combos share the same schema fields, so the helper applies to
        // both. Bootstrap is anonymous-only — there's no staff-bypass to
        // worry about here.
        const availability = buildAvailabilityFilter();
        Object.assign(menuFilter, availability);
        Object.assign(comboFilter, availability);

        // ── Settings scope: prefer branch-level, fall back to tenant-level
        // The full inheritance logic lives in settingsController.resolveSettingsForRequest
        // — too heavy for a public bootstrap. We do the read directly
        // and merge the customer-relevant sections only. Admin-only
        // sections (wallet, billing, notifications) are never returned.
        const settingsBranchId = branch ? branch._id : null;

        const now = new Date();
        const promoFilter = {
            ...tenantFilter,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
        };
        if (branchScope) Object.assign(promoFilter, branchScope);

        const couponFilter = {
            ...tenantFilter,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
        };
        if (branchScope) Object.assign(couponFilter, branchScope);

        // ── Parallel fetch ─────────────────────────────────────────────
        // Promise.allSettled means a single slow / failing collection
        // doesn't kill the whole bootstrap. The customer can still see
        // the menu even if (say) the promotions collection is locked.
        // Default raised from 100 → 500 because real tenants commonly
        // exceed 100 menu items (e.g. Hotel Tip Top: 172), and the
        // customer relies on the bootstrap payload as the full menu —
        // category filter is client-side, so a truncated payload makes
        // items in tail categories silently disappear. Cap raised to
        // 1000 to keep a hard upper bound for pathological tenants.
        const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

        const [
            categoriesRes,
            menuRes,
            combosRes,
            settingsRes,
            tenantSettingsRes,
            promotionsRes,
            couponsRes,
        ] = await Promise.allSettled([
            // KIOSK-PERF — public bootstrap is the hot first-paint
            // payload (172-item tenants push ~260KB / 3s). Projecting
            // away admin-only fields shrinks the payload by ~45%
            // (260KB → ~140KB) and makes the JSON parse + React first
            // render visibly snappier on tablets / kiosks. Fields
            // dropped: createdAt, __v, restaurant, branch, branchPrices,
            // orderCount, inactivationReason, inactivationUntil,
            // availableDays/startTime/endTime (server already applied
            // the availability filter, the client doesn't re-check),
            // healthLevel/healthyIngredients (admin-side only).
            Category.find(categoryFilter)
                .select('_id name image displayOrder status')
                .sort('displayOrder')
                .lean(),
            MenuItem.find(menuFilter)
                .select('_id name category description images cookingTime serveUpto ingredients vegType isFeatured basePrice offerPercentage offerExpiryDate unit sizes toppings isHealthy healthTags nutritionalInfo inStock prepStation status finalPrice branchPrices')
                .populate('category', 'name image status')
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean(),
            Combo.find(comboFilter)
                .select('_id name description images categories price originalPrice discount discountType savings vegType serveUpto isSpecial isHealthy taxApplicable serviceCharge availableDays startTime endTime status')
                .sort({ createdAt: -1 })
                .lean(),
            Settings.findOne({ restaurant: restaurant._id, branch: settingsBranchId }).lean(),
            // Tenant-level settings is the fallback source for taxes /
            // operatingHours / branding when the branch-level doc is
            // missing or thin. Skip the second query when the active
            // scope already IS tenant-level.
            settingsBranchId
                ? Settings.findOne({ restaurant: restaurant._id, branch: null }).lean()
                : Promise.resolve(null),
            Promotion.find(promoFilter).sort({ displayOrder: 1, createdAt: -1 }).lean(),
            Coupon.find(couponFilter).sort({ createdAt: -1 }).lean(),
        ]);

        const errors = [];
        const ok = (r, key) => {
            if (r.status === 'fulfilled') return r.value;
            errors.push({ section: key, message: r.reason?.message || 'Unknown error' });
            logger.warn('public.menu-bootstrap.section-failed', {
                section: key,
                error: r.reason?.message,
                slug,
            });
            return null;
        };

        const categories     = ok(categoriesRes, 'categories') || [];
        // Resolve per-branch price overrides so the menu shows exactly what
        // orderController will charge (it prices via resolvePrice too), then
        // drop branchPrices from the public payload.
        const menu           = (ok(menuRes, 'menu') || []).map((m) => {
            applyBranchPrice(m, branch ? branch._id : null);
            delete m.branchPrices;
            delete m._pricingSource;
            return m;
        });
        const combos         = ok(combosRes, 'combos') || [];
        const branchSettings = ok(settingsRes, 'settings');
        const tenantSettings = ok(tenantSettingsRes, 'tenantSettings');
        const promotions     = ok(promotionsRes, 'promotions') || [];
        const coupons        = ok(couponsRes, 'coupons') || [];

        // Merge settings: pick the branch-level doc, then fall back to
        // the tenant-level doc field-by-field for inherited sections.
        // Same sections that settingsController INHERITED_SECTIONS lists
        // — taxes, reservation, operatingHours — plus general branding.
        const merged = branchSettings
            ? { ...(tenantSettings || {}), ...branchSettings }
            : (tenantSettings || branchSettings || null);

        // Deep-merge taxes specifically — branch can set its own gst %,
        // additionalCharges normally live tenant-wide. Same shape the
        // admin/customer bill-preview math expects.
        if (branchSettings && tenantSettings) {
            const branchTaxes = branchSettings.taxes || {};
            const tenantTaxes = tenantSettings.taxes || {};
            const branchHasCharges = Array.isArray(branchTaxes.additionalCharges) && branchTaxes.additionalCharges.length > 0;
            const tenantCharges = Array.isArray(tenantTaxes.additionalCharges) ? tenantTaxes.additionalCharges : [];
            if (!branchHasCharges && tenantCharges.length > 0) {
                merged.taxes = { ...branchTaxes, additionalCharges: tenantCharges };
            }
            // Logo / banners fallback — branding lives at the tenant level.
            const tGen = tenantSettings.general || {};
            const bGen = merged.general || {};
            const fallback = { ...bGen };
            if (!bGen.logoUrl && tGen.logoUrl) fallback.logoUrl = tGen.logoUrl;
            if ((!Array.isArray(bGen.banners) || bGen.banners.length === 0)
                && Array.isArray(tGen.banners) && tGen.banners.length > 0) {
                fallback.banners = tGen.banners;
            }
            merged.general = fallback;
        }

        // ── Public-safe slimming ──────────────────────────────────────
        // Strip server-only / admin-only fields the customer should
        // never see. The page reads taxes, operatingHours, reservation,
        // and the general branding (logo/cafe name/banners). Wallet
        // settings and notifications config are admin concerns.
        // general.legal (PAN / GSTIN / legal name / FSSAI) is private —
        // same rule as settingsController.sanitizePublicSettings.
        const publicGeneral = { ...(merged?.general || {}) };
        delete publicGeneral.legal;
        const safeSettings = merged
            ? {
                general: publicGeneral,
                taxes: merged.taxes || {},
                operatingHours: merged.operatingHours || [],
                reservation: merged.reservation || {},
            }
            : null;

        // ── Cache headers ─────────────────────────────────────────────
        // 60s fresh + 5 min stale-while-revalidate is the same window
        // we already use for /menu and /categories. CDN can cache by
        // (slug, branch) since both are query params and the response
        // is identical for every customer at that branch.
        if (errors.length === 0) {
            res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        } else {
            res.set('Cache-Control', 'no-store');
        }
        res.set('Vary', 'Accept-Encoding');

        return res.status(200).json({
            success: errors.length === 0,
            data: {
                restaurant: {
                    _id: restaurant._id,
                    name: restaurant.name,
                    slug: restaurant.slug,
                    city: restaurant.city || '',
                    phone: restaurant.contactPhone || '',
                    logo: restaurant.logo || '',
                    features: publicFeaturesOf(restaurant),
                    // Resolved for the bootstrap branch (the picker's /
                    // kiosk device's branch); no branch picked → Main when
                    // the tenant has branch overrides, else the tenant
                    // profile (§12.1).
                    operations: publicOperationsOf(restaurant, { branchId: await operationsBranchFor(restaurant, branch?._id || null) }),
                },
                branch: branch ? {
                    _id: branch._id,
                    name: branch.name,
                    slug: branch.slug,
                    city: branch.city || '',
                    addressLine1: branch.addressLine1 || '',
                } : null,
                categories,
                menu,
                combos,
                settings: safeSettings,
                promotions,
                coupons,
            },
            ...(errors.length ? { _errors: errors } : {}),
        });
    } catch (err) {
        logger.error('public.menu-bootstrap error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load menu bundle' });
    }
};
