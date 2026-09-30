/**
 * Order status machine contract.
 *
 * The bug this pins: 'ready' and 'served' had no path to 'cancelled',
 * so the waiter's Cancel button returned 409 INVALID_TRANSITION on any
 * order past 'preparing' — exactly when a cancellation is most likely
 * (wrong dish plated, customer walked out). The waiter UI reported a
 * flat "Failed to cancel order" and the order was stuck.
 *
 * Cancelling a prepared order writes off real food, so the fix is not
 * simply "allow it": it is allowed, but gated on a reason and a
 * privileged role so the void is attributable.
 */

const {
    VALID_TRANSITIONS,
    CANCEL_REQUIRES_REASON,
    CANCEL_PRIVILEGED_ROLES,
    CANCEL_PRIVILEGED_STATES,
    STATUS_TIMESTAMP_FIELD,
    canTransition,
} = require('../utils/orderLifecycle');

describe('the happy path still works', () => {
    test.each([
        ['new', 'preparing'],
        ['preparing', 'ready'],
        ['preparing', 'served'],
        ['ready', 'served'],
    ])('%s → %s is allowed', (from, to) => {
        expect(canTransition(from, to)).toBe(true);
    });
});

describe('cancellation is reachable from every live state', () => {
    // The regression under test. Before the fix only new/preparing
    // could be cancelled.
    test.each(['new', 'preparing', 'ready', 'served'])(
        '%s → cancelled is allowed',
        (from) => {
            expect(canTransition(from, 'cancelled')).toBe(true);
        },
    );

    test('a cancelled order is terminal — nothing may follow it', () => {
        expect(VALID_TRANSITIONS.cancelled).toEqual([]);
        for (const to of ['new', 'preparing', 'ready', 'served', 'cancelled']) {
            expect(canTransition('cancelled', to)).toBe(false);
        }
    });
});

describe('illegal moves are still rejected', () => {
    test.each([
        ['new', 'ready'],       // can't plate what was never cooked
        ['new', 'served'],
        ['ready', 'preparing'], // no going backwards
        ['served', 'preparing'],
        ['served', 'ready'],
    ])('%s → %s is rejected', (from, to) => {
        expect(canTransition(from, to)).toBe(false);
    });

    test('an unknown status has no transitions defined', () => {
        expect(VALID_TRANSITIONS['not-a-status']).toBeUndefined();
        expect(canTransition('not-a-status', 'cancelled')).toBe(false);
    });
});

describe('late-cancellation gate', () => {
    test('only ready/served cancellations demand a reason', () => {
        expect(CANCEL_REQUIRES_REASON.has('ready')).toBe(true);
        expect(CANCEL_REQUIRES_REASON.has('served')).toBe(true);
        // Nothing was cooked yet, so no write-off to justify.
        expect(CANCEL_REQUIRES_REASON.has('new')).toBe(false);
        expect(CANCEL_REQUIRES_REASON.has('preparing')).toBe(false);
    });

    test('a plain waiter is NOT allowed to void a prepared order', () => {
        // Shrinkage hides in untraceable voids — a waiter must escalate.
        expect(CANCEL_PRIVILEGED_ROLES.has('waiter')).toBe(false);
        expect(CANCEL_PRIVILEGED_ROLES.has('chef')).toBe(false);
        expect(CANCEL_PRIVILEGED_ROLES.has('customer')).toBe(false);
    });

    test('only a served order needs a privileged role; ready needs just a reason', () => {
        expect(CANCEL_PRIVILEGED_STATES.has('served')).toBe(true);
        expect(CANCEL_PRIVILEGED_STATES.has('ready')).toBe(false);
        for (const st of CANCEL_PRIVILEGED_STATES) {
            expect(CANCEL_REQUIRES_REASON.has(st)).toBe(true);
        }
    });

    test('captain, manager and admin may void a prepared order', () => {
        expect(CANCEL_PRIVILEGED_ROLES.has('captain')).toBe(true);
        expect(CANCEL_PRIVILEGED_ROLES.has('manager')).toBe(true);
        expect(CANCEL_PRIVILEGED_ROLES.has('admin')).toBe(true);
    });

    test('every state needing a reason is actually reachable to cancel', () => {
        // Guards against a future edit that gates a state the machine
        // no longer lets you cancel from — the gate would be dead code.
        for (const from of CANCEL_REQUIRES_REASON) {
            expect(canTransition(from, 'cancelled')).toBe(true);
        }
    });
});

describe('per-status timestamps', () => {
    // updatedAt is bumped by any save, so it cannot answer "how long
    // has this been ready?". Each live status gets its own anchor.
    test.each([
        ['preparing', 'preparationStartedAt'],
        ['ready', 'preparationCompletedAt'],
        ['served', 'servedAt'],
    ])('%s stamps %s', (status, field) => {
        expect(STATUS_TIMESTAMP_FIELD[status]).toBe(field);
    });

    test('ready has a dedicated stamp — the chef timer depends on it', () => {
        // The Ready-for-Pickup timer previously fell back to createdAt
        // and therefore showed total order age, not time-since-ready.
        expect(STATUS_TIMESTAMP_FIELD.ready).toBeTruthy();
        expect(STATUS_TIMESTAMP_FIELD.ready).not.toBe('updatedAt');
        expect(STATUS_TIMESTAMP_FIELD.ready).not.toBe('createdAt');
    });

    test('new and cancelled stamp nothing extra', () => {
        expect(STATUS_TIMESTAMP_FIELD.new).toBeUndefined();
        expect(STATUS_TIMESTAMP_FIELD.cancelled).toBeUndefined();
    });
});
