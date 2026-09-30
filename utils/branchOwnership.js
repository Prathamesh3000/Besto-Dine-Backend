/**
 * resolveOwnedBranch — validate a client-supplied `branch` id for a write.
 *
 *   - Branch-pinned callers (Branch Admin / pinned staff) ALWAYS write to
 *     their own branch: a body value that names a different branch is
 *     refused (403 BRANCH_MISMATCH); a matching / empty value resolves to
 *     the pin.
 *   - Tenant-level callers: null / undefined / '' → `{ branchId: null }`
 *     (callers decide the default, e.g. Main branch). Anything else must
 *     be a valid ObjectId of a branch in the caller's tenant.
 *
 * Returns `{ ok: true, branchId }` or `{ ok: false, status, code?, message }`.
 */
const mongoose = require('mongoose');
const Branch = require('../models/branch');
const { tenantFilter, pinnedBranchId } = require('./tenantScope');

const isBlank = (v) => v === null || v === undefined || v === '';

async function resolveOwnedBranch(req, rawBranchId) {
    const pinned = pinnedBranchId(req);
    if (pinned) {
        const pinnedId = String(pinned._id || pinned);
        if (!isBlank(rawBranchId) && String(rawBranchId) !== pinnedId) {
            return {
                ok: false,
                status: 403,
                code: 'BRANCH_MISMATCH',
                message: 'You can only create or edit records for your own branch.',
            };
        }
        return { ok: true, branchId: pinned };
    }

    if (isBlank(rawBranchId)) return { ok: true, branchId: null };
    if (!mongoose.isValidObjectId(rawBranchId)) {
        return { ok: false, status: 400, message: 'Invalid branch id' };
    }
    const exists = await Branch.exists({ _id: rawBranchId, ...tenantFilter(req) });
    if (!exists) {
        return { ok: false, status: 400, message: 'Branch not found or not part of your restaurant' };
    }
    return { ok: true, branchId: rawBranchId };
}

module.exports = { resolveOwnedBranch };
