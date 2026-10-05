/**
 * Branch controller — Phase 6 step 1.
 *
 * Tenant-admin CRUD for branches within the caller's own restaurant.
 * The route layer wraps every method in `protect + adminOnly +
 * featureGate('multiBranch')`, so by the time a handler runs we know:
 *   - req.user.role === 'admin'
 *   - req.restaurant is the caller's tenant
 *   - the tenant's plan includes multiBranch
 *
 * Controllers NEVER read the restaurant id from the URL or body —
 * it always comes from req.restaurant._id. A crafted request body
 * containing a different `restaurant` value is explicitly stripped
 * on updates so a tenant admin can't "transfer" a branch to another
 * tenant.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const Branch = require('../models/branch');
const User = require('../models/user');
const Order = require('../models/order');
const Table = require('../models/table');
const MenuItem = require('../models/menuItem');
const Area = require('../models/area');
const Coupon = require('../models/coupon');
const Promotion = require('../models/promotion');
const Settings = require('../models/settings');
const Hall = require('../models/hall');
const Recipe = require('../models/recipe');
const Inventory = require('../models/inventory');
const Category = require('../models/category');
const Combo = require('../models/combo');
const EventType = require('../models/eventType');
const Package = require('../models/package');
const DecorationPackage = require('../models/decorationPackage');
const Addon = require('../models/addon');
const Notification = require('../models/notification');
const Request = require('../models/request');
const logger = require('../utils/logger');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { generateTempPassword, getNextStaffIdForBranch, validateStaffEmail } = require('../utils/staffUtils');
const { createMainBranchFor } = require('../utils/createMainBranch');
const { pickAllowed, BRANCH_UPDATE_FIELDS } = require('../utils/bodyAllowlist');

const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function slugify(input = '') {
    return String(input)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function buildBranchPayload(b, subAdmin = null) {
    if (!b) return null;
    return {
        _id: b._id,
        name: b.name,
        slug: b.slug,
        displayLabel: b.displayLabel || '',
        addressLine1: b.addressLine1 || '',
        addressLine2: b.addressLine2 || '',
        city: b.city || '',
        state: b.state || '',
        postalCode: b.postalCode || '',
        country: b.country || '',
        latitude: b.latitude ?? null,
        longitude: b.longitude ?? null,
        contactPhone: b.contactPhone || '',
        contactEmail: b.contactEmail || '',
        isActive: b.isActive,
        sortOrder: b.sortOrder || 0,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        subAdmin: subAdmin ? {
            _id: subAdmin._id,
            name: subAdmin.name,
            email: subAdmin.email,
            mobile: subAdmin.mobile || '',
            staffId: subAdmin.staffId,
            status: subAdmin.status,
            mustChangePassword: !!subAdmin.mustChangePassword,
            lastLoginAt: subAdmin.lastLoginAt || null,
            // True when the displayed "admin" is the tenant owner
            // surfaced as a fallback on the Main branch card (because
            // Main usually has no pinned Branch Admin — the owner runs
            // it directly). The frontend renders this as "Owner" and
            // hides the edit/reset affordances that target a pinned
            // sub-admin record this user doesn't have.
            isOwner: !!subAdmin.isTenantOwner,
        } : null,
    };
}

/**
 * Look up the Branch Admin user for a given branch within the caller's tenant.
 * Convention set by createBranch: role='admin' + branch=<branchId>.
 * Returns null if the branch has no Branch Admin (legacy / manual deletion).
 */
async function findBranchSubAdmin(branchId, tenantObjId) {
    return User.findOne({
        role: 'admin',
        branch: branchId,
        restaurant: tenantObjId,
    })
        .select('_id name email mobile staffId status mustChangePassword lastLoginAt isTenantOwner')
        .lean();
}

/**
 * Look up the tenant owner / fallback admin for the Main branch card.
 * The Main branch usually has no pinned Branch Admin — the tenant owner
 * runs it directly. To guarantee the chip is never empty we try, in order:
 *   1. The exact Restaurant.owner user (most reliable).
 *   2. Any isTenantOwner=true admin in the tenant (legacy data where
 *      Restaurant.owner was never backfilled).
 *   3. Any tenant-level (unpinned) admin in the tenant.
 *   4. Any admin in the tenant at all.
 * Returns null only if the tenant somehow has no admin users.
 */
async function findTenantOwner(restaurant) {
    const tenantObjId = restaurant?._id;
    if (!tenantObjId) return null;
    const projection = '_id name email mobile staffId status mustChangePassword lastLoginAt isTenantOwner branch';

    if (restaurant.owner) {
        const byOwnerRef = await User.findOne({
            _id: restaurant.owner,
            restaurant: tenantObjId,
            role: 'admin',
        }).select(projection).lean();
        if (byOwnerRef) return byOwnerRef;
    }

    const byFlag = await User.findOne({
        restaurant: tenantObjId,
        role: 'admin',
        isTenantOwner: true,
    }).select(projection).lean();
    if (byFlag) return byFlag;

    const unpinned = await User.findOne({
        restaurant: tenantObjId,
        role: 'admin',
        $or: [{ branch: null }, { branch: { $exists: false } }],
    }).select(projection).lean();
    if (unpinned) return unpinned;

    return User.findOne({
        restaurant: tenantObjId,
        role: 'admin',
    }).select(projection).lean();
}

/**
 * Initialize a new branch's menu by giving it access to every active
 * menu item that lives on the Main branch — either tenant-level shared
 * (branch: null) OR explicitly owned by Main (branch: <mainId>). The
 * branch gets a per-branch `branchPrices` entry so it shows up in the
 * branch admin's strict filter (`{ branch: pinned } OR
 * { branchPrices.branch: pinned }`), and the branch can override
 * pricing independently of Main.
 *
 * Only called when the admin explicitly opts in to "Copy menu from
 * Main" at branch-create / branch-edit time. Without that opt-in the
 * new branch's menu stays empty — that is the "Proper Clean create"
 * the user asked for.
 *
 * Idempotent: items that already carry a branchPrices entry for this
 * branch are skipped, so re-running the sync is safe.
 *
 * @returns {number} count of menu items that received a new branchPrices entry
 */
async function initializeBranchMenu(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);

    // Source = tenant-level shared items PLUS Main-branch-owned items.
    // The OR covers both legacy data (branch:null seeded before per-
    // branch scoping) and the modern "tenant owner manages Main"
    // pattern. Items already exposed to this branch are skipped.
    const sourceBranchClause = mainId
        ? { $or: [{ branch: null }, { branch: mainId }] }
        : { branch: null };

    const sharedItems = await MenuItem.find({
        restaurant: restaurantId,
        ...sourceBranchClause,
        status: 'active',
        'branchPrices.branch': { $ne: branchId },
    }).select('_id basePrice offerPercentage offerExpiryDate');

    if (!sharedItems.length) return 0;

    // Bulk-write: push a branchPrices entry onto each item in one round-trip.
    const ops = sharedItems.map((item) => ({
        updateOne: {
            filter: { _id: item._id },
            update: {
                $push: {
                    branchPrices: {
                        branch: branchId,
                        basePrice: item.basePrice,
                        offerPercentage: item.offerPercentage || 0,
                        finalPrice: item.basePrice - (item.basePrice * ((item.offerPercentage || 0) / 100)),
                        offerExpiryDate: item.offerExpiryDate || null,
                    },
                },
            },
        },
    }));

    const result = await MenuItem.bulkWrite(ops, { ordered: false });
    return result.modifiedCount || 0;
}

/**
 * Initialize a new branch's areas by copying every area from the
 * tenant's Main branch into the new sub-branch. Each area is a fresh
 * Area document scoped to the new branch (same name + note + isActive).
 *
 * Areas are scoped per-branch (unique index on name + restaurant +
 * branch), so a sub-branch needs its OWN Area documents — it can't
 * just reference the Main's. This sync gives every new branch the
 * Main's area layout from day one without the Branch Admin having to
 * recreate "Indoor", "Outdoor", "AC", etc. by hand.
 *
 * Idempotent: skips any area whose name already exists for the new
 * branch (e.g. when re-run via a manual sync endpoint).
 *
 * Source resolution:
 *   - Main = the tenant's slug='main' branch (subscriber identity).
 *   - Falls back to areas with branch=null (legacy tenant-level areas
 *     from before the per-branch scoping migration) if no Main areas
 *     exist — that way old tenants still get something useful seeded.
 *
 * @returns {number} count of newly-created area documents
 */
async function initializeBranchAreas(restaurantId, branchId) {
    // Find the Main branch — never the new branch itself.
    const main = await Branch.findOne({
        restaurant: restaurantId,
        slug: 'main',
        isActive: true,
    }).select('_id').lean();

    // Collect candidate source areas. Prefer Main's; fall back to
    // legacy tenant-level (branch=null) so tenants that pre-date the
    // per-branch areas migration still seed something.
    let sourceAreas = [];
    if (main && String(main._id) !== String(branchId)) {
        sourceAreas = await Area.find({
            restaurant: restaurantId,
            branch: main._id,
            isActive: true,
        }).select('name note isActive').lean();
    }
    if (!sourceAreas.length) {
        sourceAreas = await Area.find({
            restaurant: restaurantId,
            branch: null,
            isActive: true,
        }).select('name note isActive').lean();
    }
    if (!sourceAreas.length) return 0;

    // Skip names that already exist on the destination (idempotent).
    const existingNames = new Set(
        (await Area.find({ restaurant: restaurantId, branch: branchId })
            .select('name').lean())
            .map(a => String(a.name).toLowerCase())
    );

    const docs = sourceAreas
        .filter(a => !existingNames.has(String(a.name).toLowerCase()))
        .map(a => ({
            restaurant: restaurantId,
            branch: branchId,
            name: a.name,
            note: a.note || '',
            isActive: a.isActive !== false,
        }));
    if (!docs.length) return 0;

    try {
        const created = await Area.insertMany(docs, { ordered: false });
        return created.length;
    } catch (err) {
        // ordered:false means individual duplicate-key errors don't
        // abort the batch — count whatever did succeed via insertedDocs.
        if (err?.insertedDocs) return err.insertedDocs.length;
        throw err;
    }
}

/**
 * Resolve the Main branch id for a given tenant. Shared lookup used
 * by every catalog-sync helper that needs a source branch.
 */
async function getMainBranchIdFor(restaurantId) {
    const main = await Branch.findOne({
        restaurant: restaurantId,
        slug: 'main',
        isActive: true,
    }).select('_id').lean();
    return main?._id || null;
}

/**
 * Generic per-branch catalog cloner used by Coupons and Promotions.
 * Both share the same shape: tenant + branch scoping with a unique
 * key field (`code` for coupons, `title` for promotions). Walks the
 * source branch's docs PLUS tenant-level (branch:null) seed docs,
 * filters out anything the destination already has by the dedupe key,
 * and bulk-inserts fresh docs scoped to the destination branch. Strips
 * per-branch runtime counters (e.g. coupon usageCount) so the
 * destination starts clean.
 *
 * Source = Main branch OR branch:null (tenant-level). Without the
 * null fallback, tenants whose coupons/promotions sit at the tenant
 * level (the legacy default) would see "0 copied" when ticking the
 * sync toggle — that was the bug.
 */
async function cloneCatalogToBranch(Model, restaurantId, sourceBranchId, branchId, {
    dedupeKey,
    stripFields = [],
    extraFilter = {},
}) {
    const sources = await Model.find({
        restaurant: restaurantId,
        $or: [
            { branch: sourceBranchId },
            { branch: null },
        ],
        ...extraFilter,
    }).lean();
    if (!sources.length) return 0;

    const existingKeys = new Set(
        (await Model.find({ restaurant: restaurantId, branch: branchId })
            .select(dedupeKey).lean())
            .map(d => String(d[dedupeKey]).toLowerCase())
    );

    const docs = sources
        .filter(s => !existingKeys.has(String(s[dedupeKey]).toLowerCase()))
        .map(s => {
            const fresh = { ...s };
            delete fresh._id;
            delete fresh.createdAt;
            delete fresh.updatedAt;
            delete fresh.__v;
            for (const f of stripFields) delete fresh[f];
            fresh.restaurant = restaurantId;
            fresh.branch = branchId;
            return fresh;
        });
    if (!docs.length) return 0;

    try {
        const created = await Model.insertMany(docs, { ordered: false });
        return created.length;
    } catch (err) {
        if (err?.insertedDocs) return err.insertedDocs.length;
        throw err;
    }
}

async function initializeBranchCoupons(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(Coupon, restaurantId, mainId, branchId, {
        dedupeKey: 'code',
        // Reset per-branch usage counters — the new branch hasn't
        // redeemed anything yet.
        stripFields: ['usageCount'],
    });
}

async function initializeBranchPromotions(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(Promotion, restaurantId, mainId, branchId, {
        dedupeKey: 'title',
    });
}

async function initializeBranchCategories(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(Category, restaurantId, mainId, branchId, {
        dedupeKey: 'name',
    });
}

async function initializeBranchCombos(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(Combo, restaurantId, mainId, branchId, {
        dedupeKey: 'name',
    });
}

async function initializeBranchHalls(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(Hall, restaurantId, mainId, branchId, {
        dedupeKey: 'name',
    });
}

async function initializeBranchEventTypes(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(EventType, restaurantId, mainId, branchId, {
        dedupeKey: 'title',
    });
}

async function initializeBranchPackages(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(Package, restaurantId, mainId, branchId, {
        dedupeKey: 'name',
    });
}

async function initializeBranchDecorations(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(DecorationPackage, restaurantId, mainId, branchId, {
        dedupeKey: 'name',
    });
}

async function initializeBranchAddons(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;
    return cloneCatalogToBranch(Addon, restaurantId, mainId, branchId, {
        dedupeKey: 'slug',
    });
}

/**
 * Clone the Main branch's tables onto a sub-branch. Tables reference
 * areas by ObjectId, so we map each Main table's area to the
 * sub-branch's area with the same name (case-insensitive). Tables
 * whose area doesn't exist on the sub-branch are SKIPPED rather than
 * orphaned — admin should sync Areas first (or together) for full
 * coverage.
 *
 * Each cloned table gets a fresh qrToken (QR codes must be unique
 * platform-wide) and resets to status='free'. Runtime fields
 * (activeOrder, currentDiner, assignedWaiter, mergedWith, alerts)
 * are deliberately not copied — those belong to the source branch's
 * actual operations.
 *
 * Idempotent: skip if a table with the same name already exists in
 * the mapped destination area (matches the unique index on
 * name+area).
 */
async function initializeBranchTables(restaurantId, branchId) {
    const mainId = await getMainBranchIdFor(restaurantId);
    if (!mainId || String(mainId) === String(branchId)) return 0;

    // Sub-branch area name → id. Without areas there's nothing to
    // anchor copied tables to, so bail early.
    const destAreas = await Area.find({ restaurant: restaurantId, branch: branchId })
        .select('_id name').lean();
    if (!destAreas.length) return 0;
    const destAreaByName = new Map(
        destAreas.map(a => [String(a.name).toLowerCase().trim(), a._id])
    );

    // Source area id → name map. Source = Main's areas PLUS tenant-level
    // (branch:null) areas. Without the null fallback, tenants whose
    // areas live at branch:null (legacy default) couldn't have their
    // Main-branch tables copied — `s.area` would point at a null-branch
    // area id that's missing from the map, so every table was silently
    // skipped. That was the "0 tables copied" bug.
    const sourceAreas = await Area.find({
        restaurant: restaurantId,
        $or: [{ branch: mainId }, { branch: null }],
    }).select('_id name').lean();
    const sourceAreaIdToName = new Map(
        sourceAreas.map(a => [String(a._id), String(a.name).toLowerCase().trim()])
    );

    // Source tables — Main's own + tenant-level (branch:null) tables.
    // Same fix as the area lookup: legacy tables without a branch field
    // should still get cloned into the new branch.
    const sources = await Table.find({
        restaurant: restaurantId,
        $or: [{ branch: mainId }, { branch: null }],
        isActive: true,
    }).select('name capacity area').lean();
    if (!sources.length) return 0;

    // Dedupe key: (lowercased name) + destination area id. Matches
    // the unique index on { name, area }.
    const existingDest = await Table.find({ restaurant: restaurantId, branch: branchId })
        .select('name area').lean();
    const existingKey = new Set(
        existingDest.map(t => `${String(t.name).toLowerCase().trim()}|${String(t.area)}`)
    );

    const docs = [];
    for (const s of sources) {
        const sourceAreaName = sourceAreaIdToName.get(String(s.area));
        if (!sourceAreaName) continue;
        const destAreaId = destAreaByName.get(sourceAreaName);
        if (!destAreaId) continue; // sub-branch missing this area — skip, don't orphan
        const dedupeKey = `${String(s.name).toLowerCase().trim()}|${String(destAreaId)}`;
        if (existingKey.has(dedupeKey)) continue;
        docs.push({
            restaurant: restaurantId,
            branch: branchId,
            name: s.name,
            capacity: s.capacity,
            area: destAreaId,
            status: 'free',
            qrToken: `tb-${crypto.randomBytes(6).toString('hex')}`,
            isActive: true,
        });
    }
    if (!docs.length) return 0;

    try {
        const created = await Table.insertMany(docs, { ordered: false });
        return created.length;
    } catch (err) {
        if (err?.insertedDocs) return err.insertedDocs.length;
        throw err;
    }
}

// GET /api/v1/branches
exports.listBranches = async (req, res) => {
    try {
        const includeInactive = req.query.includeInactive === 'true';
        const filter = { ...tenantFilter(req) };
        if (!includeInactive) filter.isActive = true;

        // ── HARD ENFORCEMENT ───────────────────────────────────────
        // Branch-pinned staff (Branch Admin) can only see their own branch.
        // AdminBranchContext uses this list to render the switcher —
        // returning just one entry locks the UI naturally.
        const pinned = pinnedBranchId(req);
        if (pinned) filter._id = pinned;

        // ── AUTO-HEAL: ensure tenant has a Main branch ─────────────
        // Every tenant must have a slug='main' branch — it's the
        // marker the customer picker, Settings inheritance, and
        // mergedBranchFilter all rely on. New tenants get one at
        // signup (createMainBranchFor in publicController +
        // superadminController), but legacy tenants that were created
        // before that wiring or that ever lost their Main row fall
        // through without one. Heal lazily on the first list read so
        // the admin never has to run a script. Pinned staff don't get
        // to trigger this — only the unpinned tenant owner can.
        if (req.restaurant && !pinned) {
            const hasMain = await Branch.exists({
                restaurant: req.restaurant._id,
                slug: 'main',
            });
            if (!hasMain) {
                try {
                    await createMainBranchFor(req.restaurant, req.user?._id || null);
                } catch (healErr) {
                    // Non-fatal: log and continue with whatever
                    // branches exist. Common cause: a stale row with
                    // slug='main' but isActive=false — safe to ignore
                    // because surfacing the rest of the list is more
                    // useful than erroring out.
                    logger.error('listBranches: auto-heal Main failed (non-fatal): ' + healErr.message);
                }
            }
        }

        const branches = await Branch.find(filter)
            .sort({ isActive: -1, sortOrder: 1, createdAt: -1 })
            .lean();

        // Batch-fetch all Branch Admins for these branches in one query.
        const branchIds = branches.map(b => b._id);
        const subAdmins = branchIds.length
            ? await User.find({
                role: 'admin',
                branch: { $in: branchIds },
                restaurant: tenantId(req),
            })
                .select('_id name email mobile staffId status mustChangePassword lastLoginAt branch isTenantOwner')
                .lean()
            : [];
        const subAdminByBranch = new Map(
            subAdmins.map(u => [String(u.branch), u])
        );

        // Fallback for the Main branch: a freshly-onboarded tenant has no
        // pinned Branch Admin on Main — the tenant owner runs it directly
        // (unpinned, isTenantOwner=true). Surface the owner as Main's
        // "admin" on the card so it isn't visually empty next to the
        // sub-branches that DO have a pinned Branch Admin chip. The
        // helper tries Restaurant.owner first, then isTenantOwner=true,
        // then any unpinned admin, then any admin — so even legacy
        // tenants where `Restaurant.owner` was never backfilled still
        // get a visible Owner chip.
        const mainBranch = branches.find(b => b.slug === 'main');
        if (mainBranch && !subAdminByBranch.has(String(mainBranch._id))) {
            const owner = await findTenantOwner(req.restaurant);
            if (owner) {
                subAdminByBranch.set(String(mainBranch._id), owner);
            }
        }

        return res.status(200).json({
            success: true,
            data: branches.map(b => buildBranchPayload(b, subAdminByBranch.get(String(b._id)) || null)),
        });
    } catch (err) {
        logger.error('listBranches error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list branches' });
    }
};

// GET /api/v1/branches/:id
exports.getBranch = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        // ── HARD ENFORCEMENT ───────────────────────────────────────
        // Branch-pinned staff can only read their own branch record.
        const pinned = pinnedBranchId(req);
        if (pinned && String(pinned) !== String(id)) {
            return res.status(403).json({
                success: false,
                code: 'BRANCH_SCOPE_VIOLATION',
                message: 'You can only view your assigned branch.',
            });
        }

        const branch = await Branch.findOne({ _id: id, ...tenantFilter(req) }).lean();
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }
        let subAdmin = await findBranchSubAdmin(branch._id, tenantId(req));
        // Main branch fallback: surface the tenant owner when no pinned
        // Branch Admin exists. Mirrors listBranches so single-fetch and
        // list views render the same chip.
        if (!subAdmin && branch.slug === 'main') {
            subAdmin = await findTenantOwner(req.restaurant);
        }
        return res.status(200).json({ success: true, data: buildBranchPayload(branch, subAdmin) });
    } catch (err) {
        logger.error('getBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch branch' });
    }
};

// POST /api/v1/branches
//
// Branch Admin (managerName + managerEmail) is MANDATORY. A branch cannot
// be created without assigning a Branch Admin to run it. The backend
// validates ALL inputs (branch + Branch Admin) BEFORE creating anything.
// If the Branch Admin account fails to create, the branch is rolled back.
exports.createBranch = async (req, res) => {
    try {
        const {
            name,
            slug,
            displayLabel,
            addressLine1, addressLine2,
            city, state, postalCode, country,
            contactPhone, contactEmail,
            sortOrder,
            latitude, longitude,
            // Branch Admin fields (mandatory)
            managerName, managerEmail, managerPhone, managerPermissions,
        } = req.body || {};

        // ── Guard: tenant must exist ────────────────────────────────
        // featureGate lets legacy tenants (req.restaurant = null) through,
        // but branch creation needs a real tenant for scoping + limits.
        if (!req.restaurant) {
            return res.status(400).json({
                success: false,
                message: 'Cannot create branches without a restaurant context.',
            });
        }

        // ── Validate branch fields ──────────────────────────────────
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, message: 'Branch name is required.' });
        }
        const trimmedName = String(name).trim();
        if (trimmedName.length > 80) {
            return res.status(400).json({ success: false, message: 'Branch name cannot exceed 80 characters.' });
        }

        // ── Validate Branch Admin fields (mandatory) ───────────────────
        if (!managerName || !String(managerName).trim()) {
            return res.status(400).json({ success: false, message: 'Branch Admin name is required. Every branch must have a Branch Admin.' });
        }
        if (!managerEmail || !String(managerEmail).trim()) {
            return res.status(400).json({ success: false, message: 'Branch Admin email is required. Every branch must have a Branch Admin.' });
        }
        const cleanEmail = managerEmail.toLowerCase().trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(cleanEmail)) {
            return res.status(400).json({ success: false, message: 'Invalid email format for Branch Admin.' });
        }
        // Phone is optional, but if provided it must match the User
        // schema's mobile validator (10-digit Indian, starting 6-9).
        // Validating upfront avoids creating the branch only to fail
        // at subAdmin.save() and roll it back.
        let cleanPhone = '';
        if (managerPhone !== undefined && managerPhone !== null) {
            cleanPhone = String(managerPhone).trim();
            if (cleanPhone && !/^[6-9]\d{9}$/.test(cleanPhone)) {
                return res.status(400).json({
                    success: false,
                    message: 'Branch Admin phone must be a 10-digit Indian mobile starting with 6, 7, 8, or 9.',
                });
            }
        }

        // ── Enforce plan's maxBranches limit ────────────────────────
        const tf = tenantFilter(req);
        const activeBranchCount = await Branch.countDocuments({ ...tf, isActive: true });
        const rawMax = req.restaurant.getLimit('maxBranches');
        const maxBranches = rawMax > 0 ? rawMax : 1; // 0 = plan didn't set a limit, default to 1
        if (activeBranchCount >= maxBranches) {
            return res.status(403).json({
                success: false,
                code: 'BRANCH_LIMIT_REACHED',
                message: `Your plan allows ${maxBranches} branch(es). You currently have ${activeBranchCount} active. Upgrade your plan to add more.`,
                current: activeBranchCount,
                limit: maxBranches,
            });
        }

        // ── Staff limit check (for the Branch Admin about to be created) ──
        const activeStaffCount = await User.countDocuments({
            ...tf,
            role: { $in: ['admin', 'waiter', 'captain', 'chef'] },
            status: 'active',
        });
        const rawStaffMax = req.restaurant.getLimit('maxStaff');
        const maxStaff = rawStaffMax > 0 ? rawStaffMax : 5;
        if (activeStaffCount >= maxStaff) {
            return res.status(403).json({
                success: false,
                code: 'STAFF_LIMIT_REACHED',
                message: `Your plan allows ${maxStaff} staff members. You currently have ${activeStaffCount} active. Upgrade your plan before adding a branch.`,
                current: activeStaffCount,
                limit: maxStaff,
            });
        }

        // ── Email uniqueness (3-tier: global + per-tenant) ──────────
        const emailCheck = await validateStaffEmail(cleanEmail, tenantId(req));
        if (!emailCheck.ok) {
            return res.status(400).json({ success: false, message: emailCheck.message });
        }

        // ── Generate unique slug ────────────────────────────────────
        let finalSlug = slug ? slugify(slug) : slugify(trimmedName);
        // If slugified result is empty or invalid (e.g. name was all
        // special characters like "Café !!!"), fall back to a timestamp.
        if (!finalSlug || !SLUG_REGEX.test(finalSlug)) {
            finalSlug = `branch-${Date.now().toString(36)}`;
        }
        // Reserve 'main' for the auto-provisioned tenant Main branch.
        // Owners can call their first branch anything they like, but
        // not "main" — that slug is the well-known marker that
        // utils/createMainBranch.js + utils/mainBranch.js use to find
        // the tenant's primary location.
        if (finalSlug === 'main') {
            return res.status(400).json({
                success: false,
                code: 'SLUG_RESERVED',
                message: 'The slug "main" is reserved for the primary branch. Please choose a different slug.',
            });
        }
        // Retry loop for slug collisions (max 3 attempts)
        for (let attempt = 0; attempt < 3; attempt++) {
            const taken = await Branch.exists({ ...tf, slug: finalSlug });
            if (!taken) break;
            finalSlug = `${slugify(trimmedName) || 'branch'}-${Math.random().toString(36).slice(2, 6)}`;
        }

        // ── All validations passed — create branch ──────────────────
        const branch = await Branch.create({
            restaurant: tenantId(req),
            name: trimmedName,
            slug: finalSlug,
            displayLabel: String(displayLabel || '').trim().slice(0, 60),
            addressLine1: addressLine1 || '',
            addressLine2: addressLine2 || '',
            city: city || '',
            state: state || '',
            postalCode: postalCode || '',
            country: country || 'India',
            // Delivery-distance origin; blank → null (tenant origin used).
            latitude: latitude === '' || latitude == null || !Number.isFinite(+latitude) ? null : +latitude,
            longitude: longitude === '' || longitude == null || !Number.isFinite(+longitude) ? null : +longitude,
            contactPhone: contactPhone || '',
            contactEmail: (contactEmail || '').toLowerCase().trim(),
            sortOrder: Number.isFinite(+sortOrder) ? +sortOrder : 0,
            createdBy: req.user?._id,
        });

        // ── Create Branch Admin account ────────────────────────────────
        try {
            const staffId = await getNextStaffIdForBranch(tf, branch._id);
            const tempPassword = generateTempPassword();

            const subAdmin = new User({
                name: String(managerName).trim(),
                email: cleanEmail,
                password: tempPassword,
                mobile: cleanPhone,
                role: 'admin',
                staffId,
                restaurant: tenantId(req),
                branch: branch._id,
                permissions: managerPermissions || {},
                status: 'active',
                mustChangePassword: true,
            });
            await subAdmin.save();

            // ── Seed branch-scoped Settings ────────────────────────
            // Create the Settings document for this (tenant, branch)
            // up front, populated from the branch's own contact / address
            // info. That way the Branch Admin's first visit to the Settings
            // tab shows their branch's details in Cafe/Hotel Information
            // instead of generic defaults or tenant-level values.
            try {
                // Deduplicated join: skip a later part if it already appears
                // in what we've collected (handles users who type the full
                // address into Line 1 AND fill city/state/postal separately).
                const addressParts = [];
                const addPart = (raw) => {
                    const part = String(raw || '').trim();
                    if (!part) return;
                    const seen = addressParts.join(' ').toLowerCase();
                    if (!seen.includes(part.toLowerCase())) addressParts.push(part);
                };
                addPart(branch.addressLine1);
                addPart(branch.addressLine2);
                addPart(branch.city);
                addPart(branch.state);
                addPart(branch.postalCode);
                const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
                await Settings.findOneAndUpdate(
                    { restaurant: tenantId(req), branch: branch._id },
                    {
                        $setOnInsert: {
                            restaurant: tenantId(req),
                            branch: branch._id,
                            general: {
                                cafeName: branch.name,
                                contactNumber: branch.contactPhone || '',
                                email: branch.contactEmail || '',
                                address: addressParts.join(', '),
                            },
                            operatingHours: days.map(day => ({
                                day,
                                start: '09:00',
                                end: '23:00',
                                isOpen: true,
                            })),
                        },
                    },
                    { upsert: true, new: true }
                );
            } catch (settingsErr) {
                // Non-fatal: the branch itself is created. Settings will
                // be lazily created on first GET by settingsController.
                logger.error('createBranch: Settings seed failed (non-fatal): ' + settingsErr.message);
            }

            // Optional "Copy from Main" — the create modal exposes the
            // same syncFromMain toggles as the Edit form so the admin
            // can seed the new branch with Main's menu / areas / tables
            // / coupons / promotions in one step. Untouched keys = clean
            // start (the historical default). Order matters: areas
            // BEFORE tables (tables reference areas by id), and we run
            // each sync independently so one failure doesn't block the
            // others.
            const syncFromMain = req.body?.syncFromMain || {};
            const syncResult = {
                menu: null, areas: null, tables: null, coupons: null,
                promotions: null, categories: null, combos: null, halls: null,
                eventTypes: null, packages: null, decorations: null, addons: null,
            };
            const rid = tenantId(req);
            const runSync = async (key, fn) => {
                if (syncFromMain[key] !== true) return;
                try {
                    syncResult[key] = await fn(rid, branch._id);
                } catch (e) {
                    syncResult[key] = { error: e.message };
                    logger.error(`createBranch: ${key} sync failed (non-fatal): ` + e.message);
                }
            };
            // Order matters: categories BEFORE menu (menu items reference
            // categories by id); areas BEFORE tables (tables reference
            // areas by id). Each sync runs independently so one failure
            // doesn't block the others.
            await runSync('categories', initializeBranchCategories);
            await runSync('menu',       initializeBranchMenu);
            await runSync('areas',      initializeBranchAreas);
            await runSync('tables',     initializeBranchTables);
            await runSync('coupons',    initializeBranchCoupons);
            await runSync('promotions', initializeBranchPromotions);
            await runSync('combos',     initializeBranchCombos);
            await runSync('halls',      initializeBranchHalls);
            await runSync('eventTypes', initializeBranchEventTypes);
            await runSync('packages',   initializeBranchPackages);
            await runSync('decorations', initializeBranchDecorations);
            await runSync('addons',     initializeBranchAddons);

            return res.status(201).json({
                success: true,
                data: buildBranchPayload(branch),
                manager: {
                    created: true,
                    user: {
                        _id: subAdmin._id,
                        name: subAdmin.name,
                        email: subAdmin.email,
                        staffId: subAdmin.staffId,
                    },
                    tempPassword,
                },
                sync: syncResult,
            });
        } catch (mgrErr) {
            // Rollback: delete the branch since Branch Admin failed
            logger.error('createBranch: Branch Admin creation failed, rolling back branch: ' + mgrErr.message);
            try {
                await Branch.deleteOne({ _id: branch._id });
            } catch (rollbackErr) {
                logger.error('createBranch: rollback also failed (orphaned branch): ' + rollbackErr.message);
            }

            // Surface the real cause to the admin so they can fix it.
            // Three branches: duplicate-key (E11000), schema validation
            // (bad mobile, missing field, etc.), and everything else.
            if (mgrErr?.code === 11000) {
                // Same diagnostic split as in createBranchSubAdmin —
                // 11000 can be email_per_tenant_unique OR
                // staffId_1_restaurant_1, and the message has to match.
                const keyPattern = mgrErr.keyPattern || {};
                const keyValue   = mgrErr.keyValue   || {};
                if (keyPattern.staffId || keyValue.staffId) {
                    return res.status(409).json({
                        success: false,
                        code: 'STAFF_ID_COLLISION',
                        message: 'Could not assign a unique staff ID. Branch creation rolled back. Retry usually fixes this.',
                    });
                }
                return res.status(409).json({
                    success: false,
                    code: 'EMAIL_TAKEN',
                    message: 'A staff member with this email already exists. Branch creation rolled back.',
                });
            }
            if (mgrErr?.name === 'ValidationError') {
                const firstMsg = Object.values(mgrErr.errors || {})[0]?.message || mgrErr.message;
                return res.status(400).json({
                    success: false,
                    message: `Branch Admin invalid: ${firstMsg}. Branch creation rolled back.`,
                });
            }
            return res.status(500).json({
                success: false,
                message: 'Failed to create Branch Admin account. Branch creation rolled back.',
            });
        }
    } catch (err) {
        if (err?.code === 11000) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_TAKEN',
                message: 'A branch with that slug already exists for your restaurant.',
            });
        }
        if (err?.name === 'ValidationError') {
            const firstMsg = Object.values(err.errors || {})[0]?.message || err.message;
            return res.status(400).json({ success: false, message: firstMsg });
        }
        logger.error('createBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create branch' });
    }
};

// PUT /api/v1/branches/:id
exports.updateBranch = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        // Explicit allowlist (utils/bodyAllowlist.js). restaurant,
        // createdBy, timestamps and the create-only manager* fields are
        // never branch-editable here, and neither is isActive: disabling
        // goes through DELETE /:id and reactivation through
        // PATCH /:id/reactivate, which enforces the plan's maxBranches.
        const updates = pickAllowed(req.body, BRANCH_UPDATE_FIELDS);
        // Coordinates: a cleared field arrives as '' — store null so the
        // tenant-level delivery origin is used instead of 0,0.
        for (const k of ['latitude', 'longitude']) {
            if (k in updates) {
                const v = updates[k];
                updates[k] = (v === '' || v == null || !Number.isFinite(+v)) ? null : +v;
            }
        }

        // Pull the inheritance toggles off the body — they're not
        // branch fields, they trigger separate sync runs after the
        // update succeeds. Shape:
        //   { syncFromMain: { menu: bool, areas: bool } }
        const syncFromMain = (req.body && typeof req.body.syncFromMain === 'object' && req.body.syncFromMain) || {};

        // Look up the target once — needed for both slug + name
        // guards below (Main branch is immutable in identity).
        const existing = await Branch.findOne({ _id: id, ...tenantFilter(req) }).select('slug name').lean();
        const isMain = existing?.slug === 'main';

        // ── NAME LOCK on the Main branch ────────────────────────────
        // The Main branch represents the SUBSCRIBER (tenant owner) and
        // its name must always equal the tenant's name. Renaming Main
        // here would let an admin sever that link — e.g. tenant
        // "Hotel Tip Top" with Main renamed to "Pune Office" would
        // make the subscriber identity invisible in the Branches tab
        // and customer picker. The legitimate way to change Main's
        // name is to update the tenant's name (Super Admin updates
        // restaurant.name → mirrored to Main via updateRestaurant
        // sync block in superadminController.js).
        if (isMain && typeof updates.name === 'string') {
            const proposed = String(updates.name).trim();
            if (proposed && proposed !== existing.name) {
                return res.status(400).json({
                    success: false,
                    code: 'MAIN_NAME_LOCKED',
                    message: 'The Main branch name is tied to your restaurant name and cannot be edited here. Update your restaurant name instead.',
                });
            }
            // Same value as current — silently strip so the rest of
            // the update (address, phone, email) still flows through.
            delete updates.name;
        }

        // Re-slugify if a new slug was explicitly supplied. Leave
        // the existing slug alone otherwise — renaming a branch
        // should NOT silently break any external URL bound to the
        // old slug.
        if (typeof updates.slug === 'string') {
            const proposed = slugify(updates.slug);
            if (!SLUG_REGEX.test(proposed)) {
                return res.status(400).json({ success: false, message: 'Slug contains invalid characters' });
            }
            // Two-way guard around the reserved 'main' slug:
            //   1. Sub-branches can't rename themselves into 'main'
            //      (would collide with the auto-Main marker).
            //   2. The Main branch can't rename ITS slug away from
            //      'main' (would orphan getMainBranchId lookups).
            const currentSlug = existing?.slug;
            if (proposed === 'main' && currentSlug !== 'main') {
                return res.status(400).json({
                    success: false,
                    code: 'SLUG_RESERVED',
                    message: 'The slug "main" is reserved for the primary branch.',
                });
            }
            if (currentSlug === 'main' && proposed !== 'main') {
                return res.status(400).json({
                    success: false,
                    code: 'SLUG_LOCKED',
                    message: 'The Main branch slug cannot be changed.',
                });
            }
            updates.slug = proposed;
        }
        if (typeof updates.contactEmail === 'string') {
            updates.contactEmail = updates.contactEmail.toLowerCase().trim();
        }

        const branch = await Branch.findOneAndUpdate(
            { _id: id, ...tenantFilter(req) },
            updates,
            { new: true, runValidators: true }
        );
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }

        // ── Inheritance sync (post-update, never on Main) ──────────
        // The Edit modal exposes "Sync from Main" toggles. Run only
        // the ones the admin selected. Main is the source — never
        // sync onto itself. Order matters: areas BEFORE tables (tables
        // reference areas by id), so a single save with both checked
        // can seed tables onto the freshly-created areas.
        const syncResult = { menu: null, areas: null, tables: null, coupons: null, promotions: null, categories: null, combos: null };
        if (!isMain) {
            const rid = tenantId(req);
            const runSync = async (key, fn) => {
                if (syncFromMain[key] !== true) return;
                try {
                    syncResult[key] = await fn(rid, branch._id);
                } catch (e) {
                    syncResult[key] = { error: e.message };
                    logger.error(`updateBranch: ${key} sync failed: ` + e.message);
                }
            };
            // categories before menu (FK), areas before tables (FK).
            await runSync('categories', initializeBranchCategories);
            await runSync('menu',       initializeBranchMenu);
            await runSync('areas',      initializeBranchAreas);
            await runSync('tables',     initializeBranchTables);
            await runSync('coupons',    initializeBranchCoupons);
            await runSync('combos',     initializeBranchCombos);
            await runSync('halls',      initializeBranchHalls);
            await runSync('eventTypes', initializeBranchEventTypes);
            await runSync('packages',   initializeBranchPackages);
            await runSync('decorations', initializeBranchDecorations);
            await runSync('addons',     initializeBranchAddons);
            await runSync('promotions', initializeBranchPromotions);
        }

        return res.status(200).json({
            success: true,
            data: buildBranchPayload(branch),
            sync: syncResult,
        });
    } catch (err) {
        if (err?.code === 11000) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_TAKEN',
                message: 'Another branch with that slug already exists.',
            });
        }
        logger.error('updateBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update branch' });
    }
};

// POST /api/v1/branches/:id/subadmin
//
// Create a Branch Admin for an EXISTING branch that doesn't have one
// yet. Used from the branch Edit form's Branch Admin tab when the
// admin needs to attach a manager after the fact (legacy branches,
// or branches whose Branch Admin was deleted from Staff).
//
// Validation mirrors createBranch's manager block:
//   - name + email mandatory, phone optional but format-checked
//   - 3-tier email uniqueness (validateStaffEmail)
//   - tenant staff-limit enforced
// Refuses if a Branch Admin already exists for the branch — that path
// should go through PATCH /:id/subadmin instead.
exports.createBranchSubAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        const branch = await Branch.findOne({ _id: id, ...tenantFilter(req) })
            .select('_id name isActive').lean();
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }
        if (!branch.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Cannot assign a Branch Admin to a disabled branch. Reactivate it first.',
            });
        }

        // Refuse if one already exists — caller should PATCH instead.
        const existing = await findBranchSubAdmin(branch._id, tenantId(req));
        if (existing) {
            return res.status(409).json({
                success: false,
                code: 'SUBADMIN_EXISTS',
                message: 'This branch already has a Branch Admin. Edit the existing one instead.',
            });
        }

        const { name, email, phone, permissions } = req.body || {};

        // ── Validate fields ─────────────────────────────────────────
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, message: 'Branch Admin name is required.' });
        }
        const trimmedName = String(name).trim();
        if (trimmedName.length > 80) {
            return res.status(400).json({ success: false, message: 'Branch Admin name cannot exceed 80 characters.' });
        }
        if (!email || !String(email).trim()) {
            return res.status(400).json({ success: false, message: 'Branch Admin email is required.' });
        }
        const cleanEmail = String(email).toLowerCase().trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(cleanEmail)) {
            return res.status(400).json({ success: false, message: 'Invalid email format for Branch Admin.' });
        }
        let cleanPhone = '';
        if (phone !== undefined && phone !== null) {
            cleanPhone = String(phone).trim();
            if (cleanPhone && !/^[6-9]\d{9}$/.test(cleanPhone)) {
                return res.status(400).json({
                    success: false,
                    message: 'Branch Admin phone must be a 10-digit Indian mobile starting with 6, 7, 8, or 9.',
                });
            }
        }

        // ── Staff limit check ───────────────────────────────────────
        const tf = tenantFilter(req);
        const activeStaffCount = await User.countDocuments({
            ...tf,
            role: { $in: ['admin', 'waiter', 'captain', 'chef'] },
            status: 'active',
        });
        const rawStaffMax = req.restaurant?.getLimit?.('maxStaff') ?? 0;
        const maxStaff = rawStaffMax > 0 ? rawStaffMax : 5;
        if (activeStaffCount >= maxStaff) {
            return res.status(403).json({
                success: false,
                code: 'STAFF_LIMIT_REACHED',
                message: `Your plan allows ${maxStaff} staff members. You currently have ${activeStaffCount} active. Upgrade your plan to add more.`,
                current: activeStaffCount,
                limit: maxStaff,
            });
        }

        // ── Email uniqueness (3-tier: global + per-tenant) ──────────
        const emailCheck = await validateStaffEmail(cleanEmail, tenantId(req));
        if (!emailCheck.ok) {
            return res.status(400).json({ success: false, message: emailCheck.message });
        }

        // ── Create ──────────────────────────────────────────────────
        const staffId = await getNextStaffIdForBranch(tf, branch._id);
        const tempPassword = generateTempPassword();
        const subAdmin = new User({
            name: trimmedName,
            email: cleanEmail,
            password: tempPassword,
            mobile: cleanPhone,
            role: 'admin',
            staffId,
            restaurant: tenantId(req),
            branch: branch._id,
            permissions: permissions || {},
            status: 'active',
            mustChangePassword: true,
        });
        try {
            await subAdmin.save();
        } catch (saveErr) {
            if (saveErr?.code === 11000) {
                // 11000 can be triggered by either of two unique indexes:
                //   email_per_tenant_unique  →  email collision
                //   staffId_1_restaurant_1   →  staffId collision (regenerator bug)
                // Inspect keyPattern/keyValue to return the RIGHT message
                // instead of always blaming email — that was hiding a
                // separate bug for every empty branch in the tenant.
                const keyPattern = saveErr.keyPattern || {};
                const keyValue   = saveErr.keyValue   || {};
                if (keyPattern.staffId || keyValue.staffId) {
                    logger.error(`createBranchSubAdmin: staffId collision on "${keyValue.staffId}" for tenant ${tenantId(req)}`);
                    return res.status(409).json({
                        success: false,
                        code: 'STAFF_ID_COLLISION',
                        message: 'Could not assign a unique staff ID — retrying usually fixes this. If it keeps failing, contact support.',
                    });
                }
                if (keyPattern.email || keyValue.email) {
                    return res.status(409).json({
                        success: false,
                        code: 'EMAIL_TAKEN',
                        message: 'A staff member with this email already exists.',
                    });
                }
                // Unknown unique-index collision — surface the raw field name
                // so support can diagnose without guessing.
                const offendingField = Object.keys(keyPattern)[0] || 'unknown field';
                return res.status(409).json({
                    success: false,
                    message: `Duplicate value on "${offendingField}". Please change it and try again.`,
                });
            }
            if (saveErr?.name === 'ValidationError') {
                const firstMsg = Object.values(saveErr.errors || {})[0]?.message || saveErr.message;
                return res.status(400).json({ success: false, message: `Branch Admin invalid: ${firstMsg}` });
            }
            throw saveErr;
        }

        return res.status(201).json({
            success: true,
            subAdmin: {
                _id: subAdmin._id,
                name: subAdmin.name,
                email: subAdmin.email,
                mobile: subAdmin.mobile || '',
                staffId: subAdmin.staffId,
                status: subAdmin.status,
                mustChangePassword: !!subAdmin.mustChangePassword,
                lastLoginAt: subAdmin.lastLoginAt || null,
            },
            tempPassword,
        });
    } catch (err) {
        logger.error('createBranchSubAdmin error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create Branch Admin' });
    }
};

// PATCH /api/v1/branches/:id/subadmin
//
// Edit the current Branch Admin's display-only fields (name, phone).
// Email and role are immutable from this endpoint — changing them
// must go through the Staff tab (proper user management).
exports.updateSubAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        const branch = await Branch.findOne({ _id: id, ...tenantFilter(req) }).select('_id').lean();
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }

        const subAdmin = await User.findOne({
            role: 'admin',
            branch: branch._id,
            restaurant: tenantId(req),
        });
        if (!subAdmin) {
            return res.status(404).json({
                success: false,
                code: 'NO_SUBADMIN',
                message: 'This branch has no Branch Admin assigned. Create one from the Staff tab.',
            });
        }

        const { name, mobile } = req.body || {};
        if (typeof name === 'string') {
            const trimmed = name.trim();
            if (!trimmed) {
                return res.status(400).json({ success: false, message: 'Name cannot be empty' });
            }
            if (trimmed.length > 80) {
                return res.status(400).json({ success: false, message: 'Name cannot exceed 80 characters' });
            }
            subAdmin.name = trimmed;
        }
        if (typeof mobile === 'string') {
            subAdmin.mobile = mobile.trim();
        }
        await subAdmin.save();

        // Sync the tenant owner when editing the primary branch's Branch Admin.
        // Primary = lowest sortOrder, then oldest createdAt among active branches.
        // Without this, Super Admin's ownerProfile (which reads restaurant.owner)
        // and AdminLayout's header (logged-in owner's cached name) stay stale.
        const ownerId = req.restaurant?.owner;
        if (ownerId && String(ownerId) !== String(subAdmin._id)) {
            const primary = await Branch.findOne({ ...tenantFilter(req), isActive: true })
                .sort({ sortOrder: 1, createdAt: 1 })
                .select('_id')
                .lean();
            if (primary && String(primary._id) === String(branch._id)) {
                const ownerUser = await User.findById(ownerId);
                if (ownerUser) {
                    if (typeof name === 'string' && name.trim()) ownerUser.name = name.trim();
                    if (typeof mobile === 'string') ownerUser.mobile = mobile.trim();
                    await ownerUser.save({ validateModifiedOnly: true });
                }
            }
        }

        return res.status(200).json({
            success: true,
            subAdmin: {
                _id: subAdmin._id,
                name: subAdmin.name,
                email: subAdmin.email,
                mobile: subAdmin.mobile || '',
                staffId: subAdmin.staffId,
                status: subAdmin.status,
                mustChangePassword: !!subAdmin.mustChangePassword,
                lastLoginAt: subAdmin.lastLoginAt || null,
            },
        });
    } catch (err) {
        if (err?.name === 'ValidationError') {
            const firstMsg = Object.values(err.errors || {})[0]?.message || err.message;
            return res.status(400).json({ success: false, message: firstMsg });
        }
        logger.error('updateSubAdmin error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update Branch Admin' });
    }
};

// POST /api/v1/branches/:id/subadmin/reset-password
//
// Generate a new temporary password for the branch's Branch Admin.
// The plaintext is returned ONCE in the response — the admin is
// expected to share it securely with the Branch Admin, who will be
// forced to change it on next login (mustChangePassword=true).
exports.resetSubAdminPassword = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        const branch = await Branch.findOne({ _id: id, ...tenantFilter(req) }).select('_id name').lean();
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }

        const subAdmin = await User.findOne({
            role: 'admin',
            branch: branch._id,
            restaurant: tenantId(req),
        });
        if (!subAdmin) {
            return res.status(404).json({
                success: false,
                code: 'NO_SUBADMIN',
                message: 'This branch has no Branch Admin assigned. Create one from the Staff tab.',
            });
        }

        const tempPassword = generateTempPassword();
        subAdmin.password = tempPassword;
        subAdmin.mustChangePassword = true;
        await subAdmin.save();

        logger.info(`Branch Admin password reset for branch ${branch._id} (${branch.name}) by admin ${req.user?._id}`);

        return res.status(200).json({
            success: true,
            tempPassword,
            subAdmin: {
                _id: subAdmin._id,
                name: subAdmin.name,
                email: subAdmin.email,
                staffId: subAdmin.staffId,
            },
        });
    } catch (err) {
        logger.error('resetSubAdminPassword error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
};

// GET /api/v1/branches/:id/disable-check
//
// Phase G: Pre-disable safety check. Returns blockers (things that
// prevent disabling) and warnings (things the admin should know about).
exports.preDisableCheck = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }
        const tf = tenantFilter(req);

        const [activeOrders, assignedStaff, assignedTables] = await Promise.all([
            Order.countDocuments({ branch: id, status: { $in: ['new', 'preparing', 'ready'] }, ...tf }),
            User.countDocuments({ branch: id, status: 'active', ...tf }),
            Table.countDocuments({ branch: id, ...tf }),
        ]);

        const blockers = {};
        if (activeOrders > 0) blockers.activeOrders = activeOrders;

        const warnings = {};
        if (assignedStaff > 0) warnings.assignedStaff = assignedStaff;
        if (assignedTables > 0) warnings.assignedTables = assignedTables;

        return res.status(200).json({
            success: true,
            canDisable: Object.keys(blockers).length === 0,
            blockers,
            warnings,
        });
    } catch (err) {
        logger.error('preDisableCheck error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to check branch status' });
    }
};

// DELETE /api/v1/branches/:id
//
// Soft-delete only: flips `isActive = false`. Also unassigns all staff
// pinned to this branch (sets their branch to null) so they become
// tenant-level until reassigned.
exports.deleteBranch = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }
        // The Main branch represents the tenant's primary location and
        // owns the inheritance lineage for sub-branches' Settings,
        // promotions, and shared menu. Disabling it would orphan
        // every sub-branch's resolution. Block the operation; the
        // owner can rename the Main branch from the admin UI but
        // cannot deactivate it.
        const target = await Branch.findOne({ _id: id, ...tenantFilter(req) }).select('slug name').lean();
        if (target?.slug === 'main') {
            return res.status(400).json({
                success: false,
                code: 'MAIN_BRANCH_PROTECTED',
                message: 'The Main branch cannot be disabled. It represents your tenant\'s primary location.',
            });
        }
        if (!target) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }
        // Same blocker as hardDeleteBranch / preDisableCheck: never hide a
        // branch from customers while it still has live kitchen tickets.
        const activeOrders = await Order.countDocuments({
            branch: id,
            status: { $in: ['new', 'preparing', 'ready'] },
            ...tenantFilter(req),
        });
        if (activeOrders > 0) {
            return res.status(400).json({
                success: false,
                code: 'ACTIVE_ORDERS',
                message: `This branch has ${activeOrders} active order(s). Complete or cancel them before disabling.`,
                activeOrders,
            });
        }
        const branch = await Branch.findOneAndUpdate(
            { _id: id, ...tenantFilter(req) },
            { isActive: false },
            { new: true }
        );
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }

        // The branch's own Branch Admin(s) stay pinned to it — nulling
        // their branch would make them tenant-wide admins. Deactivate
        // them instead and revoke their sessions (tokenVersion bump).
        const adminResult = await User.updateMany(
            { role: 'admin', isTenantOwner: { $ne: true }, branch: id, ...tenantFilter(req) },
            { $set: { status: 'inactive' }, $inc: { tokenVersion: 1 } }
        );

        // Unassign all other staff pinned to this branch
        const unassignResult = await User.updateMany(
            { branch: id, ...tenantFilter(req), $nor: [{ role: 'admin', isTenantOwner: { $ne: true } }] },
            { $set: { branch: null } }
        );

        return res.status(200).json({
            success: true,
            data: buildBranchPayload(branch),
            message: 'Branch disabled',
            staffUnassigned: (unassignResult.modifiedCount || 0) + (adminResult.modifiedCount || 0),
            branchAdminsDeactivated: adminResult.modifiedCount || 0,
        });
    } catch (err) {
        logger.error('deleteBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete branch' });
    }
};

// PATCH /api/v1/branches/:id/reactivate — undoes a soft-delete.
exports.reactivateBranch = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        // ── Enforce plan's maxBranches limit on reactivation too ──
        const activeBranchCount = await Branch.countDocuments({ ...tenantFilter(req), isActive: true });
        const rawMax = req.restaurant?.getLimit?.('maxBranches') ?? 0;
        const maxBranches = rawMax > 0 ? rawMax : 1;
        if (activeBranchCount >= maxBranches) {
            return res.status(403).json({
                success: false,
                code: 'BRANCH_LIMIT_REACHED',
                message: `Your plan allows ${maxBranches} branch(es). You currently have ${activeBranchCount} active. Upgrade your plan to reactivate this branch.`,
                current: activeBranchCount,
                limit: maxBranches,
            });
        }

        const branch = await Branch.findOneAndUpdate(
            { _id: id, ...tenantFilter(req) },
            { isActive: true },
            { new: true }
        );
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }
        // Undo deleteBranch: its Branch Admin(s) were deactivated (kept pinned).
        await User.updateMany(
            { role: 'admin', isTenantOwner: { $ne: true }, branch: id, status: 'inactive', ...tenantFilter(req) },
            { $set: { status: 'active' } }
        );
        return res.status(200).json({ success: true, data: buildBranchPayload(branch) });
    } catch (err) {
        logger.error('reactivateBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reactivate branch' });
    }
};

// DELETE /api/v1/branches/:id/permanent
//
// HARD delete: removes the branch row AND every piece of branch-scoped
// operational data attached to it. Historical records (Orders,
// Transactions, Reservations, AdvanceBookings, RefundRequests,
// CouponRedemptions) are NOT touched — they remain as audit trail
// with a dangling branch ref, which is fine for reports.
//
// Blockers (same gating as disable):
//   - Main branch is protected (it's the tenant's primary location)
//   - Active orders (new / preparing / ready) — admin must close them first
//
// Cascade order matters: child docs first, branch row last.
exports.hardDeleteBranch = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        const tf = tenantFilter(req);
        const target = await Branch.findOne({ _id: id, ...tf }).select('slug name').lean();
        if (!target) {
            return res.status(404).json({ success: false, message: 'Branch not found' });
        }
        if (target.slug === 'main') {
            return res.status(400).json({
                success: false,
                code: 'MAIN_BRANCH_PROTECTED',
                message: 'The Main branch cannot be deleted. It represents your tenant\'s primary location.',
            });
        }

        // Reuse the disable-check blocker for active orders. Permanently
        // wiping a branch with live orders would orphan kitchen tickets
        // and customer expectations — same reasoning as soft-disable.
        const activeOrders = await Order.countDocuments({
            branch: id,
            status: { $in: ['new', 'preparing', 'ready'] },
            ...tf,
        });
        if (activeOrders > 0) {
            return res.status(400).json({
                success: false,
                code: 'ACTIVE_ORDERS',
                message: `This branch has ${activeOrders} active order(s). Complete or cancel them before deleting.`,
                activeOrders,
            });
        }

        const branchScopedFilter = { branch: id, ...tf };

        // 1. Remove the Branch Admin user account (role:admin pinned here).
        const branchAdminDel = await User.deleteMany({
            role: 'admin',
            branch: id,
            restaurant: tenantId(req),
        });

        // 2. Unassign every other staff user pinned to this branch so they
        //    fall back to tenant-level and can be reassigned elsewhere.
        const staffUnassign = await User.updateMany(
            { role: { $in: ['waiter', 'captain', 'chef', 'manager'] }, branch: id, restaurant: tenantId(req) },
            { $set: { branch: null } }
        );

        // 3. Wipe branch-scoped operational catalogues + config.
        //    Run in parallel — none of these depend on each other.
        const [
            settingsDel, areaDel, tableDel, couponDel, promotionDel,
            hallDel, recipeDel, inventoryDel, categoryDel, notificationDel, requestDel,
        ] = await Promise.all([
            Settings.deleteMany(branchScopedFilter),
            Area.deleteMany(branchScopedFilter),
            Table.deleteMany(branchScopedFilter),
            Coupon.deleteMany(branchScopedFilter),
            Promotion.deleteMany(branchScopedFilter),
            Hall.deleteMany(branchScopedFilter),
            Recipe.deleteMany(branchScopedFilter),
            Inventory.deleteMany(branchScopedFilter),
            Category.deleteMany(branchScopedFilter),
            Notification.deleteMany(branchScopedFilter),
            Request.deleteMany(branchScopedFilter),
        ]);

        // 4. Strip this branch's price entries from every shared menu item.
        //    Shared items live with branch=null and carry per-branch overrides
        //    in branchPrices[] — leaving stale entries would point at a
        //    deleted branch.
        const menuPull = await MenuItem.updateMany(
            { restaurant: tenantId(req), 'branchPrices.branch': id },
            { $pull: { branchPrices: { branch: id } } }
        );

        // 5. Finally delete the branch row itself.
        await Branch.deleteOne({ _id: id, ...tf });

        const cleanup = {
            branchAdminDeleted: branchAdminDel.deletedCount || 0,
            staffUnassigned: staffUnassign.modifiedCount || 0,
            settings: settingsDel.deletedCount || 0,
            areas: areaDel.deletedCount || 0,
            tables: tableDel.deletedCount || 0,
            coupons: couponDel.deletedCount || 0,
            promotions: promotionDel.deletedCount || 0,
            halls: hallDel.deletedCount || 0,
            recipes: recipeDel.deletedCount || 0,
            inventory: inventoryDel.deletedCount || 0,
            categories: categoryDel.deletedCount || 0,
            notifications: notificationDel.deletedCount || 0,
            requests: requestDel.deletedCount || 0,
            menuPriceEntries: menuPull.modifiedCount || 0,
        };

        logger.info(`hardDeleteBranch: tenant=${tenantId(req)} branch=${id} (${target.name}) by user=${req.user?._id} cleanup=${JSON.stringify(cleanup)}`);

        return res.status(200).json({
            success: true,
            message: `Branch "${target.name}" permanently deleted.`,
            cleanup,
        });
    } catch (err) {
        logger.error('hardDeleteBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete branch' });
    }
};

// POST /api/v1/branches/:id/sync-menu
//
// Manually sync menu items to a branch. Adds branchPrices entries for
// all active shared menu items that don't already have one for this
// branch. If `resetPrices=true` is passed in the body, existing
// branchPrices entries are also reset to the item's current default.
//
// Use case: after adding new menu items to the restaurant, the admin
// can sync them to specific branches (or all branches at once).
exports.syncMenuToBranch = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }

        const branch = await Branch.findOne({ _id: id, ...tenantFilter(req), isActive: true }).lean();
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found or inactive' });
        }

        const resetPrices = req.body?.resetPrices === true;
        const rid = tenantId(req);

        // Phase 1: sync NEW items (no branchPrices entry for this branch yet)
        const newlySynced = await initializeBranchMenu(rid, branch._id);

        // Phase 2: optionally reset existing entries to current defaults
        let pricesReset = 0;
        if (resetPrices) {
            const itemsWithEntry = await MenuItem.find({
                restaurant: rid,
                branch: null,
                status: 'active',
                'branchPrices.branch': branch._id,
            }).select('_id basePrice offerPercentage offerExpiryDate');

            if (itemsWithEntry.length) {
                const ops = itemsWithEntry.map((item) => ({
                    updateOne: {
                        filter: { _id: item._id, 'branchPrices.branch': branch._id },
                        update: {
                            $set: {
                                'branchPrices.$.basePrice': item.basePrice,
                                'branchPrices.$.offerPercentage': item.offerPercentage || 0,
                                'branchPrices.$.finalPrice': item.basePrice - (item.basePrice * ((item.offerPercentage || 0) / 100)),
                                'branchPrices.$.offerExpiryDate': item.offerExpiryDate || null,
                            },
                        },
                    },
                }));
                const result = await MenuItem.bulkWrite(ops, { ordered: false });
                pricesReset = result.modifiedCount || 0;
            }
        }

        return res.status(200).json({
            success: true,
            message: `Menu synced to "${branch.name}".`,
            newlySynced,
            pricesReset,
        });
    } catch (err) {
        logger.error('syncMenuToBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to sync menu to branch' });
    }
};

// POST /api/v1/branches/sync-menu-all
//
// Sync menu items to ALL active branches at once. Convenience endpoint
// for admins who just added new items and want every branch updated.
exports.syncMenuToAllBranches = async (req, res) => {
    try {
        const rid = tenantId(req);
        if (!rid) {
            return res.status(400).json({ success: false, message: 'Restaurant context required.' });
        }

        const activeBranches = await Branch.find({ restaurant: rid, isActive: true })
            .select('_id name')
            .lean();

        if (!activeBranches.length) {
            return res.status(200).json({
                success: true,
                message: 'No active branches to sync.',
                results: [],
            });
        }

        const results = [];
        for (const branch of activeBranches) {
            const synced = await initializeBranchMenu(rid, branch._id);
            results.push({ branchId: branch._id, name: branch.name, synced });
        }

        const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);

        return res.status(200).json({
            success: true,
            message: `Menu synced to ${activeBranches.length} branch(es). ${totalSynced} new price entries added.`,
            results,
        });
    } catch (err) {
        logger.error('syncMenuToAllBranches error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to sync menu to branches' });
    }
};

// POST /api/v1/branches/:id/sync-areas
//
// Manually sync the Main branch's areas onto a specific sub-branch.
// Idempotent — only NEW area names are inserted (existing names are
// left alone, since the Branch Admin may have customised note/isActive).
//
// Use case: admin added a new area ("Garden", "Rooftop") on the Main
// branch and wants the same area available on a particular sub-branch
// without re-creating it manually.
exports.syncAreasToBranch = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch id' });
        }
        const rid = tenantId(req);
        const branch = await Branch.findOne({ _id: id, ...tenantFilter(req), isActive: true })
            .select('_id name slug').lean();
        if (!branch) {
            return res.status(404).json({ success: false, message: 'Branch not found or inactive' });
        }
        // Refuse to sync onto Main itself — Main IS the source.
        if (branch.slug === 'main') {
            return res.status(400).json({
                success: false,
                code: 'MAIN_IS_SOURCE',
                message: 'The Main branch is the source — areas cannot be synced onto itself.',
            });
        }

        const newlySynced = await initializeBranchAreas(rid, branch._id);
        return res.status(200).json({
            success: true,
            message: newlySynced > 0
                ? `${newlySynced} area(s) synced to "${branch.name}".`
                : `"${branch.name}" already has every Main branch area.`,
            newlySynced,
        });
    } catch (err) {
        logger.error('syncAreasToBranch error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to sync areas to branch' });
    }
};

// POST /api/v1/branches/sync-areas-all
//
// Sync Main branch's areas to EVERY active sub-branch at once.
// Convenience endpoint for admins who added a new area on Main and
// want every branch updated. Skips the Main branch itself.
exports.syncAreasToAllBranches = async (req, res) => {
    try {
        const rid = tenantId(req);
        if (!rid) {
            return res.status(400).json({ success: false, message: 'Restaurant context required.' });
        }

        const activeBranches = await Branch.find({
            restaurant: rid,
            isActive: true,
            slug: { $ne: 'main' },
        }).select('_id name').lean();

        if (!activeBranches.length) {
            return res.status(200).json({
                success: true,
                message: 'No sub-branches to sync.',
                results: [],
            });
        }

        const results = [];
        for (const branch of activeBranches) {
            const synced = await initializeBranchAreas(rid, branch._id);
            results.push({ branchId: branch._id, name: branch.name, synced });
        }
        const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);

        return res.status(200).json({
            success: true,
            message: `Areas synced to ${activeBranches.length} sub-branch(es). ${totalSynced} new area(s) added.`,
            results,
        });
    } catch (err) {
        logger.error('syncAreasToAllBranches error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to sync areas to branches' });
    }
};
