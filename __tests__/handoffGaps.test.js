/**
 * Wave-1 hand-off gaps: keyed/deduped webhook events (order.paid, refund.created),
 * HSN snapshot on order lines + GST report preference, tender timestamps,
 * and inventory-deduction recovery wiring. No network, no database.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const WebhookEndpoint = require('../models/webhookEndpoint');
const WebhookDelivery = require('../models/webhookDelivery');
const Restaurant = require('../models/restaurant');
const svc = require('../utils/webhookService');

const RID = '64b000000000000000000001';
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function arm({ existing = null } = {}) {
    jest.spyOn(WebhookEndpoint, 'find').mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'e1', restaurant: RID, secret: 's', url: 'https://127.0.0.1/blocked', active: true }] }) });
    jest.spyOn(Restaurant, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ subscription: { features: { publicApi: true } } }) }) });
    const findOne = jest.spyOn(WebhookDelivery, 'findOne').mockReturnValue({ select: () => ({ lean: async () => existing }) });
    const create = jest.spyOn(WebhookDelivery, 'create').mockImplementation(async (d) => ({ ...d, _id: 'd1' }));
    jest.spyOn(WebhookDelivery, 'updateOne').mockResolvedValue({});
    jest.spyOn(WebhookEndpoint, 'findOneAndUpdate').mockResolvedValue({ active: true, consecutiveFailures: 1 });
    return { create, findOne };
}

describe('keyed webhook events', () => {
    afterEach(() => jest.restoreAllMocks());

    test('eventIdForKey is deterministic and distinct per key / type / tenant', () => {
        const a = svc.eventIdForKey(RID, 'order.paid', 'order:1:paid');
        expect(a).toBe(svc.eventIdForKey(RID, 'order.paid', 'order:1:paid'));
        expect(a).toMatch(/^evt_[0-9a-f]{24}$/);
        expect(a).not.toBe(svc.eventIdForKey(RID, 'order.paid', 'order:2:paid'));
        expect(a).not.toBe(svc.eventIdForKey(RID, 'refund.created', 'order:1:paid'));
    });

    test('emitOrderPaid called by several settlement paths delivers ONE event with a derived id', async () => {
        const { create } = arm();
        const order = { _id: '64b0000000000000000000aa', restaurant: RID, orderId: 'ORD-P1', paymentStatus: 'Paid', items: [], total: 100 };
        svc.emitOrderPaid(order);
        svc.emitOrderPaid(order);   // e.g. razorpay verify + webhook
        svc.emitOrderPaid({ ...order });
        await wait();
        expect(create).toHaveBeenCalledTimes(1);
        const row = create.mock.calls[0][0];
        expect(row.type).toBe('order.paid');
        expect(row.eventId).toBe(svc.eventIdForKey(RID, 'order.paid', `order:${order._id}:paid`));
        expect(row.payload.id).toBe(row.eventId);
    });

    test('a delivery already stored for the same event id (another process) is not duplicated', async () => {
        const { create, findOne } = arm({ existing: { _id: 'old' } });
        svc.emitOrderPaid({ _id: '64b0000000000000000000bb', restaurant: RID, orderId: 'ORD-P2', items: [] });
        await wait();
        expect(findOne).toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    test('refund.created: same refund reported twice is one event; a second refund is a new event', async () => {
        const { create } = arm();
        const order = { _id: '64b0000000000000000000cc', restaurant: RID, orderId: 'ORD-R1', refundedAmount: 40 };
        svc.emitRefundCreated(order, { amount: 40, mode: 'wallet', refundRequestId: 'rr1' });
        svc.emitRefundCreated(order, { amount: 40, mode: 'wallet' });
        svc.emitRefundCreated({ ...order, refundedAmount: 70 }, { amount: 30, mode: 'wallet' });
        await wait();
        expect(create).toHaveBeenCalledTimes(2);
        const first = create.mock.calls[0][0];
        expect(first.type).toBe('refund.created');
        expect(first.payload.data).toEqual({ order_id: 'ORD-R1', amount: 40, mode: 'wallet', refund_request_id: 'rr1' });
        expect(create.mock.calls[0][0].eventId).not.toBe(create.mock.calls[1][0].eventId);
    });

    test('helpers never throw on bad input and un-keyed emits keep random ids', async () => {
        expect(() => svc.emitOrderPaid(null)).not.toThrow();
        expect(() => svc.emitRefundCreated(undefined)).not.toThrow();
        const { create } = arm();
        svc.emitWebhookEvent(RID, 'webhook.test', {});
        svc.emitWebhookEvent(RID, 'webhook.test', {});
        await wait();
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[0][0].eventId).not.toBe(create.mock.calls[1][0].eventId);
    });
});

describe('refund + paid wiring (source)', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    test('processOrderRefund and the direct refund controller emit refund.created; the approval controller no longer double-emits', () => {
        expect(read('utils/orderRefund.js')).toMatch(/emitRefundCreated/);
        expect(read('controllers/razorpay/refunds.js')).toMatch(/emitRefundCreated/);
        expect(read('controllers/refundRequestController.js')).not.toMatch(/emitWebhookEvent\(rr\.restaurant, 'refund\.created'/);
        expect(read('controllers/refundRequestController.js')).toMatch(/refundRequestId: rr\._id/);
    });
    test('every paid-transition path emits order.paid', () => {
        for (const f of ['services/orderStatusService.js', 'controllers/razorpay/_shared.js', 'controllers/walletController.js', 'services/orderPaymentService.js']) {
            expect(read(f)).toMatch(/emitOrderPaid/);
        }
    });
});

describe('HSN snapshot on order lines', () => {
    const { resolveLineHsn, enrichCartItems, buildAppendItems } = require('../services/orderPricingService');
    const { resolveHsn, buildGstReport } = require('../utils/gstReport');

    test('resolveLineHsn: item, then category, then tenant default, then empty', () => {
        expect(resolveLineHsn({ hsnCode: '2106', category: { hsnCode: '9963' } }, '996331')).toBe('2106');
        expect(resolveLineHsn({ hsnCode: '', category: { hsnCode: '9963' } }, '996331')).toBe('9963');
        expect(resolveLineHsn({ category: { name: 'x' } }, '996331')).toBe('996331');
        expect(resolveLineHsn({}, '')).toBe('');
        expect(resolveLineHsn(undefined)).toBe('');
    });

    test('enrichCartItems stamps hsnCode (client value is overridden)', () => {
        const menu = { _id: 'm1', name: 'Tea', hsnCode: '0902', category: { name: 'Drinks', hsnCode: '2202' }, prepTimeMinutes: 5 };
        const out = enrichCartItems([{ menuItem: 'm1', price: 10, quantity: 1, hsnCode: '9999' }], new Map([['m1', menu]]), { defaultHsn: '996331' });
        expect(out[0].hsnCode).toBe('0902');
        const noHsn = { _id: 'm2', name: 'Soda', category: { name: 'Drinks', hsnCode: '2202' } };
        expect(enrichCartItems([{ menuItem: 'm2', price: 10, quantity: 1 }], new Map([['m2', noHsn]]))[0].hsnCode).toBe('2202');
        const bare = { _id: 'm3', name: 'Misc', category: { name: 'X' } };
        expect(enrichCartItems([{ menuItem: 'm3', price: 10, quantity: 1 }], new Map([['m3', bare]]), { defaultHsn: '996331' })[0].hsnCode).toBe('996331');
        expect(typeof buildAppendItems).toBe('function');
    });

    test('order schema carries item hsnCode', () => {
        const Order = require('../models/order');
        expect(Order.schema.path('items').schema.path('hsnCode')).toBeTruthy();
    });

    test('GST report prefers the order-line hsnCode, falls back to the menu lookup for old orders', () => {
        const ctx = { itemHsn: { m1: 'LIVE1' }, categoryHsn: { drinks: 'LIVECAT' }, defaultHsn: '996331' };
        expect(resolveHsn({ menuItem: 'm1', hsnCode: 'SOLD1' }, ctx)).toEqual({ hsn: 'SOLD1', source: 'order' });
        expect(resolveHsn({ menuItem: 'm1' }, ctx)).toEqual({ hsn: 'LIVE1', source: 'item' });
        expect(resolveHsn({ menuItem: 'zz', category: 'Drinks', hsnCode: '' }, ctx)).toEqual({ hsn: 'LIVECAT', source: 'category' });
        expect(resolveHsn({ menuItem: 'zz' }, ctx).source).toBe('default');

        const order = {
            orderId: 'O1', status: 'served', paymentStatus: 'Paid', createdAt: new Date('2026-10-01T10:00:00Z'), paidAt: new Date('2026-10-01T10:30:00Z'),
            total: 105, gst: 5, items: [{ menuItem: 'm1', name: 'Tea', price: 100, quantity: 1, hsnCode: 'SOLD1' }],
        };
        const report = buildGstReport({ orders: [order], ...ctx, tz: 'Asia/Kolkata', range: {} });
        expect(report.hsn.map((h) => h.hsn)).toContain('SOLD1');
        expect(report.hsn.map((h) => h.hsn)).not.toContain('LIVE1');
    });
});

describe('tender timestamps', () => {
    const { resolveTenderedBody } = require('../services/orderTenderService');
    const { loadSources } = require('../services/ledgerSources');
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

    test('counter tenders get an `at` (and legacy prior lines are stamped, never null)', () => {
        const old = { total: 200, amountPaid: 0, paymentStatus: 'Unpaid', type: 'takeaway' };
        const r = resolveTenderedBody(old, { payments: [{ method: 'cash', amount: 120 }, { method: 'upi', amount: 80 }], paymentStatus: 'Paid' }, { userId: 'u1', role: 'captain' });
        expect(r.payments).toHaveLength(2);
        for (const p of r.payments) expect(p.at).toBeInstanceOf(Date);

        const partial = { total: 200, amountPaid: 50, paymentMethod: 'cash', paymentStatus: 'Partially Paid', type: 'takeaway' };
        const r2 = resolveTenderedBody(partial, { payments: [{ method: 'upi', amount: 150 }], paymentStatus: 'Paid' }, { userId: 'u1', role: 'captain' });
        expect(r2.payments.length).toBeGreaterThanOrEqual(2);
        for (const p of r2.payments) expect(p.at).toBeInstanceOf(Date);
    });

    test('razorpay + wallet tender pushes set `at`; schema defaults it too', () => {
        expect(read('controllers/razorpay/_shared.js')).toMatch(/\$push = \{ payments: \{[^}]*at: new Date\(\)/);
        expect(read('controllers/walletController.js')).toMatch(/\$push: \{ payments: \{[^}]*at: new Date\(\)/);
        const Order = require('../models/order');
        const m = new Order({ payments: [{ method: 'cash', amount: 5 }] });
        expect(m.payments[0].at).toBeInstanceOf(Date);
    });

    test('ledger day-buckets a tender on payments[].at, falling back to paidAt', async () => {
        const Order = require('../models/order');
        const day = (d) => new Date(`2026-10-${d}T08:00:00Z`);
        const orders = [{
            orderId: 'A', paidAt: day('05'), amountPaid: 100, paymentMethod: 'cash',
            payments: [{ method: 'cash', amount: 60, at: day('04') }, { method: 'upi', amount: 40, at: day('05') }],
        }, { orderId: 'B', paidAt: day('05'), amountPaid: 30, paymentMethod: 'cash' }];
        const chain = (rows) => { const c = { select: () => c, limit: () => c, lean: async () => rows }; return c; };
        jest.spyOn(Order, 'find').mockReturnValueOnce(chain(orders)).mockReturnValueOnce(chain([]));
        for (const m of ['expense', 'supplierPayment', 'supplierInvoice', 'purchaseOrder']) {
            jest.spyOn(require('../models/' + m), 'find').mockReturnValue(chain([]));
        }
        const out = await loadSources({ restaurantId: RID, start: new Date('2026-10-05T00:00:00Z'), end: new Date('2026-10-06T00:00:00Z') });
        jest.restoreAllMocks();
        {
            const seen = out.tenders.map((t) => `${t.order.orderId}:${t.line.method}`);
            expect(seen).toContain('A:upi');
            expect(seen).not.toContain('A:cash');   // 04 Oct line is outside the 05 Oct bucket
            expect(seen).toContain('B:cash');       // no payments[] -> legacy line on paidAt
        }
    });
});

describe('inventory deduction recovery wiring', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    test.each([
        'services/orderCreateService.js', 'services/orderItemsService.js', 'services/orderHoldService.js', 'services/orderStatusService.js',
    ])('%s no longer calls deductInventoryForOrder from inventoryController directly', (f) => {
        const src = read(f);
        expect(src).not.toMatch(/\{ deductInventoryForOrder \} = require\('\.\.\/controllers\/inventoryController'\)/);
        expect(src).toMatch(/runDeductionWithRecovery/);
    });
});
