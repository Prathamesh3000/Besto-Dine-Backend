/**
 * Activity log for delegated platform staff (PLATFORM_STAFF_PLAN.md).
 *
 * Mount AFTER `platformStaffGate`. For a `platformstaff` user it writes to the
 * existing AuditLog once the response is finished:
 *   - GET       -> `platformstaff.view` (first view of a module per window, so
 *                  a page that polls does not flood the log; default 10 min,
 *                  PLATFORM_VIEW_LOG_MINUTES=0 logs every view)
 *   - non-GET   -> `platformstaff.write`, but only when the controller did not
 *                  already write its own specific audit row (recordAudit sets
 *                  req._audited)
 * Blocked requests are logged by the gate itself (`platformstaff.denied`).
 * Super admins are untouched.
 */
const { recordAudit } = require('../utils/audit');

const lastView = new Map();   // `${actorId}:${module}` -> timestamp
const MAX_ENTRIES = 5000;

function windowMs() {
    const m = Number(process.env.PLATFORM_VIEW_LOG_MINUTES);
    return (Number.isFinite(m) && m >= 0 ? m : 10) * 60 * 1000;
}

function shouldLogView(actorId, module, now = Date.now()) {
    const w = windowMs();
    if (w === 0) return true;
    const key = `${actorId}:${module}`;
    const prev = lastView.get(key);
    if (prev && now - prev < w) return false;
    if (lastView.size >= MAX_ENTRIES) {
        for (const [k, t] of lastView) if (now - t >= w) lastView.delete(k);
        if (lastView.size >= MAX_ENTRIES) lastView.clear();
    }
    lastView.set(key, now);
    return true;
}

function platformStaffActivity(req, res, next) {
    if (req.user?.role !== 'platformstaff') return next();
    const method = req.method;
    const path = req.path;            // captured now: req.url is restored after the router unwinds
    res.on('finish', () => {
        const module = req.platformModule;
        if (!module || res.statusCode >= 400) return;
        if (method === 'GET' || method === 'HEAD') {
            if (!shouldLogView(String(req.user._id), module)) return;
            recordAudit(req, { action: 'platformstaff.view', targetType: 'platform', details: { module, path } });
        } else if (!req._audited) {
            recordAudit(req, { action: 'platformstaff.write', targetType: 'platform', details: { module, method, path } });
        }
    });
    next();
}

module.exports = { platformStaffActivity, shouldLogView, _resetForTests: () => lastView.clear() };
