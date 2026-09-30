// Operational error with an HTTP status + machine-readable code
// (BUGS_REPORT #33).
//
//   throw new AppError(404, 'NOT_FOUND', 'Booking not found');
//   throw AppError.badRequest('Invalid status', 'INVALID_STATUS');
//
// utils/asyncHandler.js turns it into
//   res.status(status).json({ success: false, code, message, ...details })
// so handlers can `throw` instead of hand-writing error responses. Any
// other error thrown inside an asyncHandler goes to the global error
// handler in server.js (generic 5xx message in production).
class AppError extends Error {
    /**
     * @param {number} status   HTTP status (4xx/5xx)
     * @param {string} [code]   machine-readable code, e.g. 'ALREADY_CANCELLED'
     * @param {string} [message] human-readable message (returned to the client)
     * @param {object} [details] extra fields merged into the JSON body
     */
    constructor(status, code, message, details) {
        super(message || code || 'Error');
        this.name = 'AppError';
        this.status = Number(status) || 500;
        this.statusCode = this.status;
        this.code = code || undefined;
        this.details = details || undefined;
        // Global error handler (server.js) only echoes err.message for
        // 4xx errors that set `expose`.
        this.expose = this.status < 500;
        this.isOperational = true;
    }

    static badRequest(message, code = 'BAD_REQUEST', details) { return new AppError(400, code, message, details); }
    static unauthorized(message = 'Unauthorized', code = 'UNAUTHORIZED') { return new AppError(401, code, message); }
    static forbidden(message = 'Forbidden', code = 'FORBIDDEN') { return new AppError(403, code, message); }
    static notFound(message = 'Not found', code = 'NOT_FOUND') { return new AppError(404, code, message); }
    static conflict(message, code = 'CONFLICT', details) { return new AppError(409, code, message, details); }
}

/**
 * `{ error: err.message }` outside production, `{}` in production — the
 * same rule the global error handler in server.js applies, for handlers
 * that still build their own 5xx body:
 *   res.status(500).json({ success: false, message: 'Failed to X', ...devError(error) });
 */
function devError(err) {
    if (process.env.NODE_ENV === 'production') return {};
    const msg = err && err.message ? err.message : (err ? String(err) : '');
    return msg ? { error: msg } : {};
}

module.exports = AppError;
module.exports.AppError = AppError;
module.exports.devError = devError;
