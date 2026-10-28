/**
 * KOT rounds (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 2, D6): per-order round
 * (item.kotNo / order.kots[]) plus a daily per-branch ticket number.
 *
 *   - create stamps round 1 and returns { kotNo, ticketNo }
 *   - sequential appends -> rounds 2, 3; concurrent appends never share a round
 *   - a retry with the same Idempotency-Key replays the same round
 *   - repeat (single and all) onto an open order stamps the next round
 *   - GET /orders/:id/kots groups legacy lines as round 1; foreign tenant -> 404
 *   - ticketNo increments per branch per day
 *   - renderKot prints "KOT #<ticket> (Round <n>)"; reprint keeps the numbers
 */
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const PrintJob = require(path.join(BACKEND, 'models/printJob'));
const { renderKot, toPlainText } = require(path.join(BACKEND, 'utils/receiptRenderer'));
const { nextTicketNo } = require(path.join(BACKEND, 'utils/kotRounds'));

const ctx = useIntegrationApp();
const rid = () => crypto.randomBytes(6).toString('hex');
let A;
let B;

beforeAll(async () => {
    A = await seedTenant({ label: 'kot-a' });
    B = await seedTenant({ label: 'kot-b' });
});

const admin = () => ctx.api.as(A.users.admin, A);
const create = (client = admin()) => client.post('/orders').send({
    type: 'takeaway', pickupLocation: 'Counter',
    items: [{ menuItem: String(A.items.paneer._id), quantity: 1 }],
    total: 5000, clientIdempotencyKey: `idem_${rid()}${rid()}`,
});
const appendBody = (item = A.items.naan, quantity = 1) => ({ items: [{ menuItem: String(item._id), quantity }] });
const append = (id, body = appendBody(), headers = {}) => {
    let r = ctx.api.as(A.users.waiter, A).post(`/orders/${id}/append`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
};

describe('rounds on create / append', () => {
    test('create stamps round 1 and returns kotNo + ticketNo', async () => {
        const res = await create();
        expect(res.status).toBe(201);
        expect(res.body.kotNo).toBe(1);
        expect(res.body.ticketNo).toBeGreaterThanOrEqual(1);
        const o = await Order.findById(res.body.order._id).lean();
        expect(o.items.every((i) => i.kotNo === 1)).toBe(true);
        expect(o.kots).toHaveLength(1);
        expect(o.kots[0]).toMatchObject({ kotNo: 1, ticketNo: res.body.ticketNo, itemCount: 1 });
        expect(o.kotRoundSeq).toBe(1);
    });

    test('two sequential appends are rounds 2 and 3 with their own ticket numbers', async () => {
        const created = await create();
        const id = created.body.order._id;
        const a2 = await append(id);
        const a3 = await append(id, appendBody(A.items.thali));
        expect(a2.status).toBe(200);
        expect(a2.body).toMatchObject({ kotNo: 2, addedCount: 1 });
        expect(a3.body.kotNo).toBe(3);
        expect(a2.body.ticketNo).toBe(created.body.ticketNo + 1);
        expect(a3.body.ticketNo).toBe(a2.body.ticketNo + 1);
        const o = await Order.findById(id).lean();
        expect(o.kots.map((k) => k.kotNo)).toEqual([1, 2, 3]);
        expect(o.kotRoundSeq).toBe(3);
        const naan = o.items.find((i) => i.name === 'Garlic Naan');
        expect(naan.kotNo).toBe(2);
    });

    test('two concurrent appends get distinct rounds', async () => {
        const created = await create();
        const id = created.body.order._id;
        const [r1, r2] = await Promise.all([
            append(id, appendBody(A.items.naan)),
            append(id, appendBody(A.items.thali)),
        ]);
        // A losing writer may hit a Mongoose VersionError (existing behaviour);
        // whoever succeeded must never share a round.
        const rounds = [r1, r2].filter((r) => r.status === 200).map((r) => r.body.kotNo);
        expect(rounds.length).toBeGreaterThanOrEqual(1);
        expect(new Set(rounds).size).toBe(rounds.length);
        for (const n of rounds) expect(n).toBeGreaterThanOrEqual(2);
        const o = await Order.findById(id).lean();
        expect(o.kotRoundSeq).toBe(3); // both claimed a round, even if one save lost
    });

    test('append that merges into an existing line is still its own round in /kots', async () => {
        const created = await create();
        const id = created.body.order._id;
        const res = await append(id, appendBody(A.items.paneer, 2)); // same line as the original paneer
        expect(res.body.kotNo).toBe(2);
        const kots = await admin().get(`/orders/${id}/kots`);
        expect(kots.status).toBe(200);
        expect(kots.body.kots.map((k) => k.kotNo)).toEqual([1, 2]);
        expect(kots.body.kots[1].items).toEqual([expect.objectContaining({ name: 'Paneer Tikka', quantity: 2 })]);
        expect(kots.body.kots[0].items).toEqual([expect.objectContaining({ name: 'Paneer Tikka', quantity: 1 })]);
    });

    test('retry with the same Idempotency-Key replays the same round, no new round', async () => {
        const created = await create();
        const id = created.body.order._id;
        const key = `kot-${rid()}${rid()}`;
        const first = await append(id, appendBody(), { 'Idempotency-Key': key });
        await new Promise((r) => setTimeout(r, 200)); // idempotency record is written async
        const retry = await append(id, appendBody(), { 'Idempotency-Key': key });
        expect(first.body.kotNo).toBe(2);
        expect(retry.headers['idempotent-replayed']).toBe('true');
        expect(retry.body.kotNo).toBe(2);
        expect(retry.body.ticketNo).toBe(first.body.ticketNo);
        const o = await Order.findById(id).lean();
        expect(o.kots).toHaveLength(2);
        expect(o.kotRoundSeq).toBe(2);
    });
});

describe('repeat stamps a round', () => {
    test('repeat one item onto an open order -> next round', async () => {
        const cust = await createCustomer('kotrep');
        const client = ctx.api.as(cust, A);
        const created = await create(client);
        expect(created.status).toBe(201);
        const id = created.body.order._id;
        const itemId = created.body.order.items[0]._id;
        const res = await client.post(`/orders/${id}/repeat/${itemId}`).send({ quantity: 1 });
        expect(res.status).toBe(200);
        expect(res.body.kotNo).toBe(2);
        expect(res.body.ticketNo).toBeGreaterThan(created.body.ticketNo);
        const o = await Order.findById(id).lean();
        expect(o.kots.map((k) => k.kotNo)).toEqual([1, 2]);
    });

    test('repeat-all onto an open order -> next round', async () => {
        const cust = await createCustomer('kotrepall');
        const client = ctx.api.as(cust, A);
        const created = await create(client);
        const id = created.body.order._id;
        const res = await client.post(`/orders/${id}/repeat-all`).send({});
        expect(res.status).toBe(200);
        expect(res.body.kotNo).toBe(2);
        expect(typeof res.body.ticketNo).toBe('number');
    });
});

describe('GET /orders/:id/kots', () => {
    test('legacy order without kotNo groups as round 1', async () => {
        const created = await create();
        const id = created.body.order._id;
        await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, {
            $unset: { kots: '', kotRoundSeq: '', 'items.$[].kotNo': '' },
        });
        const res = await admin().get(`/orders/${id}/kots`);
        expect(res.status).toBe(200);
        expect(res.body.kots).toHaveLength(1);
        expect(res.body.kots[0]).toMatchObject({ kotNo: 1, ticketNo: null, status: 'new' });
        expect(res.body.kots[0].items[0]).toMatchObject({ name: 'Paneer Tikka', quantity: 1 });
        // a later append on a legacy order becomes round 2
        const a = await append(id);
        expect(a.body.kotNo).toBe(2);
        const again = await admin().get(`/orders/${id}/kots`);
        expect(again.body.kots.map((k) => k.kotNo)).toEqual([1, 2]);
    });

    test('shape: kotNo, ticketNo, sentAt, sentBy, items[{_id,name,quantity}], status', async () => {
        const created = await create();
        const res = await admin().get(`/orders/${created.body.order._id}/kots`);
        expect(res.body.kots[0]).toEqual({
            kotNo: 1, ticketNo: created.body.ticketNo, sentAt: expect.any(String),
            sentBy: String(A.users.admin._id), status: 'new',
            items: [{ _id: expect.any(String), name: 'Paneer Tikka', quantity: 1 }],
        });
    });

    test('another tenant gets 404; unauthenticated is refused', async () => {
        const created = await create();
        const id = created.body.order._id;
        const cross = await ctx.api.as(B.users.admin, B).get(`/orders/${id}/kots`);
        expect(cross.status).toBe(404);
        const anon = await ctx.api.guest(A).get(`/orders/${id}/kots`);
        expect([401, 403]).toContain(anon.status);
    });
});

describe('ticket numbers', () => {
    test('increment per branch within a day and restart on a new day', async () => {
        const day1 = '2031-01-01'; // a day no other test touches
        const t1 = await nextTicketNo(A.restaurant._id, A.branch._id, day1);
        const t2 = await nextTicketNo(A.restaurant._id, A.branch._id, day1);
        const other = await nextTicketNo(B.restaurant._id, B.branch._id, day1);
        const next = await nextTicketNo(A.restaurant._id, A.branch._id, '2031-01-02');
        expect([t1, t2]).toEqual([1, 2]);
        expect(other).toBe(1);
        expect(next).toBe(1);
    });

    test('two creates in a row are consecutive', async () => {
        const a = await create();
        const b = await create();
        expect(b.body.ticketNo).toBe(a.body.ticketNo + 1);
    });
});

describe('print', () => {
    test('renderKot header carries ticket and round; legacy slips have none', () => {
        const base = {
            cafeName: 'Cafe', order: { orderId: 'ORD-1', type: 'takeaway' },
            items: [{ name: 'Tea', quantity: 1 }], station: 'kitchen', reason: 'append',
        };
        expect(toPlainText(renderKot({ ...base, kot: { ticketNo: 12, kotNo: 2 } }))).toContain('KOT #12 (Round 2)');
        expect(toPlainText(renderKot({ ...base, kot: { rounds: 3 } }))).toContain('KOT Rounds 1-3 (all)');
        expect(toPlainText(renderKot(base))).not.toContain('KOT #');
    });

    test('create / append / reprint slips carry the numbers', async () => {
        const cfg = await ctx.api.as(A.users.admin, A).patch('/settings/printers').send({
            enabled: true,
            autoPrint: { kotOnCreate: true, kotOnAppend: true, billOnPaid: false },
            list: [{ name: 'Kitchen', station: 'kitchen', interface: 'lan', host: '127.0.0.1', port: 9100, paperWidth: '80' }],
        });
        expect(cfg.status).toBe(200);
        const created = await create();
        const id = created.body.order._id;
        const a2 = await append(id);
        await new Promise((r) => setTimeout(r, 400));
        const reprint = await ctx.api.as(A.users.admin, A).post(`/orders/${id}/reprint-kot`).send({ kotNo: 2 });
        expect(reprint.status).toBe(200);
        await new Promise((r) => setTimeout(r, 400));
        const jobs = await PrintJob.find({ order: id, kind: 'kot' }).sort({ createdAt: 1 }).lean();
        const texts = jobs.map((j) => toPlainText(j.document));
        expect(texts[0]).toContain(`KOT #${created.body.ticketNo} (Round 1)`);
        expect(texts[1]).toContain(`KOT #${a2.body.ticketNo} (Round 2)`);
        expect(texts[1]).toContain('ADDED ITEMS');
        expect(texts[2]).toContain(`KOT #${a2.body.ticketNo} (Round 2)`);
        expect(texts[2]).toContain('REPRINT');
        expect(texts[2]).toContain('Garlic Naan');
        expect(texts[2]).not.toContain('Paneer');
    });
});
