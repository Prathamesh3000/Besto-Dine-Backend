/**
 * Tenant API keys — generation, hashing and constant-time verification.
 *
 * Format:   bd_live_<prefix>_<secret>
 *   prefix  10 hex chars, stored in clear, unique — the lookup id
 *   secret  48 hex chars (192 bits), shown ONCE, only its sha256 is stored
 *
 * The secret has 192 bits of entropy, so a plain (unsalted, fast) sha256
 * is the right primitive: nothing to brute-force, and verification stays
 * cheap enough for a per-request check.
 */
'use strict';

const crypto = require('crypto');

const KEY_PREFIX = 'bd_live_';
const PREFIX_BYTES = 5;    // 10 hex chars
const SECRET_BYTES = 24;   // 48 hex chars

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** @returns {{ key: string, prefix: string, hash: string }} */
function generateApiKey() {
    const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
    const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    return { key: `${KEY_PREFIX}${prefix}_${secret}`, prefix, hash: sha256Hex(secret) };
}

const KEY_RE = /^bd_live_([0-9a-f]{10})_([0-9a-f]{48})$/;

/** @returns {{ prefix: string, secret: string } | null} */
function parseApiKey(raw) {
    if (typeof raw !== 'string') return null;
    const m = KEY_RE.exec(raw.trim());
    return m ? { prefix: m[1], secret: m[2] } : null;
}

/** Constant-time check of a presented secret against a stored sha256 hex. */
function verifySecret(secret, storedHash) {
    if (typeof secret !== 'string' || typeof storedHash !== 'string') return false;
    const a = Buffer.from(sha256Hex(secret), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = { KEY_PREFIX, generateApiKey, parseApiKey, verifySecret, sha256Hex };
