/**
 * tableSessionGuard — reject table scan tokens issued before staff freed the
 * table (Table.sessionEpoch, stamped by utils/tableSessions.endTableSessions).
 *
 * Mounted once on the v1 router, so every endpoint that accepts an
 * X-Scan-Token (guest order create / pay / cancel, service requests, order
 * lookups) refuses a revoked session with
 *
 *   401 { code: 'TABLE_SESSION_ENDED' }
 *
 * and the customer app signs the diner out. Tokens that are missing, expired
 * or malformed are left for the route to reject as before. The scan endpoint
 * itself (GET /tables/token/:qr) is exempt: a returning diner must be able to
 * scan again to get a fresh token.
 */
const Table = require('../models/table');
const logger = require('../utils/logger');
const { verifyTypedToken, TOKEN_TYPES } = require('./authMiddleware');

const CACHE_TTL_MS = 3000;
const CACHE_MAX = 5000;
const epochCache = new Map(); // tableId -> { epoch:number|null, at:number }

async function epochOf(tableId) {
    const hit = epochCache.get(tableId);
    const now = Date.now();
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.epoch;
    const t = await Table.findById(tableId).select('sessionEpoch').lean();
    const epoch = t && t.sessionEpoch ? new Date(t.sessionEpoch).getTime() : null;
    if (epochCache.size >= CACHE_MAX) epochCache.clear();
    epochCache.set(tableId, { epoch, at: now });
    return epoch;
}

/** Drop a table's cached epoch so a just-written epoch takes effect at once. */
function forgetTableEpoch(tableId) {
    epochCache.delete(String(tableId));
}

async function tableSessionGuard(req, res, next) {
    try {
        const raw = req.headers['x-scan-token'];
        if (!raw) return next();
        if (req.method === 'GET' && /^\/tables\/(scan|token)\//.test(req.path)) return next();
        let decoded;
        try {
            decoded = verifyTypedToken(raw, TOKEN_TYPES.SCAN);
        } catch {
            return next(); // expired / malformed: the route reports it as before
        }
        if (!decoded || !decoded.tableId || !decoded.iat) return next();
        const epoch = await epochOf(String(decoded.tableId));
        // iat is in whole seconds: only a token issued in an EARLIER second than
        // the epoch is revoked, so a diner who re-scans right after the reset
        // is never locked out by their own fresh token.
        if (epoch && (Number(decoded.iat) + 1) * 1000 <= epoch) {
            return res.status(401).json({
                success: false,
                code: 'TABLE_SESSION_ENDED',
                message: 'Your table session has ended. Please scan the QR code again.',
            });
        }
        return next();
    } catch (err) {
        // Fail open: a lookup problem must not block ordering for everyone.
        logger.warn('tableSessionGuard lookup failed: ' + err.message);
        return next();
    }
}

module.exports = tableSessionGuard;
module.exports.forgetTableEpoch = forgetTableEpoch;
module.exports._epochCache = epochCache;
