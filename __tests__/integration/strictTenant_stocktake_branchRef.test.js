/**
 * STRICT tenant: a branch id taken from req.body / req.query must belong to the
 * caller's tenant (400, no CastError text) - stocktake create (shared
 * resolveBranchId), inventory item create/update, CSV imports, payroll runs.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const model = (n) => require(path.join(BACKEND, 'models', n));
const Branch = model('branch');
const Inventory = model('inventory');
const Stocktake = model('stocktake');
const PayrollRun = model('payrollRun');

const ctx = useIntegrationApp();
let A; let B; let A2;
const adminA = () => ctx.api.as(A.users.admin);
const txt = (r) => JSON.stringify(r.body || {}) + String(r.text || '');
const GARBAGE = ['not-an-id', '{"$ne":null}', '0'.repeat(24)];
const noLeak = (r) => expect(txt(r)).not.toMatch(/CastError|Cast to|BSON|ObjectId failed/i);

beforeAll(async () => {
    A = await seedTenant({ label: 'stk-a' });
    B = await seedTenant({ label: 'stk-b' });
    A2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A-Second', slug: 'a-second', isActive: true });
    await Inventory.create({
        restaurant: A.restaurant._id, branch: A.branch._id, category: 'Raw Ingredients', unit: 'kg',
        currentStock: 10, minStock: 1, costPerUnit: 5, itemId: 'INV-001', name: 'A-Flour',
    });
});

describe('stocktake create: body/query branch ownership', () => {
    test("B's branch id in body is refused (400) and no stocktake is stored", async () => {
        const r = await adminA().post('/inventory/stocktakes').send({ name: 'x', branch: String(B.branch._id) });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('INVALID_BRANCH');
        noLeak(r);
        expect(await Stocktake.countDocuments({ restaurant: A.restaurant._id })).toBe(0);
        expect(await Stocktake.countDocuments({ branch: B.branch._id })).toBe(0);
    });

    test.each(GARBAGE)('garbage / unknown branch %s never leaks cast errors and never stores a foreign branch', async (g) => {
        const r = await adminA().post('/inventory/stocktakes').send({ name: 'x', branch: g });
        expect(r.status).toBeLessThan(500);
        noLeak(r);
        if (g === '0'.repeat(24)) expect(r.status).toBe(400);
        expect(await Stocktake.countDocuments({ branch: B.branch._id })).toBe(0);
    });

    test("B's branch id in the query string is refused too", async () => {
        const r = await adminA().post(`/inventory/stocktakes?branch=${B.branch._id}`).send({ name: 'q' });
        expect([400, 404]).toContain(r.status); // 404 when the branch-context middleware already rejects it
        expect(await Stocktake.countDocuments({ branch: B.branch._id })).toBe(0);
    });

    test("operator-object branch ({ $ne }) cannot be used to widen", async () => {
        const r = await adminA().post('/inventory/stocktakes').send({ name: 'op', branch: { $ne: null } });
        expect(r.status).toBeLessThan(500);
        noLeak(r);
        expect(await Stocktake.countDocuments({ branch: B.branch._id })).toBe(0);
    });

    test("A's own branch still works and is stored", async () => {
        const r = await adminA().post('/inventory/stocktakes').send({ name: 'ok', branch: String(A.branch._id) });
        expect(r.status).toBe(201);
        expect(String(r.body.stocktake.branch)).toBe(String(A.branch._id));
        expect(r.body.stocktake.lines.length).toBeGreaterThan(0);
    });
});

describe('inventory item create/update: foreign branch', () => {
    const base = { name: 'A-New', category: 'Raw Ingredients', unit: 'kg', minStock: 1, costPerUnit: 1, currentStock: 3 };
    test('create with B branch -> 400, nothing stored', async () => {
        const r = await adminA().post('/inventory').send({ ...base, branch: String(B.branch._id) });
        expect(r.status).toBe(400);
        noLeak(r);
        expect(await Inventory.countDocuments({ name: 'A-New' })).toBe(0);
    });
    test('create with garbage branch -> 400 without cast text', async () => {
        const r = await adminA().post('/inventory').send({ ...base, branch: 'zzz' });
        expect(r.status).toBe(400);
        noLeak(r);
    });
    test('create with own branch works', async () => {
        const r = await adminA().post('/inventory').send({ ...base, branch: String(A2._id) });
        expect(r.status).toBe(201);
        const doc = await Inventory.findOne({ name: 'A-New' }).lean();
        expect(String(doc.branch)).toBe(String(A2._id));
    });
    test('update re-pointing at B branch -> 400, unchanged', async () => {
        const doc = await Inventory.findOne({ name: 'A-New' }).lean();
        const r = await adminA().put(`/inventory/${doc._id}`).send({ branch: String(B.branch._id) });
        expect(r.status).toBe(400);
        noLeak(r);
        expect(String((await Inventory.findById(doc._id).lean()).branch)).toBe(String(A2._id));
    });
});

describe('CSV imports: ?branch= / body branch of another tenant', () => {
    const csv = ['name,category,unit,minStock,costPerUnit', 'Csv-Item,Raw Ingredients,kg,1,1'].join('\n');
    test('inventory import with B branch -> 400, nothing created', async () => {
        const r = await adminA().post(`/inventory/import?branch=${B.branch._id}`).attach('file', Buffer.from(csv), { filename: 'i.csv', contentType: 'text/csv' });
        expect([400, 404]).toContain(r.status);
        noLeak(r);
        expect(await Inventory.countDocuments({ name: 'Csv-Item' })).toBe(0);
    });
    test('recipes import with B branch -> 400', async () => {
        const rc = ['menuItemName,inventoryItemName,quantity,unit', 'x,y,1,kg'].join('\n');
        const r = await adminA().post(`/inventory/recipes/import?branch=${B.branch._id}`).attach('file', Buffer.from(rc), { filename: 'r.csv', contentType: 'text/csv' });
        expect([400, 404]).toContain(r.status);
        noLeak(r);
    });
    test('inventory import with own branch works', async () => {
        const r = await adminA().post(`/inventory/import?branch=${A2._id}`).attach('file', Buffer.from(csv), { filename: 'i.csv', contentType: 'text/csv' });
        expect(r.status).toBeLessThan(300);
        const doc = await Inventory.findOne({ name: 'Csv-Item' }).lean();
        expect(doc && String(doc.branch)).toBe(String(A2._id));
    });
});

describe('payroll run: foreign branch', () => {
    test('body.branch of tenant B -> 400, no run stored', async () => {
        const r = await adminA().post('/payroll/runs').send({ periodStart: '2025-03-01', periodEnd: '2025-03-31', branch: String(B.branch._id) });
        expect(r.status).toBe(400);
        noLeak(r);
        expect(await PayrollRun.countDocuments({ branch: B.branch._id })).toBe(0);
    });
});
