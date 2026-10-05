/**
 * Procurement + batch production (checklist 8.2), through the real HTTP
 * stack: supplier CRUD + validation + derived outstanding, the purchase
 * order lifecycle (ordered → partially-received → received, payments
 * unpaid → partial → paid, cancel), GRN stock increments with exact
 * quantities and audit history, purchase / payment reports, and
 * production batches that consume recipe ingredients (with unit
 * conversion) and bank the produced output.
 *
 * Cross-tenant isolation for suppliers / POs / production is covered by
 * tenantIsolationSweep*.test.js and is not repeated here.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const Inventory = req_('models/inventory');
const Recipe = req_('models/recipe');
const MenuItem = req_('models/menuItem');
const Supplier = req_('models/supplier');
const PurchaseOrder = req_('models/purchaseOrder');
const Production = req_('models/production');

const ctx = useIntegrationApp();
let A;

const uniq = () => Math.random().toString(16).slice(2, 8);
const admin = () => ctx.api.as(A.users.admin);
const reloadInv = (id) => Inventory.findById(id).lean();
const reloadPo = (id) => PurchaseOrder.findById(id).lean();

beforeAll(async () => {
    A = await seedTenant({ label: 'proc' });
});

function mkInv(fields = {}) {
    return Inventory.create({
        restaurant: A.restaurant._id, branch: null, itemId: `INV-P${uniq()}`,
        name: `Stock ${uniq()}`, category: 'Raw Ingredients', unit: 'kg',
        currentStock: 0, minStock: 0, costPerUnit: 100, ...fields,
    });
}

async function mkSupplier(extra = {}) {
    const res = await admin().post('/suppliers').send({ name: `Vendor ${uniq()}`, ...extra });
    expect(res.status).toBe(201);
    return res.body.supplier;
}

async function mkPo(supplier, lines, extra = {}) {
    const res = await admin().post('/purchase-orders').send({
        supplier: String(supplier._id),
        lines: lines.map(([inv, orderedQty, rate, taxPercent = 0]) => ({ inventoryItem: String(inv._id), orderedQty, rate, taxPercent })),
        ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.order;
}

const receive = (po, lines, note) => admin().post(`/purchase-orders/${po._id}/receive`)
    .send({ lines: lines.map(([inv, qty, more = {}]) => ({ inventoryItem: String(inv._id), qty, ...more })), note });
const pay = (po, body) => admin().post(`/purchase-orders/${po._id}/payment`).send(body);

// ═══════════════════════════════════════════════════════════════════════
describe('suppliers', () => {
    test('create: 201, SUP-### code, normalised fields, tenant stamped', async () => {
        const res = await admin().post('/suppliers').send({
            name: '  Fresh Farms  ', contactPerson: 'Ravi', mobile: '+91 98765-43210',
            email: 'Orders@FreshFarms.test', gstNumber: '27abcde1234f1z5', paymentTermsDays: '15',
            categories: ['Vegetables', '', null, 'Dairy'],
        });
        expect(res.status).toBe(201);
        const saved = await Supplier.findById(res.body.supplier._id).lean();
        expect(saved).toMatchObject({
            name: 'Fresh Farms', email: 'orders@freshfarms.test', gstNumber: '27ABCDE1234F1Z5',
            paymentTermsDays: 15, categories: ['Vegetables', 'Dairy'], isActive: true,
        });
        expect(saved.code).toMatch(/^SUP-\d{3,}$/);
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
    });

    test.each([
        ['no name', { name: '  ' }, 'Supplier name is required'],
        ['bad email', { email: 'not-an-email' }, 'Invalid email'],
        ['bad mobile', { mobile: '12ab' }, 'Invalid mobile number'],
        ['bad GSTIN', { gstNumber: '27ABCDE1234F1X5' }, 'Enter a valid 15-character GSTIN, e.g. 27ABCDE1234F1Z5'],
        ['negative terms', { paymentTermsDays: -1 }, 'Payment terms (days) must be 0 or greater'],
        ['non-numeric terms', { paymentTermsDays: 'soon' }, 'Payment terms (days) must be 0 or greater'],
    ])('create rejects %s → 400', async (_l, body, message) => {
        const res = await admin().post('/suppliers').send({ name: `V ${uniq()}`, ...body });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
    });

    test('duplicate name (case-insensitive) is refused on create and on rename', async () => {
        const a = await mkSupplier();
        const b = await mkSupplier();
        const dup = await admin().post('/suppliers').send({ name: a.name.toUpperCase() });
        expect(dup.status).toBe(400);
        expect(dup.body.message).toBe('A supplier with this name already exists');
        const ren = await admin().put(`/suppliers/${b._id}`).send({ name: a.name.toLowerCase() });
        expect(ren.status).toBe(400);
        expect((await Supplier.findById(b._id).lean()).name).toBe(b.name);
    });

    test('update: partial fields, validation, isActive toggle; unknown id → 404', async () => {
        const s = await mkSupplier();
        const bad = await admin().put(`/suppliers/${s._id}`).send({ email: 'x@' });
        expect(bad.status).toBe(400);
        const ok = await admin().put(`/suppliers/${s._id}`).send({ contactPerson: '  Meena ', paymentTermsDays: 30, isActive: false });
        expect(ok.status).toBe(200);
        expect(await Supplier.findById(s._id).lean()).toMatchObject({ name: s.name, contactPerson: 'Meena', paymentTermsDays: 30, isActive: false });
        expect((await admin().put(`/suppliers/${new mongoose.Types.ObjectId()}`).send({ notes: 'x' })).status).toBe(404);
    });

    test('non-admin staff are refused (adminOnly)', async () => {
        expect((await ctx.api.as(A.users.chef).get('/suppliers')).status).toBe(403);
        expect((await ctx.api.as(A.users.waiter).post('/suppliers').send({ name: 'x' })).status).toBe(403);
        expect((await ctx.api.as(A.users.chef).get('/purchase-orders')).status).toBe(403);
        expect((await ctx.api.as(A.users.chef).post('/production').send({})).status).toBe(403);
    });

    test('delete is blocked while an open PO references the supplier; allowed once it is cancelled', async () => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const po = await mkPo(s, [[inv, 1, 10]]);
        const blocked = await admin().delete(`/suppliers/${s._id}`);
        expect(blocked.status).toBe(400);
        expect(blocked.body.message).toBe('Cannot delete — 1 open purchase order(s) reference this supplier. Deactivate instead.');
        expect((await admin().patch(`/purchase-orders/${po._id}/cancel`)).status).toBe(200);
        expect((await admin().delete(`/suppliers/${s._id}`)).status).toBe(200);
        expect(await Supplier.findById(s._id)).toBeNull();
    });

    test('list / getOne derive outstanding = Σ (grandTotal − amountPaid) over non-cancelled POs', async () => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const p1 = await mkPo(s, [[inv, 10, 50]]);          // 500
        await mkPo(s, [[inv, 4, 25, 5]]);                   // 100 + 5 = 105
        const p3 = await mkPo(s, [[inv, 1, 999]]);          // cancelled: excluded
        expect((await pay(p1, { amount: 120.5 })).status).toBe(200);
        expect((await admin().patch(`/purchase-orders/${p3._id}/cancel`)).status).toBe(200);

        const list = await admin().get('/suppliers');
        const row = list.body.suppliers.find((x) => x._id === String(s._id));
        expect(row).toMatchObject({ outstanding: 484.5, poCount: 2, totalBilled: 605 });
        const one = await admin().get(`/suppliers/${s._id}`);
        expect(one.body.supplier.outstanding).toBe(484.5);
        expect(one.body.purchaseOrders).toHaveLength(3);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('purchase orders: create + totals', () => {
    test('totals are exact: subtotal, per-line tax, grand total; lines snapshot name + unit', async () => {
        const s = await mkSupplier();
        const rice = await mkInv({ name: `PoRice ${uniq()}`, unit: 'kg' });
        const cups = await mkInv({ name: `PoCups ${uniq()}`, unit: 'pcs', category: 'Packaging' });
        // 10 × 45.5 = 455 (+5% = 22.75) ; 24 × 12.25 = 294 (+12% = 35.28)
        const po = await mkPo(s, [[rice, 10, 45.5, 5], [cups, 24, 12.25, 12]], { invoiceNumber: 'INV-77' });
        const saved = await reloadPo(po._id);
        expect(saved).toMatchObject({
            subTotal: 749, taxTotal: 58.03, grandTotal: 807.03, amountPaid: 0,
            status: 'ordered', paymentStatus: 'unpaid', supplierName: s.name, invoiceNumber: 'INV-77',
        });
        expect(saved.poNumber).toMatch(/^PO-\d{3,}$/);
        expect(saved.lines.map((l) => [l.name, l.unit, l.orderedQty, l.receivedQty, l.rate, l.taxPercent]))
            .toEqual([[rice.name, 'kg', 10, 0, 45.5, 5], [cups.name, 'pcs', 24, 0, 12.25, 12]]);
    });

    test('PO numbers are sequential per tenant', async () => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const a = await mkPo(s, [[inv, 1, 1]]);
        const b = await mkPo(s, [[inv, 1, 1]]);
        const n = (po) => parseInt(po.poNumber.split('-')[1], 10);
        expect(n(b)).toBe(n(a) + 1);
        const next = await admin().get('/purchase-orders/next-number');
        expect(parseInt(next.body.poNumber.split('-')[1], 10)).toBe(n(b) + 1);
    });

    test.each([
        ['no supplier', (s, inv) => ({ lines: [{ inventoryItem: String(inv._id), orderedQty: 1, rate: 1 }] }), 400, 'A valid supplier is required'],
        ['unknown supplier', (s, inv) => ({ supplier: String(new mongoose.Types.ObjectId()), lines: [{ inventoryItem: String(inv._id), orderedQty: 1, rate: 1 }] }), 404, 'Supplier not found'],
        ['no lines', (s) => ({ supplier: String(s._id), lines: [] }), 400, 'Add at least one item line'],
        ['unknown item', (s) => ({ supplier: String(s._id), lines: [{ inventoryItem: String(new mongoose.Types.ObjectId()), orderedQty: 1, rate: 1 }] }), 400, 'One or more items are invalid for this tenant'],
        ['zero quantity', (s, inv) => ({ supplier: String(s._id), lines: [{ inventoryItem: String(inv._id), orderedQty: 0, rate: 1 }] }), 400, 'Quantity for {inv} must be greater than 0'],
        ['negative rate', (s, inv) => ({ supplier: String(s._id), lines: [{ inventoryItem: String(inv._id), orderedQty: 1, rate: -1 }] }), 400, 'Rate for {inv} is invalid'],
    ])('create rejects %s', async (_l, build, status, message) => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const before = await PurchaseOrder.countDocuments({ restaurant: A.restaurant._id });
        const res = await admin().post('/purchase-orders').send(build(s, inv));
        expect(res.status).toBe(status);
        expect(res.body.message).toBe(message.replace('{inv}', inv.name));
        expect(await PurchaseOrder.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('tax percent is clamped to 0..100', async () => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const po = await mkPo(s, [[inv, 2, 10, 250]]);
        expect(await reloadPo(po._id)).toMatchObject({ subTotal: 20, taxTotal: 20, grandTotal: 40 });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('purchase orders: receiving goods (GRN)', () => {
    test('partial then full receipt: exact stock increments, status transitions, GRN serials, history', async () => {
        const s = await mkSupplier();
        const rice = await mkInv({ unit: 'kg', currentStock: 3.5, minStock: 5 });
        const oil = await mkInv({ unit: 'L', currentStock: 0, minStock: 1 });
        const po = await mkPo(s, [[rice, 25, 60], [oil, 10, 140]]);

        let res = await receive(po, [[rice, 10, { batchNumber: 'B-1', expiryDate: '2099-01-31' }], [oil, 0]], 'first truck');
        expect(res.status).toBe(200);
        expect(res.body.grnNumber).toBe('GRN-001');
        let saved = await reloadPo(po._id);
        expect(saved.status).toBe('partially-received');
        expect(saved.lines.map((l) => l.receivedQty)).toEqual([10, 0]);
        expect(saved.receipts[0]).toMatchObject({ grnNumber: 'GRN-001', note: 'first truck' });
        expect(saved.receipts[0].lines).toEqual([expect.objectContaining({ qty: 10, batchNumber: 'B-1' })]); // zero row skipped

        let r = await reloadInv(rice._id);
        expect(r).toMatchObject({ currentStock: 13.5, status: 'in-stock', expiryTracking: true });
        expect(new Date(r.expiryDate).toISOString().slice(0, 10)).toBe('2099-01-31');
        expect(r.adjustmentHistory.at(-1)).toMatchObject({
            type: 'restock', quantity: 10, previousStock: 3.5, newStock: 13.5, reason: `GRN GRN-001 · PO ${po.poNumber}`,
        });
        expect((await reloadInv(oil._id)).currentStock).toBe(0);

        res = await receive(po, [[rice, 15], [oil, 10]]);
        expect(res.status).toBe(200);
        expect(res.body.grnNumber).toBe('GRN-002');
        saved = await reloadPo(po._id);
        expect(saved.status).toBe('received');
        expect(saved.lines.map((l) => l.receivedQty)).toEqual([25, 10]);
        r = await reloadInv(rice._id);
        expect(r.currentStock).toBe(28.5);
        const o = await reloadInv(oil._id);
        expect(o).toMatchObject({ currentStock: 10, status: 'in-stock' });

        const again = await receive(po, [[rice, 1]]);
        expect(again.status).toBe(400);
        expect(again.body.message).toBe('This PO is already fully received');
        expect((await reloadInv(rice._id)).currentStock).toBe(28.5);
    });

    test.each([
        ['no lines', [], 'Provide at least one received line'],
        ['only zero quantities', 'zero', 'No positive quantities to receive'],
        ['an item not on the PO', 'foreign', 'A received line does not match any PO line'],
    ])('receive rejects %s → 400, no stock change', async (_l, kind, message) => {
        const s = await mkSupplier();
        const inv = await mkInv({ currentStock: 1 });
        const other = await mkInv({ currentStock: 1 });
        const po = await mkPo(s, [[inv, 5, 10]]);
        const lines = kind === 'zero' ? [[inv, 0], [inv, -2]] : kind === 'foreign' ? [[other, 1]] : [];
        const res = await receive(po, lines);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        expect((await reloadInv(inv._id)).currentStock).toBe(1);
        expect((await reloadInv(other._id)).currentStock).toBe(1);
        expect((await reloadPo(po._id)).receipts).toHaveLength(0);
    });

    test('over-receiving a single-line PO is accepted: stock gets the full delivered quantity', async () => {
        const s = await mkSupplier();
        const inv = await mkInv({ currentStock: 0 });
        const po = await mkPo(s, [[inv, 10, 10]]);
        const res = await receive(po, [[inv, 12]]);
        expect(res.status).toBe(200);
        const saved = await reloadPo(po._id);
        expect(saved.status).toBe('received');
        expect(saved.lines[0].receivedQty).toBe(12);
        expect((await reloadInv(inv._id)).currentStock).toBe(12);
    });

    // Regression (fixed 2026-10): computeReceiveStatus marks 'received' only when every line is fully received.
    test('over-receiving one line keeps the PO partially-received while another line is still outstanding', async () => {
        const s = await mkSupplier();
        const a = await mkInv();
        const b = await mkInv();
        const po = await mkPo(s, [[a, 10, 5], [b, 10, 5]]);
        expect((await receive(po, [[a, 20]])).status).toBe(200);
        const saved = await reloadPo(po._id);
        expect(saved.lines.map((l) => l.receivedQty)).toEqual([20, 0]);
        expect(saved.status).toBe('partially-received'); // was 'received' before the fix
        const rest = await receive(po, [[b, 10]]);
        expect(rest.status).toBe(200);
        expect((await reloadInv(b._id)).currentStock).toBe(10);
    });

    // Regression (fixed 2026-10): receive() increments stock via Inventory.incStock (3-decimal precision), never round2.
    test('receiving goods keeps 3-decimal stock (0.955 kg + 1 kg → 1.955 kg)', async () => {
        const s = await mkSupplier();
        const inv = await mkInv({ unit: 'kg', currentStock: 0.955 });
        const po = await mkPo(s, [[inv, 1, 200]]);
        expect((await receive(po, [[inv, 1]])).status).toBe(200);
        const saved = await reloadInv(inv._id);
        expect(saved.adjustmentHistory.at(-1)).toMatchObject({ quantity: 1, previousStock: 0.955 });
        expect(saved.currentStock).toBeCloseTo(1.955, 9); // was 1.96 before the fix
    });

    test('receiving does NOT change costPerUnit (no weighted-average / last-price update)', async () => {
        const s = await mkSupplier();
        const inv = await mkInv({ unit: 'kg', currentStock: 10, costPerUnit: 100 });
        const po = await mkPo(s, [[inv, 10, 160]]);
        expect((await receive(po, [[inv, 10]])).status).toBe(200);
        const saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBe(20);
        // Pinned current behaviour: the purchase rate never reaches the item,
        // so valuation (qty × costPerUnit) stays at the old ₹100/kg.
        expect(saved.costPerUnit).toBe(100);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('purchase orders: payments, cancel, edit', () => {
    test('payments: partial → paid; over-payment and non-positive amounts refused; mode defaults to cash', async () => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const po = await mkPo(s, [[inv, 3, 33.33, 18]]); // 99.99 + 18 = 117.99 (17.9982 → 18.00)
        expect(await reloadPo(po._id)).toMatchObject({ subTotal: 99.99, taxTotal: 18, grandTotal: 117.99 });

        expect((await pay(po, { amount: 0 })).status).toBe(400);
        expect((await pay(po, { amount: -5 })).status).toBe(400);

        let res = await pay(po, { amount: 50.005, mode: 'bitcoin', reference: 'r1' });
        expect(res.status).toBe(200);
        let saved = await reloadPo(po._id);
        expect(saved).toMatchObject({ amountPaid: 50.01, paymentStatus: 'partial' });
        expect(saved.payments[0]).toMatchObject({ amount: 50.01, mode: 'cash', reference: 'r1' });

        const over = await pay(po, { amount: 68 });
        expect(over.status).toBe(400);
        expect(over.body.message).toBe('Amount exceeds the outstanding due of ₹67.98');

        res = await pay(po, { amount: 67.98, mode: 'upi' });
        expect(res.status).toBe(200);
        saved = await reloadPo(po._id);
        expect(saved).toMatchObject({ amountPaid: 117.99, paymentStatus: 'paid' });
        expect(saved.payments.map((p) => p.mode)).toEqual(['cash', 'upi']);
    });

    test('cancel: an ordered PO cancels; then it can be neither received nor paid nor edited', async () => {
        const s = await mkSupplier();
        const inv = await mkInv({ currentStock: 2 });
        const po = await mkPo(s, [[inv, 5, 10]]);
        expect((await admin().patch(`/purchase-orders/${po._id}/cancel`)).status).toBe(200);
        expect((await reloadPo(po._id)).status).toBe('cancelled');

        const r = await receive(po, [[inv, 5]]);
        expect(r.status).toBe(400);
        expect(r.body.message).toBe('Cannot receive against a cancelled PO');
        expect((await pay(po, { amount: 1 })).body.message).toBe('Cannot pay a cancelled PO');
        expect((await admin().put(`/purchase-orders/${po._id}`).send({ notes: 'x' })).body.message).toBe('Cannot edit a cancelled PO');
        expect((await reloadInv(inv._id)).currentStock).toBe(2);
    });

    test.each([
        ['goods received', 'received', 'Cannot cancel — goods already received. Reverse the stock manually if needed.'],
        ['a payment recorded', 'paid', 'Cannot cancel — payments recorded against this PO.'],
    ])('cancel is refused once %s', async (_l, kind, message) => {
        const s = await mkSupplier();
        const inv = await mkInv({ currentStock: 0 });
        const po = await mkPo(s, [[inv, 5, 10]]);
        if (kind === 'received') expect((await receive(po, [[inv, 2]])).status).toBe(200);
        else expect((await pay(po, { amount: 10 })).status).toBe(200);
        const res = await admin().patch(`/purchase-orders/${po._id}/cancel`);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        expect((await reloadPo(po._id)).status).not.toBe('cancelled');
        expect((await reloadInv(inv._id)).currentStock).toBe(kind === 'received' ? 2 : 0);
    });

    test('edit before receipt recomputes totals; edit after a GRN is refused', async () => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const po = await mkPo(s, [[inv, 5, 10]]);
        const res = await admin().put(`/purchase-orders/${po._id}`).send({
            notes: 'revised', lines: [{ inventoryItem: String(inv._id), orderedQty: 8, rate: 12.5, taxPercent: 5 }],
        });
        expect(res.status).toBe(200);
        expect(await reloadPo(po._id)).toMatchObject({ notes: 'revised', subTotal: 100, taxTotal: 5, grandTotal: 105 });

        expect((await receive(po, [[inv, 1]])).status).toBe(200);
        const late = await admin().put(`/purchase-orders/${po._id}`).send({ notes: 'too late' });
        expect(late.status).toBe(400);
        expect((await reloadPo(po._id)).notes).toBe('revised');
    });

    // Regression (fixed 2026-10): update() refuses a grandTotal below amountPaid with 400.
    test('editing a part-paid PO below the amount already paid is refused', async () => {
        const s = await mkSupplier();
        const inv = await mkInv();
        const po = await mkPo(s, [[inv, 10, 100]]);
        expect((await pay(po, { amount: 500 })).status).toBe(200);
        const res = await admin().put(`/purchase-orders/${po._id}`).send({
            lines: [{ inventoryItem: String(inv._id), orderedQty: 1, rate: 100 }],
        });
        const saved = await reloadPo(po._id);
        expect({ status: res.status, grandTotal: saved.grandTotal })
            .toEqual({ status: 400, grandTotal: 1000 }); // was 200 / grandTotal 100 before the fix
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('purchase reports + summary', () => {
    let T;
    beforeAll(async () => {
        T = await seedTenant({ label: 'procrep' });
    });

    test('summary, purchase report and payment report agree to the paisa', async () => {
        const api = ctx.api.as(T.users.admin);
        const inv = await Inventory.create({
            restaurant: T.restaurant._id, itemId: 'INV-R1', name: 'Rep Dal', category: 'Raw Ingredients',
            unit: 'kg', currentStock: 0, minStock: 0, costPerUnit: 90,
        });
        const sup = async (name) => (await api.post('/suppliers').send({ name })).body.supplier;
        const s1 = await sup('Alpha Traders');
        const s2 = await sup('Beta Foods');
        const po = async (s, qty, rate, tax = 0) => (await api.post('/purchase-orders').send({
            supplier: String(s._id), lines: [{ inventoryItem: String(inv._id), orderedQty: qty, rate, taxPercent: tax }],
        })).body.order;
        const p1 = await po(s1, 10, 95.5, 5);   // 955 + 47.75 = 1002.75
        const p2 = await po(s1, 2, 100);        // 200
        const p3 = await po(s2, 3, 33.33);      // 99.99
        const p4 = await po(s2, 1, 5000);       // cancelled → excluded everywhere
        expect((await api.post(`/purchase-orders/${p1._id}/payment`).send({ amount: 1002.75 })).status).toBe(200);
        expect((await api.post(`/purchase-orders/${p3._id}/payment`).send({ amount: 50 })).status).toBe(200);
        expect((await api.post(`/purchase-orders/${p2._id}/receive`).send({ lines: [{ inventoryItem: String(inv._id), qty: 1 }] })).status).toBe(200);
        expect((await api.patch(`/purchase-orders/${p4._id}/cancel`)).status).toBe(200);

        const summary = await api.get('/purchase-orders/summary');
        expect(summary.body.summary).toMatchObject({ totalPOs: 3, pendingReceipt: 3, monthSpend: 1302.74 }); // p1, p3 ordered + p2 partial
        expect(summary.body.summary.outstanding).toBeCloseTo(249.99, 9);

        const pr = await api.get('/purchase-orders/reports/purchase?days=30');
        expect(pr.body.report).toEqual([
            expect.objectContaining({ supplierName: 'Alpha Traders', poCount: 2, totalSpend: 1202.75, paid: 1002.75, outstanding: 200 }),
            expect.objectContaining({ supplierName: 'Beta Foods', poCount: 1, totalSpend: 99.99, paid: 50, outstanding: 49.99 }),
        ]);
        expect(pr.body.totals).toEqual({ totalSpend: 1302.74, paid: 1052.75, outstanding: 249.99 });

        const pay_ = await api.get('/purchase-orders/reports/payments');
        expect(pay_.body.report.map((r) => [r.supplierName, r.outstanding, r.unpaidPOs]))
            .toEqual([['Alpha Traders', 200, 1], ['Beta Foods', 49.99, 1]]);
        expect(pay_.body.totalOutstanding).toBe(249.99);

        const listed = await api.get('/purchase-orders?status=partially-received');
        expect(listed.body.orders.map((o) => o.poNumber)).toEqual([p2.poNumber]);
        const unpaid = await api.get('/purchase-orders?paymentStatus=unpaid');
        expect(unpaid.body.orders.map((o) => o.poNumber).sort()).toEqual([p2.poNumber, p4.poNumber].sort());
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('production batches', () => {
    async function setup({ onion = 5, oil = 1, gravy = 0 } = {}) {
        const dish = await MenuItem.create({
            restaurant: A.restaurant._id, category: A.category._id, name: `Gravy Base ${uniq()}`,
            description: 'prep', basePrice: 0.01, prepStation: 'kitchen',
        });
        const inv = {
            onion: await mkInv({ name: `PrOnion ${uniq()}`, unit: 'kg', currentStock: onion, costPerUnit: 40 }),
            oil: await mkInv({ name: `PrOil ${uniq()}`, unit: 'L', currentStock: oil, costPerUnit: 180 }),
            gravy: await mkInv({ name: `PrGravy ${uniq()}`, unit: 'L', currentStock: gravy, costPerUnit: 0 }),
        };
        const recipe = await Recipe.create({
            restaurant: A.restaurant._id, menuItem: dish._id, recipeType: 'semi-finished',
            ingredients: [
                { inventoryItem: inv.onion._id, quantity: 200, unit: 'g' },
                { inventoryItem: inv.oil._id, quantity: 50, unit: 'mL' },
            ],
        });
        return { dish, inv, recipe };
    }

    test('a batch consumes ingredients × batches (g→kg, mL→L) and banks the output; cost exact', async () => {
        const { dish, inv, recipe } = await setup();
        const res = await admin().post('/production').send({
            recipeId: String(recipe._id), batchQuantity: 2.5, outputItem: String(inv.gravy._id), outputQty: 5, notes: 'lunch prep',
        });
        expect(res.status).toBe(201);
        const p = await Production.findById(res.body.production._id).lean();
        // onion 0.2 kg × 2.5 = 0.5 kg (₹20) ; oil 0.05 L × 2.5 = 0.125 L (₹22.5)
        expect(p).toMatchObject({
            batchQuantity: 2.5, outputQty: 5, outputUnit: 'L', totalCost: 42.5, recipeName: dish.name, notes: 'lunch prep',
        });
        expect(p.batchNumber).toMatch(/^PRD-\d{3,}$/);
        expect(p.consumed.map((c) => [c.name, c.qty, c.unit])).toEqual([[inv.onion.name, 0.5, 'kg'], [inv.oil.name, 0.125, 'L']]);

        const onion = await reloadInv(inv.onion._id);
        const oil = await reloadInv(inv.oil._id);
        const gravy = await reloadInv(inv.gravy._id);
        expect(onion.currentStock).toBe(4.5);
        expect(oil.currentStock).toBe(0.875);
        expect(gravy).toMatchObject({ currentStock: 5, status: 'in-stock' });
        expect(onion.adjustmentHistory.at(-1)).toMatchObject({
            type: 'usage', quantity: 0.5, previousStock: 5, newStock: 4.5, reason: `Production ${p.batchNumber} (${dish.name})`,
        });
        expect(gravy.adjustmentHistory.at(-1)).toMatchObject({ type: 'restock', quantity: 5, previousStock: 0, newStock: 5 });
    });

    test('recipe can be resolved by menuItemId; no output item → only consumption', async () => {
        const { dish, inv } = await setup();
        const res = await admin().post('/production').send({ menuItemId: String(dish._id), batchQuantity: 1 });
        expect(res.status).toBe(201);
        expect(res.body.production.outputItem).toBeNull();
        expect((await reloadInv(inv.onion._id)).currentStock).toBe(4.8);
        expect((await reloadInv(inv.oil._id)).currentStock).toBe(0.95);
        expect((await reloadInv(inv.gravy._id)).currentStock).toBe(0);
    });

    test('insufficient ingredients → 400 with every shortage listed; NOTHING is deducted or recorded', async () => {
        const { inv, recipe } = await setup({ onion: 0.3, oil: 0.05 });
        const before = await Production.countDocuments({ restaurant: A.restaurant._id });
        const res = await admin().post('/production').send({
            recipeId: String(recipe._id), batchQuantity: 2, outputItem: String(inv.gravy._id), outputQty: 4,
        });
        expect(res.status).toBe(400);
        expect(res.body.shortages).toEqual([
            { name: inv.onion.name, need: 0.4, have: 0.3, unit: 'kg' },
            { name: inv.oil.name, need: 0.1, have: 0.05, unit: 'L' },
        ]);
        expect(await Production.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
        expect((await reloadInv(inv.onion._id)).currentStock).toBe(0.3);
        expect((await reloadInv(inv.oil._id)).currentStock).toBe(0.05);
        expect((await reloadInv(inv.gravy._id)).currentStock).toBe(0);
    });

    test('exactly enough stock is accepted and leaves 0 / out-of-stock', async () => {
        const { inv, recipe } = await setup({ onion: 0.4, oil: 0.1 });
        expect((await admin().post('/production').send({ recipeId: String(recipe._id), batchQuantity: 2 })).status).toBe(201);
        expect(await reloadInv(inv.onion._id)).toMatchObject({ currentStock: 0, status: 'out-of-stock' });
        expect(await reloadInv(inv.oil._id)).toMatchObject({ currentStock: 0, status: 'out-of-stock' });
    });

    test.each([
        ['batchQuantity 0', (r) => ({ recipeId: String(r._id), batchQuantity: 0 }), 400, 'Batch quantity must be greater than 0'],
        ['no recipe', () => ({ recipeId: String(new mongoose.Types.ObjectId()), batchQuantity: 1 }), 404, 'Recipe not found'],
        ['invalid output item', (r) => ({ recipeId: String(r._id), batchQuantity: 1, outputItem: String(new mongoose.Types.ObjectId()), outputQty: 1 }), 400, 'Output item is invalid for this tenant'],
    ])('rejects %s', async (_l, build, status, message) => {
        const { inv, recipe } = await setup();
        const res = await admin().post('/production').send(build(recipe));
        expect(res.status).toBe(status);
        expect(res.body.message).toBe(message);
        expect((await reloadInv(inv.onion._id)).currentStock).toBe(5);
    });

    test('unit mismatch on an ingredient → 400, nothing deducted', async () => {
        const { inv, recipe } = await setup();
        const cans = await mkInv({ name: `PrCans ${uniq()}`, unit: 'can', currentStock: 10 });
        await Recipe.updateOne({ _id: recipe._id }, { $push: { ingredients: { inventoryItem: cans._id, quantity: 400, unit: 'g' } } });
        const res = await admin().post('/production').send({ recipeId: String(recipe._id), batchQuantity: 1 });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(`Unit mismatch on ${cans.name} (g → can). Fix the recipe unit first.`);
        expect((await reloadInv(inv.onion._id)).currentStock).toBe(5);
        expect((await reloadInv(cans._id)).currentStock).toBe(10);
    });

    // Regression (fixed 2026-10): production aggregates needs per inventory item before the shortage check and deduction.
    test('a recipe listing one ingredient twice is checked against the aggregated need', async () => {
        const { inv, recipe } = await setup({ onion: 1 });
        await Recipe.updateOne({ _id: recipe._id }, { $set: { ingredients: [
            { inventoryItem: inv.onion._id, quantity: 600, unit: 'g' },
            { inventoryItem: inv.onion._id, quantity: 600, unit: 'g' },
        ] } });
        const res = await admin().post('/production').send({ recipeId: String(recipe._id), batchQuantity: 1 });
        expect(res.status).toBe(400); // was 201 (over-consumed) before the fix
        expect((await reloadInv(inv.onion._id)).currentStock).toBe(1);
    });

    test('list + summary reflect recorded batches', async () => {
        const T = await seedTenant({ label: 'prodsum' });
        const dish = await MenuItem.create({ restaurant: T.restaurant._id, category: T.category._id, name: 'Stock', description: 'x', basePrice: 1 });
        const onion = await Inventory.create({ restaurant: T.restaurant._id, itemId: 'INV-S1', name: 'S Onion', category: 'Raw Ingredients', unit: 'kg', currentStock: 10, minStock: 0, costPerUnit: 33.3 });
        const recipe = await Recipe.create({ restaurant: T.restaurant._id, menuItem: dish._id, ingredients: [{ inventoryItem: onion._id, quantity: 1, unit: 'kg' }] });
        const api = ctx.api.as(T.users.admin);
        expect((await api.post('/production').send({ recipeId: String(recipe._id), batchQuantity: 1 })).status).toBe(201);
        expect((await api.post('/production').send({ recipeId: String(recipe._id), batchQuantity: 2 })).status).toBe(201);
        const sum = await api.get('/production/summary');
        expect(sum.body.summary).toMatchObject({ totalBatches: 2, todayBatches: 2 });
        expect(sum.body.summary.todayCost).toBeCloseTo(99.9, 9); // 33.3 + 66.6
        const list = await api.get('/production?days=1');
        expect(list.body.entries.map((e) => e.batchNumber)).toEqual(['PRD-002', 'PRD-001']);
        expect((await Inventory.findById(onion._id).lean()).currentStock).toBe(7);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('remaining read paths', () => {
    test('GET /purchase-orders/:id populates supplier + GRN user; unknown id → 404; search by PO number', async () => {
        const s = await mkSupplier({ gstNumber: '29ABCDE1234F1Z5' });
        const inv = await mkInv();
        const po = await mkPo(s, [[inv, 2, 10]]);
        expect((await receive(po, [[inv, 1]])).status).toBe(200);
        const res = await admin().get(`/purchase-orders/${po._id}`);
        expect(res.status).toBe(200);
        expect(res.body.order.supplier).toMatchObject({ name: s.name, gstNumber: '29ABCDE1234F1Z5' });
        expect(res.body.order.receipts[0].receivedBy.name).toBe(A.users.admin.name);
        expect((await admin().get(`/purchase-orders/${new mongoose.Types.ObjectId()}`)).status).toBe(404);

        const found = await admin().get(`/purchase-orders?search=${po.poNumber}`);
        expect(found.body.orders.map((o) => o.poNumber)).toEqual([po.poNumber]);
    });

    test('supplier list: search + active filter', async () => {
        const tag = uniq();
        const on = await mkSupplier({ name: `Srch ${tag} On` });
        const off = await mkSupplier({ name: `Srch ${tag} Off` });
        expect((await admin().put(`/suppliers/${off._id}`).send({ isActive: false })).status).toBe(200);
        const active = await admin().get(`/suppliers?search=${tag}&active=true`);
        expect(active.body.suppliers.map((x) => x._id)).toEqual([String(on._id)]);
        const inactive = await admin().get(`/suppliers?search=${tag}&active=false`);
        expect(inactive.body.suppliers.map((x) => x._id)).toEqual([String(off._id)]);
        expect((await admin().get(`/suppliers/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    });

    test('supplier created with body.branch is stored on that branch; a PO for it inherits the branch', async () => {
        const s = await mkSupplier({ branch: String(A.branch._id) });
        expect(String((await Supplier.findById(s._id).lean()).branch)).toBe(String(A.branch._id));
        const inv = await mkInv();
        const po = await mkPo(s, [[inv, 1, 1]]);
        expect(String((await reloadPo(po._id)).branch)).toBe(String(A.branch._id));
    });
});
