const mongoose = require('mongoose');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');
const Branch = require('../models/branch');

const { tenantFilter, tenantId, pinnedBranchId, strictBranchFilter } = require('../utils/tenantScope');
const { pickAllowed, CATEGORY_FIELDS } = require('../utils/bodyAllowlist');

/**
 * Phase 6 step 3 — validate an optional `branch` id against the
 * caller's tenant. Same behavior as the menu/table variants.
 */
async function resolveBranch(req, rawBranchId) {
    // Branch-pinned staff always write to their own branch — body.branch
    // is ignored so a Branch Admin can never create a tenant-level
    // category that leaks into other branches.
    const pinned = pinnedBranchId(req);
    if (pinned) return { ok: true, branchId: pinned };

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

// @desc    Get all categories
// @route   GET /api/categories?withCount=true  (withCount only needed for admin)
// @access  Public
exports.getCategories = async (req, res) => {
    try {
        const withCount = req.query.withCount === 'true';

        // For customer-facing calls, skip the itemCount virtual populate.
        // That virtual triggers one COUNT query per category (N+1).
        // Admin passes ?withCount=true explicitly.
        // Build filter — admin passes no filter (sees all); customer passes ?status=active
        const filter = { ...tenantFilter(req) };
        if (req.query.status) filter.status = req.query.status;
        // Kiosk-eligible filter — when the client asks `?kiosk=true`,
        // only categories with showOnKiosk:true (or the legacy default
        // — field absent) are returned. Admin/dine-in callers omit the
        // flag and see everything.
        if (req.query.kiosk === 'true') {
            filter.showOnKiosk = { $ne: false };
        }

        // Branch filter:
        //   pinned staff       → STRICT `{ branch: pinned }`. Tenant-level
        //                        (branch:null) and other-branch categories
        //                        are HIDDEN. Sharing across branches now
        //                        happens via "Copy from Main" at branch-
        //                        create time (initializeBranchCategories)
        //                        — the {name, restaurant, branch} unique
        //                        index lets each branch own its own copy.
        //   branch=<id>        → only that branch's categories
        //   branch=tenant-only → only shared (branch:null) categories
        //   branch=all         → no filter (tenant-owner view)
        //   branchScope=auto+id→ tenant-level PLUS the given branch (customer)
        //   (none of the above)→ fall back to req.branch (customer flow)
        const pinned = pinnedBranchId(req);
        if (pinned) {
            filter.branch = pinned;
        } else {
            const { branch, branchScope } = req.query;
            if (branchScope === 'auto' && mongoose.isValidObjectId(branch)) {
                filter.$or = [{ branch: null }, { branch }];
            } else if (branch === 'tenant-only' || branch === 'none') {
                filter.branch = null;
            } else if (branch && branch !== 'all' && mongoose.isValidObjectId(branch)) {
                filter.branch = branch;
            } else if (branch !== 'all' && req.branch?._id) {
                filter.$or = [{ branch: null }, { branch: req.branch._id }];
            }
        }

        let query = Category.find(filter).sort('displayOrder');
        if (withCount) {
            query = query.populate('itemCount');
            const categories = await query.lean({ virtuals: true });
            return res.status(200).json({ success: true, count: categories.length, data: categories });
        }

        const categories = await query.lean();

        // Categories change rarely — allow a generous browser cache
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
        res.status(200).json({
            success: true,
            count: categories.length,
            data: categories
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Get single category
// @route   GET /api/categories/:id
// @access  Public
exports.getCategory = async (req, res) => {
    try {
        const category = await Category.findOne({ _id: req.params.id, ...tenantFilter(req) }).populate('itemCount');
        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }
        res.status(200).json({ success: true, data: category });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Create new category
// @route   POST /api/categories
// @access  Private/Admin
exports.createCategory = async (req, res) => {
    try {
        // Phase 6 step 3 — validate optional branch before writing.
        const branchCheck = await resolveBranch(req, req.body.branch);
        if (!branchCheck.ok) {
            return res.status(400).json({ success: false, message: branchCheck.message });
        }
        const category = await Category.create({
            ...pickAllowed(req.body, CATEGORY_FIELDS),
            restaurant: tenantId(req),
            branch: branchCheck.branchId,
        });
        res.status(201).json({ success: true, data: category });
    } catch (error) {
        if (error.code === 11000) {
            // The existing {name, restaurant} unique index means two
            // branches can't (yet) share the same category name. Give
            // the user a helpful message until we migrate the index.
            return res.status(400).json({
                success: false,
                message: 'A category with this name already exists in your restaurant. If you need branch-specific categories with the same name, contact support.',
            });
        }
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private/Admin
exports.updateCategory = async (req, res) => {
    try {
        // Explicit allowlist — restaurant, timestamps and any Mongo
        // update operator in the body are dropped.
        const updateData = pickAllowed(req.body, CATEGORY_FIELDS);

        // Phase 6 step 3 — validate `branch` if it's in the body.
        // Absent key = don't touch existing assignment.
        if (Object.prototype.hasOwnProperty.call(updateData, 'branch')) {
            const branchCheck = await resolveBranch(req, updateData.branch);
            if (!branchCheck.ok) {
                return res.status(400).json({ success: false, message: branchCheck.message });
            }
            updateData.branch = branchCheck.branchId;
        }

        const category = await Category.findOneAndUpdate(
            { _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) },
            updateData,
            { returnDocument: 'after', runValidators: true }
        );

        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        res.status(200).json({ success: true, data: category });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Delete category (pass ?force=true to also delete all items in it)
// @route   DELETE /api/categories/:id
// @access  Private/Admin
exports.deleteCategory = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = strictBranchFilter(req);
        const itemCount = await MenuItem.countDocuments({ category: req.params.id, ...tf, ...bf });
        const forceDelete = req.query.force === 'true';

        if (itemCount > 0 && !forceDelete) {
            return res.status(409).json({
                success: false,
                itemCount,
                message: `This category has ${itemCount} menu item${itemCount > 1 ? 's' : ''}. Delete the category and all its items?`
            });
        }

        // Cascade: remove all menu items in this category (scoped to tenant + branch)
        if (itemCount > 0 && forceDelete) {
            await MenuItem.deleteMany({ category: req.params.id, ...tf, ...bf });
        }

        const category = await Category.findOneAndDelete({ _id: req.params.id, ...tf, ...bf });

        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        res.status(200).json({
            success: true,
            message: forceDelete && itemCount > 0
                ? `Category and ${itemCount} item${itemCount > 1 ? 's' : ''} deleted`
                : 'Category deleted'
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Update categories order
// @route   PUT /api/categories/reorder
// @access  Private/Admin
exports.reorderCategories = async (req, res) => {
    try {
        const { categories } = req.body;

        // Validate input structure
        if (!Array.isArray(categories) || categories.length === 0) {
            return res.status(400).json({ success: false, message: 'categories must be a non-empty array' });
        }

        const mongoose = require('mongoose');
        for (const cat of categories) {
            if (!cat.id || !mongoose.Types.ObjectId.isValid(cat.id)) {
                return res.status(400).json({ success: false, message: `Invalid category id: ${cat.id}` });
            }
            if (typeof cat.displayOrder !== 'number' || cat.displayOrder < 0) {
                return res.status(400).json({ success: false, message: `Invalid displayOrder for category ${cat.id}` });
            }
        }

        const tf = tenantFilter(req);
        const updatePromises = categories.map(cat =>
            Category.findOneAndUpdate({ _id: cat.id, ...tf }, { displayOrder: cat.displayOrder })
        );

        await Promise.all(updatePromises);

        res.status(200).json({ success: true, message: 'Categories reordered' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
