'use strict';
/** Request-scope helpers shared by the ledger / cash-closing / supplier-invoice controllers. */
const mongoose = require('mongoose');
const { pinnedBranchId, branchScopeClause } = require('./tenantScope');
const Branch = require('../models/branch');
const { tenantId } = require('./tenantScope');
const { refOwned } = require('./tenantRefs');
const AppError = require('./AppError');
const { DEFAULT_TZ, safeTz, isValidYmd, businessDateOf } = require('./businessDate');

/**
 * The branch a write belongs to: a pinned sub-admin's own branch, else an
 * explicit body/query branch, else the staff branch (req.branch), else null
 * (tenant-level / single outlet). ASYNC: an explicit body/query branch is
 * verified to belong to the tenant (400 INVALID_BRANCH otherwise).
 */
async function resolveBranchId(req) {
    const pinned = pinnedBranchId(req);
    if (pinned) return String(pinned._id || pinned);
    const raw = req?.body?.branch ?? req?.query?.branch;
    if (raw && raw !== 'all' && mongoose.isValidObjectId(raw)) {
        if (!(await refOwned(Branch, raw, tenantId(req)))) {
            throw new AppError(400, 'INVALID_BRANCH', 'Invalid branch');
        }
        return String(raw);
    }
    if (req?.branch?._id) return String(req.branch._id);
    return null;
}

/** Filter clause for the resolved branch; {} when tenant-level (whole tenant). */
function branchClauseFor(req, branchId) {
    return branchId ? branchScopeClause(req, branchId) : {};
}

const restaurantTz = (req) => safeTz(req?.restaurant?.timezone || DEFAULT_TZ);

/** `value` when it is a valid YYYY-MM-DD, else today's business date; null when `value` is given but invalid. */
function businessDateParam(req, value) {
    if (value === undefined || value === null || value === '') return businessDateOf(new Date(), restaurantTz(req));
    return isValidYmd(String(value)) ? String(value) : null;
}

/**
 * By-id access guard: a branch-pinned admin only reaches their own branch's records
 * (Main-branch pins also see legacy branch:null rows). {} for tenant-level callers, who
 * are not restricted to a branch.
 */
function pinnedBranchGuard(req) {
    const pinned = pinnedBranchId(req);
    return pinned ? branchScopeClause(req, pinned._id || pinned) : {};
}

module.exports = { pinnedBranchGuard, resolveBranchId, branchClauseFor, restaurantTz, businessDateParam };
