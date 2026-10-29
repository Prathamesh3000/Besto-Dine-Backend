/**
 * TOTP (RFC 6238) helpers + at-rest encryption for the optional 2FA
 * feature (Plan 3A.1). Pure functions: no DB, no HTTP.
 *
 *  - secrets are generated/encoded with otplib (base32, 20 random bytes)
 *  - verification is done here so the matched time step is known (replay
 *    protection needs the step, which otplib's check() does not return)
 *  - secrets are stored AES-256-GCM encrypted with TWO_FA_ENC_KEY (any
 *    string; hashed to 32 bytes) or, when unset, a key derived from
 *    JWT_SECRET with a distinct label. Never log a secret.
 */
'use strict';

const crypto = require('crypto');
const { authenticator } = require('otplib');

const STEP_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1; // accept previous / next code
const ENC_PREFIX = 'v1';
const ISSUER = 'BestoDine';

// ─── Encryption at rest ──────────────────────────────────────────────────────
function encKey() {
    const explicit = process.env.TWO_FA_ENC_KEY;
    if (explicit && String(explicit).trim()) {
        return crypto.createHash('sha256').update(`bestodine-2fa-key:${explicit}`).digest();
    }
    const jwt = process.env.JWT_SECRET;
    if (!jwt) throw new Error('2FA encryption key unavailable (set TWO_FA_ENC_KEY or JWT_SECRET)');
    return crypto.createHmac('sha256', jwt).update('bestodine:2fa:secret-encryption:v1').digest();
}

/** AES-256-GCM → `v1.<iv>.<tag>.<ciphertext>` (base64url). */
function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENC_PREFIX, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Inverse of encryptSecret. Throws on tampering / wrong key. */
function decryptSecret(blob) {
    const parts = String(blob || '').split('.');
    if (parts.length !== 4 || parts[0] !== ENC_PREFIX) throw new Error('Malformed 2FA secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

// ─── TOTP ────────────────────────────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(str) {
    const clean = String(str).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx < 0) throw new Error('Invalid base32');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

const generateSecret = () => authenticator.generateSecret(20);

const stepFor = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** The 6-digit code for a given step. */
function codeForStep(secret, step) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(step));
    const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
    const off = h[h.length - 1] & 0xf;
    const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const safeEq = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Check `code` against the secret within +-1 step.
 * `lastUsedStep` blocks replay: a step <= lastUsedStep never matches.
 * Returns the matched step (number) or null.
 */
function verifyCode(secret, code, { lastUsedStep = 0, nowMs = Date.now() } = {}) {
    const c = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(c)) return null;
    const cur = stepFor(nowMs);
    let matched = null;
    for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
        const step = cur + d;
        // Evaluate every window (no early exit) to keep timing flat.
        if (safeEq(codeForStep(secret, step), c) && step > (Number(lastUsedStep) || 0) && matched === null) matched = step;
    }
    return matched;
}

function otpauthUri(accountLabel, secret) {
    return authenticator.keyuri(accountLabel, ISSUER, secret);
}

// ─── Recovery codes ──────────────────────────────────────────────────────────
const RECOVERY_COUNT = 8;
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `XXXXX-XXXXX` (10 chars, ~50 bits). */
function generateRecoveryCodes(n = RECOVERY_COUNT) {
    return Array.from({ length: n }, () => {
        const bytes = crypto.randomBytes(10);
        const s = Array.from(bytes, (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
        return `${s.slice(0, 5)}-${s.slice(5)}`;
    });
}

const normalizeRecovery = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** sha256 of the normalised code, salted with a per-install label. */
function hashRecoveryCode(code) {
    return crypto.createHash('sha256').update(`bestodine-2fa-recovery:${normalizeRecovery(code)}`).digest('hex');
}

/** Index of the matching hash in `hashes`, or -1. */
function findRecoveryIndex(hashes, code) {
    const h = hashRecoveryCode(code);
    let idx = -1;
    (hashes || []).forEach((x, i) => { if (idx < 0 && safeEq(x, h)) idx = i; });
    return idx;
}

// ─── Policy ──────────────────────────────────────────────────────────────────
const TWO_FA_ROLES = new Set(['admin', 'superadmin']); // owner is role 'admin' + isTenantOwner
const eligibleRole = (role) => TWO_FA_ROLES.has(role);

/** TWO_FA_REQUIRED_ROLES (comma list, default empty). Only eligible roles count. */
function requiredRoles() {
    return String(process.env.TWO_FA_REQUIRED_ROLES || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter((r) => eligibleRole(r));
}

/** What login must do for this (password-verified) user. */
function loginPolicy(user) {
    if (!user || !eligibleRole(user.role)) return { required: false, setupRequired: false };
    if (user.twoFactor && user.twoFactor.enabled) return { required: true, setupRequired: false };
    return { required: false, setupRequired: requiredRoles().includes(user.role) };
}

module.exports = {
    STEP_SECONDS, RECOVERY_COUNT,
    encryptSecret, decryptSecret,
    generateSecret, stepFor, codeForStep, verifyCode, otpauthUri,
    generateRecoveryCodes, hashRecoveryCode, findRecoveryIndex, normalizeRecovery,
    eligibleRole, requiredRoles, loginPolicy,
};
