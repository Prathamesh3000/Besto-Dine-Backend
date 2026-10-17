const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { register, login, getMe, updateProfile, changePassword, sendOtp, verifyOtp, uploadAvatar, logout, logoutAll, refresh, forgotPassword, resetPassword, googleLogin } = require('../controllers/authController');
const { makeLimiter } = require('../utils/rateLimitStore');
const { protect } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');

// ─── Shared validation-result handler ────────────────────────────────────────
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }
    return next();
};

// Public routes
// `.isString().bail()` first: a non-string (an object such as
// `{ "$ne": null }` — reduced to `{}` by the operator sanitizer — or an
// array) must be a 400 here, not reach bcrypt / .trim() and become a 500.
router.post('/register',
    body('name').isString().withMessage('Name is required').bail().trim().notEmpty().withMessage('Name is required'),
    body('email').isString().withMessage('Please provide a valid email address').bail().trim().isEmail().withMessage('Please provide a valid email address'),
    body('password').isString().withMessage('Password must be at least 8 characters').bail().isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('mobile').isString().withMessage('Mobile number is required').bail().trim().notEmpty().withMessage('Mobile number is required'),
    validate,
    register
);
router.post('/login',
    body('email').isString().withMessage('Please provide a valid email address').bail().trim().isEmail().withMessage('Please provide a valid email address'),
    body('password').isString().withMessage('Password is required').bail().notEmpty().withMessage('Password is required'),
    validate,
    login
);
// ─── Password reset ──────────────────────────────────────────────────
// There was previously no customer reset path at all; the login page's
// "Forgot password?" link showed a toast and did nothing.
//
// IP-level limiter on top of the per-account throttle in the handler
// (3 / 15 min per account): the handler's limit is keyed on a real
// account, so it does nothing against someone spraying addresses that
// don't exist. 30 / 15 min per IP — a restaurant's staff share one
// public IP, and the old cap of 5 blocked the 6th colleague's reset
// (LOGIN_THROTTLING_PROPOSAL.md). Every reply is a generic 200, so
// skipSuccessfulRequests cannot be used here: all requests count.
const forgotPasswordLimiter = makeLimiter({ name: 'auth-forgot',
    windowMs: 15 * 60 * 1000,
    max: require('../utils/authLimiters').FORGOT_IP_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many reset requests. Please try again in 15 minutes.' },
});

router.post('/forgot-password',
    forgotPasswordLimiter,
    body('email').isString().withMessage('Please provide a valid email address').bail().trim().isEmail().withMessage('Please provide a valid email address'),
    validate,
    forgotPassword
);

// Not rate-limited by email (the caller holds a token, not an address).
// The token itself is 256 bits of entropy, single-use and 30-minute
// TTL, so guessing is not a realistic attack surface.
router.post('/reset-password',
    body('token').isString().withMessage('Reset token is required').bail().notEmpty().withMessage('Reset token is required'),
    body('newPassword').isString().withMessage('Password must be at least 8 characters').bail().isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    validate,
    resetPassword
);

// ─── Google Sign-In ──────────────────────────────────────────────────
// Takes the ID token Google Identity Services hands the browser. No
// client secret is involved — this is the ID-token flow, so there is
// no access token to obtain and nothing secret to store server-side.
//
// Rate-limited because each call triggers signature verification and,
// on a cold cache, an outbound fetch of Google's public keys. Generous
// enough that a customer retrying a flaky sign-in is never blocked.
const googleAuthLimiter = makeLimiter({ name: 'auth-google',
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many sign-in attempts. Please try again shortly.' },
});

router.post('/google', googleAuthLimiter, googleLogin);

router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);

// #28 — swap a refresh token for a new access + refresh token pair.
// Public: the access token is usually already expired when this is
// called. Per-IP limiter is generous (a restaurant's staff share one IP).
const refreshLimiter = makeLimiter({ name: 'auth-refresh',
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again shortly.' },
});
router.post('/refresh', refreshLimiter, refresh);

// Revokes the presented refresh token + clears the CRIT-08 cookie.
// Idempotent, always succeeds.
router.post('/logout', logout);
// #15 — end every session of the current user on every device.
router.post('/logout-all', protect, logoutAll);

// Protected — refreshes session data from DB (used by AuthContext on app load)
router.get('/me', protect, getMe);
router.put('/profile', protect, updateProfile);
router.post('/avatar', protect, upload.single('image'), uploadAvatar);
router.put('/change-password',
    protect,
    body('currentPassword').isString().withMessage('Current password is required').bail().notEmpty().withMessage('Current password is required'),
    body('newPassword').isString().withMessage('New password must be at least 8 characters').bail().isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    validate,
    changePassword
);

module.exports = router;
