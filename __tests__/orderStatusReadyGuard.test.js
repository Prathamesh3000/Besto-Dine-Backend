/**
 * services/orderStatusService.readyCompletesOrder — A5: the chef's Ready
 * auto-completes an order (→ served) only for a DINE-IN, non-kiosk order
 * of a tenant whose operations profile has the served step off. Takeaway
 * and kiosk orders keep their pickup "ready" step (same guard as the
 * create path), and a tenant without a profile (servedStep true) is never
 * affected.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// ESM-only transitive deps (uuid via idGenerator) cannot load in the CJS
// unit runtime; these siblings are not exercised by the pure guard.
jest.mock('../services/orderPaymentService', () => ({ recordPaidOrderLedger: jest.fn() }));
jest.mock('../services/orderNotifications', () => ({ notifyStatusTransition: jest.fn(), emitStatusUpdateEvents: jest.fn(), notify: jest.fn() }));
jest.mock('../utils/settingsCache', () => ({ getSettings: jest.fn() }));

const { readyCompletesOrder } = require('../services/orderStatusService');
const { resolveOperations, profileFromPreset } = require('../utils/operationsProfile');

const FULL_PLAN = {
    dineIn: true, takeaway: true, kitchenDisplay: true, waiterDashboard: true,
    paymentGateway: true, walletLoyalty: true, tipManagement: true, kiosk: true,
};
const tenant = (operations) => ({ subscription: { features: FULL_PLAN }, ...(operations ? { operations } : {}) });

const cafe = resolveOperations(tenant(profileFromPreset('cafeCounterPayFirst')));   // chef on, nobody serves
const today = resolveOperations(tenant(null));                                       // no profile → served step on

describe('readyCompletesOrder', () => {
    test('served step off + dine-in → Ready completes the order', () => {
        expect(cafe.orderFlow.servedStep).toBe(false);
        expect(readyCompletesOrder({ type: 'dine-in', source: 'qr-scan' }, cafe)).toBe(true);
        expect(readyCompletesOrder({ type: 'dine-in', source: 'staff' }, cafe)).toBe(true);
        expect(readyCompletesOrder({ type: 'dine-in' }, cafe)).toBe(true);
    });

    test('takeaway and kiosk orders keep their pickup "ready" step even with the served step off', () => {
        expect(readyCompletesOrder({ type: 'takeaway', source: 'web-customer' }, cafe)).toBe(false);
        expect(readyCompletesOrder({ type: 'takeaway', source: 'staff' }, cafe)).toBe(false);
        expect(readyCompletesOrder({ type: 'dine-in', source: 'kiosk' }, cafe)).toBe(false);
        expect(readyCompletesOrder({ type: 'delivery' }, cafe)).toBe(false);
    });

    test('tenant without a profile (served step on) → never auto-completes, any type', () => {
        expect(today.orderFlow.servedStep).toBe(true);
        for (const type of ['dine-in', 'takeaway', 'delivery']) {
            expect(readyCompletesOrder({ type }, today)).toBe(false);
        }
    });

    test('defensive: missing order / ops → false', () => {
        expect(readyCompletesOrder(null, cafe)).toBe(false);
        expect(readyCompletesOrder({ type: 'dine-in' }, null)).toBe(false);
        expect(readyCompletesOrder({ type: 'dine-in' }, {})).toBe(false);
    });
});
