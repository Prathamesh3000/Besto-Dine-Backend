const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Combo = require('../models/combo');
const MenuItem = require('../models/menuItem');
const Branch = require('../models/branch');
const { isStaffCaller } = require('../utils/menuAvailability');
const logger = require('../utils/logger');
const { parseCsv } = require('../utils/csvParser');
const { pickDishImage, isDeadImage } = require('../utils/dishImagePicker');

const { tenantFilter, tenantId, pinnedBranchId, strictBranchFilter, branchScopeClause } = require('../utils/tenantScope');

// File-based master template for the combo bulk-import flow. Same
// pattern as the Halls / Packages / Decorations / Menu Item templates
// so admins see one consistent download/edit/upload workflow.
const COMBO_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'combo-master-template.csv');

/**
 * Branch filter for the combo LIST endpoint.
 *   - Pinned staff (Branch Admin)  → STRICT { branch: pinned }. No
 *     tenant-null fallback; no leak from other branches.
 *   - Customer with X-Branch-Id    → permissive `{ $or: [null, selected] }`
 *     so seeded tenant-level combos still reach the customer at the
 *     QR-scanned branch.
 *   - Tenant owner (no pin)        → unfiltered (sees everything).
 */
function comboBranchFilter(req) {
    // Main-branch views also include shared (branch:null) combos — they are
    // Main's (utils/tenantScope.branchScopeClause). Other branches strict.
    const pinned = pinnedBranchId(req);
    if (pinned) return branchScopeClause(req, pinned._id || pinned);
    // Tenant owner using the admin branch switcher passes ?branch=<id>.
    // Default is STRICT (only that branch's combos) so each branch can
    // run its own promo lineup. When the caller passes `branchScope=auto`
    // (set by the admin axios interceptor for every read), we widen to
    // "shared + that branch" so tenant-level combos (branch:null) still
    // surface — without this, the master-template combo upload (which
    // lands as branch:null) is invisible to an admin who's switched
    // into a specific branch view.
    const raw = req?.query?.branch;
    const scope = req?.query?.branchScope;
    if (raw === 'all') return {};
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) {
        if (scope === 'auto') return { $or: [{ branch: null }, { branch: raw }] };
        return branchScopeClause(req, raw);
    }
    if (req?.branch?._id) return { $or: [{ branch: null }, { branch: req.branch._id }] };
    return {};
}

// Client-writable combo fields. restaurant / branch are stamped by the
// handler, savings is derived by the pre-save hook (or recomputed on
// update), and counters are never taken from the body.
const COMBO_FIELDS = [
    'name', 'serveUpto', 'description', 'images', 'vegType', 'isSpecial',
    'categories', 'price', 'originalPrice', 'discount', 'discountType',
    'unlimitedQuantity', 'taxApplicable', 'serviceCharge', 'availableDays',
    'startTime', 'endTime', 'isHealthy', 'status',
];
function pickComboFields(body = {}) {
    const out = {};
    for (const k of COMBO_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
    }
    return out;
}

/**
 * Validate the bundled items: every menuItemId must be a menu item of
 * this tenant (and, for a pinned Branch Admin, one their branch can
 * see). Name / price / veg flag of linked items are taken from the real
 * menu item, not the client. Items without a menuItemId are free-text.
 * Returns { ok, categories } or { ok:false, message }.
 */
async function resolveComboCategories(req, categories) {
    if (categories === undefined) return { ok: true, categories: undefined };
    if (!Array.isArray(categories)) return { ok: false, message: 'categories must be an array' };
    const pinned = pinnedBranchId(req);
    const out = [];
    for (const cat of categories) {
        if (!cat || typeof cat !== 'object') return { ok: false, message: 'Invalid combo category' };
        if (cat.items !== undefined && !Array.isArray(cat.items)) {
            return { ok: false, message: 'Combo category items must be an array' };
        }
        const items = [];
        for (const it of cat.items || []) {
            if (!it || typeof it !== 'object') return { ok: false, message: 'Invalid combo item' };
            if (it.menuItemId == null || it.menuItemId === '') {
                items.push({ name: it.name, price: it.price, isVeg: it.isVeg });
                continue;
            }
            if (!mongoose.isValidObjectId(it.menuItemId)) {
                return { ok: false, message: 'Invalid menu item in combo' };
            }
            const filter = { _id: it.menuItemId, ...tenantFilter(req) };
            if (pinned) filter.$or = [{ branch: pinned }, { branch: null }, { 'branchPrices.branch': pinned }];
            const mi = await MenuItem.findOne(filter).select('name basePrice finalPrice vegType').lean();
            if (!mi) return { ok: false, message: 'Combo item not found in your menu' };
            items.push({
                menuItemId: mi._id,
                name: mi.name,
                price: mi.finalPrice != null ? mi.finalPrice : (mi.basePrice || 0),
                isVeg: mi.vegType === 'veg',
            });
        }
        out.push({ name: cat.name, items });
    }
    return { ok: true, categories: out };
}

// Escape special regex characters to prevent ReDoS
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// @desc    Get all combo menus (with server-side searching, filtering, and pagination)
// @route   GET /api/combos
// @access  Public
exports.getCombos = async (req, res) => {
    try {
        const { page = 1, limit = 10, search, status, type, sort } = req.query;

        // Build Query object — scoped to the current tenant AND
        // (for pinned staff) to their branch. Branch admin sees only
        // their branch's combos; tenant owner sees everything.
        const queryObj = { ...tenantFilter(req), ...comboBranchFilter(req) };

        // Searching (by name) — escape regex special chars to prevent ReDoS
        if (search) {
            queryObj.name = { $regex: escapeRegex(search), $options: 'i' };
        }

        // Filtering by Status. Customers / anonymous callers only ever
        // see active combos (drafts and auto-archived combos stay hidden,
        // same default as /menu); staff may filter freely.
        if (!isStaffCaller(req)) {
            queryObj.status = 'active';
        } else if (status && status !== 'All Status' && status !== 'Select Status') {
            queryObj.status = status.toLowerCase();
        }

        // Filtering by Type (Veg/Non-veg) — schema enum stores 'non-veg' with hyphen
        if (type && type !== 'All Type' && type !== 'Select Type') {
            const normalized = type.toLowerCase().trim();
            queryObj.vegType = normalized === 'nonveg' ? 'non-veg' : normalized;
        }

        // Execute Query
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const parsedLimit = parseInt(limit);

        // Sorting logic
        let sortBy = { createdAt: -1 };
        if (sort) {
            if (sort === 'Price: Low to High') sortBy = { price: 1 };
            else if (sort === 'Price: High to Low') sortBy = { price: -1 };
            else if (sort === 'Oldest First') sortBy = { createdAt: 1 };
        }

        // Run count + find in parallel — eliminates one sequential round-trip
        const [totalItems, combos] = await Promise.all([
            Combo.countDocuments(queryObj),
            Combo.find(queryObj)
                .populate({
                    path: 'categories.items',
                    select: 'name price image isVeg vegType status'
                })
                .sort(sortBy)
                .skip(skip)
                .limit(parsedLimit)
                .lean()
        ]);

        res.status(200).json({
            success: true,
            totalItems,
            totalPages: Math.ceil(totalItems / parsedLimit),
            currentPage: parseInt(page),
            pageSize: parsedLimit,
            count: combos.length,
            data: combos
        });
    } catch (error) {
        logger.error('Error fetching combos:', { error: error.message });
        res.status(500).json({ success: false, message: 'Server error retrieving combos.' });
    }
};

// @desc    Get single combo menu by ID
// @route   GET /api/combos/:id
// @access  Public
exports.getComboById = async (req, res) => {
    try {
        const combo = await Combo.findOne({ _id: req.params.id, ...tenantFilter(req), ...comboBranchFilter(req) })
            .populate({
                path: 'categories.items',
                select: 'name price image isVeg vegType status'
            });

        if (!combo) {
            return res.status(404).json({ success: false, message: 'Combo not found' });
        }

        res.status(200).json({ success: true, data: combo });
    } catch (error) {
        logger.error('Error fetching combo by ID:', { error: error.message });
        res.status(500).json({ success: false, message: 'Server error retrieving combo.' });
    }
};

// @desc    Create a combo menu
// @route   POST /api/combos
// @access  Private/Admin
exports.createCombo = async (req, res) => {
    try {
        const { name, price, discount, discountType } = req.body;

        // Basic validation
        if (!name?.trim()) {
            return res.status(400).json({ success: false, message: 'Combo name is required' });
        }
        if (price == null || price < 0) {
            return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
        }
        if (discount != null && discount < 0) {
            return res.status(400).json({ success: false, message: 'Discount cannot be negative' });
        }
        if (discountType === 'Percentage' && discount > 100) {
            return res.status(400).json({ success: false, message: 'Percentage discount cannot exceed 100%' });
        }

        // Stamp with current tenant and branch (branch-pinned admin
        // creates at their own branch; tenant owner may pass body.branch
        // explicitly or leave it null for tenant-level / Main).
        const pinned = pinnedBranchId(req);
        let ownerBranch = pinned || req.body.branch || null;
        if (!pinned && ownerBranch) {
            if (!mongoose.isValidObjectId(ownerBranch)
                || !(await Branch.exists({ _id: ownerBranch, ...tenantFilter(req), isActive: true }))) {
                return res.status(400).json({ success: false, message: 'Branch not found or not part of your restaurant' });
            }
        }
        const resolved = await resolveComboCategories(req, req.body.categories);
        if (!resolved.ok) {
            return res.status(400).json({ success: false, message: resolved.message });
        }
        const fields = pickComboFields(req.body);
        if (resolved.categories !== undefined) fields.categories = resolved.categories;
        const combo = await Combo.create({
            ...fields,
            restaurant: tenantId(req),
            branch: ownerBranch,
        });

        res.status(201).json({
            success: true,
            data: combo,
            message: 'Combo Menu created successfully'
        });
    } catch (error) {
        logger.error('Error creating combo:', { error: error.message });
        res.status(400).json({ success: false, message: error.message || 'Failed to create combo' });
    }
};

// @desc    Update a combo menu
// @route   PUT /api/combos/:id
// @access  Private/Admin
exports.updateCombo = async (req, res) => {
    try {
        // Allowlisted fields only — never re-tenant the doc or write
        // counters; a pinned admin cannot re-assign the branch.
        const updateData = pickComboFields(req.body);
        if (!pinnedBranchId(req) && Object.prototype.hasOwnProperty.call(req.body, 'branch')) {
            const b = req.body.branch || null;
            if (b && (!mongoose.isValidObjectId(b)
                || !(await Branch.exists({ _id: b, ...tenantFilter(req), isActive: true })))) {
                return res.status(400).json({ success: false, message: 'Branch not found or not part of your restaurant' });
            }
            updateData.branch = b;
        }
        const resolved = await resolveComboCategories(req, req.body.categories);
        if (!resolved.ok) {
            return res.status(400).json({ success: false, message: resolved.message });
        }
        if (resolved.categories !== undefined) updateData.categories = resolved.categories;

        const scope = { _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) };

        // Recalculate savings since findByIdAndUpdate skips pre-save hooks
        if (updateData.originalPrice !== undefined || updateData.price !== undefined) {
            const existing = await Combo.findOne(scope).lean();
            if (existing) {
                const origPrice = updateData.originalPrice ?? existing.originalPrice ?? 0;
                const comboPrice = updateData.price ?? existing.price ?? 0;
                updateData.savings = Math.max(0, origPrice - comboPrice);
            }
        }

        const combo = await Combo.findOneAndUpdate(scope, updateData, {
            returnDocument: 'after',
            runValidators: true
        });

        if (!combo) {
            return res.status(404).json({ success: false, message: 'Combo not found' });
        }

        res.status(200).json({
            success: true,
            data: combo,
            message: 'Combo Menu updated successfully'
        });
    } catch (error) {
        logger.error('Error updating combo:', { error: error.message });
        res.status(400).json({ success: false, message: error.message || 'Failed to update combo' });
    }
};

// @desc    Delete combo menu
// @route   DELETE /api/combos/:id
// @access  Private/Admin
exports.deleteCombo = async (req, res) => {
    try {
        const combo = await Combo.findOneAndDelete({ _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) });

        if (!combo) {
            return res.status(404).json({ success: false, message: 'Combo not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Combo Menu deleted successfully'
        });
    } catch (error) {
        logger.error('Error deleting combo:', { error: error.message });
        res.status(500).json({ success: false, message: 'Failed to delete combo' });
    }
};

// @desc    Download the master CSV template for combo bulk import.
// @route   GET /api/combos/template
// @access  Private/Admin
//
// Serves the curated CSV from Backend/data/. The `categories` cell
// uses the format "CategoryName=item1|item2||AnotherCat=item3|item4"
// where item names must resolve to existing MenuItem docs for the
// caller's (tenant, branch) scope — importCombosCsv looks them up
// and stamps menuItemId plus a denormalized name/price/isVeg.
exports.downloadComboTemplate = (req, res) => {
    try {
        if (!fs.existsSync(COMBO_TEMPLATE_PATH)) {
            logger.error('Combo template missing on disk', { path: COMBO_TEMPLATE_PATH });
            return res.status(500).json({ success: false, message: 'Starter template not available' });
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="combo-master-template.csv"');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(COMBO_TEMPLATE_PATH).pipe(res);
    } catch (err) {
        logger.error('downloadComboTemplate error', { error: err.message });
        res.status(500).json({ success: false, message: 'Failed to serve template' });
    }
};

// @desc    Bulk-import combos from a CSV upload.
// @route   POST /api/combos/import
// @access  Private/Admin
//
// CSV columns (header row required, case-insensitive):
//   Required:  name, description, price, categories
//   Optional:  vegType, serveUpto, isSpecial, isHealthy,
//              originalPrice, discount, discountType,
//              unlimitedQuantity, taxApplicable, serviceCharge,
//              availableDays, startTime, endTime, status, images
//
// `categories` format: pipe-delimited items grouped by category, with
// groups separated by "||" and category-name + items separated by "=":
//   "Starters=Paneer Tikka|Hara Bhara Kebab||Main Course=Dal Makhani|Naan"
//
// Each item name is resolved against MenuItem.find({ name, restaurant,
// branch }). Items that can't be resolved are reported in `errors`
// for that row; the rest of the row's items still land. Rows with
// zero resolved items fail outright.
exports.importCombosCsv = async (req, res) => {
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
            name:              header.indexOf('name'),
            description:       header.indexOf('description'),
            price:             header.indexOf('price'),
            categories:        header.indexOf('categories'),
            vegType:           header.indexOf('vegtype'),
            serveUpto:         header.indexOf('serveupto'),
            isSpecial:         header.indexOf('isspecial'),
            isHealthy:         header.indexOf('ishealthy'),
            originalPrice:     header.indexOf('originalprice'),
            discount:          header.indexOf('discount'),
            discountType:      header.indexOf('discounttype'),
            unlimitedQuantity: header.indexOf('unlimitedquantity'),
            taxApplicable:     header.indexOf('taxapplicable'),
            serviceCharge:     header.indexOf('servicecharge'),
            availableDays:     header.indexOf('availabledays'),
            startTime:         header.indexOf('starttime'),
            endTime:           header.indexOf('endtime'),
            status:            header.indexOf('status'),
            images:            header.indexOf('images'),
        };
        const missing = ['name', 'description', 'price', 'categories']
            .filter(col => idx[col] === -1);
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `CSV missing required columns: ${missing.join(', ')}`,
            });
        }

        const restaurantId = tenantId(req);
        if (!restaurantId) {
            return res.status(400).json({ success: false, message: 'Tenant context required for bulk import' });
        }
        // Pin imported combos to the admin's active-view branch when
        // they have one selected; falls back to tenant-level (null)
        // only when neither pin nor an admin-chosen branch is present.
        // Same rationale as inventoryController.importItemsCsv — see
        // the long comment there.
        let branchId = pinnedBranchId(req);
        if (!branchId) {
            const rawBranchParam = req?.query?.branch || req?.body?.branch;
            if (rawBranchParam && mongoose.isValidObjectId(rawBranchParam)) {
                branchId = new mongoose.Types.ObjectId(String(rawBranchParam));
            } else if (req?.branch?._id) {
                branchId = req.branch._id;
            } else {
                branchId = null;
            }
        }

        // Helpers (mirrors Halls / Packages / Decorations conventions).
        const toBool = raw => /^(true|yes|y|1|on)$/i.test(String(raw || '').trim());
        const splitList = raw =>
            raw ? String(raw).split('|').map(s => s.trim()).filter(Boolean) : [];
        const toNum = raw => {
            if (raw === '' || raw == null) return undefined;
            const n = Number(raw);
            return Number.isFinite(n) && n >= 0 ? n : undefined;
        };

        // Cache MenuItem lookups so a 50-row CSV with overlapping items
        // doesn't do hundreds of round-trips. Key by lower-cased name;
        // value is the resolved MenuItem doc (or null when unresolved).
        const menuItemCache = new Map();
        const resolveMenuItem = async (rawName) => {
            const name = String(rawName || '').trim();
            if (!name) return null;
            const key = name.toLowerCase();
            if (menuItemCache.has(key)) return menuItemCache.get(key);
            const filter = {
                name: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
                restaurant: restaurantId,
            };
            if (branchId) filter.branch = branchId;
            const item = await MenuItem.findOne(filter).select('name basePrice finalPrice vegType').lean();
            menuItemCache.set(key, item);
            return item;
        };

        // Parse the `categories` cell into [{ name, items: [{...}] }].
        // Items that can't be resolved come back in `unresolved` so the
        // caller can surface them per row.
        const parseCategoriesCell = async (raw) => {
            const groups = String(raw || '').split('||').map(g => g.trim()).filter(Boolean);
            const built = [];
            const unresolved = [];
            for (const group of groups) {
                const eqIx = group.indexOf('=');
                const catName = eqIx >= 0 ? group.slice(0, eqIx).trim() : group.trim();
                const itemsRaw = eqIx >= 0 ? group.slice(eqIx + 1) : '';
                if (!catName) continue;
                const items = [];
                for (const itemName of splitList(itemsRaw)) {
                    const mi = await resolveMenuItem(itemName);
                    if (!mi) { unresolved.push(itemName); continue; }
                    items.push({
                        menuItemId: mi._id,
                        name:  mi.name,
                        price: mi.finalPrice != null ? mi.finalPrice : (mi.basePrice || 0),
                        isVeg: mi.vegType === 'veg',
                    });
                }
                if (items.length) built.push({ name: catName, items });
            }
            return { categories: built, unresolved };
        };

        const errors = [];
        const skipped = [];
        let created = 0;

        // Re-uploading a sheet must not duplicate combos: a row whose name
        // already exists at this branch is reported as skipped (same rule
        // as the menu / tables / halls importers).
        const existingNames = new Set(
            (await Combo.find({ restaurant: restaurantId, branch: branchId || null }).select('name').lean())
                .map((d) => String(d.name || '').trim().toLowerCase()),
        );

        for (let i = 1; i < rows.length; i++) {
            const rowNum = i + 1;
            const cells = rows[i];
            const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

            try {
                const name = get('name');
                const description = get('description');
                const priceRaw = get('price');
                const categoriesRaw = get('categories');

                if (!name)        throw new Error('name is required');
                if (existingNames.has(name.toLowerCase())) {
                    skipped.push({ row: rowNum, name, reason: `"${name}" already exists` });
                    continue;
                }
                existingNames.add(name.toLowerCase());
                if (!description) throw new Error('description is required');
                if (!categoriesRaw) throw new Error('categories cell is required');
                const price = Number(priceRaw);
                if (!Number.isFinite(price) || price < 0) {
                    throw new Error('price must be a non-negative number');
                }

                const vegTypeRaw = get('vegType').toLowerCase() || 'veg';
                if (!['veg', 'non-veg'].includes(vegTypeRaw)) {
                    throw new Error('vegType must be veg or non-veg (got ' + vegTypeRaw + ')');
                }

                const serveUptoRaw = get('serveUpto') || '2-3 person';
                const SERVE_UPTO_ENUM = ['1-2 person', '2-3 person', '3-4 person', '4-6 person', '6+ person'];
                if (!SERVE_UPTO_ENUM.includes(serveUptoRaw)) {
                    throw new Error('serveUpto must be one of: ' + SERVE_UPTO_ENUM.join(', '));
                }

                const discountTypeRaw = get('discountType') || 'Percentage';
                if (!['Percentage', 'Flat'].includes(discountTypeRaw)) {
                    throw new Error('discountType must be Percentage or Flat');
                }

                const statusRaw = (get('status') || 'active').toLowerCase();
                if (!['active', 'draft', 'archived'].includes(statusRaw)) {
                    throw new Error('status must be active|draft|archived');
                }

                const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const availableDays = splitList(get('availableDays'))
                    .map(d => {
                        const norm = d.charAt(0).toUpperCase() + d.slice(1, 3).toLowerCase();
                        return VALID_DAYS.includes(norm) ? norm : null;
                    })
                    .filter(Boolean);

                const { categories, unresolved } = await parseCategoriesCell(categoriesRaw);
                if (!categories.length) {
                    throw new Error('No menu items resolved for this combo' + (unresolved.length ? ' (unresolved: ' + unresolved.join(', ') + ')' : ''));
                }
                // Partial-resolve warning — items that couldn't be looked
                // up are reported but don't fail the row, so the combo
                // still lands with whatever items did resolve.
                if (unresolved.length) {
                    errors.push({ row: rowNum, message: 'Skipped unresolved items: ' + unresolved.join(', ') });
                }

                await Combo.create({
                    name,
                    description,
                    price,
                    categories,
                    vegType: vegTypeRaw,
                    serveUpto: serveUptoRaw,
                    isSpecial: toBool(get('isSpecial')),
                    isHealthy: toBool(get('isHealthy')),
                    originalPrice: toNum(get('originalPrice')) || 0,
                    discount: toNum(get('discount')) || 0,
                    discountType: discountTypeRaw,
                    unlimitedQuantity: get('unlimitedQuantity') === '' ? true : toBool(get('unlimitedQuantity')),
                    taxApplicable: toBool(get('taxApplicable')),
                    serviceCharge: toBool(get('serviceCharge')),
                    availableDays: availableDays.length ? availableDays : VALID_DAYS,
                    startTime: get('startTime') || '',
                    endTime: get('endTime') || '',
                    status: statusRaw,
                    // Same resolution as menu importer — trust real
                    // URLs from CSV but fall through to dishImagePicker
                    // when the row is missing or carries a known-dead
                    // placeholder source (picsum / source.unsplash).
                    images: (() => {
                        const raw = splitList(get('images'));
                        const usable = raw.filter(u => u && !isDeadImage(u));
                        return usable.length ? usable : [pickDishImage(name)];
                    })(),
                    restaurant: restaurantId,
                    branch: branchId,
                });
                created += 1;
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
        logger.error('Combo CSV import error:', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to import combos CSV' });
    }
};

