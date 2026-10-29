const crypto = require('crypto');
const { verifyTypedToken, TOKEN_TYPES } = require('./authMiddleware');
const IdempotencyRecord = require('../models/idempotencyRecord');
const logger = require('../utils/logger');

// CRIT-16 — Idempotency middleware for payment-sensitive endpoints.
//
// If the client sends an `Idempotency-Key` header, we dedupe retries
// for 24h by replaying the original response. Without the header, the
// request falls through (so existing callers that haven't migrated
// keep working). Pass `{ required: true }` on payment / refund / checkout
// routes: the header is then mandatory (400 IDEMPOTENCY_KEY_REQUIRED) once
// env IDEMPOTENCY_ENFORCE is truthy (default off until all clients send
// the key), and a record-store failure fails CLOSED.
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
//  * Only 2xx and 409 responses are cached (see isCacheableStatus).
//    5xx failures are transient, and so are most 4xx outcomes on these
//    endpoints — e.g. 400 PAYMENT_NOT_CAPTURED while the payment is still
//    in flight at Razorpay. Caching those for 24h replayed the stale
//    failure to a retry made after capture, so the retry never settled.
//    409 (already paid / payment already used) is a final answer.
//  * Concurrency: the key is CLAIMED atomically first (insert of an
//    'in_progress' record guarded by the unique index). A simultaneous twin
//    hits E11000 and gets 409 IDEMPOTENCY_IN_PROGRESS (retryable); the
//    winner's final response is then stored (awaited) and replayed to
//    later retries. Non-cacheable outcomes release the claim.
//  * Failure policy: with { required: true } and a key present, a failed
//    claim/lookup fails CLOSED (503 IDEMPOTENCY_UNAVAILABLE, retryable).
//    Other routes fail open as before. A failed final write is retried once,
//    logged at error level and flagged with X-Idempotency-Recorded: false.

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

// Which first responses are stored for replay. Success is final; 409 is a
// settled conflict. Everything else may succeed on a later retry.
function isCacheableStatus(status) {
    const code = Number(status) || 200;
    return (code >= 200 && code < 300) || code === 409;
}

// A claim ('in_progress') older than this is assumed to belong to a crashed
// process and may be taken over by a retry.
const STALE_LOCK_MS = 2 * 60 * 1000;

// IDEMPOTENCY_ENFORCE: when truthy, routes marked { required: true } reject
// requests that carry no Idempotency-Key. Default OFF so un-updated clients
// keep working. Read per request so it can be flipped without code changes.
function enforcementOn() {
    return /^(1|true|yes|on)$/i.test(String(process.env.IDEMPOTENCY_ENFORCE || '').trim());
}

function unavailable(res, stage, err) {
    logger.error(`Idempotency ${stage} failed (failing closed): ` + (err && err.message));
    res.set('Retry-After', '2');
    return res.status(503).json({
        success: false,
        code: 'IDEMPOTENCY_UNAVAILABLE',
        retryable: true,
        message: 'Could not safely process this request right now. Please retry in a moment with the same Idempotency-Key.',
    });
}

function inProgress(res) {
    res.set('Retry-After', '2');
    return res.status(409).json({
        success: false,
        code: 'IDEMPOTENCY_IN_PROGRESS',
        retryable: true,
        message: 'A request with this Idempotency-Key is still being processed. Retry shortly to receive its result.',
    });
}

function replay(res, record) {
    res.set('Idempotent-Replayed', 'true');
    return res.status(record.statusCode || 200).json(record.response);
}

// opts.required — payment / refund / checkout routes:
//   * missing key  -> 400 IDEMPOTENCY_KEY_REQUIRED, but only while
//     IDEMPOTENCY_ENFORCE is truthy (otherwise falls through, old behaviour);
//   * key present  -> FAIL CLOSED (503 IDEMPOTENCY_UNAVAILABLE, retryable)
//     if the record store cannot be read / claimed.
// opts.requiredWhen(req) -> boolean: same as required, decided per request
// (e.g. only when the body settles a payment).
// Without either option the route keeps the old optional, fail-open mode.
function idempotency(opts = {}) {
    const alwaysRequired = !!opts.required;
    const requiredWhen = typeof opts.requiredWhen === 'function' ? opts.requiredWhen : null;

    return async (req, res, next) => {
        const clientKey = req.get('Idempotency-Key');
        // requiredWhen(req): per-request opt-in to the required (fail-closed)
        // behaviour; a throwing predicate counts as "required" (safe side).
        let critical = alwaysRequired;
        if (!critical && requiredWhen) {
            try { critical = !!requiredWhen(req); } catch { critical = true; }
        }

        if (!clientKey) {
            if (critical && enforcementOn()) {
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
        const endpoint = `${String(req.method || '').toUpperCase()} ${requestPath(req)}`;
        const failOpenOrClosed = (stage, err) => {
            if (critical) return unavailable(res, stage, err);
            logger.warn(`Idempotency ${stage} failed (proceeding without dedup): ` + (err && err.message));
            return next();
        };

        // 1. Atomically claim the key (unique index) BEFORE the handler runs.
        let claimed = false;
        try {
            await IdempotencyRecord.create({
                key,
                endpoint,
                user: req.user?._id || null,
                restaurant: req.restaurant?._id || null,
                state: 'in_progress',
                lockedAt: new Date(),
                statusCode: 200,
                response: null,
            });
            claimed = true;
        } catch (err) {
            if (err?.code !== 11000) return failOpenOrClosed('claim', err);
        }

        // 2. Someone already holds / finished this key.
        if (!claimed) {
            let existing;
            try {
                existing = await IdempotencyRecord.findOne({ key }).lean();
            } catch (err) {
                return failOpenOrClosed('lookup', err);
            }
            if (!existing) return inProgress(res); // expired/released between insert and read
            if (existing.state !== 'in_progress') return replay(res, existing);

            // In-progress: a twin is running. Take over only if its claim is stale.
            try {
                const taken = await IdempotencyRecord.findOneAndUpdate(
                    { key, state: 'in_progress', lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
                    { $set: { lockedAt: new Date() } },
                ).lean();
                if (!taken) return inProgress(res);
            } catch (err) {
                return failOpenOrClosed('takeover', err);
            }
        }

        // 3. We own the claim. Persist the final response (awaited) or release.
        let settled = false;
        const originalJson = res.json.bind(res);

        const finalize = async (status, body) => {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await IdempotencyRecord.updateOne(
                        { key, state: 'in_progress' },
                        { $set: { state: 'done', statusCode: status, response: body } },
                    );
                    return true;
                } catch (err) {
                    if (attempt === 1) logger.error('Idempotency record write failed: ' + err.message);
                }
            }
            return false;
        };
        const release = async () => {
            try {
                await IdempotencyRecord.deleteOne({ key, state: 'in_progress' });
            } catch (err) {
                logger.warn('Idempotency claim release failed (stale-lock takeover will recover): ' + err.message);
            }
        };

        res.json = function (body) {
            if (settled) return originalJson(body);
            settled = true;
            const status = res.statusCode || 200;
            const work = isCacheableStatus(status)
                ? finalize(status, body).then(async (ok) => {
                    if (!ok) {
                        // The handler already ran (money may have moved), so the
                        // real result is still returned — flagged, not silent —
                        // and the claim is released so a retry is not stuck on 409.
                        res.set('X-Idempotency-Recorded', 'false');
                        await release();
                    }
                })
                : release();
            work.then(() => originalJson(body), () => originalJson(body));
            return res;
        };

        // Handler answered through something other than res.json (res.send /
        // res.end): nothing to replay, so drop the claim instead of leaving a
        // 24h in-progress lock. (Not hooked on 'close': a client abort must not
        // free the key while the handler is still running.)
        if (typeof res.once === 'function') {
            res.once('finish', () => {
                if (!settled) { settled = true; release(); }
            });
        }

        return next();
    };
}

exports.idempotency = idempotency;
exports.scopedIdempotencyKey = scopedIdempotencyKey;
exports.callerIdentity = callerIdentity;
exports.isCacheableStatus = isCacheableStatus;
