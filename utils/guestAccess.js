/**
 * Guest order-access token (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.2,
 * token-number mode follow-up).
 *
 * A guest who orders through the branch "counter QR" has no table and so
 * no scan session: the usual guest proof for GET /orders/:id/detail, the
 * tracking poll, the customer pay endpoints and the `order:<id>` socket
 * room (X-Scan-Token ↔ order.scanSessionId) does not exist for them.
 * createOrder therefore mints one random token per such order, stores a
 * SHA-256 of it on the order (`guestAccess.tokenHash`, `guestAccess.expiresAt`
 * = created + 24 h) and returns the raw token ONCE, as `guestAccessToken`
 * in the create response. The guest presents it back as the
 * `X-Guest-Access` header (or `?guestAccess=`), and the socket join sends
 * `{ room, guestAccess }`.
 *
 * Only the hash is stored: order documents reach staff lists, kitchen
 * screens and the admin drawer, and a stored raw token could be replayed
 * from any of those payloads.
 *
 * Pure (crypto only): no Mongo, no request objects beyond header / query
 * reads, so utils/socketRooms can use it too.
 */
const crypto = require('crypto');

const GUEST_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
// 24 random bytes → 32 base64url chars. The bound protects header parsing.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function hashGuestAccessToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Mint a token: `{ token, tokenHash, expiresAt }`. Only `tokenHash` + `expiresAt` go on the order. */
function issueGuestAccess(now = new Date()) {
    const token = crypto.randomBytes(24).toString('base64url');
    return {
        token,
        tokenHash: hashGuestAccessToken(token),
        expiresAt: new Date(now.getTime() + GUEST_ACCESS_TTL_MS),
    };
}

/** Well-formed token string or null. */
function normaliseGuestAccessToken(raw) {
    return typeof raw === 'string' && TOKEN_RE.test(raw) ? raw : null;
}

/** The token a request carries (`X-Guest-Access` header first, then `?guestAccess=`), or null. */
function guestAccessFromReq(req) {
    const header = req?.headers?.['x-guest-access'];
    const query = req?.query?.guestAccess;
    return normaliseGuestAccessToken(header) || normaliseGuestAccessToken(query);
}

/**
 * How `token` stands against `order.guestAccess`:
 *   'none'     — the order has no guest access (table order, staff order…)
 *                or no token was given
 *   'expired'  — the token would match but the 24 h window is over
 *   'mismatch' — a token for another order (or garbage)
 *   'ok'       — the order's own, unexpired token
 */
function guestAccessState(order, token, now = new Date()) {
    const stored = order && order.guestAccess ? order.guestAccess.tokenHash : null;
    const clean = normaliseGuestAccessToken(token);
    if (!stored || !clean) return 'none';
    const a = Buffer.from(hashGuestAccessToken(clean), 'hex');
    const b = Buffer.from(String(stored), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'mismatch';
    const expiresAt = order.guestAccess.expiresAt ? new Date(order.guestAccess.expiresAt).getTime() : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return 'expired';
    return 'ok';
}

/** True only for the order's own, unexpired token. */
function guestAccessMatches(order, token, now = new Date()) {
    return guestAccessState(order, token, now) === 'ok';
}

module.exports = {
    GUEST_ACCESS_TTL_MS,
    hashGuestAccessToken,
    issueGuestAccess,
    normaliseGuestAccessToken,
    guestAccessFromReq,
    guestAccessState,
    guestAccessMatches,
};
