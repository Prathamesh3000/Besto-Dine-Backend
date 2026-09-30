const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    // Normalised 10-digit mobile (see normalizeMobile in authController).
    mobile: {
        type: String,
        required: true,
        index: true,
    },
    // #11 — HMAC-SHA256 of the 6-digit code (hex), never the code itself.
    // Rows written before #11 hold a plain 4-digit code; verifyOtp
    // tolerates those until they expire (5 minutes).
    code: {
        type: String,
        required: true,
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: 0 }, // TTL index — MongoDB auto-deletes expired docs
    },
    verified: {
        type: Boolean,
        default: false,
    },
    // CRIT-10 / #11 — attempt cap. `attempts` is only ever changed with an
    // atomic $inc whose filter includes `attempts < MAX`, so concurrent
    // guesses cannot exceed the cap. When the cap is hit the code is
    // burned (verified=true) and a new code must be requested.
    attempts: {
        type: Number,
        default: 0,
    },
    lockedUntil: {
        type: Date,
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Otp = mongoose.model('Otp', otpSchema);

// #11 — per-mobile daily send counter. Otp rows are reaped by TTL five
// minutes after issue, so they cannot be used to count sends over a day.
// One row per (mobile, UTC day), incremented atomically with $inc.
const otpSendCounterSchema = new mongoose.Schema({
    mobile: { type: String, required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (UTC)
    count: { type: Number, default: 0 },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: 0 },
    },
});
otpSendCounterSchema.index({ mobile: 1, day: 1 }, { unique: true });

const OtpSendCounter = mongoose.model('OtpSendCounter', otpSendCounterSchema);

module.exports = Otp;
module.exports.OtpSendCounter = OtpSendCounter;
