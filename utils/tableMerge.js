// Helpers for the "merged tables share one order" semantic.
//
// A merge group is a set of physical tables that the waiter/admin has
// stuck together for a big party. Business rules enforced here:
//
//   1. One ORDER across the whole group. Whichever table holds the live
//      order is the "leader". Customer scans / staff creates on any
//      sibling table route writes to the leader's tableId.
//   2. Paying the leader's order auto-unmerges the group and frees every
//      table back to 'free'.
//   3. KOT tickets show the full group name so the kitchen knows the
//      food goes to "Table 5+6+7", not just the leader table.
//
// The Table schema has no explicit leader column — the leader is derived
// at read time. A table already holding an `activeOrder` wins; if none do
// (merge happened while all were free), the caller's own table becomes
// the leader (which will then get the order on the next create).

const Table = require('../models/table');
const Request = require('../models/request');
const logger = require('./logger');

// Return an array of all table IDs in the group: self + mergedWith.
// Accepts a populated table doc OR a plain object.
function mergeGroupIdsOf(table) {
    if (!table) return [];
    const self = table._id || table.id;
    const siblings = Array.isArray(table.mergedWith) ? table.mergedWith : [];
    return [self, ...siblings];
}

// Given any tableId, return the merge-leader's Table doc.
// - If the table isn't merged, returns the table itself.
// - If merged, returns whichever group member currently holds an
//   activeOrder; falls back to the originally-requested table when the
//   group is merged but nobody has an order yet.
async function resolveMergeLeader(tableId, tenantFilterObj = {}) {
    const table = await Table.findOne({ _id: tableId, ...tenantFilterObj }).lean();
    if (!table) return null;

    const isMerged = table.status === 'merged' || (Array.isArray(table.mergedWith) && table.mergedWith.length > 0);
    if (!isMerged) return table;

    const groupIds = mergeGroupIdsOf(table);
    const withOrder = await Table.findOne({
        _id: { $in: groupIds },
        activeOrder: { $ne: null },
        ...tenantFilterObj,
    }).lean();
    return withOrder || table;
}

// Fetch the full list of table names in the merge group, sorted by name,
// so KOT tickets can render "Table 5, 6, 7". Returns an empty array if
// the table isn't merged.
async function getMergeGroupNames(tableId, tenantFilterObj = {}) {
    const table = await Table.findOne({ _id: tableId, ...tenantFilterObj })
        .select('name mergedWith status')
        .lean();
    if (!table) return [];
    const isMerged = table.status === 'merged' || (Array.isArray(table.mergedWith) && table.mergedWith.length > 0);
    if (!isMerged) return [];
    const ids = mergeGroupIdsOf(table);
    const group = await Table.find({ _id: { $in: ids }, ...tenantFilterObj })
        .select('name')
        .lean();
    return group.map(t => t.name).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

// Free a table — and if it's the member of a merge group, unmerge and
// free every sibling in one shot. Clears mergedWith / activeOrder on all
// members so the next customer gets a clean table. Returns the list of
// freed table IDs so callers can emit a single `table:updated` socket
// event covering the whole group.
async function freeTableOrUnmergeGroup(tableId, tenantFilterObj = {}) {
    const table = await Table.findOne({ _id: tableId, ...tenantFilterObj })
        .select('mergedWith status branch restaurant')
        .lean();
    if (!table) return { freedIds: [], branch: null };

    const isMerged = table.status === 'merged' || (Array.isArray(table.mergedWith) && table.mergedWith.length > 0);
    const groupIds = isMerged ? mergeGroupIdsOf(table) : [table._id];

    await Table.updateMany(
        { _id: { $in: groupIds }, ...tenantFilterObj },
        {
            $set: {
                status: 'free',
                mergedWith: [],
                activeOrder: null,
                // Wipe the diner snapshot so the next guest who scans
                // this table doesn't see / leak the previous diner's name
                // in the admin drawer.
                currentDiner: { user: null, name: '', phone: '', isRegistered: false, claimedAt: null },
            },
        }
    );

    // Soft-close any service requests (Water / Call Waiter / Bill /
    // Other) still tied to these tables. Without this, the admin
    // dashboard's Customer Requests card carries stale "9893 min ago"
    // entries for tables that left long ago — the table goes 'free' but
    // the Request docs stayed pending/accepted because nothing in the
    // free path touched them. Completing them instead of deleting
    // preserves the audit trail (who asked, who attended, when).
    let cleanedRequestsCount = 0;
    try {
        const now = new Date();
        const r = await Request.updateMany(
            {
                table: { $in: groupIds },
                status: { $in: ['pending', 'accepted'] },
                ...tenantFilterObj,
            },
            { $set: { status: 'completed', completedAt: now } }
        );
        cleanedRequestsCount = r.modifiedCount || 0;
    } catch (err) {
        // Non-fatal — the table is freed regardless. Log so we can
        // diagnose stuck request rows in production.
        logger.warn('freeTableOrUnmergeGroup: request soft-close failed: ' + err.message);
    }

    // Tell connected admin clients that requests for this branch just
    // changed so the dashboard's Customer Requests card re-fetches via
    // the React-Query invalidator wired to `request:updated`. Only emit
    // if we actually closed something — avoids needless refetches on
    // tables that had no outstanding requests.
    if (cleanedRequestsCount > 0) {
        try {
            const { getIO, emitToAdmin } = require('./socket');
            const io = getIO();
            emitToAdmin(io, table.branch, 'request:updated', {
                reason: 'table-freed',
                tableIds: groupIds.map(id => id.toString()),
                // Tenant hint — this runs from background sweepers too.
                restaurant: table.restaurant ? String(table.restaurant) : undefined,
            });
        } catch (err) {
            logger.warn('freeTableOrUnmergeGroup: socket emit failed: ' + err.message);
        }
    }

    return { freedIds: groupIds, branch: table.branch || null };
}

module.exports = {
    resolveMergeLeader,
    mergeGroupIdsOf,
    getMergeGroupNames,
    freeTableOrUnmergeGroup,
};
