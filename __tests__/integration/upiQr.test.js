/**
 * UPI "scan to pay" at the table:
 *   Settings -> payments { upiId, upiPayeeName }   (PATCH /settings/payments, PUT /settings)
 *   GET /orders/:id/upi-qr                         (captain / admin / manager)
 *   unpaid bill slip + GET /orders/:id/bill/preview carry a { qr } line
 *   PATCH /orders/:id/status { paymentStatus:'Paid', paymentMethod:'UPI', manualConfirm:true, upiRef }
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createUser } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const Order = req_('models/order');
const Table = req_('models/table');
const Settings = req_('models/settings');
const PrintJob = req_('models/printJob');
const logger = req_('utils/logger');
const { toPlainText } = req_('utils/receiptRenderer');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(6).toString('hex');
const VPA = 'tiptopcafe@okaxis';
const VPA_RAW = '  TipTopCafe@OkAxis ';
const NAME = 'Tip Top Cafe & Co';
let A;
let B;
let manager;

const as = (role, t = A) => ctx.api.as(t.users[role], t);
const admin = () => as('admin');
const captain = () => as('captain');
const qrLinesOf = (lines) => (lines || []).filter((l) => l.qr);

beforeAll(async () => {
    A = await seedTenant({ label: 'upi-a' });
    B = await seedTenant({ label: 'upi-b' });
    manager = await createUser({
        name: 'mgr upi', email: `manager.${rid()}@staff.test`, role: 'manager',
        restaurant: A.restaurant._id, branch: A.branch._id, permissions: defaultPermissionsForRole('manager'),
    });
    const printers = {
        enabled: true,
        autoPrint: { kotOnCreate: false, kotOnAppend: false, billOnPaid: false },
        list: [{ name: 'Counter', station: 'counter', interface: 'lan', host: '10.9.9.2', port: 9102, paperWidth: '80' }],
    };
    expect((await admin().patch('/settings/printers').send(printers)).status).toBe(200);
    expect((await as('admin', B).patch('/settings/printers').send(printers)).status).toBe(200);
});

const takeaway = async (t = A) => {
    const res = await ctx.api.as(t.users.admin, t).post('/orders').send({
        type: 'takeaway', pickupLocation: 'Counter',
        items: [{ menuItem: String(t.items.paneer._id), quantity: 1 }],
        total: 5000, clientIdempotencyKey: `idem_${rid()}${rid()}`,
    });
    expect(res.status).toBe(201);
    return res.body.order;
};
const dineIn = async () => {
    const table = await createTable(A, { capacity: 6 });
    const res = await captain().post('/orders').send({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }], total: 5000,
    });
    expect(res.status).toBe(201);
    return { order: res.body.order, table };
};
const reload = (id) => Order.findById(id).lean();
const qr = (id, client = captain()) => client.get(`/orders/${id}/upi-qr`);
const preview = (id, client = captain()) => client.get(`/orders/${id}/bill/preview`);
const money = (n) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const settleBody = (extra = {}) => ({ paymentStatus: 'Paid', paymentMethod: 'UPI', manualConfirm: true, ...extra });
const qs = (uri) => new URL(uri.replace('upi://pay?', 'https://x/?')).searchParams;

describe('Settings: payments.upiId / upiPayeeName', () => {
    test('validation: bad VPA, overlong values and wrong types are 400s with a field map', async () => {
        for (const upiId of ['nope', 'a@b', 'x y@upi', `${'a'.repeat(98)}@upi`, 12, {}]) {
            const r = await admin().patch('/settings/payments').send({ upiId });
            expect(r.status).toBe(400);
            expect(r.body.errors).toHaveProperty('upiId');
        }
        const long = await admin().patch('/settings/payments').send({ upiPayeeName: 'x'.repeat(61) });
        expect(long.status).toBe(400);
        expect(long.body.errors).toHaveProperty('upiPayeeName');
        const put = await admin().put('/settings').send({ payments: { upiId: 'bad' } });
        expect(put.status).toBe(400);
        expect(put.body.errors).toHaveProperty(['payments.upiId']);
    });

    test('saved trimmed + lowercased; payee name control chars stripped; unknown keys ignored; change logged masked', async () => {
        const spy = jest.spyOn(logger, 'info');
        try {
            const r = await admin().patch('/settings/payments').send({ upiId: VPA_RAW, upiPayeeName: `  ${NAME}\u0007\n `, secret: 'x' });
            expect(r.status).toBe(200);
            expect(r.body.payments).toMatchObject({ upiId: VPA, upiPayeeName: NAME });
            const doc = await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean();
            expect(doc.payments).toEqual({ upiId: VPA, upiPayeeName: NAME });
            const lines = spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('UPI payee changed'));
            expect(lines.length).toBeGreaterThan(0);
            expect(lines.join('\n')).toContain('ti***@okaxis');
            expect(lines.join('\n')).not.toContain(VPA);
        } finally { spy.mockRestore(); }
    });

    test('manager may edit (settings are admin/manager); captain / waiter / chef may not', async () => {
        expect((await ctx.api.as(manager, A).patch('/settings/payments').send({ upiPayeeName: NAME })).status).toBe(200);
        for (const role of ['captain', 'waiter', 'chef']) {
            expect((await as(role).patch('/settings/payments').send({ upiId: 'evil@upi' })).status).toBe(403);
        }
        expect((await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean()).payments.upiId).toBe(VPA);
    });

    test('staff reads: admin/manager full + mask; captain/waiter/chef masked only; guests nothing', async () => {
        const adm = (await admin().get('/settings')).body;
        expect(adm.payments).toEqual({ upiId: VPA, upiPayeeName: NAME, upiIdMasked: 'ti***@okaxis', upiConfigured: true, upiInherited: false });
        // the manager is pinned to the Main branch: own doc has no id, the tenant one applies
        expect((await ctx.api.as(manager, A).get('/settings')).body.payments).toEqual({ upiId: '', upiPayeeName: NAME, upiIdMasked: 'ti***@okaxis', upiConfigured: true, upiInherited: true });
        for (const role of ['captain', 'waiter', 'chef']) {
            const s = (await as(role).get('/settings')).body;
            expect(s.payments).toEqual({ upiConfigured: true, upiIdMasked: 'ti***@okaxis', upiPayeeName: NAME });
            expect(JSON.stringify(s)).not.toContain(VPA);
        }
        const guest = await ctx.api.guest(A).get('/settings');
        expect(guest.status).toBe(200);
        expect(guest.body.payments).toBeUndefined();
        expect(JSON.stringify(guest.body)).not.toContain('okaxis');
    });

    test('PUT /settings merges the two fields; echoing the GET shape back is accepted; other tenant untouched', async () => {
        expect((await admin().put('/settings').send({ payments: { upiPayeeName: 'Changed' } })).status).toBe(200);
        let doc = await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean();
        expect(doc.payments).toEqual({ upiId: VPA, upiPayeeName: 'Changed' });
        expect((await admin().put('/settings').send({ payments: { upiId: VPA, upiPayeeName: NAME, upiIdMasked: 'x', upiConfigured: false } })).status).toBe(200);
        doc = await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean();
        expect(doc.payments).toEqual({ upiId: VPA, upiPayeeName: NAME });
        const bDoc = await Settings.findOne({ restaurant: B.restaurant._id, branch: null }).lean();
        expect(bDoc?.payments?.upiId || '').toBe('');
    });
});

describe('GET /orders/:id/upi-qr', () => {
    test('409 UPI_NOT_CONFIGURED when the restaurant has no UPI id', async () => {
        const o = await takeaway(B);
        const r = await qr(o._id, as('captain', B));
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ success: false, code: 'UPI_NOT_CONFIGURED' });
    });

    test('shape: amount = current due, masked payee, upi:// uri, PNG data URL', async () => {
        const order = await takeaway();
        const r = await qr(order._id);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
            success: true, orderId: order.orderId, amount: order.total,
            payee: { name: NAME, upiIdMasked: 'ti***@okaxis' },
            billStatus: null, paymentStatus: 'Pending',
            note: 'Amount is the balance due now; regenerate if the bill changes',
        });
        expect(r.body.payee).not.toHaveProperty('upiId');
        expect(r.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
        expect(r.body.upiUri.startsWith('upi://pay?pa=tiptopcafe@okaxis&pn=Tip%20Top%20Cafe%20%26%20Co&am=')).toBe(true);
        const q = qs(r.body.upiUri);
        expect(q.get('am')).toBe(order.total.toFixed(2));
        expect(q.get('cu')).toBe('INR');
        expect(q.get('tr')).toBe(order.orderId.replace(/[^A-Za-z0-9._-]/g, ''));
        expect(q.get('tn')).toContain(order.orderId);
        expect((await qr(order._id, as('admin'))).status).toBe(200);
        expect((await qr(order._id, ctx.api.as(manager, A))).status).toBe(200);
    });

    test('dine-in note carries the table label', async () => {
        const { order, table } = await dineIn();
        const r = await qr(order._id);
        expect(qs(r.body.upiUri).get('tn')).toBe(`Table ${table.name} ${order.orderId}`);
    });

    test('amount follows tip (inside total), manual discount and partial amountPaid', async () => {
        const order = await takeaway();
        const total = order.total;
        await Order.updateOne({ _id: order._id }, { $set: { tipAmount: 25, total: total + 25 } });
        expect((await qr(order._id)).body.amount).toBe(total + 25);
        expect((await captain().patch(`/orders/${order._id}/status`).send({ manualDiscount: 30 })).status).toBe(200);
        expect((await qr(order._id)).body.amount).toBe(total + 25 - 30);
        await Order.updateOne({ _id: order._id }, { $set: { amountPaid: 50 } });
        expect((await qr(order._id)).body.amount).toBe(total + 25 - 30 - 50);
        await Order.updateOne({ _id: order._id }, { $set: { amountPaid: total + 25 } });
        const none = await qr(order._id);
        expect(none.status).toBe(409);
        expect(none.body.code).toBe('NOTHING_DUE');
    });

    test('bill status is reported (final)', async () => {
        const order = await takeaway();
        await captain().post(`/orders/${order._id}/bill/save`).send({ final: true });
        expect((await qr(order._id)).body.billStatus).toBe('final');
    });

    test('paid and cancelled orders are 409', async () => {
        const paid = await takeaway();
        expect((await captain().patch(`/orders/${paid._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' })).status).toBe(200);
        const p = await qr(paid._id);
        expect(p.status).toBe(409);
        expect(p.body.code).toBe('ORDER_ALREADY_PAID');
        const cancelled = await takeaway();
        expect((await admin().patch(`/orders/${cancelled._id}/status`).send({ status: 'cancelled' })).status).toBe(200);
        const c = await qr(cancelled._id);
        expect(c.status).toBe(409);
        expect(c.body.code).toBe('ORDER_CANCELLED');
    });

    test('waiter -> 403 BILLING_CAPTAIN_ONLY; chef 403; guest rejected; unknown id 404', async () => {
        const order = await takeaway();
        const w = await qr(order._id, as('waiter'));
        expect(w.status).toBe(403);
        expect(w.body).toMatchObject({ success: false, code: 'BILLING_CAPTAIN_ONLY', message: 'Billing and payment are handled by the captain' });
        expect((await qr(order._id, as('chef'))).status).toBe(403);
        expect([401, 403]).toContain((await qr(order._id, ctx.api.guest(A))).status);
        expect((await qr('zzz')).status).toBe(404);
        expect((await qr('0123456789abcdef01234567')).status).toBe(404);
    });

    test("tenant isolation: tenant B cannot read tenant A's order or payee", async () => {
        const order = await takeaway();
        const r = await qr(order._id, as('admin', B));
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toContain('okaxis');
    });
});

describe('printed / previewed bill', () => {
    test('unpaid + configured: Scan to pay block after the totals; preview equals the print document', async () => {
        const order = await takeaway();
        const prev = await preview(order._id);
        expect(prev.status).toBe(200);
        const amt = money(order.total);
        expect(prev.body.text).toContain('Scan to pay');
        expect(prev.body.text).toContain(`[UPI QR: Rs ${amt}]`);
        expect(prev.body.text).toContain(`Pay Rs ${amt}`);
        expect(prev.body.text).toContain(NAME);
        expect(prev.body.text).not.toContain(VPA); // never the raw UPI id as text
        expect(prev.body.text.indexOf('TOTAL')).toBeLessThan(prev.body.text.indexOf('Scan to pay'));

        const qrLines = qrLinesOf(prev.body.lines);
        expect(qrLines).toHaveLength(1);
        expect(qrLines[0]).toMatchObject({ size: 6, a: 'c' });
        expect(qrLines[0].t).toContain(`[UPI QR: Rs ${amt}]`);
        expect(qrLines[0].qr).toBe((await qr(order._id)).body.upiUri); // slip QR == app QR

        const print = await captain().post(`/print/orders/${order._id}/bill`).send({});
        expect(print.status).toBe(202);
        const job = await PrintJob.findById(print.body.jobId).lean();
        expect(prev.body.text).toBe(toPlainText(job.document));
        expect(prev.body.lines).toEqual(JSON.parse(JSON.stringify(job.document.lines)));
    });

    test('QR amount tracks discount and partial payment shown on the slip', async () => {
        const order = await takeaway();
        await captain().patch(`/orders/${order._id}/status`).send({ manualDiscount: 20 });
        await Order.updateOne({ _id: order._id }, { $set: { amountPaid: 40 } });
        const prev = await preview(order._id);
        expect(prev.body.text).toContain(`[UPI QR: Rs ${money(order.total - 20 - 40)}]`);
        expect(prev.body.text).toContain('Balance due');
    });

    test('paid orders and restaurants without a UPI id print exactly as before', async () => {
        const noUpi = await takeaway(B);
        const p1 = await preview(noUpi._id, as('captain', B));
        expect(p1.body.text).not.toContain('Scan to pay');
        expect(qrLinesOf(p1.body.lines)).toHaveLength(0);

        const paid = await takeaway();
        await captain().patch(`/orders/${paid._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash' });
        const p2 = await preview(paid._id);
        expect(p2.body.text).not.toContain('Scan to pay');
        expect(qrLinesOf(p2.body.lines)).toHaveLength(0);
    });

    test('58 mm slip; payee name falls back to the cafe name; clearing the UPI id removes the block', async () => {
        const other = await seedTenant({ label: 'upi-c' });
        const c = (r) => ctx.api.as(other.users[r], other);
        await c('admin').patch('/settings/printers').send({ enabled: true, list: [{ name: 'Counter', station: 'counter', interface: 'lan', host: '10.1.1.1', paperWidth: '58' }] });
        await c('admin').patch('/settings/payments').send({ upiId: 'shop@upi' });
        const o = (await c('admin').post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', items: [{ menuItem: String(other.items.paneer._id), quantity: 1 }], total: 5000, clientIdempotencyKey: `idem_${rid()}${rid()}`,
        })).body.order;
        const withQr = await c('captain').get(`/orders/${o._id}/bill/preview`);
        expect(withQr.body.width).toBe(32);
        expect(withQr.body.text).toContain('Scan to pay');
        expect((await c('captain').get(`/orders/${o._id}/upi-qr`)).body.payee.name).toBeTruthy();
        expect((await c('admin').patch('/settings/payments').send({ upiId: '' })).status).toBe(200);
        const without = await c('captain').get(`/orders/${o._id}/bill/preview`);
        expect(without.body.text).not.toContain('Scan to pay');
        expect((await c('captain').get(`/orders/${o._id}/upi-qr`)).body.code).toBe('UPI_NOT_CONFIGURED');
    });
});

describe('captain confirms "UPI payment received"', () => {
    test('manualConfirm settles like cash: Paid, payment block, table freed, no pending state before', async () => {
        const { order, table } = await dineIn();
        await Order.updateOne({ _id: order._id }, { $set: { status: 'ready' } });
        expect((await reload(order._id)).payment?.state || 'none').toBe('none');
        await qr(order._id); // showing the QR changes nothing
        expect((await reload(order._id)).payment?.state || 'none').toBe('none');

        const res = await captain().patch(`/orders/${order._id}/status`).send(settleBody({ upiRef: '  4821 ' }));
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.paymentStatus).toBe('Paid');
        expect(saved.paymentMethod).toBe('UPI');
        expect(saved.paidAt).toBeTruthy();
        expect(saved.amountPaid).toBe(order.total);
        expect(saved.total).toBe(order.total);
        expect(saved.payment).toMatchObject({ state: 'paid', method: 'upi-qr-manual', amount: order.total, reference: '4821' });
        expect(String(saved.payment.updatedBy)).toBe(String(A.users.captain._id));
        expect((await Table.findById(table._id).lean()).status).toBe('free');
        expect(res.body.order.payment).toMatchObject({ state: 'paid', method: 'upi-qr-manual', reference: '4821' });
        expect((await qr(order._id)).body.code).toBe('ORDER_ALREADY_PAID');
    });

    test('admin and manager may confirm; explicit amountPaid >= due is accepted, partial is AMOUNT_TOO_LOW', async () => {
        const low = await takeaway();
        const r = await captain().patch(`/orders/${low._id}/status`).send(settleBody({ amountPaid: 10 }));
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('AMOUNT_TOO_LOW');
        expect((await reload(low._id)).paymentStatus).not.toBe('Paid');

        const a = await takeaway();
        expect((await admin().patch(`/orders/${a._id}/status`).send(settleBody({ amountPaid: a.total }))).status).toBe(200);
        const m = await takeaway();
        expect((await ctx.api.as(manager, A).patch(`/orders/${m._id}/status`).send(settleBody())).status).toBe(200);
        expect((await reload(m._id)).payment).toMatchObject({ state: 'paid', method: 'upi-qr-manual', reference: '' });
    });

    test('a discount applied in the same request lowers the amount recorded', async () => {
        const o = await takeaway();
        const r = await captain().patch(`/orders/${o._id}/status`).send(settleBody({ manualDiscount: 25 }));
        expect(r.status).toBe(200);
        const saved = await reload(o._id);
        expect(saved.amountPaid).toBe(o.total - 25);
        expect(saved.payment.amount).toBe(o.total - 25);
    });

    test('guards: waiter and chef 403, bad upiRef / manualConfirm 400, plain UPI settle keeps method "UPI"', async () => {
        const o = await takeaway();
        const w = await as('waiter').patch(`/orders/${o._id}/status`).send(settleBody());
        expect(w.status).toBe(403);
        expect(w.body.code).toBe('BILLING_CAPTAIN_ONLY');
        const ch = await as('chef').patch(`/orders/${o._id}/status`).send(settleBody());
        expect(ch.status).toBe(403);
        expect(ch.body.code).toBe('BILLING_CAPTAIN_ONLY');

        const long = await captain().patch(`/orders/${o._id}/status`).send(settleBody({ upiRef: 'x'.repeat(41) }));
        expect(long.status).toBe(400);
        expect(long.body.code).toBe('INVALID_UPI_REF');
        expect((await captain().patch(`/orders/${o._id}/status`).send(settleBody({ upiRef: 123 }))).body.code).toBe('INVALID_UPI_REF');
        expect((await captain().patch(`/orders/${o._id}/status`).send(settleBody({ manualConfirm: 'true' }))).body.code).toBe('INVALID_MANUAL_CONFIRM');
        const wrongMethod = await captain().patch(`/orders/${o._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash', manualConfirm: true });
        expect(wrongMethod.body.code).toBe('MANUAL_CONFIRM_NEEDS_UPI');
        expect((await reload(o._id)).paymentStatus).not.toBe('Paid');

        const plain = await captain().patch(`/orders/${o._id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'UPI', upiRef: 'UTR-77' });
        expect(plain.status).toBe(200);
        expect((await reload(o._id)).payment).toMatchObject({ state: 'paid', method: 'UPI', reference: 'UTR-77' });
    });

    test('another tenant cannot settle it', async () => {
        const o = await takeaway();
        const r = await as('admin', B).patch(`/orders/${o._id}/status`).send(settleBody());
        expect([403, 404]).toContain(r.status);
        expect((await reload(o._id)).paymentStatus).not.toBe('Paid');
    });
});

describe('customer / guest surfaces never expose the payee', () => {
    test('guest at a table: order create/read and public settings carry no upiId / upiUri', async () => {
        const table = await createTable(A, { capacity: 4 });
        const { scanToken } = await scanTable(ctx.api, table);
        const guest = ctx.api.guest(A, scanToken);
        const placed = await guest.post('/orders').send({
            type: 'dine-in', tableId: String(table._id), items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }], total: 5000,
        });
        expect(placed.status).toBe(201);
        const read = await guest.get(`/orders/${placed.body.order._id}`);
        const blob = JSON.stringify([placed.body, read.body, (await guest.get('/settings')).body]);
        expect(blob).not.toMatch(/okaxis|upi:\/\/|upiUri|upiId/);
        expect([401, 403]).toContain((await guest.get(`/orders/${placed.body.order._id}/upi-qr`)).status);
    });
});
