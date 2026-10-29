/**
 * Optional TOTP 2FA (Plan 3A.1) — admin / superadmin only.
 *
 *   GET  /auth/2fa/status               (auth)
 *   POST /auth/2fa/setup                (auth)  → secret + otpauth URI + QR (once)
 *   POST /auth/2fa/enable               (auth)  { code } → recovery codes (once)
 *   POST /auth/2fa/disable              (auth)  { password, code | recoveryCode }
 *   POST /auth/2fa/recovery/regenerate  (auth)  { code }
 *   POST /auth/2fa/reset                (auth)  { userId } owner → other admin, superadmin → anyone
 *   POST /auth/2fa/verify               (public) { challengeToken, code | recoveryCode }
 *
 * Login (authController.login) returns { twoFactorRequired, challengeToken }
 * instead of tokens; `verify` completes the normal session issue.
 * Logic lives here; docs: Backend/docs/TWO_FACTOR_AUTH.md.
 */
'use strict';

const QRCode = require('qrcode');
const User = require('../models/user');
const logger = require('../utils/logger');
const loginAttempts = require('../utils/loginAttempts');
const totp = require('../utils/totp');
const { signTypedToken, verifyTypedToken } = require('../middlewares/authMiddleware');

const CHALLENGE_TYP = '2fa-challenge';
const CHALLENGE_TTL = '5m';
const MAX_CODE_FAILS = 5;

const SECRET_SELECT = '+twoFactor.secretEnc +twoFactor.recoveryHashes';

/** Short-lived, single-purpose JWT. `typ` is not 'user', so protect() rejects it. */
function signChallenge(user) {
    return signTypedToken(
        CHALLENGE_TYP,
        { id: String(user._id), role: user.role, tv: Number(user.tokenVersion) || 0 },
        { expiresIn: CHALLENGE_TTL },
    );
}

const lockKeyFor = (userId) => `2fa:${String(userId)}`;

const fail = (res, status, code, message, extra = {}) =>
    res.status(status).json({ success: false, code, message, ...extra });

async function isLocked(userId) {
    const lock = await loginAttempts.getLock(lockKeyFor(userId));
    return (lock.fails || 0) >= MAX_CODE_FAILS;
}

/** Count a wrong code; returns true when the account is now locked. */
async function recordCodeFailure(req, userId) {
    try {
        const r = await loginAttempts.recordFailure(lockKeyFor(userId), { ip: req.ip, exempt: true });
        if (r.fails === MAX_CODE_FAILS) {
            logger.warn('auth.2fa.locked', { userId: String(userId), fails: r.fails, ip: req.ip });
        }
        return r.fails >= MAX_CODE_FAILS;
    } catch (err) {
        logger.error('auth.2fa.record-failure-error', { error: err.message });
        return false;
    }
}

const lockedResponse = (res) => {
    const secs = Math.ceil(loginAttempts.lockMs() / 1000);
    res.set('Retry-After', String(secs));
    return fail(res, 429, 'TWO_FA_LOCKED', 'Too many incorrect codes. Try again in 15 minutes.');
};

async function loadSelf(req) {
    return User.findById(req.user._id).select(`+password ${SECRET_SELECT}`);
}

/**
 * Check a TOTP code against a loaded user (with secret) and consume the
 * step atomically (replay-safe). Returns true / false.
 */
async function consumeTotp(user, code) {
    if (!user.twoFactor?.secretEnc) return false;
    let secret;
    try { secret = totp.decryptSecret(user.twoFactor.secretEnc); } catch (err) {
        logger.error('auth.2fa.decrypt-failed', { userId: String(user._id) });
        return false;
    }
    const step = totp.verifyCode(secret, code, { lastUsedStep: user.twoFactor.lastUsedStep || 0 });
    if (step === null) return false;
        // AUDIT-EXEMPT: acts on the caller's own user row (_id from the authenticated session)
    const r = await User.updateOne(
        { _id: user._id, $or: [{ 'twoFactor.lastUsedStep': { $lt: step } }, { 'twoFactor.lastUsedStep': { $exists: false } }] },
        { $set: { 'twoFactor.lastUsedStep': step } },
    );
    return (r?.modifiedCount ?? r?.nModified ?? 0) > 0;
}

/** Check a recovery code and burn it (single use, atomic). */
async function consumeRecovery(user, code) {
    const hashes = user.twoFactor?.recoveryHashes || [];
    const idx = totp.findRecoveryIndex(hashes, code);
    if (idx < 0) return false;
        // AUDIT-EXEMPT: acts on the caller's own user row (_id from the authenticated session)
    const r = await User.updateOne(
        { _id: user._id, 'twoFactor.recoveryHashes': hashes[idx] },
        { $pull: { 'twoFactor.recoveryHashes': hashes[idx] } },
    );
    return (r?.modifiedCount ?? r?.nModified ?? 0) > 0;
}

const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);

/** Either a TOTP code or a recovery code. */
async function consumeAnyCode(user, body) {
    const code = strOrNull(body?.code);
    const rec = strOrNull(body?.recoveryCode);
    if (code && (await consumeTotp(user, code))) return 'totp';
    if (rec && (await consumeRecovery(user, rec))) return 'recovery';
    return null;
}

// ─── GET /status ─────────────────────────────────────────────────────────────
exports.status = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('+twoFactor.recoveryHashes');
        const eligible = totp.eligibleRole(user.role);
        const enabled = !!user.twoFactor?.enabled;
        return res.json({
            success: true,
            eligible,
            enabled,
            setupRequired: eligible && !enabled && totp.requiredRoles().includes(user.role),
            verifiedAt: user.twoFactor?.verifiedAt || null,
            recoveryCodesRemaining: enabled ? (user.twoFactor?.recoveryHashes || []).length : 0,
        });
    } catch (err) {
        logger.error('auth.2fa.status-error', { error: err.message });
        return fail(res, 500, 'SERVER_ERROR', 'Could not load two-factor status');
    }
};

// ─── POST /setup ─────────────────────────────────────────────────────────────
exports.setup = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!totp.eligibleRole(user.role)) {
            return fail(res, 403, 'TWO_FA_NOT_AVAILABLE', 'Two-factor authentication is available for owner and admin accounts only.');
        }
        if (user.twoFactor?.enabled) {
            return fail(res, 409, 'TWO_FA_ALREADY_ENABLED', 'Two-factor authentication is already enabled. Disable it first to re-enrol.');
        }
        const secret = totp.generateSecret();
        // AUDIT-EXEMPT: acts on the caller's own user row (_id from the authenticated session)
        await User.updateOne(
            { _id: user._id },
            { $set: { 'twoFactor.enabled': false, 'twoFactor.secretEnc': totp.encryptSecret(secret), 'twoFactor.lastUsedStep': 0 } },
        );
        const uri = totp.otpauthUri(user.email, secret);
        const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, secret, otpauthUri: uri, qrDataUrl });
    } catch (err) {
        logger.error('auth.2fa.setup-error', { error: err.message });
        return fail(res, 500, 'SERVER_ERROR', 'Could not start two-factor setup');
    }
};

// ─── POST /enable ────────────────────────────────────────────────────────────
exports.enable = async (req, res) => {
    try {
        const user = await loadSelf(req);
        if (!totp.eligibleRole(user.role)) return fail(res, 403, 'TWO_FA_NOT_AVAILABLE', 'Two-factor authentication is not available for this account.');
        if (user.twoFactor?.enabled) return fail(res, 409, 'TWO_FA_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
        if (!user.twoFactor?.secretEnc) return fail(res, 400, 'TWO_FA_NOT_STARTED', 'Start setup first.');
        if (await isLocked(user._id)) return lockedResponse(res);

        const secret = totp.decryptSecret(user.twoFactor.secretEnc);
        const step = totp.verifyCode(secret, req.body?.code, { lastUsedStep: 0 });
        if (step === null) {
            const locked = await recordCodeFailure(req, user._id);
            return locked ? lockedResponse(res) : fail(res, 400, 'INVALID_CODE', 'That code is not correct. Check your authenticator app and try again.');
        }
        const codes = totp.generateRecoveryCodes();
        // AUDIT-EXEMPT: acts on the caller's own user row (_id from the authenticated session)
        const r = await User.updateOne(
            { _id: user._id, 'twoFactor.enabled': { $ne: true } },
            { $set: {
                'twoFactor.enabled': true,
                'twoFactor.verifiedAt': new Date(),
                'twoFactor.lastUsedStep': step,
                'twoFactor.recoveryHashes': codes.map(totp.hashRecoveryCode),
            } },
        );
        if (!((r?.modifiedCount ?? r?.nModified ?? 0) > 0)) return fail(res, 409, 'TWO_FA_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
        try { await loginAttempts.clear(lockKeyFor(user._id)); } catch (_) { /* best effort */ }
        logger.info('auth.2fa.enabled', { userId: String(user._id) });
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, recoveryCodes: codes });
    } catch (err) {
        logger.error('auth.2fa.enable-error', { error: err.message });
        return fail(res, 500, 'SERVER_ERROR', 'Could not enable two-factor authentication');
    }
};

// ─── POST /disable ───────────────────────────────────────────────────────────
exports.disable = async (req, res) => {
    try {
        const user = await loadSelf(req);
        if (!user.twoFactor?.enabled) return fail(res, 400, 'TWO_FA_NOT_ENABLED', 'Two-factor authentication is not enabled.');
        if (await isLocked(user._id)) return lockedResponse(res);
        const password = req.body?.password;
        const pwOk = typeof password === 'string' && password && user.password && (await user.comparePassword(password));
        const codeOk = pwOk ? await consumeAnyCode(user, req.body) : null;
        if (!pwOk || !codeOk) {
            const locked = await recordCodeFailure(req, user._id);
            return locked ? lockedResponse(res) : fail(res, 400, 'INVALID_CREDENTIALS', 'Password or code is not correct.');
        }
        // AUDIT-EXEMPT: acts on the caller's own user row (_id from the authenticated session)
        await User.updateOne(
            { _id: user._id },
            { $set: { 'twoFactor.enabled': false, 'twoFactor.lastUsedStep': 0 }, $unset: { 'twoFactor.secretEnc': '', 'twoFactor.recoveryHashes': '', 'twoFactor.verifiedAt': '' } },
        );
        try { await loginAttempts.clear(lockKeyFor(user._id)); } catch (_) { /* best effort */ }
        logger.info('auth.2fa.disabled', { userId: String(user._id) });
        return res.json({ success: true });
    } catch (err) {
        logger.error('auth.2fa.disable-error', { error: err.message });
        return fail(res, 500, 'SERVER_ERROR', 'Could not disable two-factor authentication');
    }
};

// ─── POST /recovery/regenerate ───────────────────────────────────────────────
exports.regenerateRecovery = async (req, res) => {
    try {
        const user = await loadSelf(req);
        if (!user.twoFactor?.enabled) return fail(res, 400, 'TWO_FA_NOT_ENABLED', 'Two-factor authentication is not enabled.');
        if (await isLocked(user._id)) return lockedResponse(res);
        // A fresh authenticator code is required (recovery codes are not accepted here).
        if (!(await consumeTotp(user, req.body?.code))) {
            const locked = await recordCodeFailure(req, user._id);
            return locked ? lockedResponse(res) : fail(res, 400, 'INVALID_CODE', 'That code is not correct.');
        }
        const codes = totp.generateRecoveryCodes();
        await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.recoveryHashes': codes.map(totp.hashRecoveryCode) } });
        logger.info('auth.2fa.recovery-regenerated', { userId: String(user._id) });
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, recoveryCodes: codes });
    } catch (err) {
        logger.error('auth.2fa.regenerate-error', { error: err.message });
        return fail(res, 500, 'SERVER_ERROR', 'Could not regenerate recovery codes');
    }
};

// ─── POST /reset (admin) ─────────────────────────────────────────────────────
exports.adminReset = async (req, res) => {
    try {
        const actor = req.user;
        const targetId = strOrNull(req.body?.userId);
        if (!targetId || !/^[a-f0-9]{24}$/i.test(targetId)) return fail(res, 400, 'INVALID_USER', 'userId is required.');
        if (String(actor._id) === targetId) return fail(res, 400, 'USE_DISABLE', 'Use "Disable" to turn off your own two-factor authentication.');

        const isSuper = actor.role === 'superadmin';
        const isOwner = actor.role === 'admin' && actor.isTenantOwner === true && !!actor.restaurant;
        if (!isSuper && !isOwner) return fail(res, 403, 'FORBIDDEN', 'Only the restaurant owner or a super admin can reset two-factor authentication.');

        const filter = isSuper ? { _id: targetId } : { _id: targetId, restaurant: actor.restaurant, role: 'admin' };
        const target = await User.findOne(filter).select('_id role');
        if (!target) return fail(res, 404, 'NOT_FOUND', 'User not found.');

        // AUDIT-EXEMPT: target already resolved by the tenant-scoped lookup above
        await User.updateOne(
            { _id: target._id },
            { $set: { 'twoFactor.enabled': false, 'twoFactor.lastUsedStep': 0 }, $unset: { 'twoFactor.secretEnc': '', 'twoFactor.recoveryHashes': '', 'twoFactor.verifiedAt': '' } },
        );
        // Bump tokenVersion + revoke refresh sessions (shared helper).
        await require('./authController').revokeAllSessions(target._id);
        try { await loginAttempts.clear(lockKeyFor(target._id)); } catch (_) { /* best effort */ }
        logger.warn('auth.2fa.admin-reset', { actorId: String(actor._id), targetId: String(target._id) });
        return res.json({ success: true });
    } catch (err) {
        logger.error('auth.2fa.reset-error', { error: err.message });
        return fail(res, 500, 'SERVER_ERROR', 'Could not reset two-factor authentication');
    }
};

// ─── POST /verify (public) ───────────────────────────────────────────────────
exports.verify = async (req, res) => {
    try {
        const token = strOrNull(req.body?.challengeToken);
        if (!token) return fail(res, 400, 'INVALID_CHALLENGE', 'Sign in again.');
        let decoded;
        try { decoded = verifyTypedToken(token, CHALLENGE_TYP); } catch (_) {
            return fail(res, 401, 'INVALID_CHALLENGE', 'This sign-in step has expired. Please sign in again.');
        }
        if (!decoded?.id || decoded.typ !== CHALLENGE_TYP) return fail(res, 401, 'INVALID_CHALLENGE', 'Please sign in again.');

        // AUDIT-EXEMPT: pre-session challenge: identity comes from the signed challenge token
        const user = await User.findById(decoded.id).select(SECRET_SELECT);
        if (!user || (Number(user.tokenVersion) || 0) !== (Number(decoded.tv) || 0)
            || user.status === 'inactive' || !user.twoFactor?.enabled || !totp.eligibleRole(user.role)) {
            return fail(res, 401, 'INVALID_CHALLENGE', 'Please sign in again.');
        }
        if (await isLocked(user._id)) return lockedResponse(res);

        const hashesBefore = (user.twoFactor.recoveryHashes || []).length;
        const how = await consumeAnyCode(user, req.body);
        if (!how) {
            const locked = await recordCodeFailure(req, user._id);
            return locked ? lockedResponse(res) : fail(res, 401, 'INVALID_CODE', 'That code is not correct.');
        }
        try { await loginAttempts.clear(lockKeyFor(user._id)); } catch (_) { /* best effort */ }

        const extra = {};
        if (how === 'recovery') {
            const left = Math.max(0, hashesBefore - 1);
            extra.recoveryCodesRemaining = left;
            logger.warn('auth.2fa.recovery-used', { userId: String(user._id), remaining: left });
        }
        return await require('./authController').completeLogin(req, res, user, extra);
    } catch (err) {
        logger.error('auth.2fa.verify-error', { error: err.message });
        return fail(res, 500, 'SERVER_ERROR', 'Verification failed');
    }
};

exports.signChallenge = signChallenge;
exports.CHALLENGE_TYP = CHALLENGE_TYP;
exports.MAX_CODE_FAILS = MAX_CODE_FAILS;
