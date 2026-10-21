/**
 * customerTrackingPolicy — server-side enforcement of
 * `orderFlow.customerTracking:false` (OPERATIONS_CONTROL_PANEL_DESIGN.md
 * §12.3).
 *
 * A tenant whose profile has no chef screen (module `chef` off) has nobody
 * pressing Preparing / Ready, so the customer app shows "Order confirmed —
 * collect at the counter" instead of a live kitchen timeline. Until now
 * that was UI-only: the detail / my-orders / tracking payloads still
 * carried the real kitchen status and timestamps. This module is the
 * single place that shapes a CUSTOMER-facing order payload for such a
 * tenant:
 *
 *   - status collapses to the customer-visible lifecycle
 *       new | preparing | ready  → 'confirmed'
 *       served                   → 'completed'
 *       cancelled                → 'cancelled'
 *       awaiting-payment         → 'awaiting-payment'
 *   - kitchen-only fields are removed (prep timestamps, station, prep
 *     time, chef)
 *   - `trackingDisabled: true` is set so the client can pick its page
 *
 * Pure: no Mongo, no request. `ops` is a RESOLVED operations profile
 * (utils/operationsProfile.resolveOperations / publicOperationsOf) or
 * null. With tracking on (the default, and every tenant without a
 * profile) the payload is returned UNTOUCHED — same reference — so those
 * tenants behave exactly as before. Staff / admin payloads must never go
 * through this module.
 */

const STATUS_COLLAPSE = Object.freeze({
    'new': 'confirmed',
    'preparing': 'confirmed',
    'ready': 'confirmed',
    'served': 'completed',
    'cancelled': 'cancelled',
    'awaiting-payment': 'awaiting-payment',
});

// Top-level order fields that only mean something with a kitchen screen.
// `servedAt` / `releasedAt` / `cancelledAt` / `paidAt` stay: completion,
// payment and cancellation are the events the customer still gets.
const KITCHEN_ORDER_FIELDS = Object.freeze([
    'preparationStartedAt',
    'preparationCompletedAt',
    'chef',
    // Not stored today; listed so a future ETA field is stripped the day
    // it appears in a customer payload rather than leaking by default.
    'estimatedReadyAt',
    'estimatedPrepMinutes',
    'eta',
    'etaMinutes',
]);

// Line-item fields that describe where / how long the kitchen cooks it.
const KITCHEN_ITEM_FIELDS = Object.freeze(['prepStation', 'prepTimeMinutes']);

/** Customer-visible status for a tenant without tracking. Unknown → as is. */
function collapseStatus(status) {
    if (status == null) return status;
    return STATUS_COLLAPSE[status] || status;
}

/** `true` unless the resolved profile explicitly turns tracking off. */
function customerTrackingEnabled(ops) {
    return !(ops && ops.orderFlow && ops.orderFlow.customerTracking === false);
}

// Mongoose documents expose their fields through getters; `toObject()`
// gives a plain object we can spread. Lean docs / formatter output pass
// through unchanged.
function toPlain(v) {
    if (v && typeof v.toObject === 'function') return v.toObject();
    return v;
}

function stripItem(item) {
    const plain = toPlain(item);
    if (!plain || typeof plain !== 'object') return plain;
    const out = { ...plain };
    for (const k of KITCHEN_ITEM_FIELDS) delete out[k];
    return out;
}

/**
 * Shape ONE customer-facing order payload (formatted row or lean doc) for
 * the resolved profile `ops`. Returns the input itself when tracking is on
 * or the payload is not an object.
 */
function applyCustomerTrackingPolicy(orderPayload, ops) {
    if (customerTrackingEnabled(ops)) return orderPayload;
    const plain = toPlain(orderPayload);
    if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return orderPayload;

    const out = { ...plain };
    for (const k of KITCHEN_ORDER_FIELDS) delete out[k];
    if ('status' in out) out.status = collapseStatus(out.status);
    if (Array.isArray(out.items)) out.items = out.items.map(stripItem);
    out.trackingDisabled = true;
    return out;
}

/** Same for a list of payloads (my-orders, active-list). */
function applyCustomerTrackingPolicyToList(list, ops) {
    if (customerTrackingEnabled(ops) || !Array.isArray(list)) return list;
    return list.map((o) => applyCustomerTrackingPolicy(o, ops));
}

/**
 * Socket copy of a status payload for the customer rooms: real status is
 * never sent when tracking is off. Returns the payload itself when
 * tracking is on.
 */
function customerEventPayload(payload, ops) {
    if (customerTrackingEnabled(ops)) return payload;
    if (!payload || typeof payload !== 'object') return payload;
    const out = { ...payload };
    for (const k of KITCHEN_ORDER_FIELDS) delete out[k];
    if ('status' in out) out.status = collapseStatus(out.status);
    out.trackingDisabled = true;
    return out;
}

/**
 * Is this a status transition the customer still hears about when tracking
 * is off? Payment-only updates (no status) and the terminal states yes;
 * the kitchen steps no. `new` (a held order released by payment) is a
 * payment event, so yes.
 */
function customerHearsTransition(status) {
    if (status == null || status === '') return true;
    return status !== 'preparing' && status !== 'ready';
}

module.exports = {
    STATUS_COLLAPSE,
    KITCHEN_ORDER_FIELDS,
    KITCHEN_ITEM_FIELDS,
    collapseStatus,
    customerTrackingEnabled,
    applyCustomerTrackingPolicy,
    applyCustomerTrackingPolicyToList,
    customerEventPayload,
    customerHearsTransition,
};
