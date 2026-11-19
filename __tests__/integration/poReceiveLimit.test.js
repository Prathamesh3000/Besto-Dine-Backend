/** BUG-19: a PO line can never be received beyond its ordered quantity. */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Inventory = require(path.join(BACKEND, 'models/inventory'));
const Supplier = require(path.join(BACKEND, 'models/supplier'));
const PurchaseOrder = require(path.join(BACKEND, 'models/purchaseOrder'));

const ctx = useIntegrationApp();
let A;
const uniq = () => Math.random().toString(16).slice(2, 8);
const admin = () => ctx.api.as(A.users.admin);

beforeAll(async () => { A = await seedTenant({ label: 'porl' }); });

const mkInv = () => Inventory.create({
    restaurant: A.restaurant._id, branch: null, itemId: `INV-R${uniq()}`, name: `Stock ${uniq()}`,
    category: 'Raw Ingredients', unit: 'kg', currentStock: 0, minStock: 0, costPerUnit: 100,
});
async function mkPo(lines) {
    const s = await admin().post('/suppliers').send({ name: `Vendor ${uniq()}` });
    const res = await admin().post('/purchase-orders').send({
        supplier: String(s.body.supplier._id),
        lines: lines.map(([inv, orderedQty]) => ({ inventoryItem: String(inv._id), orderedQty, rate: 10, taxPercent: 0 })),
    });
    expect(res.status).toBe(201);
    return res.body.order;
}
const receive = (po, lines) => admin().post(`/purchase-orders/${po._id}/receive`)
    .send({ lines: lines.map(([inv, qty]) => ({ inventoryItem: String(inv._id), qty })) });
const stock = async (inv) => (await Inventory.findById(inv._id).lean()).currentStock;

describe('PO receive limit (BUG-19)', () => {
    test('ordered 10: receive 4 ok, then 100 is rejected with ordered/received/remaining; stock unchanged', async () => {
        const inv = await mkInv();
        const po = await mkPo([[inv, 10]]);
        expect((await receive(po, [[inv, 4]])).status).toBe(200);
        const bad = await receive(po, [[inv, 100]]);
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('OVER_RECEIPT');
        expect(bad.body.message).toMatch(/ordered 10, already received 4, remaining 6/);
        expect(await stock(inv)).toBe(4);
        const saved = await PurchaseOrder.findById(po._id).lean();
        expect(saved.receipts).toHaveLength(1);
        expect(saved.status).toBe('partially-received');
        expect(saved.lines[0].receivedQty).toBe(4);
    });

    test('receiving exactly the remaining completes the PO', async () => {
        const inv = await mkInv();
        const po = await mkPo([[inv, 10]]);
        await receive(po, [[inv, 4]]);
        expect((await receive(po, [[inv, 6]])).status).toBe(200);
        expect((await PurchaseOrder.findById(po._id).lean()).status).toBe('received');
        expect(await stock(inv)).toBe(10);
    });

    test('a single request over the ordered qty is rejected', async () => {
        const inv = await mkInv();
        const po = await mkPo([[inv, 10]]);
        const bad = await receive(po, [[inv, 10.5]]);
        expect(bad.status).toBe(400);
        expect(await stock(inv)).toBe(0);
    });

    test('duplicate rows for one item in one request count cumulatively; nothing is applied', async () => {
        const a = await mkInv();
        const b = await mkInv();
        const po = await mkPo([[a, 10], [b, 10]]);
        const bad = await receive(po, [[b, 5], [a, 6], [a, 6]]);
        expect(bad.status).toBe(400);
        expect(await stock(a)).toBe(0);
        expect(await stock(b)).toBe(0);
        expect((await PurchaseOrder.findById(po._id).lean()).receipts).toHaveLength(0);
    });

    test('one line over rejects the whole receipt even when another line is fine', async () => {
        const a = await mkInv();
        const b = await mkInv();
        const po = await mkPo([[a, 10], [b, 10]]);
        expect((await receive(po, [[a, 5], [b, 11]])).status).toBe(400);
        expect(await stock(a)).toBe(0);
    });

    test('partial receipts across lines still work', async () => {
        const a = await mkInv();
        const b = await mkInv();
        const po = await mkPo([[a, 10], [b, 10]]);
        expect((await receive(po, [[a, 10]])).status).toBe(200);
        expect((await PurchaseOrder.findById(po._id).lean()).status).toBe('partially-received');
        expect((await receive(po, [[b, 10]])).status).toBe(200);
        expect((await PurchaseOrder.findById(po._id).lean()).status).toBe('received');
    });
});
