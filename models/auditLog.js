const mongoose = require('mongoose');

/**
 * AuditLog — immutable record of every privileged Super Admin action.
 *
 * Used for compliance, support investigations and post-incident review.
 * Documents are append-only: there is no update / delete API exposed.
 *
 * Capacity note: a TTL index is intentionally NOT applied. Audit logs must
 * be retained for the platform's contractual / regulatory window. If volume
 * becomes a concern, archive offline rather than auto-deleting.
 */
const auditLogSchema = new mongoose.Schema({
    // Actor is optional — most entries are by an authenticated
    // Super Admin, but system events (Razorpay webhooks, scheduled
    // reconciliation jobs) have no user context. For those, `actor`
    // is null and `actorEmail` / `actorRole` identify the origin
    // (e.g. "razorpay-webhook", role: "system").
    actor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
    },
    actorEmail: { type: String, default: '' },     // denormalised for fast list rendering
    actorRole:  { type: String, default: '' },     // 'superadmin' | 'system' | ...
    actorLevel: { type: String, default: '' },     // 'full' | 'support'

    // Dot-notation action key — e.g. 'restaurant.create', 'plan.update',
    // 'restaurant.suspend', 'restaurant.impersonate'.
    action: {
        type: String,
        required: true,
        index: true,
        maxlength: 80,
    },

    targetType: {
        type: String,
        enum: ['restaurant', 'plan', 'user', 'platform', ''],
        default: '',
    },
    targetId:   { type: mongoose.Schema.Types.ObjectId },
    targetName: { type: String, default: '' },     // human-readable

    // Free-form action metadata: { before, after, reason, ... }.
    // Keep PII out of here — Super Admin must never persist customer data
    // they were not contractually permitted to view.
    details: { type: Object, default: {} },

    ip:        { type: String, default: '' },
    userAgent: { type: String, default: '' },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

// ─── Indexes ─────────────────────────────────────────────────────────────
// Most queries are "show me actions on X" or "show me what Y did".
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
