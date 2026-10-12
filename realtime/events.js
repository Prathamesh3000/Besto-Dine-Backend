// Canonical Socket.io event names (BUGS_REPORT #32).
//
// Every server → client event emitted by the Backend is listed here so the
// names live in one place. Use the constants instead of string literals:
//
//   const EVENTS = require('../realtime/events');
//   emitToAdmin(io, branch, EVENTS.NOTIFICATION_NEW, { title, description });
//
// The string values are part of the wire protocol — the Frontend listens
// for these exact names (Frontend/src/utils/socket.js + pages). Never rename
// a value without updating every client listener.

const EVENTS = Object.freeze({
    // Generic bell/toast notification (persisted row usually accompanies it).
    NOTIFICATION_NEW: 'notification:new',

    // Orders
    ORDER_NEW: 'order:new',
    ORDER_UPDATED: 'order:updated',
    ORDER_READY: 'order:ready',
    ORDER_CANCELLED: 'order:cancelled',
    ORDER_APPENDED: 'order:appended',
    ORDER_KOT_REPRINT: 'order:kot-reprint',
    STALE_ORDERS_DETECTED: 'stale-orders:detected',
    COUNTER_PAYMENT_REQUESTED: 'counter-payment:requested',

    // Tables / sessions
    TABLE_UPDATED: 'table:updated',
    // QA #14 — sent to the `table:<id>` room when the admin deletes or
    // disables a table, so seated diners stop ordering immediately.
    TABLE_UNAVAILABLE: 'table:unavailable',
    SESSION_ENDED: 'session:ended',

    // Customer service requests (waiter calls, bill requests …)
    REQUEST_NEW: 'request:new',
    REQUEST_UPDATED: 'request:updated',

    // Refund requests
    REFUND_REQUEST_NEW: 'refund-request:new',
    REFUND_REQUEST_DECIDED: 'refund-request:decided',

    // Staff wallet / tips
    STAFF_WITHDRAWAL_NEW: 'staff-withdrawal:new',
    STAFF_WITHDRAWAL_UPDATED: 'staff-withdrawal:updated',
    TIP_SETTLED: 'tip:settled',
    STAFF_DUTY_CHANGED: 'staff:duty-changed',

    // Floor escalation (captain → admin)
    CAPTAIN_ESCALATION: 'captain:escalation',

    // Inventory
    INVENTORY_ALERT: 'inventory:alert',

    // Settings / menu / auth
    SETTINGS_UPDATED: 'settings:updated',
    MENU_UPDATED: 'menu:updated',

    // Super Admin changed how the tenant operates (operations profile) —
    // staff apps refetch /auth/me.
    TENANT_OPERATIONS_UPDATED: 'tenant:operations-updated',
    AUTH_RELOAD: 'auth:reload',

    // Thermal printing (services/printService.js ↔ print-agent/)
    PRINT_JOB: 'print:job',                   // server → agent: a job to print
    PRINT_JOB_UPDATED: 'print:job-updated',   // server → admin: job status changed
    PRINT_AGENT_STATUS: 'print:agent-status', // server → admin: agent online/offline
});

const ALL_EVENTS = Object.freeze(Object.values(EVENTS));

// `require('../realtime/events').ORDER_NEW` and
// `const { EVENTS } = require('../realtime/events')` both work.
module.exports = Object.freeze({ ...EVENTS, EVENTS, ALL_EVENTS });
