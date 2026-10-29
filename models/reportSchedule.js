const mongoose = require('mongoose');

// Scheduled emailed reports (services/reportScheduleService.js).
// One doc = "email <type> to <recipients> every <frequency> around <hour>
// (tenant timezone)". lastPeriodKey is the period most recently CLAIMED
// for sending (e.g. '2026-10-28' for a daily report); the job claims it
// with an atomic conditional update before emailing, which is what makes a
// period send at most once even with several app instances.
const reportScheduleSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    type: { type: String, enum: ['daily-sales', 'gst-summary'], required: true },
    frequency: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
    // Local hour (tenant timezone) after which the report may be sent.
    hour: { type: Number, default: 8, min: 0, max: 23 },
    recipients: { type: [{ type: String, trim: true, lowercase: true, maxlength: 254 }], default: [] },
    enabled: { type: Boolean, default: true },
    lastRunAt: { type: Date, default: null },
    lastPeriodKey: { type: String, default: '' },
    lastError: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

reportScheduleSchema.index({ restaurant: 1, enabled: 1 });

// Auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
reportScheduleSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.models.ReportSchedule || mongoose.model('ReportSchedule', reportScheduleSchema);
