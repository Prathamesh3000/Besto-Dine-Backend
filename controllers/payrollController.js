'use strict';
/**
 * Payroll controller (simple payroll: attendance + wallet payout; not
 * statutory payroll). Thin HTTP layer over services/payroll/payrollService.
 */
const svc = require('../services/payroll/payrollService');
const logger = require('../utils/logger');
const { tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { recordTenantAudit } = require('../services/tenantAuditService');

const ctxOf = (req) => ({
    restaurantId: tenantId(req),
    timezone: req.restaurant?.timezone,
    actorId: req.user?._id,
    pinnedBranchId: pinnedBranchId(req) || null,
});

function fail(res, err, what) {
    if (err && err.status) {
        return res.status(err.status).json({ success: false, message: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    logger.error(`payroll ${what} error:`, { error: err && err.message });
    return res.status(500).json({ success: false, message: `Failed to ${what}.` });
}

function audit(req, entityId, summary, after) {
    try {
        recordTenantAudit(req, { action: 'other', entityType: 'PayrollRun', entityId: String(entityId), summary, after });
    } catch { /* audit must never break payroll */ }
}

const wrap = (what, fn) => async (req, res) => {
    try {
        const ctx = ctxOf(req);
        if (!ctx.restaurantId) return res.status(400).json({ success: false, message: 'Restaurant context required.' });
        return await fn(req, res, ctx);
    } catch (err) {
        return fail(res, err, what);
    }
};

exports.listProfiles = wrap('load pay profiles', async (req, res, ctx) => {
    res.json({ success: true, staff: await svc.listProfiles(ctx) });
});

exports.upsertProfile = wrap('save pay profile', async (req, res, ctx) => {
    const profile = await svc.upsertProfile(ctx, req.params.staffId, req.body);
    res.json({ success: true, profile });
});

exports.listRuns = wrap('load payroll runs', async (req, res, ctx) => {
    res.json({ success: true, runs: await svc.listRuns(ctx) });
});

exports.createRun = wrap('create payroll run', async (req, res, ctx) => {
    const { run, skipped } = await svc.createDraft(ctx, req.body);
    res.status(201).json({ success: true, run, skipped });
});

exports.getRun = wrap('load payroll run', async (req, res, ctx) => {
    res.json({ success: true, run: await svc.getRun(ctx, req.params.id) });
});

exports.updateAdjustments = wrap('update payroll adjustments', async (req, res, ctx) => {
    const run = await svc.updateAdjustments(ctx, req.params.id, req.body?.adjustments);
    res.json({ success: true, run });
});

exports.finalize = wrap('finalize payroll run', async (req, res, ctx) => {
    const run = await svc.finalize(ctx, req.params.id);
    audit(req, run._id, `Payroll finalized ${run.periodStart} to ${run.periodEnd}`, { status: run.status, totals: run.totals });
    res.json({ success: true, run });
});

exports.pay = wrap('mark payroll paid', async (req, res, ctx) => {
    const out = await svc.markPaid(ctx, req.params.id, req.body);
    if (!out.alreadyPaid) {
        audit(req, out.run._id, `Payroll paid via ${out.run.payoutMethod}`, { status: out.run.status, method: out.run.payoutMethod, totals: out.run.totals });
    }
    res.json({ success: true, run: out.run, alreadyPaid: out.alreadyPaid, credited: out.credited });
});

exports.exportCsv = wrap('export payroll', async (req, res, ctx) => {
    const run = await svc.getRun(ctx, req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${run.periodStart}-${run.periodEnd}.csv"`);
    res.send(svc.toCsv(run));
});

exports.payslip = wrap('load payslip', async (req, res, ctx) => {
    const run = await svc.getRun(ctx, req.params.id);
    const name = req.restaurant?.name || '';
    if (String(req.query.format) === 'html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(svc.payslipHtml(run, req.params.staffId, name));
    }
    return res.json({ success: true, payslip: svc.payslipJson(run, req.params.staffId, name) });
});
