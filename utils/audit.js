const AuditLog = require('../models/auditLog');
const logger = require('./logger');

/**
 * Persist a Super Admin action to the audit log.
 *
 * Audit writes are best-effort and MUST NEVER throw out of the controller
 * that called them — a failed audit write should not roll back the user's
 * action, but it must be loud in the server logs so an operator can
 * investigate.
 *
 * Usage:
 *   await recordAudit(req, {
 *       action: 'restaurant.create',
 *       targetType: 'restaurant',
 *       targetId: restaurant._id,
 *       targetName: restaurant.name,
 *       details: { plan: plan.slug },
 *   });
 */
async function recordAudit(req, {
    action,
    targetType = '',
    targetId,
    targetName = '',
    details = {},
}) {
    try {
        if (!req?.user?._id || !action) {
            logger.warn('recordAudit called without actor or action');
            return null;
        }

        // Strip obvious secrets from the details payload before persisting.
        const safeDetails = sanitizeDetails(details);

        return await AuditLog.create({
            actor: req.user._id,
            actorEmail: req.user.email || '',
            actorRole:  req.user.role || '',
            actorLevel: req.user.superadminLevel || '',
            action,
            targetType,
            targetId,
            targetName,
            details: safeDetails,
            ip: req.ip || req.headers['x-forwarded-for'] || '',
            userAgent: req.headers['user-agent'] || '',
        });
    } catch (err) {
        // Audit failures are loud but non-fatal.
        logger.error('Audit log write failed: ' + err.message, {
            action,
            actor: req?.user?._id?.toString(),
        });
        return null;
    }
}

const SECRET_KEYS = new Set([
    'password', 'newpassword', 'currentpassword', 'temppassword',
    'token', 'jwt', 'apikey', 'secret', 'authorization',
]);

function sanitizeDetails(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(input)) {
        if (SECRET_KEYS.has(k.toLowerCase())) {
            out[k] = '[REDACTED]';
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = sanitizeDetails(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

module.exports = { recordAudit };
