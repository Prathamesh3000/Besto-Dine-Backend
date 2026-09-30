const mongoose = require('mongoose');

// CRIT-16 — Idempotency records for payment-sensitive endpoints.
//
// Callers send an Idempotency-Key header (stable across retries). The
// first request executes and we persist the final response here. Every
// retry with the same key replays the cached response byte-for-byte so
// a flaky network cannot mark an order as paid twice or double-credit
// a wallet recharge.
//
// TTL: 24 hours. The Idempotency-Key contract is "treat this as one
// logical request for the next 24h"; longer windows would store too
// much traffic for no practical benefit.
const idempotencyRecordSchema = new mongoose.Schema({
    // NOT the raw client header: middlewares/idempotency.js stores
    // sha256(caller identity | tenant | method | path | client key), so
    // the global unique index is effectively per-caller-per-endpoint and
    // one caller can never replay another caller's cached response.
    key: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    endpoint: {
        type: String,
        required: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        default: null,
    },
    statusCode: {
        type: Number,
        default: 200,
    },
    response: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 60 * 60 * 24, // 24h TTL — Mongo auto-deletes
    },
});

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
