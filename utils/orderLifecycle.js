/**
 * orderLifecycle — the order status machine.
 *
 * Extracted from orderController.js (5,400+ lines), which could not be
 * require()'d from a unit test: it pulls in models, sockets and an
 * ESM-only uuid build at import time. A rule this central should be
 * testable without booting half the server, so it lives here.
 *
 * Every staff surface depends on this contract — the chef's Kanban,
 * the waiter's Cancel button, the admin dashboard. Change it here and
 * __tests__/orderLifecycle.test.js will tell you what you broke.
 */

/**
 * Allowed status moves.
 *
 * 'ready' and 'served' previously had NO path to 'cancelled', so the
 * waiter's Cancel button returned 409 INVALID_TRANSITION on any order
 * past 'preparing' — exactly when a cancellation is most likely (wrong
 * dish plated, customer walked out). The waiter saw a flat "Failed to
 * cancel order" with no recourse.
 *
 * Cancelling from those two states destroys food that was actually
 * produced, so it is permitted but gated — see below.
 */
const VALID_TRANSITIONS = {
    'new': ['preparing', 'cancelled'],
    'preparing': ['ready', 'served', 'cancelled'],
    'ready': ['served', 'cancelled'],
    'served': ['served', 'cancelled'],
    'cancelled': [],
};

/**
 * States whose cancellation writes off prepared food. These demand a
 * written reason so the void is attributable.
 */
const CANCEL_REQUIRES_REASON = new Set(['ready', 'served']);

/**
 * Roles permitted to void an order in a CANCEL_PRIVILEGED_STATES state.
 * A waiter voiding their own served order without a trace is how
 * shrinkage hides, so they must escalate to a captain or manager.
 */
const CANCEL_PRIVILEGED_ROLES = new Set(['captain', 'manager', 'admin']);

/**
 * States whose cancellation additionally needs a privileged role.
 *
 * Previously this was every CANCEL_REQUIRES_REASON state, i.e. 'ready'
 * too. But the waiter app's Orders tab only lists READY (and served)
 * orders, so a waiter could never cancel anything from it — the
 * reported "unable to cancel order". A 'ready' order has not reached
 * the guest yet (wrong dish plated, guest walked out): the waiter who
 * is holding it may void it, with a mandatory reason that is recorded
 * alongside cancelledBy/cancelledAt. Only a 'served' order — food the
 * guest already has — still needs a captain/manager.
 */
const CANCEL_PRIVILEGED_STATES = new Set(['served']);

/** Is this status move legal? Unknown `from` states allow nothing. */
function canTransition(from, to) {
    const allowed = VALID_TRANSITIONS[from];
    return Boolean(allowed && allowed.includes(to));
}

/**
 * Which dedicated timestamp field, if any, a transition into `status`
 * should stamp.
 *
 * `updatedAt` is bumped by ANY save, so it cannot answer "how long has
 * this been ready?" — the chef's Ready-for-Pickup timer was reading
 * createdAt for want of a better anchor and therefore showed total
 * order age instead of time-since-ready.
 */
const STATUS_TIMESTAMP_FIELD = {
    preparing: 'preparationStartedAt',
    ready: 'preparationCompletedAt',
    served: 'servedAt',
};

module.exports = {
    VALID_TRANSITIONS,
    CANCEL_REQUIRES_REASON,
    CANCEL_PRIVILEGED_ROLES,
    CANCEL_PRIVILEGED_STATES,
    STATUS_TIMESTAMP_FIELD,
    canTransition,
};
