/**
 * CRUD for emailed report schedules (models/reportSchedule.js).
 * Sending itself is done by services/reportScheduleService.js.
 */
const ReportSchedule = require('../models/reportSchedule');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { tenantId } = require('../utils/tenantScope');
const { safeTz } = require('../utils/reportDates');
const { validateRecipients, duePeriod, MAX_SCHEDULES_PER_TENANT } = require('../services/reportScheduleService');

const TYPES = ['daily-sales', 'gst-summary'];
const FREQS = ['daily', 'weekly', 'monthly'];

function needTenant(req) {
    const id = tenantId(req);
    if (!id) throw AppError.badRequest('A restaurant context is required', 'TENANT_REQUIRED');
    return id;
}

function parseHour(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 23) throw AppError.badRequest('hour must be 0 to 23', 'BAD_HOUR');
    return n;
}

const shape = (s) => ({
    _id: s._id, type: s.type, frequency: s.frequency, hour: s.hour, recipients: s.recipients,
    enabled: s.enabled, lastRunAt: s.lastRunAt, lastError: s.lastError, createdAt: s.createdAt,
});

exports.list = asyncHandler(async (req, res) => {
    const schedules = await ReportSchedule.find({ restaurant: needTenant(req) }).sort({ createdAt: -1 }).limit(MAX_SCHEDULES_PER_TENANT + 5).lean();
    res.json({ success: true, schedules: schedules.map(shape), limit: MAX_SCHEDULES_PER_TENANT });
}, 'Failed to load report schedules');

exports.create = asyncHandler(async (req, res) => {
    const restaurantId = needTenant(req);
    const { type, frequency } = req.body || {};
    if (!TYPES.includes(type)) throw AppError.badRequest('Unknown report type', 'BAD_TYPE');
    if (!FREQS.includes(frequency)) throw AppError.badRequest('Unknown frequency', 'BAD_FREQUENCY');
    const hour = req.body.hour === undefined ? 8 : parseHour(req.body.hour);
    const v = validateRecipients(req.body.recipients);
    if (v.error) throw AppError.badRequest(v.error, 'BAD_RECIPIENTS');

    const count = await ReportSchedule.countDocuments({ restaurant: restaurantId });
    if (count >= MAX_SCHEDULES_PER_TENANT) {
        throw AppError.badRequest(`You can have at most ${MAX_SCHEDULES_PER_TENANT} report schedules`, 'SCHEDULE_LIMIT');
    }
    // Start counting from the next boundary: do not mail a past period right away.
    const first = duePeriod({ frequency, hour }, new Date(), safeTz(req.restaurant?.timezone));
    const doc = await ReportSchedule.create({
        restaurant: restaurantId, type, frequency, hour, recipients: v.recipients,
        enabled: true, lastPeriodKey: first.key, createdBy: req.user?._id || null,
    });
    res.status(201).json({ success: true, schedule: shape(doc) });
}, 'Failed to create report schedule');

exports.update = asyncHandler(async (req, res) => {
    const restaurantId = needTenant(req);
    const body = req.body || {};
    const $set = {};
    if (body.enabled !== undefined) $set.enabled = !!body.enabled;
    if (body.hour !== undefined) $set.hour = parseHour(body.hour);
    if (body.frequency !== undefined) {
        if (!FREQS.includes(body.frequency)) throw AppError.badRequest('Unknown frequency', 'BAD_FREQUENCY');
        $set.frequency = body.frequency;
    }
    if (body.recipients !== undefined) {
        const v = validateRecipients(body.recipients);
        if (v.error) throw AppError.badRequest(v.error, 'BAD_RECIPIENTS');
        $set.recipients = v.recipients;
    }
    if (!Object.keys($set).length) throw AppError.badRequest('Nothing to update', 'NO_CHANGES');
    if ($set.enabled === true || $set.frequency || $set.hour !== undefined) {
        // Re-enabling / re-timing must not replay periods that passed while it was off.
        const cur = await ReportSchedule.findOne({ _id: req.params.id, restaurant: restaurantId }).lean();
        if (!cur) throw AppError.notFound('Schedule not found');
        const next = { ...cur, ...$set };
        if (next.enabled) $set.lastPeriodKey = duePeriod(next, new Date(), safeTz(req.restaurant?.timezone)).key;
    }
    const doc = await ReportSchedule.findOneAndUpdate({ _id: req.params.id, restaurant: restaurantId }, { $set }, { returnDocument: 'after' });
    if (!doc) throw AppError.notFound('Schedule not found');
    res.json({ success: true, schedule: shape(doc) });
}, 'Failed to update report schedule');

exports.remove = asyncHandler(async (req, res) => {
    const r = await ReportSchedule.deleteOne({ _id: req.params.id, restaurant: needTenant(req) });
    if (!r.deletedCount) throw AppError.notFound('Schedule not found');
    res.json({ success: true });
}, 'Failed to delete report schedule');
