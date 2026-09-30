// Helpers for honouring per-staff area / table assignments when routing
// real-time notifications. The data model (Backend/models/user.js):
//
//   user.assignedAreas  : [Area]   // waiter & captain
//   user.assignedTables : [Table]  // waiter only (captain covers areas)
//
// Empty arrays mean "no filter" — that staff member should receive every
// event for their branch (legacy behaviour). A non-empty array switches
// the staff to filtered mode: they only get events that match.

const User = require('../models/user');

/**
 * Find the (active) waiters at a tenant/branch who should be notified
 * about an event at a specific table.
 *
 * Matching rules per waiter:
 *   1. If `assignedTables` is non-empty:
 *        - Notify ONLY when the tableId appears in that list.
 *   2. Else if `assignedAreas` is non-empty:
 *        - Notify ONLY when the table's area appears in that list.
 *   3. Else (both arrays empty):
 *        - Notify (legacy — receive every table in the branch).
 *
 * `branch=null` matches waiters at the same null branch (single-tenant
 * setups + the tenant-owner bucket). Callers should pass the table's
 * branch verbatim.
 *
 * Returns an array of plain `_id` strings (no full docs) so the caller
 * can iterate quickly when emitting per-user socket events.
 */
exports.findWaitersForTable = async function findWaitersForTable({
    restaurant,
    branch,
    tableId,
    tableAreaId,
}) {
    if (!restaurant) return [];

    const filter = {
        restaurant,
        role: 'waiter',
        status: 'active',
        branch: branch || null,
    };

    // Match in the DB layer so we don't fetch the whole waiter roster.
    // The $or below codifies the three rules in the docblock above:
    //   - waiter has no assignments at all                  → match
    //   - waiter's assignedTables contains this table       → match
    //   - waiter's assignedAreas contains this table's area → match
    const conditions = [
        {
            // Empty / missing assignedAreas AND empty / missing
            // assignedTables → catch-all waiter.
            $and: [
                { $or: [{ assignedAreas: { $size: 0 } }, { assignedAreas: { $exists: false } }] },
                { $or: [{ assignedTables: { $size: 0 } }, { assignedTables: { $exists: false } }] },
            ],
        },
    ];
    if (tableId) conditions.push({ assignedTables: tableId });
    if (tableAreaId) conditions.push({ assignedAreas: tableAreaId });

    filter.$or = conditions;

    const docs = await User.find(filter).select('_id').lean();
    return docs.map(d => String(d._id));
};

/**
 * Same as findWaitersForTable but for captains. Captains only honour
 * the area-level assignment — `assignedTables` is ignored even if set.
 */
exports.findCaptainsForTable = async function findCaptainsForTable({
    restaurant,
    branch,
    tableAreaId,
}) {
    if (!restaurant) return [];

    const filter = {
        restaurant,
        role: 'captain',
        status: 'active',
        branch: branch || null,
    };

    const conditions = [
        { $or: [{ assignedAreas: { $size: 0 } }, { assignedAreas: { $exists: false } }] },
    ];
    if (tableAreaId) conditions.push({ assignedAreas: tableAreaId });

    filter.$or = conditions;

    const docs = await User.find(filter).select('_id').lean();
    return docs.map(d => String(d._id));
};
