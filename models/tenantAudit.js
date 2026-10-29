const mongoose = require('mongoose');

/**
 * TenantAudit — append-only, per-restaurant record of sensitive staff
 * actions (cancellations, discounts, refunds, bill edits, staff / settings /
 * menu-price changes). Distinct from AuditLog, which is platform / super
 * admin only.
 *
 * Retention: TTL via env AUDIT_RETENTION_DAYS (default 730 = 2 years).
 * Written only through services/tenantAuditService.recordTenantAudit.
 */
const ACTIONS = [
    'order.cancel', 'order.void', 'order.discount', 'order.price_edit', 'order.refund',
    'bill.edit', 'bill.finalize',
    'staff.create', 'staff.deactivate', 'staff.role_change', 'staff.permission_change',
    'settings.change', 'menu.price_change',
    'other',
];

const days = Number(process.env.AUDIT_RETENTION_DAYS);
const RETENTION_DAYS = Number.isFinite(days) && days > 0 ? days : 730;

const tenantAuditSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branch:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    actor: {
        id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        name: { type: String, default: '' },
        role: { type: String, default: '' },
    },
    action:     { type: String, enum: ACTIONS, required: true },
    entityType: { type: String, default: '', maxlength: 60 },
    entityId:   { type: String, default: '', maxlength: 100 },
    summary:    { type: String, default: '', maxlength: 500 },
    before:     { type: mongoose.Schema.Types.Mixed, default: null },
    after:      { type: mongoose.Schema.Types.Mixed, default: null },
    ip:         { type: String, default: '' },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false }, minimize: false });

tenantAuditSchema.index({ restaurant: 1, createdAt: -1 });
tenantAuditSchema.index({ restaurant: 1, action: 1, createdAt: -1 });
tenantAuditSchema.index({ restaurant: 1, 'actor.id': 1, createdAt: -1 });
tenantAuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 });

tenantAuditSchema.plugin(require('../utils/tenantScopePlugin'));

const TenantAudit = mongoose.model('TenantAudit', tenantAuditSchema);
TenantAudit.ACTIONS = ACTIONS;
module.exports = TenantAudit;
