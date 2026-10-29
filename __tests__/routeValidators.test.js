/**
 * Request validation on the routes that had none (plan 3A.2). The REAL route
 * files are mounted with their controllers / auth / gates mocked, so these
 * prove (a) the validator is wired on the route, (b) a payload shaped like
 * what the clients send still reaches the controller, (c) wrong types,
 * malformed ids and absurd ranges get the uniform 400 body. No DB.
 */
const express = require('express');
const request = require('supertest');

// Every controller export becomes a handler that answers 200 + its own name.
jest.mock('../controllers/staffWalletController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/tipController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/purchaseController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/supplierController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/productionController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/tenantBillingController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/orderController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/deliveryController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/areaController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/shiftController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/inventoryController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/hallController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/captainController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));
jest.mock('../controllers/comboController', () => new Proxy({}, { get: (_t, k) => (req, res) => res.json({ ok: true, handler: String(k) }) }));

jest.mock('../middlewares/authMiddleware', () => new Proxy({}, {
    // `protect` is itself a middleware, `restrictTo('x')` a factory: serve both shapes.
    get: () => (...a) => (typeof a[2] === 'function' ? a[2]() : (req, res, next) => next()),
}));
jest.mock('../middlewares/tenantContext', () => ({ attachTenant: (req, res, next) => next() }));
jest.mock('../middlewares/featureGate', () => ({ featureGate: () => (req, res, next) => next(), featureGateAny: () => (req, res, next) => next() }));
jest.mock('../middlewares/idempotency', () => ({ idempotency: () => (req, res, next) => next() }));
jest.mock('../middlewares/orderCreateLimiter', () => ({ orderCreateLimiter: (req, res, next) => next() }));
jest.mock('../utils/rateLimitStore', () => ({ makeLimiter: () => (req, res, next) => next() }));

const OID = '507f1f77bcf86cd799439011';

function appFor(routePath) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { role: 'admin', _id: OID }; next(); }); // routes with local role checks (inventory recipes)
    app.use('/', require(routePath));
    return app;
}

// Cases: [description, method, url, body, expectedStatus]
function table(app, rows) {
    test.each(rows)('%s', async (_d, method, url, body, status) => {
        const res = await request(app)[method](url).send(body);
        expect(res.status).toBe(status);
        if (status === 400) {
            expect(res.body.success).toBe(false);
            expect(typeof res.body.message).toBe('string');
            expect(Array.isArray(res.body.errors)).toBe(true);
        } else {
            expect(res.body.ok).toBe(true);
        }
    });
}

describe('staff wallet routes', () => {
    const app = appFor('../routes/staffWalletRoute');
    table(app, [
        ['withdraw: UPI payload the mobile app sends', 'post', '/withdraw', { amount: 500, method: 'UPI', upiId: 'ram@upi', note: '' }, 200],
        ['withdraw: amount as numeric string (web form)', 'post', '/withdraw', { amount: '250.50', method: 'Cash' }, 200],
        ['withdraw: extra unknown keys are tolerated', 'post', '/withdraw', { amount: 100, method: 'Cash', deviceId: 'x', foo: { a: 1 } }, 200],
        ['withdraw: missing body still reaches the controller (it owns "required")', 'post', '/withdraw', {}, 200],
        ['withdraw: negative amount', 'post', '/withdraw', { amount: -5, method: 'Cash' }, 400],
        ['withdraw: zero amount', 'post', '/withdraw', { amount: 0, method: 'Cash' }, 400],
        ['withdraw: non-numeric amount', 'post', '/withdraw', { amount: 'abc', method: 'Cash' }, 400],
        ['withdraw: amount object (NoSQL operator)', 'post', '/withdraw', { amount: { $gt: 0 }, method: 'Cash' }, 400],
        ['withdraw: absurd amount', 'post', '/withdraw', { amount: 1e12, method: 'Cash' }, 400],
        ['withdraw: bad method', 'post', '/withdraw', { amount: 100, method: 'Bitcoin' }, 400],
        ['withdraw: upiId must be text', 'post', '/withdraw', { amount: 100, method: 'UPI', upiId: { a: 1 } }, 400],
        ['withdraw: note too long', 'post', '/withdraw', { amount: 100, method: 'Cash', note: 'x'.repeat(501) }, 400],
        ['approve: valid id + txnRef', 'post', `/withdrawals/${OID}/approve`, { txnRef: 'UTR123' }, 200],
        ['approve: malformed id', 'post', '/withdrawals/not-an-id/approve', {}, 400],
        ['reject: valid', 'post', `/withdrawals/${OID}/reject`, { reason: 'wrong account' }, 200],
        ['reject: reason must be text', 'post', `/withdrawals/${OID}/reject`, { reason: ['x'] }, 400],
    ]);
});

describe('tip routes', () => {
    const app = appFor('../routes/tipRoute');
    table(app, [
        ['settle: valid', 'post', '/settle', { waiterId: OID, paymentMethod: 'Cash', note: 'eod' }, 200],
        ['settle: online', 'post', '/settle', { waiterId: OID, paymentMethod: 'Online' }, 200],
        ['settle: empty body reaches controller', 'post', '/settle', {}, 200],
        ['settle: malformed waiterId', 'post', '/settle', { waiterId: 'abc', paymentMethod: 'Cash' }, 400],
        ['settle: waiterId object', 'post', '/settle', { waiterId: { $ne: null }, paymentMethod: 'Cash' }, 400],
        ['settle: bad paymentMethod', 'post', '/settle', { waiterId: OID, paymentMethod: 'cash' }, 400],
    ]);
});

describe('purchase routes', () => {
    const app = appFor('../routes/purchaseRoute');
    const line = { inventoryItem: OID, orderedQty: 10, rate: 55.5, taxPercent: 5 };
    table(app, [
        ['create: valid PO', 'post', '/', { supplier: OID, orderDate: '2026-10-01', expectedDate: '2026-10-05', lines: [line], notes: 'n', invoiceNumber: 'INV-1' }, 200],
        ['create: numeric strings from a form', 'post', '/', { supplier: OID, lines: [{ inventoryItem: OID, orderedQty: '3', rate: '10', taxPercent: '' }] }, 200],
        ['create: empty body reaches controller', 'post', '/', {}, 200],
        ['create: bad supplier id', 'post', '/', { supplier: 'x', lines: [line] }, 400],
        ['create: lines not an array', 'post', '/', { supplier: OID, lines: 'x' }, 400],
        ['create: line with bad inventory id', 'post', '/', { supplier: OID, lines: [{ ...line, inventoryItem: '1' }] }, 400],
        ['create: zero quantity', 'post', '/', { supplier: OID, lines: [{ ...line, orderedQty: 0 }] }, 400],
        ['create: negative rate', 'post', '/', { supplier: OID, lines: [{ ...line, rate: -1 }] }, 400],
        ['create: tax over 100', 'post', '/', { supplier: OID, lines: [{ ...line, taxPercent: 101 }] }, 400],
        ['create: 201 lines', 'post', '/', { supplier: OID, lines: Array.from({ length: 201 }, () => line) }, 400],
        ['create: bad date', 'post', '/', { supplier: OID, lines: [line], expectedDate: 'tomorrow-ish' }, 400],
        ['update: valid', 'put', `/${OID}`, { notes: 'x', lines: [line] }, 200],
        ['update: bad id', 'put', '/zzz', { notes: 'x' }, 400],
        ['receive: valid', 'post', `/${OID}/receive`, { lines: [{ inventoryItem: OID, qty: 4 }], note: 'ok' }, 200],
        ['receive: negative qty', 'post', `/${OID}/receive`, { lines: [{ inventoryItem: OID, qty: -4 }] }, 400],
        ['receive: bad id', 'post', '/abc/receive', { lines: [] }, 400],
        ['payment: valid', 'post', `/${OID}/payment`, { amount: 1200, mode: 'upi', reference: 'UTR9', paidAt: '2026-10-02T10:00:00Z' }, 200],
        ['payment: amount string', 'post', `/${OID}/payment`, { amount: '1200.50' }, 200],
        ['payment: zero', 'post', `/${OID}/payment`, { amount: 0 }, 400],
        ['payment: Infinity-like string', 'post', `/${OID}/payment`, { amount: 'Infinity' }, 400],
        ['payment: absurd', 'post', `/${OID}/payment`, { amount: 99999999999 }, 400],
        ['payment: bad paidAt', 'post', `/${OID}/payment`, { amount: 5, paidAt: 'nope' }, 400],
        ['payment: bad id', 'post', '/x/payment', { amount: 5 }, 400],
        ['cancel: valid', 'patch', `/${OID}/cancel`, {}, 200],
        ['cancel: bad id', 'patch', '/x/cancel', {}, 400],
    ]);
});

describe('supplier routes', () => {
    const app = appFor('../routes/supplierRoute');
    table(app, [
        ['create: typical', 'post', '/', { name: 'Fresh Farms', mobile: '9876543210', email: 'a@b.co', gstNumber: '27ABCDE1234F1Z5', paymentTermsDays: 15, categories: ['Dairy'], address: 'x' }, 200],
        ['create: paymentTermsDays as string', 'post', '/', { name: 'S', paymentTermsDays: '30' }, 200],
        ['create: unknown keys tolerated', 'post', '/', { name: 'S', foo: 1 }, 200],
        ['create: name must be text', 'post', '/', { name: { $gt: '' } }, 400],
        ['create: name too long', 'post', '/', { name: 'x'.repeat(151) }, 400],
        ['create: terms out of range', 'post', '/', { name: 'S', paymentTermsDays: 100000 }, 400],
        ['create: categories not strings', 'post', '/', { name: 'S', categories: [{ a: 1 }] }, 400],
        ['create: bad branch id', 'post', '/', { name: 'S', branch: 'main' }, 400],
        ['update: valid', 'put', `/${OID}`, { isActive: false, name: 'S2' }, 200],
        ['update: bad id', 'put', '/nope', { name: 'S2' }, 400],
        ['delete: valid', 'delete', `/${OID}`, undefined, 200],
        ['delete: bad id', 'delete', '/nope', undefined, 400],
    ]);
});

describe('production routes', () => {
    const app = appFor('../routes/productionRoute');
    table(app, [
        ['create: valid', 'post', '/', { recipeId: OID, batchQuantity: 2, outputQty: 20, notes: 'n', productionDate: '2026-10-03' }, 200],
        ['create: by menu item', 'post', '/', { menuItemId: OID, batchQuantity: '1.5' }, 200],
        ['create: zero batch', 'post', '/', { recipeId: OID, batchQuantity: 0 }, 400],
        ['create: bad recipe id', 'post', '/', { recipeId: 'r1', batchQuantity: 1 }, 400],
        ['create: absurd batch', 'post', '/', { recipeId: OID, batchQuantity: 1e9 }, 400],
    ]);
});

describe('tenant billing routes', () => {
    const app = appFor('../routes/tenantBillingRoute');
    table(app, [
        ['upgrade: valid plan', 'post', '/upgrade', { planId: OID }, 200],
        ['upgrade: empty body reaches controller', 'post', '/upgrade', {}, 200],
        ['upgrade: malformed plan id', 'post', '/upgrade', { planId: 'gold' }, 400],
        ['verify: razorpay triplet', 'post', '/upgrade/verify', { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'a'.repeat(64) }, 200],
        ['verify: non-text id', 'post', '/upgrade/verify', { razorpay_order_id: { a: 1 } }, 400],
        ['downgrade request: valid', 'post', '/downgrade-request', { planId: OID, reason: 'Too expensive for us right now' }, 200],
        ['downgrade request: reason over 1000', 'post', '/downgrade-request', { planId: OID, reason: 'x'.repeat(1001) }, 400],
        ['downgrade request: bad plan', 'post', '/downgrade-request', { planId: '1', reason: 'long enough reason' }, 400],
        ['cancel downgrade: valid id', 'delete', `/downgrade-request/${OID}`, undefined, 200],
        ['cancel downgrade: bad id', 'delete', '/downgrade-request/abc', undefined, 400],
    ]);
});

describe('order routes (human order numbers stay valid)', () => {
    const app = appFor('../routes/orderRoute');
    table(app, [
        ['create: typical payload', 'post', '/', { type: 'dine-in', tableId: OID, items: [{ menuItem: OID, quantity: 1 }], total: 250, note: 'less spicy' }, 200],
        ['create: unknown keys tolerated', 'post', '/', { items: [{ menuItem: OID }], clientIdempotencyKey: 'k', source: 'kiosk' }, 200],
        ['create: items not an array', 'post', '/', { items: 'x' }, 400],
        ['create: item not an object', 'post', '/', { items: [5] }, 400],
        ['create: 201 items', 'post', '/', { items: Array.from({ length: 201 }, () => ({})) }, 400],
        ['create: total negative', 'post', '/', { items: [{}], total: -1 }, 400],
        ['create: note object', 'post', '/', { items: [{}], note: { a: 1 } }, 400],
        ['status by ObjectId', 'patch', `/${OID}/status`, { status: 'preparing' }, 200],
        ['status by human order number', 'patch', '/ORD-0001/status', { status: 'ready' }, 200],
        ['status: payments array passes untouched (tender code owns it)', 'patch', `/${OID}/status`, { status: 'served', paymentStatus: 'Paid', payments: [{ method: 'cash', amount: 5 }] }, 200],
        ['status: status must be text', 'patch', `/${OID}/status`, { status: { $ne: 1 } }, 400],
        ['status: path-ish id', 'patch', '/..%2F..%2Fx/status', { status: 'ready' }, 400],
        ['delivery: valid', 'patch', `/${OID}/delivery`, { status: 'assigned', partnerName: 'Raj' }, 200],
        ['delivery: partnerName object', 'patch', `/${OID}/delivery`, { partnerName: {} }, 400],
        ['append: valid', 'post', `/${OID}/append`, { items: [{ menuItem: OID, quantity: 2 }] }, 200],
        ['append: items string', 'post', `/${OID}/append`, { items: 'x' }, 400],
        ['coupon: valid', 'patch', `/${OID}/coupon`, { code: 'SAVE10' }, 200],
        ['coupon: code object', 'patch', `/${OID}/coupon`, { code: { $ne: null } }, 400],
        ['bill/save: final true', 'post', `/${OID}/bill/save`, { final: true }, 200],
        ['bill/save: final must be boolean', 'post', `/${OID}/bill/save`, { final: { a: 1 } }, 400],
        ['bill/reopen: reason too long', 'post', `/${OID}/bill/reopen`, { reason: 'x'.repeat(501) }, 400],
        ['payment: valid', 'patch', `/${OID}/payment`, { paymentStatus: 'Paid', paymentMethod: 'razorpay' }, 200],
        ['payment: method object', 'patch', `/${OID}/payment`, { paymentMethod: { a: 1 } }, 400],
        ['cancel by order number', 'patch', '/ORD-0042/cancel', {}, 200],
        ['rating: numeric string stays valid (service owns the 1-5 rule)', 'patch', `/${OID}/rating`, { rating: '5', feedback: 'great' }, 200],
        ['rating: feedback object', 'patch', `/${OID}/rating`, { rating: 5, feedback: { a: 1 } }, 400],
        ['repeat item: valid ids', 'post', `/${OID}/repeat/${OID}`, { quantity: 2 }, 200],
        ['repeat item: bad item id', 'post', `/${OID}/repeat/abc`, {}, 400],
        ['repeat item: quantity zero', 'post', `/${OID}/repeat/${OID}`, { quantity: 0 }, 400],
        ['repeat all: valid', 'post', `/${OID}/repeat-all`, { selections: [], targetTableId: OID }, 200],
        ['cleanup-stale: valid', 'post', '/admin/cleanup-stale', { minutesOld: 360, type: 'takeaway', dryRun: true }, 200],
        ['cleanup-stale: dryRun string', 'post', '/admin/cleanup-stale', { dryRun: { a: 1 } }, 400],
        ['delivery quote: valid', 'post', '/delivery-quote', { lat: 19.07, lng: 72.87, address: 'x' }, 200],
        ['delivery quote: lat out of range', 'post', '/delivery-quote', { lat: 123, lng: 72.87 }, 400],
    ]);
});

describe('area / shift / captain / print-free simple routes', () => {
    table(appFor('../routes/areaRoute'), [
        ['area create', 'post', '/', { name: 'Terrace', note: 'n', branch: OID }, 200],
        ['area create: name object', 'post', '/', { name: {} }, 400],
        ['area update bad id', 'put', '/x', { name: 'a' }, 400],
        ['area update isActive false', 'put', `/${OID}`, { isActive: false }, 200],
        ['area delete bad id', 'delete', '/x', undefined, 400],
    ]);
    table(appFor('../routes/shiftRoute'), [
        ['clock-in with note', 'post', '/clock-in', { note: 'on time' }, 200],
        ['clock-in with no body', 'post', '/clock-in', undefined, 200],
        ['clock-out note too long', 'post', '/clock-out', { note: 'x'.repeat(501) }, 400],
        ['handover valid', 'post', '/handover', { note: 'ok', cashCounted: '1250.50' }, 200],
        ['handover negative cash', 'post', '/handover', { cashCounted: -1 }, 400],
        ['handover cash text', 'post', '/handover', { cashCounted: 'lots' }, 400],
    ]);
    table(appFor('../routes/captainRoute'), [
        ['escalate valid', 'post', '/escalate', { reason: 'Table 4 angry', orderId: 'ORD-1', tableName: 'T4', severity: 'urgent' }, 200],
        ['escalate reason object', 'post', '/escalate', { reason: { a: 1 } }, 400],
    ]);
});

describe('inventory / hall / combo', () => {
    table(appFor('../routes/inventoryRoute'), [
        ['create item', 'post', '/', { name: 'Tomato', category: 'Fruits & Vegetables', unit: 'kg', currentStock: 10, minStock: '2', costPerUnit: 30.5, expiryTracking: true }, 200],
        ['create item: stock negative', 'post', '/', { name: 'Tomato', currentStock: -1 }, 400],
        ['create item: name object', 'post', '/', { name: { $ne: 1 } }, 400],
        ['update bad id', 'put', '/x', { name: 'a' }, 400],
        ['adjust valid', 'patch', `/${OID}/adjust`, { type: 'restock', quantity: 5, reason: 'delivery' }, 200],
        ['adjust: reason too long', 'patch', `/${OID}/adjust`, { type: 'waste', quantity: 1, reason: 'x'.repeat(501) }, 400],
        ['delete bad id', 'delete', '/x', undefined, 400],
        ['recipe save valid', 'post', '/recipes', { menuItemId: OID, ingredients: [{ inventoryItem: OID, quantity: 0.2, unit: 'kg' }], yield: 2, prepLossPercent: 5 }, 200],
        ['recipe save: bad ingredient id', 'post', '/recipes', { menuItemId: OID, ingredients: [{ inventoryItem: 'x', quantity: 1, unit: 'kg' }] }, 400],
        ['recipe save: ingredients not array', 'post', '/recipes', { menuItemId: OID, ingredients: 'x' }, 400],
        ['recipe delete bad id', 'delete', '/recipes/x', undefined, 400],
    ]);
    table(appFor('../routes/hallRoute'), [
        ['hall create', 'post', '/', { name: 'Grand', type: 'Banquet Hall', maxCapacity: 300, minCapacity: 50, basePrice: 50000 }, 200],
        ['hall create: capacity text', 'post', '/', { name: 'Grand', maxCapacity: 'big' }, 400],
        ['hall update bad id', 'put', '/x', { name: 'a' }, 400],
        ['hall delete bad id', 'delete', '/x', undefined, 400],
    ]);
    table(appFor('../routes/comboRoute'), [
        ['combo create', 'post', '/', { name: 'Thali', price: 299, discount: 10, discountType: 'percent', categories: [] }, 200],
        ['combo create: price text', 'post', '/', { name: 'Thali', price: 'cheap' }, 400],
        ['combo update bad id', 'put', '/x', { name: 'a' }, 400],
        ['combo delete bad id', 'delete', '/x', undefined, 400],
    ]);
});
