const mongoose = require('mongoose');

/**
 * PayrollPayout - one row per (run, staff) wallet credit. The unique index is
 * the idempotency guard: the row is inserted in the SAME mongo transaction as
 * the wallet credit, so a retry can never credit the same line twice.
 */
const payrollPayoutSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollRun', required: true },
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['wallet'], default: 'wallet' },
    reference: { type: String, required: true },     // `${run}:${staff}`
}, { timestamps: true });

payrollPayoutSchema.index({ restaurant: 1, run: 1, staff: 1 }, { unique: true });
payrollPayoutSchema.index({ restaurant: 1, reference: 1 }, { unique: true });

payrollPayoutSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('PayrollPayout', payrollPayoutSchema);
