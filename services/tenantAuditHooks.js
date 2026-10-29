'use strict';

/**
 * Thin, never-throwing adapters between feature code and
 * tenantAuditService, so call sites stay a single line.
 */
const { recordTenantAudit, REDACT_RE } = require('./tenantAuditService');

const num = (v) => Math.max(0, Number(v) || 0);

// After an order status / payment PATCH was committed: cancel and manual
// discount changes.
function auditOrderUpdate(req, oldOrder, order) {
    try {
        if (!oldOrder || !order) return;
        const id = order.orderId || String(order._id || '');
        if (order.status === 'cancelled' && oldOrder.status !== 'cancelled') {
            const paid = oldOrder.paymentStatus === 'Paid' || num(oldOrder.amountPaid) > 0;
            recordTenantAudit(req, {
                action: paid ? 'order.void' : 'order.cancel',
                entityType: 'order', entityId: id,
                summary: `Order ${id} cancelled from "${oldOrder.status}"${order.cancellationReason ? `: ${order.cancellationReason}` : ''}`,
                before: { status: oldOrder.status, paymentStatus: oldOrder.paymentStatus, total: oldOrder.total },
                after: { status: order.status, reason: order.cancellationReason || req?.body?.cancellationReason || '' },
            });
        }
        if (num(order.manualDiscount) !== num(oldOrder.manualDiscount)) {
            recordTenantAudit(req, {
                action: 'order.discount',
                entityType: 'order', entityId: id,
                summary: `Manual discount on order ${id}: ${num(oldOrder.manualDiscount)} -> ${num(order.manualDiscount)}`,
                before: { manualDiscount: num(oldOrder.manualDiscount) },
                after: { manualDiscount: num(order.manualDiscount) },
            });
        }
    } catch { /* never throw */ }
}

// Refund result from utils/orderRefund.
function auditRefund(req, order, info = {}) {
    try {
        const id = order?.orderId || String(order?._id || '');
        recordTenantAudit(req, {
            action: 'order.refund',
            entityType: 'order', entityId: id,
            summary: `Refund${info.amount != null ? ` of ${info.amount}` : ''} on order ${id}${info.reason ? `: ${info.reason}` : ''}`,
            before: { paymentStatus: info.beforeStatus || null },
            after: { amount: info.amount, mode: info.mode || null, paymentStatus: order?.paymentStatus || null, reason: info.reason || '' },
        });
    } catch { /* never throw */ }
}


const who = (u) => ({ id: String(u?._id || ''), name: u?.name || '', role: u?.role || '' });

// Staff lifecycle. `kind`: 'create' | 'deactivate' | 'update'.
function auditStaff(req, kind, before, after) {
    try {
        const target = after || before;
        const id = String(target?._id || '');
        const label = `${target?.name || id} (${target?.role || ''})`;
        if (kind === 'create') {
            return recordTenantAudit(req, { action: 'staff.create', entityType: 'staff', entityId: id, summary: `Staff created: ${label}`, after: { ...who(target), status: target?.status, branch: target?.branch } });
        }
        if (kind === 'deactivate') {
            return recordTenantAudit(req, { action: 'staff.deactivate', entityType: 'staff', entityId: id, summary: `Staff ${after ? 'set to ' + after.status : 'removed'}: ${label}`, before: { status: before?.status }, after: { status: after ? after.status : 'removed' } });
        }
        if (before && after && before.role !== after.role) {
            recordTenantAudit(req, { action: 'staff.role_change', entityType: 'staff', entityId: id, summary: `Role of ${after.name || id}: ${before.role} -> ${after.role}`, before: { role: before.role }, after: { role: after.role } });
        }
        if (before && after && JSON.stringify(before.permissions || null) !== JSON.stringify(after.permissions || null)) {
            recordTenantAudit(req, { action: 'staff.permission_change', entityType: 'staff', entityId: id, summary: `Permissions changed for ${after.name || id}`, before: { permissions: before.permissions || null }, after: { permissions: after.permissions || null } });
        }
    } catch { /* never throw */ }
}

// Settings change: record changed top-level keys only (names, plus values for
// non-secret scalars via the service redaction).
function auditSettingsChange(req, beforeDoc, patch, section = '') {
    try {
        const plain = (d) => (d && typeof d.toObject === 'function' ? d.toObject() : (d || {}));
        const prev = plain(beforeDoc);
        const before = {};
        const after = {};
        const changed = [];
        for (const [k, v] of Object.entries(patch || {})) {
            if (JSON.stringify(prev[k]) === JSON.stringify(v)) continue;
            changed.push(k);
            const leaf = String(k).split('.').pop();
            const secret = REDACT_RE.test(leaf);
            before[k] = secret ? '[REDACTED]' : prev[k];
            after[k] = secret ? '[REDACTED]' : v;
        }
        if (!changed.length) return;
        recordTenantAudit(req, { action: 'settings.change', entityType: 'settings', entityId: section, summary: `Settings changed: ${changed.slice(0, 20).join(', ')}`, before, after });
    } catch { /* never throw */ }
}

// Menu item price edits (base price or variants).
function auditMenuPrice(req, before, after) {
    try {
        if (!before || !after) return;
        const pick = (m) => ({ basePrice: m.basePrice, offerPercentage: m.offerPercentage, finalPrice: m.finalPrice, sizes: m.sizes, toppings: m.toppings });
        const b = pick(typeof before.toObject === 'function' ? before.toObject() : before);
        const a = pick(typeof after.toObject === 'function' ? after.toObject() : after);
        if (JSON.stringify(b) === JSON.stringify(a)) return;
        recordTenantAudit(req, { action: 'menu.price_change', entityType: 'menu', entityId: String(after._id || before._id || ''), summary: `Price changed for ${after.name || before.name || 'menu item'}`, before: b, after: a });
    } catch { /* never throw */ }
}

module.exports = { auditOrderUpdate, auditRefund, auditStaff, auditSettingsChange, auditMenuPrice };
