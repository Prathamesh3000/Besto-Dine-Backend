const mongoose = require('mongoose');

/**
 * StaffPayProfile - per-staff pay settings for simple payroll runs
 * (attendance + wallet payout only; NOT statutory payroll).
 *
 *   monthly : baseRate = salary for a full month (prorated by attendance)
 *   daily   : baseRate = pay per day present
 *   hourly  : baseRate = pay per regular hour
 *
 * Managed by admin/owner only. One profile per (restaurant, staff).
 */
const staffPayProfileSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    payType: { type: String, enum: ['monthly', 'daily', 'hourly'], required: true },
    baseRate: { type: Number, required: true, min: 0, max: 10000000 },
    // Rate per overtime hour. null = no extra overtime pay (hourly staff then
    // get overtime hours at baseRate).
    overtimeRate: { type: Number, default: null, min: 0, max: 100000 },
    // Hours per business day after which time counts as overtime.
    overtimeThresholdHours: { type: Number, default: 8, min: 1, max: 24 },
    // Monthly pay only: expected working days in a full month (default 26).
    workingDaysPerMonth: { type: Number, default: 26, min: 1, max: 31 },
    active: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

staffPayProfileSchema.index({ restaurant: 1, staff: 1 }, { unique: true });

staffPayProfileSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('StaffPayProfile', staffPayProfileSchema);
