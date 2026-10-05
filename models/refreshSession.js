const mongoose = require('mongoose');

/**
 * RefreshSession — one row per issued refresh token (#28 / #15).
 *
 * The refresh token itself is an opaque 256-bit random string handed to
 * the client; only its SHA-256 is stored here, so a DB leak does not
 * yield usable tokens. Tokens rotate on every /auth/refresh: the
 * presented row is revoked and a new row in the same `family` is
 * created. Presenting an already-rotated token outside the short grace
 * window is treated as theft and revokes the whole family.
 *
 * `tv` snapshots User.tokenVersion at issue time. Bumping tokenVersion
 * (password change / reset / "log out everywhere") therefore invalidates
 * every refresh session as well as every access token.
 */
const refreshSessionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    tokenHash: {
        type: String,
        required: true,
        unique: true,
    },
    family: {
        type: String,
        required: true,
        index: true,
    },
    tv: {
        type: Number,
        default: 0,
    },
    // ── Absolute session ceiling ──────────────────────────────────
    // Set ONCE when the family is created (at login) and carried
    // through every rotation UNCHANGED. `expiresAt` below is per-token
    // and resets on each refresh — on its own that is a sliding window
    // with no ceiling, so any client that refreshes before it lapses
    // stays signed in forever. A tab left open overnight does exactly
    // that: background polling triggers a refresh every ~30 minutes,
    // each one buying another full TTL.
    //
    // This field is what actually ends a session. Once passed, refresh
    // is refused however recently the user was active, and they must
    // sign in again.
    familyExpiresAt: {
        type: Date,
        required: true,
        index: true,
    },

    expiresAt: {
        type: Date,
        required: true,
        index: { expires: 0 }, // TTL — Mongo reaps expired sessions
    },
    revokedAt: {
        type: Date,
        default: null,
    },
    // When this token was issued — i.e. when the session was last used
    // (each refresh issues a new row). Customer sessions end after
    // CUSTOMER_IDLE_TIMEOUT_MINUTES without use (authController.refresh).
    lastUsedAt: {
        type: Date,
        default: Date.now,
    },
    // Set when the row was revoked because it was rotated (as opposed to
    // logout / theft). Used for the concurrent-refresh grace window.
    rotatedAt: {
        type: Date,
        default: null,
    },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('RefreshSession', refreshSessionSchema);
