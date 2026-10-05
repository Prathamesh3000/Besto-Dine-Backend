/**
 * razorpayErrors — turn a Razorpay SDK rejection into something loggable.
 *
 * Why this exists
 * ---------------
 * The Razorpay SDK does NOT reject with an Error. It rejects with a
 * plain object:
 *
 *   { statusCode: 400,
 *     error: { code, description, field, reason, step, source } }
 *
 * That object has no `.message` and no top-level `.description`. Every
 * handler in this codebase was logging one or both of:
 *
 *   { error: err.message }                       → {}
 *   { error: err.message, description: err.description }  → {}
 *
 * Winston drops undefined keys, so the whole log line collapsed to a
 * bare timestamp. The one fact worth having — what Razorpay actually
 * objected to — was discarded at the exact moment it mattered.
 *
 * That is how a 43-character `receipt` (Razorpay's limit is 40) broke
 * every order payment while producing no diagnosable log for it.
 *
 * Use this in EVERY catch around a razorpay.* call. It also handles
 * ordinary Errors (network, timeout, programming mistakes) so it is
 * always the right thing to reach for.
 */

/**
 * @param {unknown} err  whatever the SDK (or the runtime) threw
 * @returns {object} a flat, Winston-friendly object — never empty
 */
function describeRazorpayError(err) {
    if (!err) return { error: 'unknown error' };

    // Razorpay API rejection — the shape that used to log as {}.
    if (err.error && typeof err.error === 'object') {
        return {
            statusCode: err.statusCode,
            code: err.error.code,
            description: err.error.description,
            field: err.error.field,
            reason: err.error.reason,
            step: err.error.step,
            source: err.error.source,
        };
    }

    // Ordinary Error: network failure, DNS, timeout, our own bug.
    if (err.message) return { error: err.message, stack: err.stack };

    // Anything else — stringify rather than lose it.
    try {
        return { error: JSON.stringify(err) };
    } catch {
        return { error: String(err) };
    }
}

/**
 * A short human-readable reason, for surfacing to staff in an admin UI
 * where a full object would be noise. Falls back to a generic string so
 * a caller can always render something.
 */
function razorpayErrorSummary(err) {
    const d = describeRazorpayError(err);
    return d.description || d.error || 'Payment gateway error';
}

module.exports = { describeRazorpayError, razorpayErrorSummary };
