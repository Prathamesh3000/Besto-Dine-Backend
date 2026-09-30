/**
 * Google Sign-In — ID token verification.
 *
 * Flow
 * ----
 * The browser runs Google Identity Services, which hands it a signed
 * ID token (a JWT) after the user picks their account. The browser
 * POSTs that token to /auth/google. This module proves the token is
 * genuine, was minted for US, and is current — then the controller
 * trusts its claims.
 *
 * Why there is no client SECRET here
 * ----------------------------------
 * This is the ID-token flow, not the authorization-code flow. We only
 * need to know *who the user is*; we never call Google APIs on their
 * behalf, so there is no access token to obtain and no secret to hold.
 * That is a real security win: the most dangerous credential in a
 * typical OAuth integration simply doesn't exist in this deployment.
 * GOOGLE_CLIENT_ID is public by design — it ships in the browser.
 *
 * Why not the google-auth-library package
 * ---------------------------------------
 * The signature check itself is done by `jsonwebtoken`, which is
 * already a dependency and is the battle-tested part. What's left is
 * key discovery, which is a cached HTTPS GET. Adding a large transitive
 * dependency tree to avoid ~40 lines of fetch-and-cache wasn't worth
 * it. If this ever needs the code flow (offline access, Calendar, etc.)
 * that calculus changes — switch to the official library then.
 *
 * What is verified (all of it matters)
 * ------------------------------------
 *   signature   RS256 against Google's published public keys
 *   alg         pinned to RS256 — stops "alg: none" / HS256 confusion,
 *               where an attacker re-signs a token using the public key
 *               as an HMAC secret
 *   aud         MUST equal our client id. Without this, a token issued
 *               to ANY other Google app would be accepted here, and
 *               anyone could log in as anyone. This is the single most
 *               important check in the file.
 *   iss         accounts.google.com
 *   exp/iat     handled by jsonwebtoken, with a small clock tolerance
 *   email_      enforced by the CALLER before linking to an existing
 *   verified    account — see authController.googleLogin
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

// Small tolerance for clock drift between our server and Google's.
const CLOCK_TOLERANCE_SEC = 30;

/**
 * JWKS cache. Google rotates signing keys regularly and publishes the
 * rotation window in Cache-Control, so honouring that header keeps us
 * from either hammering the endpoint or trusting a retired key.
 */
let jwksCache = { keys: null, expiresAt: 0 };

async function fetchGoogleKeys() {
    const now = Date.now();
    if (jwksCache.keys && now < jwksCache.expiresAt) {
        return jwksCache.keys;
    }

    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) {
        throw new Error(`Google JWKS fetch failed with ${res.status}`);
    }
    const body = await res.json();
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
        throw new Error('Google JWKS response contained no keys');
    }

    // Respect Google's own cache window; fall back to an hour.
    let ttlMs = 60 * 60 * 1000;
    const cacheControl = res.headers.get('cache-control') || '';
    const maxAge = /max-age=(\d+)/i.exec(cacheControl);
    if (maxAge) ttlMs = Math.max(60, parseInt(maxAge[1], 10)) * 1000;

    jwksCache = { keys: body.keys, expiresAt: now + ttlMs };
    return body.keys;
}

/**
 * Find the key that signed this token and convert it to a form
 * jsonwebtoken can use. Node has imported JWK directly since v16, so no
 * manual modulus/exponent-to-PEM juggling is needed.
 */
async function resolveSigningKey(kid) {
    let keys = await fetchGoogleKeys();
    let jwk = keys.find((k) => k.kid === kid);

    // A token signed with a key we haven't seen usually means Google
    // rotated since our last fetch. Bust the cache once and retry
    // before treating it as a bad token.
    if (!jwk) {
        jwksCache = { keys: null, expiresAt: 0 };
        keys = await fetchGoogleKeys();
        jwk = keys.find((k) => k.kid === kid);
    }
    if (!jwk) return null;

    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/** Is Google Sign-In configured on this deployment? */
function isGoogleAuthConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID);
}

/**
 * Verify a Google ID token and return its claims.
 *
 * Resolves to a normalised profile, or throws. Callers should treat any
 * throw as "authentication failed" and must NOT relay the message to
 * the client verbatim — the reasons are useful in logs and useful to an
 * attacker probing what we check.
 */
async function verifyGoogleIdToken(idToken) {
    if (!isGoogleAuthConfigured()) {
        throw new Error('GOOGLE_CLIENT_ID is not configured');
    }
    if (!idToken || typeof idToken !== 'string') {
        throw new Error('No ID token supplied');
    }

    // Decode (NOT trust) the header to learn which key to fetch.
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded?.header?.kid) {
        throw new Error('ID token has no key id');
    }
    if (decoded.header.alg !== 'RS256') {
        // Pinned again below in jwt.verify; rejected early here so an
        // odd algorithm never reaches key resolution.
        throw new Error(`Unexpected token algorithm: ${decoded.header.alg}`);
    }

    const publicKey = await resolveSigningKey(decoded.header.kid);
    if (!publicKey) {
        throw new Error('No matching Google signing key for this token');
    }

    // Accept a comma-separated list so a deployment can run web and
    // Android/iOS client ids against one backend.
    const audiences = String(process.env.GOOGLE_CLIENT_ID)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const payload = jwt.verify(idToken, publicKey, {
        algorithms: ['RS256'],
        audience: audiences,
        issuer: VALID_ISSUERS,
        clockTolerance: CLOCK_TOLERANCE_SEC,
    });

    if (!payload.sub) {
        throw new Error('ID token has no subject claim');
    }
    if (!payload.email) {
        throw new Error('ID token carried no email address');
    }

    return {
        googleId: payload.sub,
        email: String(payload.email).toLowerCase().trim(),
        // Google sends this as a real boolean or the string "true"
        // depending on the surface that minted the token.
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        name: payload.name || '',
        picture: payload.picture || '',
    };
}

/** Clears the key cache. Test seam. */
function _resetJwksCache() {
    jwksCache = { keys: null, expiresAt: 0 };
}

module.exports = {
    verifyGoogleIdToken,
    isGoogleAuthConfigured,
    _resetJwksCache,
    GOOGLE_JWKS_URL,
    VALID_ISSUERS,
};
