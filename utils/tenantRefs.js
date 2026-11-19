/**
 * Ownership checks for ids that arrive in a request body / query and are
 * stored as references (category, area, branch, tables, package, ...).
 *
 * The scope plugin scopes the QUERY, but it cannot tell that an id the
 * caller typed belongs to another tenant, so every controller that stores a
 * body-supplied id must verify it. Use these helpers instead of ad-hoc
 * `mongoose.isValidObjectId` checks.
 *
 *   if (!(await refOwned(Category, req.body.category, tenantId(req)))) {
 *       return res.status(400).json({ success: false, message: 'Invalid category' });
 *   }
 *
 * All helpers answer false (never throw) for a missing tenant, a malformed
 * id, an object/array id ({"$ne":null}) or a doc of another tenant.
 */
const mongoose = require('mongoose');

function toIdString(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return /^[a-f\d]{24}$/i.test(v) ? v : null;
    if (v instanceof mongoose.Types.ObjectId) return v.toString();
    return null; // objects, arrays, numbers: never accepted
}

/** True when `id` is a well-formed ObjectId string/ObjectId (no operators). */
function isPlainId(id) {
    return toIdString(id) !== null;
}

/** True when `id` names a doc of `Model` owned by `restaurantId`. */
async function refOwned(Model, id, restaurantId, extraFilter = {}) {
    const s = toIdString(id);
    if (!s || !restaurantId) return false;
    const found = await Model.exists({ ...extraFilter, _id: s, restaurant: restaurantId });
    return Boolean(found);
}

/** True when EVERY id in `ids` is owned (an empty array is true). Duplicates allowed. */
async function refsOwned(Model, ids, restaurantId, extraFilter = {}) {
    if (!Array.isArray(ids)) return false;
    if (!restaurantId) return false;
    const strs = [];
    for (const v of ids) {
        const s = toIdString(v);
        if (!s) return false;
        strs.push(s);
    }
    const unique = [...new Set(strs)];
    if (unique.length === 0) return true;
    const n = await Model.countDocuments({ ...extraFilter, _id: { $in: unique }, restaurant: restaurantId });
    return n === unique.length;
}

module.exports = { isPlainId, refOwned, refsOwned, toIdString };
