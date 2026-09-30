/**
 * sendServerError — the catch-block reply for controllers that used to put
 * `err.message` straight into a 500 response (leaking Mongo / driver /
 * Cloudinary internals to the browser).
 *
 *   - Mongoose ValidationError → 400 with the first field message (those
 *     messages are written for users: "Name is required", enum errors…).
 *   - CastError (malformed id / number)    → 400 "Invalid value for <path>".
 *   - Duplicate key (E11000)               → 409 "already exists".
 *   - Anything else → logged with logger.error and answered with a
 *     generic 500 message.
 */
const logger = require('./logger');

const GENERIC = 'Something went wrong. Please try again.';

function sendServerError(res, err, context, fallback = GENERIC) {
    if (err && err.name === 'ValidationError' && err.errors) {
        const first = Object.values(err.errors)[0];
        return res.status(400).json({ success: false, message: first?.message || 'Validation failed' });
    }
    if (err && err.name === 'CastError') {
        return res.status(400).json({ success: false, message: `Invalid value for ${err.path || 'field'}` });
    }
    if (err && err.code === 11000) {
        return res.status(409).json({ success: false, message: 'A record with these details already exists' });
    }
    logger.error(`${context || 'request'} failed`, { error: err?.message, stack: err?.stack });
    return res.status(500).json({ success: false, message: fallback });
}

module.exports = { sendServerError, GENERIC_ERROR_MESSAGE: GENERIC };
