// Shared request validation on top of express-validator (BUGS_REPORT #33).
//
//   const { validate, body, param, query, objectIdParam, optionalObjectId } = require('../middlewares/validate');
//
//   router.put('/:id', protect, validate([
//       objectIdParam('id'),
//       body('name').optional().isString().isLength({ max: 100 }),
//       body('capacity').optional().isInt({ min: 1, max: 1000 }).withMessage('Capacity must be 1–1000'),
//       optionalObjectId('body', 'branch'),
//   ]), controller.update);
//
// On failure responds 400:
//   { success: false, message: '<first error>', errors: [{ field, message }] }
// (one entry per field — the first failing rule). On success calls next()
// and leaves req untouched: no sanitizers run unless a chain adds them, so
// controllers keep seeing exactly what the frontend sent.
//
// Keep chains permissive — mirror what the controller already accepts.
// They exist to reject wrong TYPES / malformed ids / absurd ranges before
// they reach Mongoose (CastErrors → 500s, regex DoS, huge strings), not
// to re-implement business rules.
const { body, param, query, check, validationResult } = require('express-validator');

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** true for a 24-hex string, an ObjectId, or a populated doc with a valid _id. */
function isObjectIdLike(v) {
    if (v == null) return false;
    if (typeof v === 'string') return OBJECT_ID_RE.test(v);
    if (typeof v === 'object') {
        if (v._id && v._id !== v) return isObjectIdLike(v._id);
        if (typeof v.toHexString === 'function') return OBJECT_ID_RE.test(v.toHexString());
    }
    return false;
}

function locationFn(location) {
    switch (location) {
        case 'body': return body;
        case 'query': return query;
        case 'param':
        case 'params': return param;
        default: return check;
    }
}

/** Required ObjectId route param (default `:id`). */
function objectIdParam(name = 'id', message) {
    return param(name).custom(isObjectIdLike).withMessage(message || `Invalid ${name}`);
}

/** Required ObjectId in body/query. */
function requiredObjectId(location, field, message) {
    return locationFn(location)(field)
        .exists({ values: 'falsy' }).withMessage(message || `${field} is required`).bail()
        .custom(isObjectIdLike).withMessage(message || `Invalid ${field}`);
}

/**
 * Optional ObjectId: undefined / null / '' pass (and 'all' in query strings,
 * the branch-picker convention); anything else must be a valid id.
 */
function optionalObjectId(location, field, message) {
    return locationFn(location)(field)
        .optional({ values: 'falsy' })
        .custom((v) => (location === 'query' && v === 'all') || isObjectIdLike(v))
        .withMessage(message || `Invalid ${field}`);
}

/** Optional array of ObjectIds. */
function optionalObjectIdArray(location, field, message) {
    return locationFn(location)(field)
        .optional({ values: 'null' })
        .custom((v) => Array.isArray(v) && v.every(isObjectIdLike))
        .withMessage(message || `${field} must be a list of valid ids`);
}

/** Terminal middleware: turn collected errors into the standard 400 body. */
function handleValidation(req, res, next) {
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    const seen = new Set();
    const errors = [];
    for (const e of result.array()) {
        const field = e.path || e.param || (e.type === 'alternative' ? 'request' : 'field');
        if (seen.has(field)) continue;
        seen.add(field);
        errors.push({ field, message: String(e.msg || 'Invalid value') });
    }
    return res.status(400).json({
        success: false,
        message: errors[0]?.message || 'Validation failed',
        errors,
    });
}

/**
 * validate([chains...]) → [...chains, handleValidation] — mount as one
 * route middleware (Express flattens arrays).
 */
function validate(chains) {
    const list = Array.isArray(chains) ? chains : [chains];
    return [...list, handleValidation];
}

module.exports = {
    validate,
    handleValidation,
    isObjectIdLike,
    objectIdParam,
    requiredObjectId,
    optionalObjectId,
    optionalObjectIdArray,
    body,
    param,
    query,
    check,
};
