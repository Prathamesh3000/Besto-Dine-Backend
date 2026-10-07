const MenuItem = require('../models/menuItem');
const Order = require('../models/order');
const Category = require('../models/category');
const Branch = require('../models/branch');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { parseCsv } = require('../utils/csvParser');
const { pickDishImage, isDeadImage } = require('../utils/dishImagePicker');

// File-based master template for the bulk-import flow. Same pattern as
// the Halls / Packages / Decorations templates so admins encounter one
// consistent download/edit/upload workflow across all entities.
const MENU_ITEM_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'menuItem-master-template.csv');

// ─── Public cache header for customer-facing reads (60s fresh, 5min stale) ───
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

const { tenantFilter, tenantId, isBranchPinned, pinnedBranchId, strictBranchFilter } = require('../utils/tenantScope');
const { applyBranchPrice } = require('../utils/priceResolver');
const { buildAvailabilityFilter, isStaffCaller } = require('../utils/menuAvailability');
const { pickAllowed, MENU_ITEM_FIELDS } = require('../utils/bodyAllowlist');

/**
 * Phase 6 step 3 — validate an optional `branch` id against the
 * caller's tenant. Same pattern as tableController.resolveBranch.
 *
 *   - '' / null / undefined → treated as "tenant-level" (no branch)
 *   - valid ObjectId belonging to this tenant → accepted
 *   - anything else → rejected
 */
async function resolveBranch(req, rawBranchId) {
    // ── HARD ENFORCEMENT (write-side) ───────────────────────────────
    // Branch-pinned staff (Sub Admins) always write to their own branch.
    // They cannot create shared / tenant-level items (branch: null),
    // nor target another branch via body.branch. Any body value is
    // silently overridden by the pin.
    const pinned = pinnedBranchId(req);
    if (pinned) {
        return { ok: true, branchId: pinned };
    }

    if (rawBranchId === null || rawBranchId === undefined || rawBranchId === '') {
        return { ok: true, branchId: null };
    }
    if (!mongoose.isValidObjectId(rawBranchId)) {
        return { ok: false, message: 'Invalid branch id' };
    }
    const exists = await Branch.exists({
        _id: rawBranchId,
        ...tenantFilter(req),
        isActive: true,
    });
    if (!exists) {
        return { ok: false, message: 'Branch not found or not part of your restaurant' };
    }
    return { ok: true, branchId: rawBranchId };
}

// Customers see the price their branch will actually be charged
// (orderController prices via resolvePrice(menu, req.branch)). Staff get
// raw docs so the admin screens keep editing the default price.
function applyCustomerBranchPricing(items, req) {
    if (isStaffCaller(req) || !req?.branch?._id) return items;
    for (const item of items) {
        if (item) applyBranchPrice(item, req.branch._id);
    }
    return items;
}

/**
 * Build the branch-filter portion of a menu query. Supports three
 * modes:
 *
 *   branch=<id>        → only items assigned to that branch
 *   branch=tenant-only → only items with branch:null (shared items)
 *   branch=all / unset → no branch filter
 *   branchScope=auto   → { $or: [{ branch: null }, { branch: id }] }
 *                        This is the CUSTOMER-FACING mode: show the
 *                        tenant-level menu PLUS the branch-specific
 *                        items for the branch they're currently
 *                        ordering from.
 *
 * Phase 6 step 5: when `req.branch` is set (X-Branch-Id header
 * resolved by attachTenant) AND the query doesn't explicitly say
 * `branch=all`, we auto-apply the customer-facing scope so customers
 * naturally see "their branch + shared". Admin filtering still works
 * because the query string overrides — passing `?branch=all` or
 * `?branch=<otherId>` ignores req.branch entirely.
 */
function buildBranchFilter(query, req) {
    // ── HARD ENFORCEMENT (read-side) ────────────────────────────────
    // Branch-pinned staff (Branch Admin) see only items they explicitly
    // own — either:
    //   (a) items directly assigned to their branch (branch: pinned), or
    //   (b) items the branch was opted into via "Copy menu from Main"
    //       (initializeBranchMenu pushes a `branchPrices.branch:pinned`
    //       entry — works for both tenant-level AND Main-branch source
    //       items, so the branch picks up Main's full menu on sync).
    // Items the branch never opted into are HIDDEN — this is the
    // "Proper Clean" state the user asked for: a new branch sees
    // NOTHING from Main unless the admin checks "Copy menu from Main"
    // at branch-create time. Query string overrides are ignored — a
    // Branch Admin cannot pass ?branch=all to widen scope.
    const pinned = pinnedBranchId(req);
    if (pinned) {
        return {
            $or: [
                { branch: pinned },
                { 'branchPrices.branch': pinned },
            ],
        };
    }

    const { branch, branchScope } = query;

    // Explicit query string always wins for non-pinned callers.
    if (branchScope === 'auto' && mongoose.isValidObjectId(branch)) {
        return { $or: [{ branch: null }, { branch }] };
    }
    if (branch === 'tenant-only' || branch === 'none') return { branch: null };
    if (branch === 'all') return null;
    if (mongoose.isValidObjectId(branch)) return { branch };

    // No explicit branch query — fall back to req.branch (Phase 6
    // step 5). Tenant-level callers (no header, no staff branch)
    // get no filter, same as before.
    if (req?.branch?._id) {
        return { $or: [{ branch: null }, { branch: req.branch._id }] };
    }
    return null;
}

/**
 * "Copy from Main" clones Category docs into the new branch (new ids)
 * but shared menu items keep pointing at the source (Main / tenant-level)
 * categories, and a Branch Admin only sees their branch's categories.
 * Map source category ids to the branch's same-named copy so a pinned
 * viewer's items land in (and can be filtered by) their own categories.
 */
async function branchCategoryAliases(req, branchId) {
    const branchCats = await Category.find({ ...tenantFilter(req), branch: branchId })
        .select('_id name image status').lean();
    const toBranch = new Map();   // source category id → branch category
    const fromBranch = new Map(); // branch category id → [source ids]
    if (!branchCats.length) return { toBranch, fromBranch };
    const byName = new Map(branchCats.map((c) => [String(c.name).toLowerCase(), c]));
    const sources = await Category.find({
        ...tenantFilter(req),
        branch: { $ne: branchId },
        name: { $in: branchCats.map((c) => c.name) },
    }).select('_id name').lean();
    for (const src of sources) {
        const bc = byName.get(String(src.name).toLowerCase());
        if (!bc) continue;
        toBranch.set(String(src._id), bc);
        const list = fromBranch.get(String(bc._id)) || [];
        list.push(src._id);
        fromBranch.set(String(bc._id), list);
    }
    return { toBranch, fromBranch };
}

function remapItemCategories(items, toBranch) {
    if (!toBranch?.size) return items;
    for (const item of items) {
        const cid = item?.category?._id || item?.category;
        const bc = cid && toBranch.get(String(cid));
        if (!bc) continue;
        item.category = item.category?._id ? { ...item.category, ...bc } : bc._id;
    }
    return items;
}

// @desc    Get all menu items (searching, filtering, pagination)
// @route   GET /api/menu
// @access  Public
exports.getAllMenuItems = async (req, res) => {
    try {
        const { page = 1, limit = 20, search, category, status, type, sort } = req.query;

        // Build query object — always scoped to the current tenant.
        const queryObj = { ...tenantFilter(req) };

        // Phase 6 step 3 + step 5 — optional branch filter. Merged
        // into queryObj via buildBranchFilter. When `req.branch` is
        // set (the customer's active branch from X-Branch-Id), the
        // helper auto-applies the customer-facing "shared + this
        // branch" scope. Admin queries can override via ?branch=all.
        const branchClause = buildBranchFilter(req.query, req);
        if (branchClause) Object.assign(queryObj, branchClause);
        const pinnedForCats = pinnedBranchId(req);
        const catAliases = pinnedForCats ? await branchCategoryAliases(req, pinnedForCats) : null;

        // Restrict to an explicit id set (used by the Menu page's
        // "Needs Attention First" filter, which passes the ids of items with
        // inventory issues so ALL of them surface together, properly paged).
        if (req.query.ids) {
            const idList = String(req.query.ids)
                .split(',')
                .map(s => s.trim())
                .filter(s => mongoose.Types.ObjectId.isValid(s));
            // No valid ids → return an empty set rather than the whole menu.
            queryObj._id = { $in: idList.length ? idList : [new mongoose.Types.ObjectId()] };
        }

        // Search: use the text index for 3+ char queries (fast); regex for short prefix queries
        if (search) {
            if (search.length >= 3) {
                queryObj.$text = { $search: search };
            } else {
                queryObj.name = { $regex: `^${search}`, $options: 'i' }; // prefix-anchored regex (faster)
            }
        }

        if (category && category !== 'All Category' && category !== 'Select Category') {
            // Only filter by category if it's a valid ObjectId — ignore invalid values
            if (mongoose.Types.ObjectId.isValid(category)) {
                const aliases = catAliases?.fromBranch.get(String(category));
                queryObj.category = aliases ? { $in: [category, ...aliases] } : category;
            }
        }

        if (status && status !== 'All Status' && status !== 'Select Status') {
            queryObj.status = status.toLowerCase();
        } else if (!status) {
            // M9: Default to active items for customer-facing requests
            // Admin dashboard should pass status=All Status to see drafts/archived
            queryObj.status = 'active';
        }

        if (type && type !== 'All Type' && type !== 'Select Type') {
            // Schema enum stores 'veg' or 'non-veg' (with hyphen) — don't strip it
            const normalized = type.toLowerCase().trim();
            queryObj.vegType = normalized === 'nonveg' ? 'non-veg' : normalized;
        }

        // Health Mode — filters to items marked as healthy
        if (req.query.isHealthy === 'true') {
            queryObj.isHealthy = true;
        }

        // ADM-043 — availability schedule. Hide items whose availableDays
        // doesn't cover today, or whose startTime/endTime window is
        // currently closed. Staff see everything regardless so they can
        // still manage out-of-window items from the admin dashboard.
        if (!isStaffCaller(req)) {
            Object.assign(queryObj, buildAvailabilityFilter());
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Default sort = bestsellers first. orderCount is incremented in
        // orderController.bumpMenuItemOrderCounts on every order create /
        // append, so the menu list naturally bubbles popular items to the
        // top without an aggregation pipeline. createdAt is the tie-
        // breaker so a brand-new item with zero orders still has a stable
        // position. Explicit sort options below override the default.
        let sortBy = { orderCount: -1, createdAt: -1 };
        if (sort) {
            if (sort === 'Price: Low to High') sortBy = { basePrice: 1 };
            else if (sort === 'Price: High to Low') sortBy = { basePrice: -1 };
            else if (sort === 'Newest First') sortBy = { createdAt: -1 };
            else if (sort === 'Oldest First') sortBy = { createdAt: 1 };
            else if (sort === 'Featured First') sortBy = { isFeatured: -1, orderCount: -1, createdAt: -1 };
            else if (sort === 'Most Ordered') sortBy = { orderCount: -1, createdAt: -1 };
        }
        // When using text search, add relevance score sort
        if (queryObj.$text) sortBy = { score: { $meta: 'textScore' }, ...sortBy };

        // Run count + find in parallel — eliminates one sequential round-trip
        const [totalItems, menuItems] = await Promise.all([
            MenuItem.countDocuments(queryObj),
            MenuItem.find(queryObj, queryObj.$text ? { score: { $meta: 'textScore' } } : {})
                .populate('category', 'name image status') // project only needed category fields
                .sort(sortBy)
                .skip(skip)
                .limit(parseInt(limit))
                .lean()
        ]);
        applyCustomerBranchPricing(menuItems, req);
        if (catAliases) remapItemCategories(menuItems, catAliases.toBranch);

        // Cache public (unauthenticated) menu reads; skip cache for admin/staff
        // so the dashboard always shows fresh data after edits or re-seeds.
        if (req.headers.authorization) {
            res.set('Cache-Control', 'no-store');
        } else {
            res.set('Cache-Control', PUBLIC_CACHE);
            res.vary('X-Branch-Id'); // prices differ per branch
        }
        res.status(200).json({
            success: true,
            totalItems,
            totalPages: Math.ceil(totalItems / parseInt(limit)),
            currentPage: parseInt(page),
            pageSize: parseInt(limit),
            count: menuItems.length,
            data: menuItems
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Get single menu item
// @route   GET /api/menu/:id
// @access  Public
exports.getMenuItem = async (req, res) => {
    try {
        const menuItem = await MenuItem.findOne({ _id: req.params.id, ...tenantFilter(req) })
            .populate('category', 'name image status')
            .lean();
        if (!menuItem) {
            return res.status(404).json({ success: false, message: 'Menu item not found' });
        }
        applyCustomerBranchPricing([menuItem], req);
        if (req.headers.authorization) {
            res.set('Cache-Control', 'no-store');
        } else {
            res.set('Cache-Control', PUBLIC_CACHE);
            res.vary('X-Branch-Id'); // prices differ per branch
        }
        res.status(200).json({ success: true, data: menuItem });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Create menu item
// @route   POST /api/menu
// @access  Private/Admin
exports.createMenuItem = async (req, res) => {
    try {
        // Phase 6 step 3 — validate optional branch before writing.
        // Bad / cross-tenant branch id aborts early with 400.
        const branchCheck = await resolveBranch(req, req.body.branch);
        if (!branchCheck.ok) {
            return res.status(400).json({ success: false, message: branchCheck.message });
        }

        // ── Enforce the plan's maxMenuItems limit (0 / missing = uncapped,
        // same reading as maxTables and the superadmin usage check).
        const maxMenuItems = req.restaurant?.getLimit?.('maxMenuItems') ?? 0;
        if (maxMenuItems > 0) {
            const itemCount = await MenuItem.countDocuments({ ...tenantFilter(req) });
            if (itemCount >= maxMenuItems) {
                return res.status(403).json({
                    success: false,
                    code: 'MENU_ITEM_LIMIT_REACHED',
                    message: `Your plan allows ${maxMenuItems} menu item(s). You currently have ${itemCount}. Upgrade your plan to add more.`,
                    current: itemCount,
                    limit: maxMenuItems,
                });
            }
        }

        // Stamp the new item with the current tenant. Body restaurant
        // is intentionally ignored to prevent a malicious admin from
        // creating items in another tenant.
        // Explicit allowlist — orderCount (server counter), finalPrice
        // (pre-save hook computes it), inactivationUntil (only via the
        // inactivation flow on update), branchPrices (owner-only
        // endpoint) and restaurant are never taken from the body.
        const menuItem = await MenuItem.create({
            ...pickAllowed(req.body, MENU_ITEM_FIELDS),
            restaurant: tenantId(req),
            branch: branchCheck.branchId, // null = tenant-level (shared)
        });
        res.status(201).json({ success: true, data: menuItem });
    } catch (error) {
        logger.error('Create MenuItem Error:', { error: error.message });
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Download the master CSV template for menu-item bulk import.
// @route   GET /api/menu/template
// @access  Private/Admin (editMenu)
//
// Serves the curated CSV from Backend/data/. Same pattern as the
// Halls / Packages / Decorations / Event Types / Tables / Staff
// templates — the admin downloads the file, edits it locally
// (deletes rows they don't want), then re-uploads via the import
// endpoint. Headers are cache-disabled so a backend redeploy with
// fresh template content is picked up on the next download.
exports.downloadMenuItemTemplate = (req, res) => {
    try {
        if (!fs.existsSync(MENU_ITEM_TEMPLATE_PATH)) {
            logger.error('Menu item template missing on disk', { path: MENU_ITEM_TEMPLATE_PATH });
            return res.status(500).json({ success: false, message: 'Starter template not available' });
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="menuItem-master-template.csv"');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(MENU_ITEM_TEMPLATE_PATH).pipe(res);
    } catch (err) {
        logger.error('downloadMenuItemTemplate error', { error: err.message });
        res.status(500).json({ success: false, message: 'Failed to serve template' });
    }
};

// @desc    Bulk-import menu items from a CSV upload (ADM-041)
// @route   POST /api/menu/import
// @access  Private/Admin
//
// Expected columns (header row required, case-insensitive, order-free):
//   name*, description*, category*, basePrice*,
//   vegType (veg|non-veg, default veg),
//   prepStation (kitchen|bar|counter, default kitchen),
//   unit (default pieces),
//   offerPercentage (number, default 0),
//   cookingTime (string),
//   isFeatured (true|false, default false)
//
// Behaviour:
//   - Unknown category names are auto-created (status=active, tenant-scoped).
//   - Each row is processed independently — a bad row is skipped with an
//     error entry, the rest of the file still imports.
//   - Returns { success, created, errors: [{ row, message }] }.
exports.importMenuItemsCsv = async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: 'CSV file is required (form field: file)' });
        }

        const rows = parseCsv(req.file.buffer.toString('utf8'));
        if (rows.length < 2) {
            return res.status(400).json({ success: false, message: 'CSV must contain a header row and at least one data row' });
        }

        const header = rows[0].map(h => String(h || '').trim().toLowerCase());
        const idx = {
            // ── Required core ─────────────────────────────────────────
            name:            header.indexOf('name'),
            description:     header.indexOf('description'),
            category:        header.indexOf('category'),
            basePrice:       header.indexOf('baseprice'),
            // ── Existing optional ─────────────────────────────────────
            vegType:         header.indexOf('vegtype'),
            prepStation:     header.indexOf('prepstation'),
            unit:            header.indexOf('unit'),
            offerPercentage: header.indexOf('offerpercentage'),
            cookingTime:     header.indexOf('cookingtime'),
            isFeatured:      header.indexOf('isfeatured'),
            // ── New parity-with-modal fields ──────────────────────────
            prepTimeMinutes:    header.indexOf('preptimeminutes'),
            serveUpto:          header.indexOf('serveupto'),
            availableDays:      header.indexOf('availabledays'),
            startTime:          header.indexOf('starttime'),
            endTime:            header.indexOf('endtime'),
            ingredients:        header.indexOf('ingredients'),
            sizes:              header.indexOf('sizes'),
            toppings:           header.indexOf('toppings'),
            images:             header.indexOf('images'),
            isHealthy:          header.indexOf('ishealthy'),
            healthLevel:        header.indexOf('healthlevel'),
            healthTags:         header.indexOf('healthtags'),
            healthyIngredients: header.indexOf('healthyingredients'),
            // 6 nutritionalInfo flat columns
            calories:        header.indexOf('calories'),
            protein:         header.indexOf('protein'),
            fat:             header.indexOf('fat'),
            carbs:           header.indexOf('carbs'),
            fibre:           header.indexOf('fibre'),
            iron:            header.indexOf('iron'),
        };
        const missing = ['name', 'description', 'category', 'basePrice']
            .filter(col => idx[col] === -1);
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `CSV missing required columns: ${missing.join(', ')}`,
            });
        }

        // Branch context — Sub Admins are pinned, tenant owners default to
        // tenant-level (branch: null). resolveBranch handles both.
        const branchCheck = await resolveBranch(req, null);
        if (!branchCheck.ok) {
            return res.status(400).json({ success: false, message: branchCheck.message });
        }
        const branchId = branchCheck.branchId;
        const restaurantId = tenantId(req);

        // Cache category lookups so a 100-row CSV with 10 distinct
        // categories doesn't do 100 DB round-trips. Key by lower-cased name.
        const categoryCache = new Map();
        const resolveCategory = async (rawName) => {
            const name = String(rawName || '').trim();
            if (!name) return null;
            const key = name.toLowerCase();
            if (categoryCache.has(key)) return categoryCache.get(key);
            let cat = await Category.findOne({
                name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
                restaurant: restaurantId,
            });
            if (!cat) {
                cat = await Category.create({
                    name,
                    restaurant: restaurantId,
                    branch: branchId,
                    status: 'active',
                });
            }
            categoryCache.set(key, cat._id);
            return cat._id;
        };

        const errors = [];
        const skipped = [];
        let created = 0;

        // Re-uploading a sheet (or the master template twice) must not
        // duplicate dishes: a row whose name already exists in the same
        // category at this branch is reported as skipped, like the Tables /
        // Staff / Halls importers do. Key = categoryId::lower-cased name.
        const existingKeys = new Set(
            (await MenuItem.find({ restaurant: restaurantId, branch: branchId || null })
                .select('name category').lean())
                .map((d) => `${String(d.category)}::${String(d.name || '').trim().toLowerCase()}`),
        );

        // Plan maxMenuItems (0 / missing = uncapped) — rows past the cap
        // are reported as row errors instead of being created.
        const maxMenuItems = req.restaurant?.getLimit?.('maxMenuItems') ?? 0;
        let itemCount = maxMenuItems > 0 ? await MenuItem.countDocuments({ ...tenantFilter(req) }) : 0;
        // HH:MM window bounds; legacy "H:MM" padded, anything else dropped.
        const csvTime = (raw) => {
            const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
            return m ? m[1].padStart(2, '0') + ':' + m[2] : undefined;
        };

        for (let i = 1; i < rows.length; i++) {
            // CSV row numbers are 1-based and the header is row 1, so the
            // first data row is row 2 from the user's perspective.
            const rowNum = i + 1;
            const cells = rows[i];
            const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

            try {
                const name = get('name');
                const description = get('description');
                const categoryName = get('category');
                const basePriceRaw = get('basePrice');

                if (maxMenuItems > 0 && itemCount >= maxMenuItems) {
                    throw new Error(`Plan limit reached (${maxMenuItems} menu items). Upgrade your plan to add more.`);
                }
                if (!name)        throw new Error('name is required');
                if (!description) throw new Error('description is required');
                if (!categoryName) throw new Error('category is required');
                const basePrice = Number(basePriceRaw);
                if (!Number.isFinite(basePrice) || basePrice < 0) {
                    throw new Error('basePrice must be a non-negative number');
                }

                const vegTypeRaw = get('vegType').toLowerCase() || 'veg';
                if (!['veg', 'non-veg'].includes(vegTypeRaw)) {
                    throw new Error(`vegType must be "veg" or "non-veg" (got "${vegTypeRaw}")`);
                }

                const prepStationRaw = get('prepStation').toLowerCase() || 'kitchen';
                if (!['kitchen', 'bar', 'counter'].includes(prepStationRaw)) {
                    throw new Error(`prepStation must be kitchen|bar|counter (got "${prepStationRaw}")`);
                }

                const offerPercentageRaw = get('offerPercentage');
                const offerPercentage = offerPercentageRaw === '' ? 0 : Number(offerPercentageRaw);
                if (!Number.isFinite(offerPercentage) || offerPercentage < 0 || offerPercentage > 100) {
                    throw new Error('offerPercentage must be between 0 and 100');
                }

                const isFeaturedRaw = get('isFeatured').toLowerCase();
                const isFeatured = ['true', 'yes', '1', 'y', 'on'].includes(isFeaturedRaw);

                // ── Helpers — mirror the conventions used by Halls /
                // Packages / Decorations importers so admins only have to
                // learn one CSV style across all six entities.
                const toBool = (raw) => /^(true|yes|y|1|on)$/i.test(String(raw || '').trim());
                const splitList = (raw) =>
                    raw ? String(raw).split('|').map(s => s.trim()).filter(Boolean) : [];
                const toNum = (raw) => {
                    if (raw === '' || raw == null) return undefined;
                    const n = Number(raw);
                    return Number.isFinite(n) && n >= 0 ? n : undefined;
                };
                // Sizes & toppings use a `name:price[:extra]` shorthand
                // inside each pipe-separated chunk. e.g.:
                //   sizes:    "Regular:240:1|Medium:390:2|Large:540:3"
                //   toppings: "Extra Cheese:49:veg|Mushroom:45:veg"
                // Empty / malformed chunks are skipped silently — the
                // valid rows still land.
                const parseSizes = (raw) =>
                    splitList(raw).map(chunk => {
                        const [n, p, q] = chunk.split(':').map(s => (s || '').trim());
                        const price = Number(p);
                        if (!n || !Number.isFinite(price) || price < 0) return null;
                        return { name: n, price, quantity: q || '1' };
                    }).filter(Boolean);
                const parseToppings = (raw) =>
                    splitList(raw).map(chunk => {
                        const [n, p, t] = chunk.split(':').map(s => (s || '').trim());
                        const price = Number(p);
                        if (!n || !Number.isFinite(price) || price < 0) return null;
                        const type = (t || 'veg').toLowerCase();
                        return { name: n, price, type: ['veg', 'non-veg'].includes(type) ? type : 'veg' };
                    }).filter(Boolean);

                // availableDays — accepts pipe-delimited day codes. Falls
                // back to all 7 days when blank so the item is bookable
                // every day by default (matches what the AddItemModal
                // does when an admin doesn't touch the day picker).
                const VALID_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
                const availableDaysRaw = splitList(get('availableDays'))
                    .map(d => {
                        const norm = d.charAt(0).toUpperCase() + d.slice(1, 3).toLowerCase();
                        return VALID_DAYS.includes(norm) ? norm : null;
                    })
                    .filter(Boolean);
                const availableDays = availableDaysRaw.length ? availableDaysRaw : VALID_DAYS;

                // nutritionalInfo — six flat columns roll up to one
                // nested object so the schema validators stay happy.
                const nutritionalInfo = {
                    calories: toNum(get('calories')) ?? 0,
                    protein:  toNum(get('protein'))  ?? 0,
                    fat:      toNum(get('fat'))      ?? 0,
                    carbs:    toNum(get('carbs'))    ?? 0,
                    fibre:    toNum(get('fibre'))    ?? 0,
                    iron:     toNum(get('iron'))     ?? 0,
                };

                const categoryId = await resolveCategory(categoryName);

                const dupKey = `${String(categoryId)}::${name.toLowerCase()}`;
                if (existingKeys.has(dupKey)) {
                    skipped.push({ row: rowNum, name, reason: `"${name}" already exists in ${categoryName}` });
                    continue;
                }
                existingKeys.add(dupKey);

                // Resolve images. Trust CSV-provided URLs only if they
                // look real (not the deprecated source.unsplash.com or
                // the random-photo picsum CDN — those return the same
                // generic placeholder for every dish). Otherwise call
                // dishImagePicker(name, category) which returns a hand-
                // curated Unsplash photo matching the dish or, if the
                // dish isn't in NAME_MAP, the best keyword-pool fallback.
                // Result: every imported menu item lands with a usable,
                // dish-relevant thumbnail without the admin having to
                // touch each row.
                const rawImages = splitList(get('images'));
                const usableImages = rawImages.filter(u => u && !isDeadImage(u));
                const resolvedImages = usableImages.length
                    ? usableImages
                    : [pickDishImage(name, categoryName)];

                await MenuItem.create({
                    name,
                    description,
                    category: categoryId,
                    basePrice,
                    offerPercentage,
                    finalPrice: Math.round((basePrice - (basePrice * (offerPercentage / 100))) * 100) / 100,
                    vegType: vegTypeRaw,
                    prepStation: prepStationRaw,
                    unit: get('unit') || 'pieces',
                    cookingTime: get('cookingTime') || undefined,
                    isFeatured,
                    prepTimeMinutes: toNum(get('prepTimeMinutes')) ?? 15,
                    serveUpto:       get('serveUpto') || undefined,
                    availableDays,
                    startTime:       csvTime(get('startTime')),
                    endTime:         csvTime(get('endTime')),
                    ingredients:        splitList(get('ingredients')),
                    sizes:              parseSizes(get('sizes')),
                    toppings:           parseToppings(get('toppings')),
                    images:             resolvedImages,
                    isHealthy:          toBool(get('isHealthy')),
                    healthLevel:        get('healthLevel') || undefined,
                    healthTags:         splitList(get('healthTags')),
                    healthyIngredients: splitList(get('healthyIngredients')),
                    nutritionalInfo,
                    restaurant: restaurantId,
                    branch: branchId,
                });
                created += 1;
                itemCount += 1;
            } catch (rowErr) {
                errors.push({ row: rowNum, message: rowErr.message });
            }
        }

        return res.status(200).json({
            success: true,
            created,
            skippedCount: skipped.length,
            skipped,
            errorCount: errors.length,
            errors,
        });
    } catch (err) {
        logger.error('Menu CSV import error:', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to import CSV' });
    }
};

// Auto-disable combos that bundle a menu item which just got deleted or
// inactivated. A combo embeds its items as snapshots + an optional
// `menuItemId` ref (see models/combo.js), so without this it would keep
// selling a bundle whose component the kitchen can no longer make — the
// customer orders it, the chef can't complete it. We ARCHIVE (not delete)
// the affected combos: a 5-item combo shouldn't vanish because one item
// went away, and the admin can re-point it and re-activate. We do NOT
// auto-reactivate combos when an item comes back — the admin may have
// archived a combo for other reasons. Returns the affected combos so the
// caller can warn the admin which bundles were pulled.
async function disableCombosForMenuItem(req, menuItemId) {
    try {
        const Combo = require('../models/combo');
        const filter = {
            ...tenantFilter(req),
            'categories.items.menuItemId': menuItemId,
            status: { $ne: 'archived' },
        };
        const affected = await Combo.find(filter).select('_id name').lean();
        if (affected.length > 0) {
            await Combo.updateMany(filter, { $set: { status: 'archived' } });
        }
        return affected;
    } catch (err) {
        logger.error('disableCombosForMenuItem failed', { error: err.message, menuItemId });
        return [];
    }
}

// @desc    Update menu item
// @route   PUT /api/menu/:id
// @access  Private/Admin
exports.updateMenuItem = async (req, res) => {
    try {
        // Explicit allowlist (utils/bodyAllowlist.js). restaurant,
        // orderCount, finalPrice, inactivationUntil, branchPrices and any
        // Mongo update operator in the body are dropped here; finalPrice
        // and inactivationUntil are derived below.
        const updateData = pickAllowed(req.body, MENU_ITEM_FIELDS);

        // Phase 6 step 3 — if the body is moving the item to a
        // different branch, validate it. When `branch` isn't in the
        // body at all, the existing assignment is preserved.
        if (Object.prototype.hasOwnProperty.call(updateData, 'branch')) {
            const branchCheck = await resolveBranch(req, updateData.branch);
            if (!branchCheck.ok) {
                return res.status(400).json({ success: false, message: branchCheck.message });
            }
            updateData.branch = branchCheck.branchId;
        }

        // ADM-036 — translate the inactivation modal payload into the
        // schema-level fields the scheduler reads. The modal sends:
        //   - inactivationDuration: '24h' | '1w' | 'permanent' | 'custom'
        //   - inactivationDateRange: { start, end } when duration === 'custom'
        //   - inactivationReason: optional free text
        // None of these are real schema columns — they were silently dropped
        // before this fix, so neither auto-restore nor the audit log worked.
        const duration = req.body?.inactivationDuration;
        const dateRange = req.body?.inactivationDateRange;
        const reason = req.body?.inactivationReason;

        if (updateData.status === 'archived') {
            let until = null;
            if (duration === '24h') {
                until = new Date(Date.now() + 24 * 60 * 60 * 1000);
            } else if (duration === '1w') {
                until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            } else if (duration === 'custom' && dateRange?.end) {
                const parsed = new Date(dateRange.end);
                if (!Number.isNaN(parsed.getTime())) {
                    // End of the chosen day so an item "inactive until 2026-05-12"
                    // stays inactive throughout 2026-05-12 and only restores at
                    // the next scheduler tick after midnight.
                    parsed.setHours(23, 59, 59, 999);
                    until = parsed;
                }
            }
            // 'permanent' (and any unknown value) → leave until = null;
            // permanent items only come back via manual reactivation.
            updateData.inactivationUntil = until;
            if (typeof reason === 'string') updateData.inactivationReason = reason;
        } else if (updateData.status === 'active') {
            // Reactivation (manual toggle OR scheduler) wipes both fields so
            // a future re-inactivation starts from a clean slate.
            updateData.inactivationUntil = null;
            updateData.inactivationReason = '';
        }

        // Pinned staff can only update items their branch directly owns
        // (branch: pinned). Shared (branch:null) items are tenant-owner
        // territory — a Branch Admin sees them via branchPrices but
        // can't edit the master record.
        const scope = { _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) };

        // findByIdAndUpdate bypasses pre-save hooks, so recalculate finalPrice here
        // whenever a price-affecting field is included in the update.
        if (updateData.basePrice !== undefined || updateData.offerPercentage !== undefined) {
            const existing = await MenuItem.findOne(scope).lean();
            if (existing) {
                const basePrice = updateData.basePrice ?? existing.basePrice;
                const offerPct = updateData.offerPercentage ?? existing.offerPercentage ?? 0;
                updateData.finalPrice = Math.round((basePrice - (basePrice * (offerPct / 100))) * 100) / 100;
            }
        }

        const menuItem = await MenuItem.findOneAndUpdate(scope, updateData, {
            returnDocument: 'after',
            runValidators: true
        });
        if (!menuItem) {
            return res.status(404).json({ success: false, message: 'Menu item not found' });
        }
        // If this update DISABLED the item (status moved off 'active' —
        // archived/draft), pull any combos that bundle it so they don't
        // keep selling a component that's now unavailable.
        let disabledCombos = [];
        if (updateData.status && updateData.status !== 'active') {
            disabledCombos = await disableCombosForMenuItem(req, menuItem._id);
        }
        // BUG #24 — tenant-scoped ping so customer menus drop an item the
        // moment it goes out of stock / inactive (instead of after 5 min).
        try {
            require('../utils/socket').emitMenuUpdated(menuItem.restaurant, {
                itemIds: [String(menuItem._id)],
                branch: menuItem.branch ? String(menuItem.branch) : null,
                reason: 'update',
            });
        } catch { /* socket best-effort */ }
        res.status(200).json({ success: true, data: menuItem, disabledCombos });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Delete menu item
// @route   DELETE /api/menu/:id
// @access  Private/Admin
exports.deleteMenuItem = async (req, res) => {
    try {
        const menuItem = await MenuItem.findOneAndDelete({ _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) });
        if (!menuItem) {
            return res.status(404).json({ success: false, message: 'Menu item not found' });
        }
        // Cascade: any recipe referencing this menu item is now an orphan
        // (shows as "—" in the admin Recipes tab and can never be edited
        // or food-cost-analyzed). Drop them here.
        try {
            const Recipe = require('../models/recipe');
            await Recipe.deleteMany({ menuItem: menuItem._id, ...tenantFilter(req) });
        } catch { /* non-fatal */ }
        // Auto-archive any combos that bundled this now-deleted item so
        // they stop being sold with a missing component.
        const disabledCombos = await disableCombosForMenuItem(req, menuItem._id);
        // BUG #24 — tell open customer menus to drop the item.
        try {
            require('../utils/socket').emitMenuUpdated(menuItem.restaurant, {
                itemIds: [String(menuItem._id)],
                branch: menuItem.branch ? String(menuItem.branch) : null,
                reason: 'delete',
            });
        } catch { /* socket best-effort */ }
        res.status(200).json({ success: true, message: 'Menu item deleted', disabledCombos });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Search menu items (dedicated search with category matching)
// @route   GET /api/menu/search
// @access  Public
exports.searchMenuItems = async (req, res) => {
    try {
        const { type } = req.query;
        // Bug #18 — coerce to a plain string (qs can hand us arrays /
        // objects), cap its length, escape regex metacharacters before
        // it reaches $regex, and bound the page size.
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        if (!q || !q.trim()) {
            return res.status(200).json({ success: true, results: [], categories: [] });
        }

        const query = q.trim().slice(0, 100);
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const itemQuery = { status: 'active', ...tenantFilter(req) };

        // Phase 6 step 5 — same auto branch scope as the main list.
        const branchClause = buildBranchFilter(req.query, req);
        if (branchClause) Object.assign(itemQuery, branchClause);

        // Text search for 3+ chars, prefix regex for shorter
        if (query.length >= 3) {
            itemQuery.$text = { $search: query };
        } else {
            itemQuery.name = { $regex: `^${escapedQuery}`, $options: 'i' };
        }

        // Veg/non-veg filter
        if (type === 'veg') itemQuery.vegType = 'veg';
        else if (type === 'non-veg') itemQuery.vegType = 'non-veg';

        // ADM-043 — same availability gate as the list endpoint so a
        // customer can't search up an item that's outside its schedule.
        if (!isStaffCaller(req)) {
            Object.assign(itemQuery, buildAvailabilityFilter());
        }

        // Categories don't have the branchPrices field that the menu-
        // item branch filter relies on, so reuse a category-shaped
        // scope: own + tenant-level shared for pinned, plain tenant
        // for tenant owner.
        const pinnedForCat = pinnedBranchId(req);
        const categoryBranchClause = pinnedForCat
            ? { $or: [{ branch: null }, { branch: pinnedForCat }] }
            : {};

        // Search items + matching categories in parallel
        const [items, categories] = await Promise.all([
            // AUDIT-EXEMPT: itemQuery is built from tenantFilter(req) above (scanner false positive)
            MenuItem.find(
                itemQuery,
                itemQuery.$text ? { score: { $meta: 'textScore' } } : {}
            )
                .populate('category', 'name image status')
                .sort(itemQuery.$text ? { score: { $meta: 'textScore' } } : { name: 1 })
                .limit(limit)
                .lean(),
            Category.find({
                name: { $regex: escapedQuery, $options: 'i' },
                status: 'active',
                ...tenantFilter(req),
                ...categoryBranchClause,
            }).lean()
        ]);

        res.set('Cache-Control', PUBLIC_CACHE);
        res.vary('X-Branch-Id'); // prices differ per branch
        applyCustomerBranchPricing(items, req);
        res.status(200).json({ success: true, results: items, categories });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Get trending/popular menu items (based on order frequency)
// @route   GET /api/menu/trending
// @access  Public
exports.getTrendingItems = async (req, res) => {
    try {
        const { limit = 6 } = req.query;

        // Aggregate most-ordered items from the last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const trending = await Order.aggregate([
            { $match: { createdAt: { $gte: thirtyDaysAgo }, ...tenantFilter(req) } },
            { $unwind: '$items' },
            { $group: {
                _id: '$items.menuItem',        // Group by MenuItem ObjectId (stable across renames)
                name: { $first: '$items.name' }, // Keep latest name for display
                count: { $sum: '$items.quantity' }
            }},
            { $sort: { count: -1 } },
            { $limit: parseInt(limit) }
        ]);

        // If we have order data, return trending; otherwise fall back to featured items
        if (trending.length > 0) {
            res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
            return res.status(200).json({
                success: true,
                trending: trending.map((t, i) => ({
                    id: t._id || i + 1,
                    label: t.name || 'Unknown Item',
                    orderCount: t.count
                }))
            });
        }

        // Fallback: featured active items
        const featured = await MenuItem.find({ status: 'active', isFeatured: true, ...tenantFilter(req) })
            .select('name')
            .limit(parseInt(limit))
            .lean();

        res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
        res.status(200).json({
            success: true,
            trending: featured.map((f, i) => ({ id: i + 1, label: f.name, orderCount: 0 }))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Get customization options (sizes + toppings) for a menu item
// @route   GET /api/menu/:id/customizations
// @access  Public
exports.getItemCustomizations = async (req, res) => {
    try {
        const item = await MenuItem.findOne({ _id: req.params.id, ...tenantFilter(req) })
            .select('name sizes toppings basePrice finalPrice unit')
            .lean();

        if (!item) {
            return res.status(404).json({ success: false, message: 'Menu item not found' });
        }

        res.set('Cache-Control', PUBLIC_CACHE);
        res.vary('X-Branch-Id'); // prices differ per branch
        res.status(200).json({
            success: true,
            data: {
                id: item._id,
                name: item.name,
                basePrice: item.basePrice,
                finalPrice: item.finalPrice,
                unit: item.unit || 'pieces',
                sizes: item.sizes || [],
                toppings: item.toppings || []
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Phase C: Branch-specific pricing ───────────────────────────────────────

/**
 * GET /api/v1/menu/:id/branch-prices
 * Returns the branch price overrides for a single menu item.
 */
exports.getBranchPrices = async (req, res) => {
    try {
        const item = await MenuItem.findOne({ _id: req.params.id, ...tenantFilter(req) })
            .select('name basePrice finalPrice offerPercentage branchPrices')
            .populate('branchPrices.branch', 'name slug')
            .lean();

        if (!item) {
            return res.status(404).json({ success: false, message: 'Menu item not found' });
        }

        res.status(200).json({
            success: true,
            data: {
                _id: item._id,
                name: item.name,
                defaultPrice: {
                    basePrice: item.basePrice,
                    finalPrice: item.finalPrice,
                    offerPercentage: item.offerPercentage || 0,
                },
                branchPrices: (item.branchPrices || []).map(bp => ({
                    branch: bp.branch,
                    basePrice: bp.basePrice,
                    finalPrice: bp.finalPrice,
                    offerPercentage: bp.offerPercentage || 0,
                    offerExpiryDate: bp.offerExpiryDate || null,
                })),
            },
        });
    } catch (error) {
        logger.error('getBranchPrices error: ' + error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/v1/menu/:id/branch-prices
 * Set branch-specific price overrides for a menu item.
 *
 * Body: { branchPrices: [{ branch: "id", basePrice: 350, offerPercentage: 10 }, ...] }
 *
 * Each branch id is validated against the tenant. Entries with branch ids
 * that don't belong to this tenant are silently skipped.
 * Passing an empty array clears all overrides.
 */
exports.setBranchPrices = async (req, res) => {
    try {
        const item = await MenuItem.findOne({ _id: req.params.id, ...tenantFilter(req) });
        if (!item) {
            return res.status(404).json({ success: false, message: 'Menu item not found' });
        }

        const { branchPrices } = req.body;
        if (!Array.isArray(branchPrices)) {
            return res.status(400).json({ success: false, message: 'branchPrices must be an array.' });
        }

        // Validate each entry
        const validated = [];
        for (const entry of branchPrices) {
            if (!entry.branch || !mongoose.isValidObjectId(entry.branch)) continue;
            if (typeof entry.basePrice !== 'number' || entry.basePrice < 0) continue;

            // Verify branch belongs to this tenant and is active
            const exists = await Branch.exists({
                _id: entry.branch,
                ...tenantFilter(req),
                isActive: true,
            });
            if (!exists) continue;

            // One override per branch — duplicates would make the price
            // a customer pays depend on array order.
            if (validated.some((v) => String(v.branch) === String(entry.branch))) {
                return res.status(400).json({
                    success: false,
                    code: 'DUPLICATE_BRANCH_PRICE',
                    message: 'Each branch can have only one price override.',
                });
            }

            validated.push({
                branch: entry.branch,
                basePrice: entry.basePrice,
                offerPercentage: Math.min(100, Math.max(0, entry.offerPercentage || 0)),
                offerExpiryDate: entry.offerExpiryDate || null,
            });
        }

        item.branchPrices = validated;
        await item.save(); // pre-save hook calculates finalPrice for each entry

        // Return the saved item with populated branch names
        const saved = await MenuItem.findById(item._id)
            .select('name basePrice finalPrice offerPercentage branchPrices')
            .populate('branchPrices.branch', 'name slug')
            .lean();

        res.status(200).json({
            success: true,
            message: `Branch prices updated. ${validated.length} override(s) set.`,
            data: {
                _id: saved._id,
                name: saved.name,
                defaultPrice: {
                    basePrice: saved.basePrice,
                    finalPrice: saved.finalPrice,
                    offerPercentage: saved.offerPercentage || 0,
                },
                branchPrices: (saved.branchPrices || []).map(bp => ({
                    branch: bp.branch,
                    basePrice: bp.basePrice,
                    finalPrice: bp.finalPrice,
                    offerPercentage: bp.offerPercentage || 0,
                    offerExpiryDate: bp.offerExpiryDate || null,
                })),
            },
        });
    } catch (error) {
        logger.error('setBranchPrices error: ' + error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};
