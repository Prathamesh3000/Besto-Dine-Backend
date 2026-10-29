const mongoose = require('mongoose');

/**
 * PayrollRun - a simple payroll run for a period (attendance + wallet payout).
 * Not statutory payroll: no PF / ESI / TDS.
 *
 * draft -> finalized (numbers locked) -> paid.
 *
 * `locked` is true once finalized/paid. The partial unique index below makes
 * the same staff + exact period appear in at most one locked run; overlapping
 * (non-identical) periods are rejected by the service.
 */
const lineSchema = new mongoose.Schema({
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    staffName: { type: String, default: '' },
    role: { type: String, default: '' },
    payType: { type: String, enum: ['monthly', 'daily', 'hourly'], required: true },
    baseRate: { type: Number, required: true, min: 0 },
    overtimeRate: { type: Number, default: null },
    daysPresent: { type: Number, default: 0, min: 0 },
    hours: { type: Number, default: 0, min: 0 },
    regularHours: { type: Number, default: 0, min: 0 },
    overtimeHours: { type: Number, default: 0, min: 0 },
    basePay: { type: Number, default: 0, min: 0 },
    overtimePay: { type: Number, default: 0, min: 0 },
    incentives: { type: Number, default: 0, min: 0 },
    incentiveEntryIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    tipsPaidOut: { type: Number, default: 0, min: 0 },   // informational only
    advances: { type: Number, default: 0, min: 0 },
    deductions: { type: Number, default: 0, min: 0 },
    adjustmentNote: { type: String, default: '', maxlength: 300 },
    grossPay: { type: Number, default: 0, min: 0 },
    netPay: { type: Number, default: 0, min: 0 },
    warnings: { type: [String], default: [] },
}, { _id: true });

const payrollRunSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    periodStart: { type: String, required: true },   // business date YYYY-MM-DD (inclusive)
    periodEnd: { type: String, required: true },     // business date YYYY-MM-DD (inclusive)
    timezone: { type: String, default: 'Asia/Kolkata' },
    status: { type: String, enum: ['draft', 'finalized', 'paid'], default: 'draft' },
    locked: { type: Boolean, default: false },
    lines: { type: [lineSchema], default: [] },
    totals: {
        type: new mongoose.Schema({
            staffCount: { type: Number, default: 0 },
            basePay: { type: Number, default: 0 },
            overtimePay: { type: Number, default: 0 },
            incentives: { type: Number, default: 0 },
            advances: { type: Number, default: 0 },
            deductions: { type: Number, default: 0 },
            netPay: { type: Number, default: 0 },
        }, { _id: false }),
        default: () => ({}),
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    finalizedAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paidAt: { type: Date, default: null },
    payoutMethod: { type: String, enum: ['wallet', 'cash', 'bank', null], default: null },
    payoutReference: { type: String, default: '', maxlength: 120 },
}, { timestamps: true });

payrollRunSchema.index({ restaurant: 1, periodStart: -1, status: 1 });
payrollRunSchema.index(
    { restaurant: 1, 'lines.staff': 1, periodStart: 1, periodEnd: 1 },
    { unique: true, partialFilterExpression: { locked: true }, name: 'payroll_staff_period_once' },
);

payrollRunSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('PayrollRun', payrollRunSchema);
