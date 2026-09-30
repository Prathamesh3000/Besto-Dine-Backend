// Wrap an async Express handler so thrown errors / rejected promises are
// handled in one place (BUGS_REPORT #33).
//
//   const asyncHandler = require('../utils/asyncHandler');
//   const AppError = require('../utils/AppError');
//
//   exports.getThing = asyncHandler(async (req, res) => {
//       const thing = await Thing.findOne({ _id: req.params.id, ...tenantFilter(req) });
//       if (!thing) throw new AppError(404, 'NOT_FOUND', 'Thing not found');
//       res.json({ success: true, thing });
//   }, 'Failed to fetch thing');
//
// asyncHandler(fn, fallback?)
//   fallback  optional 5xx message (string) or { message, status }. When
//             set, an unexpected error is logged and answered here with
//             { success:false, message: fallback, error? } (error only
//             outside production) — the same body the hand-written
//             try/catch blocks returned. When omitted, the error goes to
//             the global error handler in server.js (generic message in
//             production).
//
// Behaviour
//   - AppError        → res.status(err.status).json({ success:false, message, code?, ...details })
//   - other error     → fallback response (see above) or next(err)
//   - headers already sent → next(err) (Express closes the connection).
//
// Express 5 already forwards rejected promises to next(); the wrapper adds
// the AppError → JSON mapping and the per-route fallback message.
const AppError = require('./AppError');
const { devError } = require('./AppError');
const logger = require('./logger');

function sendAppError(err, req, res) {
    const body = { success: false, message: err.message };
    if (err.code) body.code = err.code;
    if (err.details && typeof err.details === 'object') Object.assign(body, err.details);
    if (err.status >= 500) {
        logger.error('AppError ' + err.status + ': ' + err.message, {
            code: err.code, method: req.method, path: req.originalUrl, stack: err.stack,
        });
    }
    return res.status(err.status).json(body);
}

function normaliseFallback(fallback) {
    if (!fallback) return null;
    if (typeof fallback === 'string') return { message: fallback, status: 500 };
    if (typeof fallback === 'object' && fallback.message) {
        const status = Number(fallback.status) || 500;
        return { message: fallback.message, status: status >= 500 && status <= 599 ? status : 500 };
    }
    return null;
}

function asyncHandler(fn, fallback) {
    const fb = normaliseFallback(fallback);
    return function asyncHandled(req, res, next) {
        const onError = (err) => handle(err, req, res, next, fb);
        let out;
        try {
            out = fn(req, res, next);
        } catch (err) {
            return onError(err);
        }
        if (out && typeof out.then === 'function') return out.catch(onError);
        return out;
    };
}

function handle(err, req, res, next, fb) {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return sendAppError(err, req, res);
    if (fb) {
        logger.error(`${req.method} ${req.originalUrl} failed: ${err?.message || err}`, { stack: err?.stack });
        return res.status(fb.status).json({ success: false, message: fb.message, ...devError(err) });
    }
    return next(err);
}

module.exports = asyncHandler;
module.exports.asyncHandler = asyncHandler;
module.exports.sendAppError = sendAppError;
