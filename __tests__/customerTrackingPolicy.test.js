/**
 * utils/customerTrackingPolicy — pure shaping of CUSTOMER-facing order
 * payloads for tenants with `orderFlow.customerTracking:false`
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.3). No Mongo.
 */
const {
    collapseStatus,
    customerTrackingEnabled,
    applyCustomerTrackingPolicy,
    applyCustomerTrackingPolicyToList,
    customerEventPayload,
    customerHearsTransition,
    KITCHEN_ORDER_FIELDS,
    KITCHEN_ITEM_FIELDS,
} = require('../utils/customerTrackingPolicy');
const { resolveOperations, normaliseProfile } = require('../utils/operationsProfile');

const FULL_PLAN = {
    dineIn: true, takeaway: true, kitchenDisplay: true, waiterDashboard: true,
    paymentGateway: true, walletLoyalty: true, tipManagement: true, kiosk: true,
};
const tenant = (operations) => ({ subscription: { features: FULL_PLAN }, operations });

const OPS_ON = resolveOperations(tenant(undefined));                      // today's default
const OPS_OFF = resolveOperations(tenant(normaliseProfile({
    modules: { qrOrdering: true, waiter: true, captain: true, chef: false, customerPayment: true },
})));

const detail = () => ({
    _id: 'x', orderId: 'ORD-1', id: 'ORD-1', status: 'preparing', paymentStatus: 'Pending',
    preparationStartedAt: new Date('2026-10-19T10:00:00Z'), preparationCompletedAt: null,
    chef: 'chef-id', servedAt: null, cancelledAt: null, releasedAt: new Date('2026-10-19T09:59:00Z'),
    total: 420, type: 'dine-in',
    items: [
        { name: 'Paneer', price: 200, quantity: 2, prepStation: 'kitchen', prepTimeMinutes: 15, instructions: '' },
        { name: 'Coke', price: 20, quantity: 1, prepStation: 'counter', prepTimeMinutes: 0 },
    ],
});

describe('fixtures', () => {
    test('the no-chef profile really has tracking off and the default has it on', () => {
        expect(OPS_ON.orderFlow.customerTracking).toBe(true);
        expect(OPS_OFF.orderFlow.customerTracking).toBe(false);
    });
});

describe('collapseStatus', () => {
    test.each([
        ['new', 'confirmed'],
        ['preparing', 'confirmed'],
        ['ready', 'confirmed'],
        ['served', 'completed'],
        ['cancelled', 'cancelled'],
        ['awaiting-payment', 'awaiting-payment'],
    ])('%s → %s', (input, expected) => {
        expect(collapseStatus(input)).toBe(expected);
    });

    test('unknown / missing values pass through', () => {
        expect(collapseStatus('weird')).toBe('weird');
        expect(collapseStatus(undefined)).toBeUndefined();
        expect(collapseStatus(null)).toBeNull();
    });
});

describe('customerTrackingEnabled', () => {
    test('on for null, {}, the default profile; off only for an explicit false', () => {
        expect(customerTrackingEnabled(null)).toBe(true);
        expect(customerTrackingEnabled(undefined)).toBe(true);
        expect(customerTrackingEnabled({})).toBe(true);
        expect(customerTrackingEnabled({ orderFlow: {} })).toBe(true);
        expect(customerTrackingEnabled(OPS_ON)).toBe(true);
        expect(customerTrackingEnabled(OPS_OFF)).toBe(false);
        expect(customerTrackingEnabled({ orderFlow: { customerTracking: false } })).toBe(false);
    });
});

describe('applyCustomerTrackingPolicy — tracking ON (default tenants)', () => {
    test('returns the very same object, nothing added or removed', () => {
        const p = detail();
        const snapshot = JSON.parse(JSON.stringify(p));
        const out = applyCustomerTrackingPolicy(p, OPS_ON);
        expect(out).toBe(p);
        expect(JSON.parse(JSON.stringify(out))).toEqual(snapshot);
        expect(out.trackingDisabled).toBeUndefined();
        expect(out.status).toBe('preparing');
        expect(out.items[0].prepStation).toBe('kitchen');
    });

    test('null ops (no restaurant / legacy single tenant) is tracking on', () => {
        const p = detail();
        expect(applyCustomerTrackingPolicy(p, null)).toBe(p);
    });

    test('list helper also returns the same array', () => {
        const list = [detail(), detail()];
        expect(applyCustomerTrackingPolicyToList(list, OPS_ON)).toBe(list);
    });
});

describe('applyCustomerTrackingPolicy — tracking OFF', () => {
    test.each([
        ['new', 'confirmed'],
        ['preparing', 'confirmed'],
        ['ready', 'confirmed'],
        ['served', 'completed'],
        ['cancelled', 'cancelled'],
        ['awaiting-payment', 'awaiting-payment'],
    ])('status %s is shown as %s with trackingDisabled:true', (status, shown) => {
        const out = applyCustomerTrackingPolicy({ ...detail(), status }, OPS_OFF);
        expect(out.status).toBe(shown);
        expect(out.trackingDisabled).toBe(true);
    });

    test('strips kitchen-only order fields and item fields, keeps everything else', () => {
        const p = detail();
        const out = applyCustomerTrackingPolicy(p, OPS_OFF);
        for (const k of KITCHEN_ORDER_FIELDS) expect(out).not.toHaveProperty(k);
        for (const item of out.items) for (const k of KITCHEN_ITEM_FIELDS) expect(item).not.toHaveProperty(k);
        // Completion / payment / cancellation markers survive.
        expect(out).toHaveProperty('servedAt');
        expect(out).toHaveProperty('cancelledAt');
        expect(out).toHaveProperty('releasedAt');
        expect(out.paymentStatus).toBe('Pending');
        expect(out.total).toBe(420);
        expect(out.items).toEqual([
            { name: 'Paneer', price: 200, quantity: 2, instructions: '' },
            { name: 'Coke', price: 20, quantity: 1 },
        ]);
    });

    test('does not mutate the input', () => {
        const p = detail();
        const snapshot = JSON.parse(JSON.stringify(p));
        applyCustomerTrackingPolicy(p, OPS_OFF);
        expect(JSON.parse(JSON.stringify(p))).toEqual(snapshot);
    });

    test('a payload without items or status still gets trackingDisabled', () => {
        expect(applyCustomerTrackingPolicy({ orderId: 'ORD-2' }, OPS_OFF)).toEqual({ orderId: 'ORD-2', trackingDisabled: true });
    });

    test('non-object payloads pass through', () => {
        expect(applyCustomerTrackingPolicy(null, OPS_OFF)).toBeNull();
        expect(applyCustomerTrackingPolicy(undefined, OPS_OFF)).toBeUndefined();
    });

    test('Mongoose-like documents are flattened via toObject()', () => {
        const doc = { toObject: () => ({ orderId: 'ORD-3', status: 'ready', preparationStartedAt: 1, items: [{ name: 'A', prepStation: 'bar' }] }) };
        expect(applyCustomerTrackingPolicy(doc, OPS_OFF)).toEqual({
            orderId: 'ORD-3', status: 'confirmed', items: [{ name: 'A' }], trackingDisabled: true,
        });
    });

    test('list helper shapes every row', () => {
        const out = applyCustomerTrackingPolicyToList([{ status: 'new' }, { status: 'served' }], OPS_OFF);
        expect(out).toEqual([{ status: 'confirmed', trackingDisabled: true }, { status: 'completed', trackingDisabled: true }]);
    });
});

describe('socket helpers', () => {
    test('customerEventPayload collapses the status only when tracking is off', () => {
        const p = { orderId: 'ORD-1', status: 'preparing', paymentStatus: 'Paid' };
        expect(customerEventPayload(p, OPS_ON)).toBe(p);
        expect(customerEventPayload(p, OPS_OFF)).toEqual({ orderId: 'ORD-1', status: 'confirmed', paymentStatus: 'Paid', trackingDisabled: true });
        expect(p.status).toBe('preparing');
    });

    test('customerHearsTransition: payment-only, new, served and cancelled yes; preparing / ready no', () => {
        expect(customerHearsTransition(undefined)).toBe(true);
        expect(customerHearsTransition(null)).toBe(true);
        expect(customerHearsTransition('')).toBe(true);
        expect(customerHearsTransition('new')).toBe(true);
        expect(customerHearsTransition('served')).toBe(true);
        expect(customerHearsTransition('cancelled')).toBe(true);
        expect(customerHearsTransition('preparing')).toBe(false);
        expect(customerHearsTransition('ready')).toBe(false);
    });
});
