'use strict';

/**
 * Tenant audit log writer.
 *
 *   recordTenantAudit(req, { action, entityType, entityId, summary, before, after })
 *
 * First arg is an Express req, or a ctx { user, restaurant, branch, ip }.
 * NEVER throws and never blocks the caller: the write is fire-and-forget
 * unless the caller awaits the returned promise (tests do). Resolves with
 * the saved doc, or null when skipped / failed.
 */
const TenantAudit = require('../models/tenantAudit');
const logger = require('../utils/logger');

const MAX_BYTES = 8 * 1024;
const REDACT_RE = /pass(word)?|secret|token$|api[-_]?key|agent[-_]?key|authorization|jwt|^otp|pin$|cvv|^card|accountnumber|account_number|ifsc|^upi|webhook|phone|mobile|email|address|aadhaar|^pan(number)?$/i;

function sanitize(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '...' : value;
    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (typeof value.toHexString === 'function') return String(value);
    if (depth > 5) return '[depth]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (typeof value.toObject === 'function') {
        try { value = value.toObject(); } catch { /* fall through */ }
    }
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1, seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = REDACT_RE.test(k) ? '[REDACTED]' : sanitize(v, depth + 1, seen);
    }
    return out;
}

// Redact then cap at ~8KB; an oversized snapshot is replaced by a stub.
function prepareSnapshot(value) {
    if (value === null || value === undefined) return null;
    const clean = sanitize(value);
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(clean)); } catch { return { _truncated: true }; }
    if (size <= MAX_BYTES) return clean;
    return { _truncated: true, _bytes: size, preview: JSON.stringify(clean).slice(0, 2000) };
}

function ctxOf(src) {
    const user = src?.user || {};
    return {
        user,
        restaurantId: src?.restaurant?._id || src?.restaurant || user.restaurant || null,
        branchId: src?.branch?._id || src?.branch || null,
        ip: src?.ip || src?.headers?.['x-forwarded-for'] || '',
    };
}

async function writeAudit(src, payload) {
    try {
        const { user, restaurantId, branchId, ip } = ctxOf(src);
        const { action = 'other', entityType = '', entityId = '', summary = '', before, after } = payload || {};
        if (!restaurantId) return null;
        const doc = await TenantAudit.create({
            restaurant: restaurantId,
            branch: branchId || null,
            actor: { id: user._id || user.id || null, name: user.name || user.fullName || user.email || '', role: user.role || '' },
            action: TenantAudit.ACTIONS.includes(action) ? action : 'other',
            entityType: String(entityType || '').slice(0, 60),
            entityId: entityId ? String(entityId).slice(0, 100) : '',
            summary: String(summary || '').slice(0, 500),
            before: prepareSnapshot(before),
            after: prepareSnapshot(after),
            ip: String(ip || '').slice(0, 100),
        });
        return doc;
    } catch (err) {
        try { logger.error('Tenant audit write failed: ' + err.message, { action: payload?.action }); } catch { /* never throw */ }
        return null;
    }
}

function recordTenantAudit(src, payload) {
    try {
        // Detach from the request path: a sync throw or rejection can never reach the caller.
        return Promise.resolve().then(() => writeAudit(src, payload)).catch(() => null);
    } catch {
        return Promise.resolve(null);
    }
}

module.exports = { REDACT_RE, recordTenantAudit, prepareSnapshot, sanitize, MAX_BYTES };
