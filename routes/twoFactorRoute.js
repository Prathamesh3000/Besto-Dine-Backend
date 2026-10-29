const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { makeLimiter } = require('../utils/rateLimitStore');
const { AUTH_IP_LIMIT, WINDOW_MS } = require('../utils/authLimiters');
const c = require('../controllers/twoFactorController');

// Per-IP backstop (failed attempts only). The per-account lockout (5 wrong
// codes, utils/loginAttempts.js) is the real brute-force stop.
const twoFaLimiter = makeLimiter({
    name: 'auth-2fa',
    windowMs: WINDOW_MS,
    max: AUTH_IP_LIMIT,
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Public: the caller holds a short-lived challenge token, not a session.
router.post('/verify', twoFaLimiter, c.verify);

router.get('/status', protect, c.status);
router.post('/setup', protect, c.setup);
router.post('/enable', protect, twoFaLimiter, c.enable);
router.post('/disable', protect, twoFaLimiter, c.disable);
router.post('/recovery/regenerate', protect, twoFaLimiter, c.regenerateRecovery);
router.post('/reset', protect, c.adminReset);

module.exports = router;
