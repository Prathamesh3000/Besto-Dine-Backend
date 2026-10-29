'use strict';

/**
 * Tenant audit log API (read only).
 *   GET /api/v1/audit         filters: from,to,action,actorId,entityType,entityId,page,limit
 *   GET /api/v1/audit/export  same filters, CSV (capped at EXPORT_MAX rows)
 *
 * Visibility: owner/admin see every row; a manager sees only rows whose
 * actor is themselves; every other role gets 403.
 */
const mongoose = require('mongoose');
const TenantAudit = require('../models/tenantAudit');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { tenantFilter } = require('../utils/tenantScope');

const EXPORT_MAX = 5000;
const isId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v) && /^[a-f0-9]{24}$/i.test(v);
const str = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function buildFilter(req) {
    const role = req.user?.role;
    if (!['admin', 'manager'].includes(role)) {
        throw new AppError(403, 'AUDIT_FORBIDDEN', 'You do not have access to the audit log');
    }
    if (!req.restaurant) throw new AppError(400, 'NO_TENANT', 'Restaurant context required');
    const q = req.query || {};
    const filter = { ...tenantFilter(req) };

    const from = q.from ? new Date(str(q.from, 40)) : null;
    const to = q.to ? new Date(str(q.to, 40)) : null;
    if ((from && isNaN(from)) || (to && isNaN(to))) throw new AppError(400, 'BAD_DATE', 'Invalid from/to date');
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = from;
        if (to) {
            // A date-only "to" means the whole day.
            if (/^\d{4}-\d{2}-\d{2}$/.test(str(q.to, 40))) to.setUTCHours(23, 59, 59, 999);
            filter.createdAt.$lte = to;
        }
    }
    const action = str(q.action, 40);
    if (action) {
        if (!TenantAudit.ACTIONS.includes(action)) throw new AppError(400, 'BAD_ACTION', 'Unknown action');
        filter.action = action;
    }
    const entityType = str(q.entityType, 60);
    if (entityType) filter.entityType = entityType;
    const entityId = str(q.entityId, 100);
    if (entityId) filter.entityId = entityId;

    const actorId = str(q.actorId, 40);
    if (actorId && !isId(actorId)) throw new AppError(400, 'BAD_ACTOR', 'Invalid actorId');
    if (role === 'manager') {
        // Managers only ever see their own actions, whatever actorId asks for.
        filter['actor.id'] = new mongoose.Types.ObjectId(String(req.user._id));
    } else if (actorId) {
        filter['actor.id'] = new mongoose.Types.ObjectId(actorId);
    }
    return filter;
}

exports.listAudit = asyncHandler(async (req, res) => {
    const filter = buildFilter(req);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [rows, total] = await Promise.all([
        TenantAudit.find({ ...filter, ...tenantFilter(req) }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        TenantAudit.countDocuments({ ...filter, ...tenantFilter(req) }),
    ]);
    res.json({ success: true, rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
}, 'Failed to load audit log');

// CSV cell: quote, and neutralise spreadsheet formula injection.
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
}
exports.csvCell = csvCell;

const COLUMNS = ['createdAt', 'action', 'actorName', 'actorRole', 'actorId', 'entityType', 'entityId', 'summary', 'before', 'after', 'ip'];
function toCsv(rows) {
    const lines = [COLUMNS.join(',')];
    for (const r of rows) {
        lines.push([
            r.createdAt ? new Date(r.createdAt).toISOString() : '',
            r.action, r.actor?.name, r.actor?.role, r.actor?.id ? String(r.actor.id) : '',
            r.entityType, r.entityId, r.summary,
            r.before == null ? '' : JSON.stringify(r.before),
            r.after == null ? '' : JSON.stringify(r.after),
            r.ip,
        ].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}
exports.toCsv = toCsv;
exports.buildFilter = buildFilter;

exports.exportAudit = asyncHandler(async (req, res) => {
    const filter = buildFilter(req);
    const rows = await TenantAudit.find({ ...filter, ...tenantFilter(req) }).sort({ createdAt: -1 }).limit(EXPORT_MAX).lean();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + toCsv(rows));
}, 'Failed to export audit log');
