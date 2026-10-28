/**
 * Bill workspace (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 3, D4):
 *   POST /orders/:id/bill/save | /bill/reopen, GET /orders/:id/bill/preview,
 *   GET /print/status, GET /print/jobs/:id, POST /print/orders/:id/bill { printerId }.
 */
const crypto = require('crypto');
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const PrintJob = require(path.join(BACKEND, 'models/printJob'));
const { toPlainText } = require(path.join(BACKEND, 'utils/receiptRenderer'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(6).toString('hex');
let A;
let B;
let branch2;
let otherBranchPrinterId;
const sockets = [];

const PRINTERS = () => ({
    enabled: true,
    autoPrint: { kotOnCreate: false, kotOnAppend: false, billOnPaid: false },
    list: [
        { name: 'Kitchen', station: 'kitchen', interface: 'lan', host: '10.9.9.1', port: 9100, paperWidth: '80' },
        { name: 'Counter', station: 'counter', interface: 'lan', host: '10.9.9.2', port: 9102, paperWidth: '80' },
        { name: 'Bar', station: 'bar', interface: 'lan', host: '10.9.9.3', port: 9101, paperWidth: '58' },
    ],
});

beforeAll(async () => {
    A = await seedTenant({ label: 'bw-a' });
    B = await seedTenant({ label: 'bw-b' });
    const res = await ctx.api.as(A.users.admin, A).patch('/settings/printers').send(PRINTERS());
    expect(res.status).toBe(200);
    // A second branch with its own printer list (a printer id that must NOT work at the main branch).
    branch2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: `second-${rid()}`, isActive: true });
    otherBranchPrinterId = `other-${rid()}`;
    await Settings.create({
        restaurant: A.restaurant._id, branch: branch2._id,
        printers: { enabled: true, list: [{ id: otherBranchPrinterId, name: 'Branch2 Counter', station: 'counter', host: '10.8.8.8', port: 9100, paperWidth: '80' }] },
    });
});

afterAll(() => { for (const s of sockets) { try { s.close(); } catch { /* ignore */ } } });

const waiter = () => ctx.api.as(A.users.waiter, A);
const captain = () => ctx.api.as(A.users.captain, A);
const admin = () => ctx.api.as(A.users.admin, A);

const createOrder = async (t = A, client = ctx.api.as(t.users.admin, t)) => {
    const res = await client.post('/orders').send({
        type: 'takeaway', pickupLocation: 'Counter',
        items: [{ menuItem: String(t.items.paneer._id), quantity: 1 }],
        total: 5000, clientIdempotencyKey: `idem_${rid()}${rid()}`,
    });
    expect(res.status).toBe(201);
    return res.body.order;
};
const save = (id, body = {}, client = captain()) => client.post(`/orders/${id}/bill/save`).send(body);
const reopen = (id, body, client = captain()) => client.post(`/orders/${id}/bill/reopen`).send(body);
const append = (id, client = waiter()) => client.post(`/orders/${id}/append`)
    .send({ items: [{ menuItem: String(A.items.naan._id), quantity: 1 }] });
const printerList = async () => (await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean()).printers.list;
const payable = (o) => Math.max(0, Math.round(((o.total || 0) - (o.manualDiscount || 0)) * 100) / 100);

function connectAgent(token) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, { auth: { agentToken: token }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });
}

describe('POST /orders/:id/bill/save', () => {
    test('saves a draft: billNo, payable snapshot, payment untouched; re-save keeps the number', async () => {
        const order = await createOrder();
        const res = await save(order._id);
        expect(res.status).toBe(200);
        expect(res.body.bill).toMatchObject({ status: 'draft', billNo: expect.any(Number), total: payable(order), reopenedAt: null });
        expect(res.body.bill.savedAt).toBeTruthy();
        expect(res.body.bill.savedBy).toBe(String(A.users.captain._id));
        expect(res.body.paymentStatus).toBe('Pending');
        const db = await Order.findById(order._id).lean();
        expect(db.paymentStatus).toBe('Pending');
        expect(db.amountPaid).toBe(0);
        expect(db.bill.history).toHaveLength(1);
        const again = await save(order._id, { final: false });
        expect(again.body.bill.billNo).toBe(res.body.bill.billNo);
    });

    test('a manual discount is part of the saved payable total', async () => {
        const order = await createOrder();
        await Order.updateOne({ _id: order._id }, { $set: { manualDiscount: 10 } });
        const res = await save(order._id);
        expect(res.body.bill.total).toBe(payable({ total: order.total, manualDiscount: 10 }));
    });

    test('final locks items: append / repeat / repeat-all / coupon / discount -> 409 BILL_FINALIZED; cancel still works', async () => {
        const order = await createOrder();
        const fin = await save(order._id, { final: true }, captain());
        expect(fin.status).toBe(200);
        expect(fin.body.bill.status).toBe('final');

        const ap = await append(order._id);
        expect(ap.status).toBe(409);
        expect(ap.body.code).toBe('BILL_FINALIZED');
        expect(ap.body.message).toMatch(/reopen/i);

        const lineId = order.items[0]._id;
        const rep = await waiter().post(`/orders/${order._id}/repeat/${lineId}`).send({ quantity: 1 });
        expect(rep.status).toBe(409);
        expect(rep.body.code).toBe('BILL_FINALIZED');
        const repAll = await waiter().post(`/orders/${order._id}/repeat-all`).send({});
        expect(repAll.status).toBe(409);
        expect(repAll.body.code).toBe('BILL_FINALIZED');

        const coupon = await captain().patch(`/orders/${order._id}/coupon`).send({ code: '' });
        expect(coupon.status).toBe(409);
        expect(coupon.body.code).toBe('BILL_FINALIZED');

        const disc = await admin().patch(`/orders/${order._id}/status`).send({ manualDiscount: 25 });
        expect(disc.status).toBe(409);
        expect(disc.body.code).toBe('BILL_FINALIZED');

        const db = await Order.findById(order._id).lean();
        expect(db.items).toHaveLength(1);
        expect(db.manualDiscount || 0).toBe(0);
        expect(db.total).toBe(order.total);

        // draft re-save of a final bill is refused too; final re-save is an idempotent no-op
        expect((await save(order._id, {})).body.code).toBe('BILL_FINALIZED');
        const idem = await save(order._id, { final: true });
        expect(idem.status).toBe(200);
        expect(idem.body.bill.billNo).toBe(fin.body.bill.billNo);

        // whole-order cancel remains allowed on a final bill
        const cancel = await admin().patch(`/orders/${order._id}/status`).send({ status: 'cancelled', cancellationReason: 'guest left' });
        expect(cancel.status).toBe(200);
    });

    test('refuses cancelled and paid orders; reopening them is refused too', async () => {
        const paid = await createOrder();
        await Order.updateOne({ _id: paid._id }, { $set: { paymentStatus: 'Paid', amountPaid: paid.total } });
        const r1 = await save(paid._id);
        expect(r1.status).toBe(409);
        expect(r1.body.code).toBe('ORDER_ALREADY_PAID');

        const cancelled = await createOrder();
        await Order.updateOne({ _id: cancelled._id }, { $set: { status: 'cancelled' } });
        const r2 = await save(cancelled._id, { final: true });
        expect(r2.status).toBe(409);
        expect(r2.body.code).toBe('ORDER_CANCELLED');

        const r3 = await reopen(paid._id, { reason: 'because' });
        expect(r3.status).toBe(409);
        expect(r3.body.code).toBe('ORDER_ALREADY_PAID');
    });

    test('guards: chef 403, foreign tenant 404, bad id 404, anonymous 401', async () => {
        const order = await createOrder();
        expect((await save(order._id, {}, ctx.api.as(A.users.chef, A))).status).toBe(403);
        expect((await save(order._id, {}, ctx.api.as(B.users.admin, B))).status).toBe(404);
        expect((await save('not-an-id')).status).toBe(404);
        expect((await ctx.api.anon().post(`/orders/${order._id}/bill/save`).send({})).status).toBeGreaterThanOrEqual(400);
        expect((await Order.findById(order._id).lean()).bill).toBeUndefined();
    });

    test('billNo is sequential per branch and unique under concurrency', async () => {
        const orders = await Promise.all([createOrder(), createOrder(), createOrder()]);
        const results = await Promise.all(orders.map((o) => save(o._id)));
        const nos = results.map((r) => r.body.bill.billNo).sort((a, b) => a - b);
        expect(new Set(nos).size).toBe(3);
        expect(nos[2] - nos[0]).toBeLessThanOrEqual(2 + 3); // a lost race may skip a number, never repeat one

        const o = await createOrder();
        const first = (await save(o._id)).body.bill.billNo;
        const o2 = await createOrder();
        const second = (await save(o2._id)).body.bill.billNo;
        expect(second).toBeGreaterThan(first);

        // another branch has its own series, starting at 1
        const b2a = await createOrder();
        const b2b = await createOrder();
        await Order.updateMany({ _id: { $in: [b2a._id, b2b._id] } }, { $set: { branch: branch2._id } });
        expect((await save(b2a._id, {}, admin())).body.bill.billNo).toBe(1);
        expect((await save(b2b._id, {}, admin())).body.bill.billNo).toBe(2);
        // and another tenant starts its own
        const bOrder = await createOrder(B);
        expect((await save(bOrder._id, {}, ctx.api.as(B.users.admin, B))).body.bill.billNo).toBe(1);
    });
});

describe('POST /orders/:id/bill/reopen', () => {
    test('waiter 403; reason needed; captain reopens, audit trail kept, then append works', async () => {
        const order = await createOrder();
        const fin = await save(order._id, { final: true });
        expect((await append(order._id)).status).toBe(409);

        expect((await reopen(order._id, { reason: 'guest added a drink' }, waiter())).status).toBe(403);
        expect((await Order.findById(order._id).lean()).bill.status).toBe('final');

        for (const body of [{}, { reason: '' }, { reason: 'ab' }, { reason: '   x ' }, { reason: 42 }]) {
            const r = await reopen(order._id, body);
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('REASON_REQUIRED');
        }

        const ok = await reopen(order._id, { reason: 'guest added a drink' });
        expect(ok.status).toBe(200);
        expect(ok.body.bill).toMatchObject({ status: 'draft', billNo: fin.body.bill.billNo, reopenReason: 'guest added a drink' });
        expect(ok.body.bill.reopenedBy).toBe(String(A.users.captain._id));
        expect(ok.body.bill.reopenedAt).toBeTruthy();
        expect(ok.body.paymentStatus).toBe('Pending');
        const db = await Order.findById(order._id).lean();
        expect(db.bill.history.map((h) => h.action)).toEqual(['finalize', 'reopen']);
        expect(db.bill.history[1]).toMatchObject({ reason: 'guest added a drink' });

        const ap = await append(order._id);
        expect(ap.status).toBe(200);
        // re-saving picks up the new total and keeps the bill number
        const re = await save(order._id, { final: true });
        expect(re.body.bill.billNo).toBe(fin.body.bill.billNo);
        expect(re.body.bill.total).toBeGreaterThan(fin.body.bill.total);
        expect(re.body.bill.total).toBe(payable(await Order.findById(order._id).lean()));
    });

    test('admin may reopen; a draft bill cannot be reopened (BILL_NOT_FINAL)', async () => {
        const order = await createOrder();
        await save(order._id, { final: true });
        expect((await reopen(order._id, { reason: 'wrong table' }, admin())).status).toBe(200);
        const again = await reopen(order._id, { reason: 'wrong table' });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('BILL_NOT_FINAL');
        const unsaved = await createOrder();
        expect((await reopen(unsaved._id, { reason: 'wrong table' })).body.code).toBe('BILL_NOT_FINAL');
    });

    test('foreign tenant 404', async () => {
        const order = await createOrder();
        await save(order._id, { final: true });
        expect((await reopen(order._id, { reason: 'sneaky' }, ctx.api.as(B.users.admin, B))).status).toBe(404);
    });
});

describe('GET /orders/:id/bill/preview and printing', () => {
    test('preview text and lines are exactly what the queued print job carries', async () => {
        const order = await createOrder();
        await append(order._id);
        const saved = await save(order._id, { final: true });
        const prev = await captain().get(`/orders/${order._id}/bill/preview`);
        expect(prev.status).toBe(200);
        expect(prev.body).toMatchObject({ success: true, orderId: order.orderId, bill: { status: 'final', billNo: saved.body.bill.billNo } });
        expect(prev.body.text).toContain(`Bill No: ${saved.body.bill.billNo}`);
        expect(prev.body.text).toContain('Paneer Tikka');
        expect(prev.body.text).toContain('Garlic Naan');
        expect(prev.body.totals.payable).toBe(saved.body.bill.total);
        expect(prev.body.printer.name).toBe('Counter');

        const print = await captain().post(`/print/orders/${order._id}/bill`).send({});
        expect(print.status).toBe(202);
        expect(print.body).toMatchObject({ success: true, jobId: expect.any(String), billNo: saved.body.bill.billNo, printer: { name: 'Counter' } });
        const job = await PrintJob.findById(print.body.jobId).lean();
        expect(job.kind).toBe('bill');
        expect(prev.body.text).toBe(toPlainText(job.document));
        expect(prev.body.lines).toEqual(JSON.parse(JSON.stringify(job.document.lines)));
        expect(prev.body.width).toBe(job.document.width);
        // the slip's TOTAL line equals the saved payable total
        expect(prev.body.text).toMatch(/TOTAL\s+[\d,]+\.\d\d/);
    });

    test('an unsaved order previews without a bill number; saving adds it to later prints', async () => {
        const order = await createOrder();
        const prev = await captain().get(`/orders/${order._id}/bill/preview`);
        expect(prev.body.bill).toEqual({ status: null, billNo: null, savedAt: null });
        expect(prev.body.text).not.toContain('Bill No:');
        const draft = await save(order._id);
        const print = await captain().post(`/print/orders/${order._id}/bill`).send({});
        const job = await PrintJob.findById(print.body.jobId).lean();
        expect(toPlainText(job.document)).toContain(`Bill No: ${draft.body.bill.billNo}`);
    });

    test('guards: chef 403, foreign tenant 404', async () => {
        const order = await createOrder();
        expect((await ctx.api.as(A.users.chef, A).get(`/orders/${order._id}/bill/preview`)).status).toBe(403);
        expect((await ctx.api.as(B.users.admin, B).get(`/orders/${order._id}/bill/preview`)).status).toBe(404);
        expect((await captain().get('/orders/zzz/bill/preview')).status).toBe(404);
    });

    test('printerId: another branch / unknown id -> 404 PRINTER_NOT_FOUND; a branch printer is used', async () => {
        const order = await createOrder();
        for (const printerId of [otherBranchPrinterId, 'nope']) {
            const r = await captain().post(`/print/orders/${order._id}/bill`).send({ printerId });
            expect(r.status).toBe(404);
            expect(r.body.code).toBe('PRINTER_NOT_FOUND');
        }
        const bar = (await printerList()).find((p) => p.name === 'Bar');
        const ok = await captain().post(`/print/orders/${order._id}/bill`).send({ printerId: bar.id });
        expect(ok.status).toBe(202);
        expect(ok.body.printer.name).toBe('Bar');
        const job = await PrintJob.findById(ok.body.jobId).lean();
        expect(job.printer.name).toBe('Bar');
        expect(job.document.width).toBe(32); // 58 mm
        // without printerId it is still the counter printer
        const dflt = await captain().post(`/print/orders/${order._id}/bill`).send({});
        expect(dflt.body.printer.name).toBe('Counter');
        expect(dflt.body).toHaveProperty('agentOnline');
    });
});

describe('GET /print/status', () => {
    test('staff see agentOnline, printers and the counter printer (no hosts); chef / anon refused', async () => {
        const off = await captain().get('/print/status');
        expect(off.status).toBe(200);
        expect(off.body.success).toBe(true);
        expect(off.body.agentOnline).toBe(false);
        expect(off.body.printingEnabled).toBe(true);
        expect(off.body.counterPrinter).toEqual({ _id: expect.any(String), name: 'Counter' });
        expect(off.body.printers.map((p) => p.name)).toEqual(['Kitchen', 'Counter', 'Bar']);
        expect(off.body.printers.filter((p) => p.isDefault).map((p) => p.name)).toEqual(['Counter']);
        expect(off.body.printers.every((p) => p.enabled === true && p._id && p.station)).toBe(true);
        expect(JSON.stringify(off.body)).not.toContain('10.9.9');
        expect(JSON.stringify(off.body)).not.toContain('host');

        const key = await admin().post('/print/agent-key');
        expect(key.status).toBe(200);
        await connectAgent(key.body.token);
        const on = await captain().get('/print/status');
        expect(on.body.agentOnline).toBe(true);
        expect((await admin().get('/print/status')).body.agentOnline).toBe(true);

        expect((await ctx.api.as(A.users.chef, A).get('/print/status')).status).toBe(403);
        expect((await ctx.api.anon().get('/print/status')).status).toBeGreaterThanOrEqual(400);
        // the admin-only routes stay admin-only
        expect((await waiter().get('/print/agent-status')).status).toBe(403);
        expect((await waiter().get('/print/jobs')).status).toBe(403);
    });

    test('tenant isolation: another tenant has its own (empty) printers and offline agent', async () => {
        const b = await ctx.api.as(B.users.captain, B).get('/print/status');
        expect(b.status).toBe(200);
        expect(b.body.agentOnline).toBe(false);
        expect(b.body.printers).toEqual([]);
        expect(b.body.counterPrinter).toBeNull();
        expect(b.body.printingEnabled).toBe(false);
    });

    test('admin ?branchId reads another branch of the tenant; a foreign branch id is a 404; staff cannot override', async () => {
        const r = await admin().get(`/print/status?branchId=${branch2._id}`);
        expect(r.status).toBe(200);
        expect(r.body.counterPrinter.name).toBe('Branch2 Counter');
        expect(r.body.branch).toBe(String(branch2._id));
        const foreign = await admin().get(`/print/status?branchId=${B.branch._id}`);
        expect(foreign.status).toBe(404);
        // a waiter pinned to the main branch ignores the query
        const w = await captain().get(`/print/status?branchId=${branch2._id}`);
        expect(w.body.counterPrinter.name).toBe('Counter');
    });
});

describe('GET /print/jobs/:id', () => {
    test('staff read back status / error without the document; other tenants get 404', async () => {
        const order = await createOrder();
        const print = await captain().post(`/print/orders/${order._id}/bill`).send({});
        expect(print.status).toBe(202);
        const id = print.body.jobId;

        const got = await captain().get(`/print/jobs/${id}`);
        expect(got.status).toBe(200);
        expect(got.body.job).toMatchObject({
            _id: id, kind: 'bill', printer: { name: 'Counter' }, orderId: order.orderId, order: String(order._id),
        });
        expect(['queued', 'sent']).toContain(got.body.job.status);
        expect(got.body.job.createdAt).toBeTruthy();
        expect(got.body.job.updatedAt).toBeTruthy();
        expect(got.body.job).not.toHaveProperty('document');
        expect(got.body.job).not.toHaveProperty('error');

        await PrintJob.updateOne({ _id: id }, { $set: { status: 'failed', error: 'Printer offline' } });
        const failed = await captain().get(`/print/jobs/${id}`);
        expect(failed.body.job).toMatchObject({ status: 'failed', error: 'Printer reported an error' });
        const adminView = await admin().get(`/print/jobs/${id}`);
        expect(adminView.body.job.error).toBe('Printer offline');
        await PrintJob.updateOne({ _id: id }, { $set: { status: 'done', error: '' } });
        expect((await captain().get(`/print/jobs/${id}`)).body.job.status).toBe('done');

        expect((await ctx.api.as(B.users.admin, B).get(`/print/jobs/${id}`)).status).toBe(404);
        expect((await ctx.api.as(B.users.captain, B).get(`/print/jobs/${id}`)).status).toBe(404);
        expect((await captain().get('/print/jobs/not-an-id')).status).toBe(404);
        expect((await captain().get(`/print/jobs/${new (require('mongoose').Types.ObjectId)()}`)).status).toBe(404);
        expect((await ctx.api.as(A.users.chef, A).get(`/print/jobs/${id}`)).status).toBe(403);
    });

    test('a branch-pinned user cannot read another branch\'s job', async () => {
        const order = await createOrder();
        const print = await captain().post(`/print/orders/${order._id}/bill`).send({});
        await PrintJob.updateOne({ _id: print.body.jobId }, { $set: { branch: branch2._id } });
        expect((await captain().get(`/print/jobs/${print.body.jobId}`)).status).toBe(404);
        expect((await admin().get(`/print/jobs/${print.body.jobId}`)).status).toBe(200);
    });

    test('non-admin staff get a generic error string, never agent text with hosts', async () => {
        const order = await createOrder();
        const print = await captain().post(`/print/orders/${order._id}/bill`).send({});
        await PrintJob.updateOne({ _id: print.body.jobId }, { $set: { status: 'failed', error: 'connect ECONNREFUSED 10.9.9.2:9100' } });
        const w = await captain().get(`/print/jobs/${print.body.jobId}`);
        expect(JSON.stringify(w.body)).not.toMatch(/10\.9\.9\.2|ECONNREFUSED/);
        expect(w.body.job.error).toBe('Printer reported an error');
        expect((await admin().get(`/print/jobs/${print.body.jobId}`)).body.job.error).toMatch(/ECONNREFUSED/);
    });
});

describe('POST /print/orders/:id/bill branch pin', () => {
    test("a branch-pinned waiter cannot print another branch's bill (404)", async () => {
        const order = await createOrder();
        await Order.updateOne({ _id: order._id }, { $set: { branch: branch2._id } });
        const r = await captain().post(`/print/orders/${order._id}/bill`).send({});
        expect(r.status).toBe(404);
        expect(await PrintJob.countDocuments({ order: order._id })).toBe(0);
    });
});

describe('append vs Save Bill race', () => {
    test('an append that loaded the order before the bill became final fails with BILL_FINALIZED', async () => {
        const order = await createOrder();
        const kotRounds = require(path.join(BACKEND, 'utils/kotRounds'));
        const orig = kotRounds.beginAppendRound;
        const spy = jest.spyOn(kotRounds, 'beginAppendRound').mockImplementation(async (...args) => {
            // Save Bill (final) lands directly in the DB after the append loaded the order
            await Order.updateOne({ _id: order._id }, { $set: { 'bill.status': 'final', 'bill.billNo': 99 } });
            return orig(...args);
        });
        try {
            const r = await append(order._id);
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('BILL_FINALIZED');
        } finally { spy.mockRestore(); }
        const after = await Order.findById(order._id).lean();
        expect(after.items).toHaveLength(1);
    });
});
