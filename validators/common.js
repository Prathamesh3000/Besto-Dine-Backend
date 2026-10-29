// Reusable express-validator building blocks for the route validators in
// this folder (plan task 3A.2). Same philosophy as middlewares/validate.js:
// strict on TYPE and RANGE, permissive on missing fields (the controllers
// own the "X is required" messages the UIs toast) and on unknown keys.
const { body, query } = require('../middlewares/validate');

const OID = /^[a-f0-9]{24}$/i;
const loc = (location) => (location === 'query' ? query : body);

/** A finite number, or a numeric string (forms post strings). */
const isNumeric = (v) => {
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v));
    return false;
};

/**
 * Optional money / quantity: undefined and null pass, '' passes (an empty
 * form field), anything else must be numeric within [min, max].
 * Pass { gt: 0 } for strictly-positive amounts.
 */
function optionalAmount(field, { min = 0, gt, max = 10000000, location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .custom((v) => {
            if (v === '') return true;
            if (!isNumeric(v)) return false;
            const n = Number(v);
            if (gt !== undefined ? !(n > gt) : n < min) return false;
            return n <= max;
        })
        .withMessage(gt !== undefined
            ? `${name} must be a number greater than ${gt}`
            : `${name} must be a number between ${min} and ${max}`);
}

/** Optional free text: a string up to `max` characters. */
function optionalText(field, max = 500, { location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .isString().withMessage(`${name} must be text`).bail()
        .isLength({ max }).withMessage(`${name} is too long (max ${max} characters)`);
}

/** Optional string restricted to a list (case-sensitive, as controllers compare). */
function optionalEnum(field, allowed, { location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .custom((v) => typeof v === 'string' && allowed.includes(v))
        .withMessage(`${name} must be one of: ${allowed.join(', ')}`);
}

/** Optional boolean (true/false or the strings 'true'/'false'). */
function optionalBool(field, { location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .custom((v) => typeof v === 'boolean' || v === 'true' || v === 'false')
        .withMessage(`${name} must be true or false`);
}

/** Optional date: '' passes; otherwise a string/number Date can parse. */
function optionalDate(field, { location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .custom((v) => v === '' || ((typeof v === 'string' || typeof v === 'number') && !Number.isNaN(new Date(v).getTime())))
        .withMessage(`${name} must be a valid date`);
}

/** Optional array with a size cap (items not inspected). */
function optionalArray(field, { max = 200, location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .custom((v) => Array.isArray(v) && v.length <= max)
        .withMessage(`${name} must be a list of at most ${max} entries`);
}

/** Optional array of strings, each up to maxLen, up to max entries. */
function optionalStringArray(field, { max = 100, maxLen = 100, location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .custom((v) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && s.length <= maxLen))
        .withMessage(`${name} must be a list of up to ${max} short text values`);
}

/**
 * Validate each line of an array field: `lineRules(line, index)` returns an
 * error message or null. Reports only the array field (one error per field).
 */
function lines(field, lineRules, { max = 200, location = 'body', label } = {}) {
    const name = label || field;
    return loc(location)(field)
        .optional({ values: 'null' })
        .custom((v) => {
            if (!Array.isArray(v)) throw new Error(`${name} must be a list`);
            if (v.length > max) throw new Error(`${name} has too many entries (max ${max})`);
            for (let i = 0; i < v.length; i++) {
                const l = v[i];
                if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error(`${name} line ${i + 1} is invalid`);
                const msg = lineRules(l, i);
                if (msg) throw new Error(`${name} line ${i + 1}: ${msg}`);
            }
            return true;
        });
}

const ruleOid = (l, key, required = true) => {
    const v = l[key];
    if (v == null || v === '') return required ? `${key} is required` : null;
    return typeof v === 'string' && OID.test(v) ? null : `${key} is not a valid id`;
};
const ruleNum = (l, key, { min = 0, gt, max = 10000000, required = false } = {}) => {
    const v = l[key];
    if (v == null || v === '') return required ? `${key} is required` : null;
    if (!isNumeric(v)) return `${key} must be a number`;
    const n = Number(v);
    if (gt !== undefined ? !(n > gt) : n < min) return `${key} is out of range`;
    return n <= max ? null : `${key} is out of range`;
};

module.exports = {
    OID,
    isNumeric,
    optionalAmount,
    optionalText,
    optionalEnum,
    optionalBool,
    optionalDate,
    optionalArray,
    optionalStringArray,
    lines,
    ruleOid,
    ruleNum,
};
