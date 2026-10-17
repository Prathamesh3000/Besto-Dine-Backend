const mongoose = require('mongoose');
const Area = require('../models/area');
const Branch = require('../models/branch');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId, branchScopeClause } = require('../utils/tenantScope');
const listCache = require('../utils/listCache');
const { devError } = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Branch filter for areas, mirroring the MenuItem pattern:
 *   branch: null → tenant-level / shared across all branches (legacy
 *                  seed data lives here)
 *   branch: <id> → physically owned by that branch
 *
 * Customers / branch-pinned admins see "shared + their branch". Without
 * this, a customer at a branch with X-Branch-Id set would query
 * { branch: <id> } and miss every tenant-level area, which is why
 * the Select Booking Type page came back empty even though seeded
 * areas exist in the DB.
 *
 * Tenant owners with no pin and no header keep the unscoped read.
 */
function areaBranchFilter(req) {
    // Branch-pinned staff (Branch Admin) see ONLY their own branch's
    // areas. Tenant-level (branch:null) and other branches' areas are
    // hidden — they only appear if explicitly copied at branch-create
    // time via the "Copy from Main" sync.
    //
    // Tenant owner picking ?branch=<id> in the admin switcher also gets
    // STRICT scope — no null fallback — so flipping to "Main" doesn't
    // show every legacy tenant-null area. Customer flow (req.branch
    // header) keeps the permissive shared+branch view.
    // Exception: branch:null areas belong to the Main branch, so a Main
    // view includes them (utils/tenantScope.branchScopeClause).
    const pinned = pinnedBranchId(req);
    if (pinned) {
        return branchScopeClause(req, pinned._id || pinned);
    }
    const raw = req?.query?.branch;
    if (raw === 'all') return null;
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) {
        return branchScopeClause(req, raw);
    }
    if (req?.branch?._id) {
        return { $or: [{ branch: null }, { branch: req.branch._id }] };
    }
    return null;
}

// Create a new area
const createArea = asyncHandler(async (req, res) => {
    const { name, note, description } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Area name is required' });
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
        return res.status(400).json({ success: false, message: 'Note must be text' });
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
        return res.status(400).json({ success: false, message: 'Description must be text' });
    }
    if (typeof description === 'string' && description.trim().length > 300) {
        return res.status(400).json({ success: false, message: 'Description cannot exceed 300 characters' });
    }

    // Sub Admin owns the area at their branch; tenant owner creates
    // branch-less (null) areas unless body.branch is explicitly set.
    const ownerBranch = pinnedBranchId(req) || req.body.branch || null;
    if (!pinnedBranchId(req) && ownerBranch) {
        if (!mongoose.isValidObjectId(ownerBranch)
            || !(await Branch.exists({ _id: ownerBranch, ...tenantFilter(req), isActive: true }))) {
            return res.status(400).json({ success: false, message: 'Branch not found or not part of your restaurant' });
        }
    }

    // Uniqueness check is per tenant + branch: Branch A and Branch B
    // can both have an area called "Rooftop".
    const existingArea = await Area.findOne({
        name: name.trim(),
        ...tenantFilter(req),
        branch: ownerBranch,
    });
    if (existingArea) {
        return res.status(400).json({ success: false, message: 'Area with this name already exists' });
    }

    const area = new Area({
        name: name.trim(),
        note: note ? note.trim() : '',
        description: description ? description.trim() : '',
        restaurant: tenantId(req),
        branch: ownerBranch,
    });

    await area.save();
    // Every branch scope of this tenant: the owner's POST has no ?branch,
    // so invalidate(req) left the Main view's cached list stale.
    areasCache.invalidateTenant(tenantId(req));
    res.status(201).json({ success: true, message: 'Area created successfully', area });
}, 'Error creating area');

// Per-(tenant, branch) cache. Areas mutate rarely (admin clicks "Add
// Area" or toggles a row off) and are read on every TablesDashboard
// paint, every kitchen-room join, every customer scan — so a 60s cache
// turns every-page-paint Mongo hits into ~once-a-minute. Writes call
// `areasCache.invalidateTenant(...)` to wipe every branch scope of the tenant.
const areasCache = listCache.create({
    name: 'areas',
    ttlMs: 60_000,
    loader: (req) => {
        const filter = { ...tenantFilter(req) };
        const branchClause = areaBranchFilter(req);
        if (branchClause) Object.assign(filter, branchClause);
        return Area.find(filter).sort({ createdAt: -1 }).lean();
    },
});

// Get all areas — Sub Admin sees their branch + tenant-shared areas;
// tenant owner sees everything (or narrows via ?branch=<id>); customers
// at a branch see "shared + their branch".
const getAreas = asyncHandler(async (req, res) => {
    const areas = await areasCache.get(req);
    // Customer / guest reads (every table scan) get a 60s browser cache
    // on top of the server cache. Staff must NOT: the admin refetches
    // this list right after "Add area" and the browser replayed the
    // previous (empty) response from disk for up to a minute. The
    // global /api `no-store` applies to them.
    const isStaff = !!(req.user && req.user.role !== 'customer');
    if (!isStaff) res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
    res.status(200).json({ success: true, areas });
}, 'Error fetching areas');

// Update an area (for name, note or isActive toggle)
const updateArea = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, note, isActive, description } = req.body || {};
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return res.status(400).json({ success: false, message: 'Area name is required' });
    }
    if (note !== undefined && typeof note !== 'string') {
        return res.status(400).json({ success: false, message: 'Note must be text' });
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
        return res.status(400).json({ success: false, message: 'Description must be text' });
    }
    if (typeof description === 'string' && description.trim().length > 300) {
        return res.status(400).json({ success: false, message: 'Description cannot exceed 300 characters' });
    }

    const area = await Area.findOne({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
    if (!area) {
        return res.status(404).json({ success: false, message: 'Area not found' });
    }

    if (name !== undefined) area.name = name.trim();
    if (note !== undefined) area.note = note.trim();
    if (description !== undefined) area.description = (description || '').trim();
    if (isActive !== undefined) area.isActive = isActive;

    await area.save();
    // Every branch scope of this tenant: the owner's POST has no ?branch,
    // so invalidate(req) left the Main view's cached list stale.
    areasCache.invalidateTenant(tenantId(req));
    res.status(200).json({ success: true, message: 'Area updated successfully', area });
}, 'Error updating area');

// Delete an area — cascade-deletes every table inside it as long as no
// table is in an unsafe state. We refuse the whole operation (rather than
// half-deleting) if any table has an active order, an open reservation,
// or is part of a merge group, because:
//   - active orders: the customer is mid-meal; their bill would orphan
//   - reservations: a confirmed seating would silently vanish
//   - merge groups: leader/sibling refs across the group break
// The error message names the offending tables so the owner knows what
// to resolve before retrying.
const deleteArea = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tf = tenantFilter(req);
    const bf = strictBranchFilter(req);

    const Table = require('../models/table');
    const Order = require('../models/order');
    const Reservation = require('../models/reservation');

    // Confirm the area exists in the caller's scope before doing any
    // destructive work. Without this an attacker could enumerate
    // foreign tenants' area ids by 200 vs 404 timing differences.
    const area = await Area.findOne({ _id: id, ...tf, ...bf });
    if (!area) {
        return res.status(404).json({ success: false, message: 'Area not found' });
    }

    // Pull every table in this area (tenant + branch scoped) so we can
    // both safety-check them and cascade-delete in one batch below.
    const tables = await Table.find({ area: id, ...tf, ...bf }).select('_id name status').lean();
    const tableIds = tables.map(t => t._id);

    if (tableIds.length > 0) {
        // ── Block on tables that can't be safely deleted ────────────
        // Active reservation = future seating that would silently vanish
        // if we cascade. The set mirrors deleteTable's check.
        const activeRes = await Reservation.find({
            table: { $in: tableIds },
            status: { $in: ['Pending', 'Approved', 'Confirmed', 'Seated'] },
            ...tf,
        }).select('table').lean();

        // Active order = customer is mid-meal. 'served' and 'cancelled'
        // are terminal; anything else (new/preparing/ready) is live.
        const activeOrders = await Order.find({
            table: { $in: tableIds },
            status: { $nin: ['served', 'cancelled'] },
            ...tf,
        }).select('table').lean();

        // Merge group = leader/sibling refs would dangle if we deleted
        // a participant. Catches both ends: a table physically marked
        // 'merged' AND a table whose _id appears in another table's
        // mergedWith list.
        const mergedTables = tables.filter(t => t.status === 'merged');
        const mergeRefs = await Table.find({
            mergedWith: { $in: tableIds },
            ...tf,
        }).select('_id').lean();

        const blockedIds = new Set([
            ...activeRes.map(r => String(r.table)),
            ...activeOrders.map(o => String(o.table)),
            ...mergedTables.map(t => String(t._id)),
            ...mergeRefs.map(t => String(t._id)),
        ]);

        if (blockedIds.size > 0) {
            const blockedNames = tables
                .filter(t => blockedIds.has(String(t._id)))
                .map(t => t.name);
            return res.status(400).json({
                success: false,
                code: 'AREA_HAS_ACTIVE_TABLES',
                message: `Cannot delete area: ${blockedIds.size} table${blockedIds.size === 1 ? ' has' : 's have'} active orders, reservations, or are merged (${blockedNames.slice(0, 5).join(', ')}${blockedNames.length > 5 ? '…' : ''}). Resolve them first.`,
                blockedTables: blockedNames,
            });
        }

        // All-clear — cascade-delete every table in the area. Use
        // deleteMany on the same scoped filter so a concurrent admin
        // can't sneak a new table into the area between the safety
        // check and the delete (the scoped query would still pick it
        // up, and a fresh table can't be in an unsafe state anyway).
        await Table.deleteMany({ area: id, ...tf, ...bf });
    }

    await Area.deleteOne({ _id: id, ...tf, ...bf });

    // Every branch scope of this tenant: the owner's POST has no ?branch,
    // so invalidate(req) left the Main view's cached list stale.
    areasCache.invalidateTenant(tenantId(req));
    res.status(200).json({
        success: true,
        message: tableIds.length
            ? `Area deleted along with ${tableIds.length} table${tableIds.length === 1 ? '' : 's'}`
            : 'Area deleted successfully',
        deletedTables: tableIds.length,
    });
}, 'Error deleting area');

module.exports = {
    createArea,
    getAreas,
    updateArea,
    deleteArea
};
