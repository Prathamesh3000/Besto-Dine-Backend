const crypto = require('crypto');
const { verifyTypedToken, TOKEN_TYPES } = require('./authMiddleware');
const IdempotencyRecord = require('../models/idempotencyRecord');
const logger = require('../utils/logger');

// CRIT-16 — Idempotency middleware for payment-sensitive endpoints.
//
// If the client sends an `Idempotency-Key` header, we dedupe retries
// for 24h by replaying the original response. Without the header, the
// request falls through (so existing callers that haven't migrated
// keep working). Pass `{ required: true }` to force callers to send
// the header; currently we ship with `required: false` as the
// rollout-safe default.
//
// Design notes:
//  * Keys must be opaque + unguessable-ish — we enforce 8-128 chars of
//    [A-Za-z0-9_-]. UUIDv4 / nanoid / random-hex all fit.
//  * Keys are SCOPED (bug #21): the stored key is a hash of
//      caller identity | tenant | HTTP method | request path | client key
//    so a caller can only ever replay its OWN cached response for the
//    SAME endpoint. Previously the raw client key was global, so anyone
//    who learned (or guessed) another user's key read that user's
//    cached payment response. Identity is the logged-in user id, else
//    the verified guest scan-session id, else the client IP.
//  * Only success and client-error (4xx) responses are cached. 5xx
//    failures are transient and the client should be free to retry.
//  * On DB-lookup failure we proceed without dedup rather than
//    hard-fail — better to risk a rare dup than to block all payments
//    during a Mongo blip.
//  * The race where two identical retries arrive simultaneously is
//    resolved by the unique index on `key`: one write wins, the other
//    returns E11000 which we silently log (the client will still get
//    the success response from its own call).

// Resolve who is calling. Scan tokens are verified (never trusted raw)
// so a guest can't claim another guest's session id.
function callerIdentity(req) {
    const uid = req.user?._id || req.user?.id;
    if (uid) return `user:${String(uid)}`;
    const scanToken = typeof req.get === 'function' ? req.get('X-Scan-Token') : req.headers?.['x-scan-token'];
    if (scanToken && process.env.JWT_SECRET) {
        try {
            const decoded = verifyTypedToken(scanToken, TOKEN_TYPES.SCAN);
            if (decoded?.sessionId) return `scan:${String(decoded.sessionId)}`;
        } catch { /* invalid / expired — fall through to IP */ }
    }
    return `ip:${req.ip || 'unknown'}`;
}

function requestPath(req) {
    const raw = req.originalUrl || req.url || '';
    const q = raw.indexOf('?');
    return q >= 0 ? raw.slice(0, q) : raw;
}

// Derive the storage key. Exported for tests and for other routers that
// need to reason about the scope.
function scopedIdempotencyKey(req, clientKey) {
    const tenant = req.restaurant?._id || req.user?.restaurant || '';
    const material = [
        callerIdentity(req),
        `t:${String(tenant)}`,
        String(req.method || '').toUpperCase(),
        requestPath(req),
        String(clientKey),
    ].join('|');
    return crypto.createHash('sha256').update(material).digest('hex');
}

function idempotency(opts = {}) {
    const required = !!opts.required;

    return async (req, res, next) => {
        const clientKey = req.get('Idempotency-Key');

        if (!clientKey) {
            if (required) {
                return res.status(400).json({
                    success: false,
                    code: 'IDEMPOTENCY_KEY_REQUIRED',
                    message: 'An Idempotency-Key header is required for this endpoint.',
                });
            }
            return next();
        }

        if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientKey)) {
            return res.status(400).json({
                success: false,
                code: 'IDEMPOTENCY_KEY_INVALID',
                message: 'Idempotency-Key must be 8-128 chars [A-Za-z0-9_-].',
            });
        }

        const key = scopedIdempotencyKey(req, clientKey);

        try {
            const existing = await IdempotencyRecord.findOne({ key }).lean();
            if (existing) {
                res.set('Idempotent-Replayed', 'true');
                return res.status(existing.statusCode || 200).json(existing.response);
            }
        } catch (err) {
            logger.warn('Idempotency lookup failed (proceeding without dedup): ' + err.message);
            return next();
        }

        // Wrap res.json so we can persist the final response body
        const originalJson = res.json.bind(res);
        res.json = function (body) {
            if (res.statusCode < 500) {
                IdempotencyRecord.create({
                    key,
                    endpoint: `${String(req.method || '').toUpperCase()} ${requestPath(req)}`,
                    user: req.user?._id || null,
                    restaurant: req.restaurant?._id || null,
                    statusCode: res.statusCode || 200,
                    response: body,
                }).catch((err) => {
                    if (err?.code !== 11000) {
                        logger.warn('Idempotency record write failed: ' + err.message);
                    }
                });
            }
            return originalJson(body);
        };

        return next();
    };
}

exports.idempotency = idempotency;
exports.scopedIdempotencyKey = scopedIdempotencyKey;
exports.callerIdentity = callerIdentity;
