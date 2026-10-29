/**
 * GST summary, Tally export and tax-export settings (routes/reportsRoute.js).
 * EXPORT AIDS ONLY: not a GST return, not a filing tool. See
 * utils/gstReport.js. Builders are pure; this file does request plumbing.
 */
const Settings = require('../models/settings');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { tenantId, analyticsBranchFilter } = require('../utils/tenantScope');
const { resolveRange, safeTz } = require('../utils/reportDates');
const { gstReportCsv, gstReportXlsx } = require('../utils/gstReport');
const { buildTallyXml, DEFAULT_LEDGERS } = require('../utils/tallyExport');
const svc = require('../services/gstReportService');

const HSN_RE = /^\d{4,8}$/;

function needTenant(req) {
    const id = tenantId(req);
    if (!id) throw AppError.badRequest('A restaurant context is required', 'TENANT_REQUIRED');
    return id;
}

async function prepare(req) {
    const restaurantId = needTenant(req);
    const tenant = await svc.loadTenantTaxContext(restaurantId);
    const tz = safeTz(req.restaurant?.timezone || tenant.tz);
    const range = resolveRange({ from: req.query.from, to: req.query.to }, tz);
    if (range.error) throw AppError.badRequest(range.error, 'BAD_RANGE');
    return { restaurantId, tenant, range };
}

const fileStamp = (r) => `${r.from}_to_${r.to}`;

// @route GET /api/reports/gst/summary?from&to&branch&format=json|csv|xlsx
exports.gstSummary = asyncHandler(async (req, res) => {
    const { restaurantId, tenant, range } = await prepare(req);
    const { report } = await svc.generateGstReport({ restaurantId, branchClause: analyticsBranchFilter(req), range, tenant });
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="gst-summary-${fileStamp(range)}.csv"`);
        return res.send(gstReportCsv(report));
    }
    if (format === 'xlsx' || format === 'excel') {
        const buf = await gstReportXlsx(report);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="gst-summary-${fileStamp(range)}.xlsx"`);
        return res.send(Buffer.from(buf));
    }
    return res.json({ success: true, report });
}, 'Failed to build GST summary');

// @route GET /api/reports/tally/export?from&to&branch
exports.tallyExport = asyncHandler(async (req, res) => {
    const { restaurantId, tenant, range } = await prepare(req);
    const { orders, hsnCtx } = await svc.generateGstReport({ restaurantId, branchClause: analyticsBranchFilter(req), range, tenant });
    const { xml, voucherCount } = buildTallyXml({
        orders, ledgers: tenant.ledgers, partyMode: tenant.partyMode, company: tenant.company, tz: range.tz, hsnCtx,
    });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Voucher-Count', String(voucherCount));
    res.setHeader('Content-Disposition', `attachment; filename="tally-sales-${fileStamp(range)}.xml"`);
    return res.send(xml);
}, 'Failed to build Tally export');

// @route GET /api/reports/gst/config
exports.getConfig = asyncHandler(async (req, res) => {
    const tenant = await svc.loadTenantTaxContext(needTenant(req));
    res.json({
        success: true,
        config: { defaultHsn: tenant.defaultHsn, ledgers: tenant.ledgers, partyMode: tenant.partyMode },
        ledgerDefaults: DEFAULT_LEDGERS,
    });
}, 'Failed to load tax export settings');

// @route PUT /api/reports/gst/config   { defaultHsn?, partyMode?, ledgers? }
exports.updateConfig = asyncHandler(async (req, res) => {
    const restaurantId = needTenant(req);
    const body = req.body || {};
    const $set = {};
    if (body.defaultHsn !== undefined) {
        const v = String(body.defaultHsn || '').trim();
        if (v && !HSN_RE.test(v)) throw AppError.badRequest('HSN/SAC must be 4 to 8 digits', 'BAD_HSN');
        $set['taxExport.defaultHsn'] = v || '996331';
    }
    if (body.partyMode !== undefined) {
        if (!['cash', 'debtors'].includes(body.partyMode)) throw AppError.badRequest('partyMode must be cash or debtors', 'BAD_PARTY_MODE');
        $set['taxExport.partyMode'] = body.partyMode;
    }
    if (body.ledgers && typeof body.ledgers === 'object') {
        for (const k of Object.keys(DEFAULT_LEDGERS)) {
            if (body.ledgers[k] === undefined) continue;
            const v = String(body.ledgers[k] || '').trim();
            if (v.length > 80) throw AppError.badRequest(`Ledger name too long: ${k}`, 'BAD_LEDGER');
            $set[`taxExport.ledgers.${k}`] = v;
        }
    }
    if (!Object.keys($set).length) throw AppError.badRequest('Nothing to update', 'NO_CHANGES');
    const doc = await Settings.findOneAndUpdate({ restaurant: restaurantId, branch: null }, { $set }, { returnDocument: 'after' });
    if (!doc) throw AppError.conflict('Save your restaurant settings once before changing tax export settings', 'NO_SETTINGS');
    const te = doc.taxExport || {};
    res.json({ success: true, config: { defaultHsn: te.defaultHsn, ledgers: te.ledgers, partyMode: te.partyMode } });
}, 'Failed to save tax export settings');
