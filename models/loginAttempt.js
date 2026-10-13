const mongoose = require('mongoose');

/**
 * Per-account failed-login counters (collection `login_attempts`).
 *
 * One row per account key (see utils/loginAttempts.accountKey):
 *   `<restaurantId>:<email>`  staff of a tenant
 *   `customer:<email>`        customers (global identity)
 *   `superadmin:<email>`      super admins (counted + warned, never locked)
 *
 * Only FAILED password checks create / touch a row; a successful login
 * deletes it. Rows live in MongoDB (not the rate-limit store) so every
 * backend instance sees the same count and a restart does not reset it.
 *
 * `expiresAt` is the TTL field (pattern: models/passwordResetToken.js,
 * models/otp.js): it is the end of the counting window while the account
 * is merely counting, and `lockedUntil` once the account is locked, so a
 * lock can never outlive its own expiry — no permanent lockouts.
 */
const loginAttemptSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    fails: { type: Number, default: 0 },
    firstFailAt: { type: Date, required: true },
    lastFailAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    // Last IP that failed — for the lock warning, never for a decision.
    lastIp: { type: String, default: '' },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: 0 }, // TTL — MongoDB drops expired docs
    },
}, { collection: 'login_attempts', versionKey: false });

module.exports = mongoose.model('LoginAttempt', loginAttemptSchema);
