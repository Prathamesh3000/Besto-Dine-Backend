// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const AuditLog = require('../../models/auditLog');
const logger = require('../../utils/logger');

// Shared filter-builder for both the paginated list and the CSV
// export. Keeping it in one place means we can't drift into "list
// shows X but export shows Y" bugs under the same filters.
function buildAuditLogFilter(query) {
    const { action, targetType, targetId, actor, from, to } = query;
    const filter = {};
    if (action)     filter.action = action;
    if (targetType) filter.targetType = targetType;
    if (targetId && mongoose.isValidObjectId(targetId)) filter.targetId = targetId;
    if (actor && mongoose.isValidObjectId(actor)) filter.actor = actor;
    // Phase 4 step 3 — optional date-range filter for compliance
    // exports. Accepts ISO strings or anything Date() can parse.
    // Silently ignores unparseable values rather than 400ing so a
    // bad bookmark doesn't break the list page.
    if (from || to) {
        filter.createdAt = {};
        if (from) {
            const d = new Date(from);
            if (!Number.isNaN(d.getTime())) filter.createdAt.$gte = d;
        }
        if (to) {
            const d = new Date(to);
            if (!Number.isNaN(d.getTime())) filter.createdAt.$lte = d;
        }
        if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }
    return filter;
}

// GET /api/v1/superadmin/audit-logs
exports.listAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const filter = buildAuditLogFilter(req.query);

        const pageNum  = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

        const [items, total] = await Promise.all([
            AuditLog.find(filter)
                .sort({ createdAt: -1 })
                .skip((pageNum - 1) * pageSize)
                .limit(pageSize)
                .lean(),
            AuditLog.countDocuments(filter),
        ]);

        return res.status(200).json({
            success: true,
            data: items,
            pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
        });
    } catch (err) {
        logger.error('listAuditLogs error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list audit logs' });
    }
};

// GET /api/v1/superadmin/audit-logs/export
//
// Compliance-friendly CSV export of audit log entries. Accepts the
// same filter query params as the list endpoint (action, targetType,
// targetId, actor) plus optional `from` / `to` date range. Returns
// up to EXPORT_CAP rows sorted oldest-first (chronological order is
// what compliance workflows expect).
//
// We don't stream row-by-row — the cap is small enough that building
// the whole payload in memory is fine and keeps the code simple.
// If this grows past ~50k rows per export, switch to a cursor +
// res.write() flush.
exports.exportAuditLogs = async (req, res) => {
    const EXPORT_CAP = 10000;
    try {
        const filter = buildAuditLogFilter(req.query);
        const items = await AuditLog.find(filter)
            .sort({ createdAt: 1 })    // chronological for compliance
            .limit(EXPORT_CAP)
            .lean();

        // ── CSV escape helper ────────────────────────────────────────
        // RFC 4180: fields containing commas, quotes, or newlines must
        // be wrapped in double quotes, with any internal quotes doubled.
        // Dates are ISO 8601 for deterministic sorting in Excel/Sheets.
        const esc = (v) => {
            if (v === null || v === undefined) return '';
            let s = typeof v === 'string' ? v : String(v);
            if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
                s = '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        };

        const header = [
            'createdAt',
            'action',
            'actorEmail',
            'actorRole',
            'actorLevel',
            'targetType',
            'targetId',
            'targetName',
            'ip',
            'userAgent',
            'details',
        ].join(',');

        const rows = items.map(a => [
            a.createdAt ? new Date(a.createdAt).toISOString() : '',
            esc(a.action),
            esc(a.actorEmail),
            esc(a.actorRole),
            esc(a.actorLevel),
            esc(a.targetType),
            esc(a.targetId?.toString?.() || ''),
            esc(a.targetName),
            esc(a.ip),
            esc(a.userAgent),
            // details is a free-form object — JSON-stringify then
            // CSV-escape. Empty objects collapse to {}, which is
            // harmless in a spreadsheet.
            esc(JSON.stringify(a.details || {})),
        ].join(','));

        // UTF-8 BOM so Excel opens the file with the right encoding
        // (otherwise non-ASCII tenant names appear mojibake).
        const body = '\uFEFF' + header + '\n' + rows.join('\n') + '\n';

        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="audit-logs-${stamp}.csv"`
        );
        if (items.length === EXPORT_CAP) {
            // Surface the truncation to the client via a response
            // header so the UI can warn the user that they need to
            // narrow the date range for a complete export.
            res.setHeader('X-Export-Truncated', 'true');
            logger.warn(`audit-logs export capped at ${EXPORT_CAP} rows`, {
                filter,
            });
        }
        return res.status(200).send(body);
    } catch (err) {
        logger.error('exportAuditLogs error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to export audit logs' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// AUDIT LOG RETENTION (Phase 7.5)
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/superadmin/audit-logs/purge
 *
 * Deletes audit log entries that are older than each tenant's plan-
 * level retention window (`limits.auditRetentionDays`). Entries with
 * `targetType !== 'restaurant'` or a missing targetId are never
 * purged — they're platform-level records (plan edits, superadmin
 * CRUD, etc.) that don't belong to any tenant.
 *
 * Body (optional):
 *   { dryRun: true }  — returns the counts without actually deleting.
 *                       Default is false (real delete). Always run a
 *                       dry-run first to verify the numbers.
 *
 * Returns: { purged: N, byTenant: [{ slug, purged, retentionDays }] }
 */
exports.purgeExpiredAuditLogs = async (req, res) => {
    try {
        const dryRun = req.body?.dryRun === true;

        // 1. Load every restaurant with its plan's retention window.
        //    We need the denormalised limits from the subscription
        //    snapshot (not the SubscriptionPlan doc) because that's
        //    what the tenant is actually on — plan edits don't silently
        //    change retention on existing tenants.
        const restaurants = await Restaurant.find({})
            .select('slug subscription.limits')
            .lean();

        let totalPurged = 0;
        const byTenant = [];

        for (const r of restaurants) {
            const days = r.subscription?.limits?.auditRetentionDays;
            // 0 or undefined/null = unlimited retention → skip
            if (!days || days <= 0) continue;

            const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            if (dryRun) {
                const count = await AuditLog.countDocuments({
                    targetType: 'restaurant',
                    targetId: r._id,
                    createdAt: { $lt: cutoff },
                });
                if (count > 0) {
                    byTenant.push({ slug: r.slug, purged: count, retentionDays: days });
                    totalPurged += count;
                }
            } else {
                const result = await AuditLog.deleteMany({
                    targetType: 'restaurant',
                    targetId: r._id,
                    createdAt: { $lt: cutoff },
                });
                if (result.deletedCount > 0) {
                    byTenant.push({ slug: r.slug, purged: result.deletedCount, retentionDays: days });
                    totalPurged += result.deletedCount;
                }
            }
        }

        logger.info(`audit-logs purge ${dryRun ? '(dry-run) ' : ''}purged=${totalPurged} tenants=${byTenant.length}`);

        return res.json({
            success: true,
            dryRun,
            purged: totalPurged,
            byTenant,
        });
    } catch (err) {
        logger.error('purgeExpiredAuditLogs error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to purge audit logs' });
    }
};
