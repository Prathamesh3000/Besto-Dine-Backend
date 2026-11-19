/**
 * STRICT tenant isolation - inventory family:
 * inventory items, recipes, purchase orders, suppliers, stocktakes,
 * inter-branch stock transfers, production batches (+ reports/CSV).
 *
 * Tenant B's rows are written straight to the DB; tenant A's owner (and a
 * branch-pinned admin) attack them with B's ids on every route. Each denial
 * is checked on the HTTP answer, on the response body (no B marker), and on
 * the B document re-read from MongoDB.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const model = (n) => require(path.join(BACKEND, 'models', n));
const Branch = model('branch');
const Inventory = model('inventory');
const Recipe = model('recipe');
const Supplier = model('supplier');
const PurchaseOrder = model('purchaseOrder');
const Stocktake = model('stocktake');
const StockTransfer = model('stockTransfer');
const Production = model('production');
const MenuItem = model('menuItem');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A; let B; let A2branch; let B2branch;
const rec = {};
const DENIED = [400, 403, 404];
const adminA = () => ctx.api.as(A.users.admin);
const adminB = () => ctx.api.as(B.users.admin);
const txt = (r) => JSON.stringify(r.body || {}) + String(r.text || '');
const lean = (M, id) => M.findById(id).lean();
const oid = () => new mongoose.Types.ObjectId();

const inv = (t, fields) => Inventory.create({
    restaurant: t.restaurant._id, branch: t.branch._id, category: 'Raw Ingredients', unit: 'kg',
    currentStock: 100, minStock: 5, costPerUnit: 10, ...fields,
});

let branchAdminA;

beforeAll(async () => {
    A = await seedTenant({ label: 'inv-a' });
    B = await seedTenant({ label: 'inv-b' });
    A2branch = await Branch.create({ restaurant: A.restaurant._id, name: 'A-Second', slug: 'a-second', isActive: true });
    B2branch = await Branch.create({ restaurant: B.restaurant._id, name: 'B-Second', slug: 'b-second', isActive: true });

    rec.aItem = await inv(A, { itemId: 'INV-001', name: 'A-Flour' });
    rec.aItem2 = await inv(A, { itemId: 'INV-002', name: 'A-Sugar' });
    rec.bItem = await inv(B, { itemId: 'INV-001', name: 'B-Secret-Flour', currentStock: 100, costPerUnit: 77 });
    rec.bItem2 = await inv(B, { itemId: 'INV-002', name: 'B-Secret-Rice', currentStock: 50, branch: B2branch._id });
    rec.bSup = await Supplier.create({ restaurant: B.restaurant._id, code: 'SUP-001', name: 'B-Secret-Supplier', mobile: '9876543210' });
    rec.aSup = await Supplier.create({ restaurant: A.restaurant._id, code: 'SUP-001', name: 'A-Supplier' });
    rec.bPo = await PurchaseOrder.create({
        restaurant: B.restaurant._id, poNumber: 'PO-001', supplier: rec.bSup._id, supplierName: 'B-Secret-Supplier',
        status: 'ordered', grandTotal: 770, subTotal: 770,
        lines: [{ inventoryItem: rec.bItem._id, name: 'B-Secret-Flour', unit: 'kg', orderedQty: 10, rate: 77 }],
    });
    rec.bRecipe = await Recipe.create({
        restaurant: B.restaurant._id, menuItem: B.items.paneer._id,
        ingredients: [{ inventoryItem: rec.bItem._id, quantity: 1, unit: 'kg' }],
    });
    rec.bStocktake = await Stocktake.create({
        restaurant: B.restaurant._id, name: 'B-Secret-Count', status: 'draft',
        lines: [{ item: rec.bItem._id, itemName: 'B-Secret-Flour', itemCode: 'INV-001', expectedQty: 100, unit: 'kg' }],
    });
    rec.bTransfer = await StockTransfer.create({
        restaurant: B.restaurant._id, number: 'TRF-001', fromBranch: B.branch._id, toBranch: B2branch._id, status: 'draft',
        lines: [{ item: rec.bItem._id, itemName: 'B-Secret-Flour', itemCode: 'INV-001', qty: 5, unit: 'kg' }],
    });
    rec.bProd = await Production.create({
        restaurant: B.restaurant._id, batchNumber: 'PRD-001', recipe: rec.bRecipe._id, menuItem: B.items.paneer._id,
        recipeName: 'B-Secret-Batch', batchQuantity: 1, totalCost: 999,
        consumed: [{ inventoryItem: rec.bItem._id, name: 'B-Secret-Flour', qty: 1, unit: 'kg' }],
    });
    rec.aRecipe = await Recipe.create({
        restaurant: A.restaurant._id, menuItem: A.items.paneer._id,
        ingredients: [{ inventoryItem: rec.aItem._id, quantity: 1, unit: 'kg' }],
    });

    branchAdminA = await createUser({
        name: 'Branch Admin inv', email: `ba.${A.slug}@staff.test`, role: 'admin',
        restaurant: A.restaurant._id, branch: A2branch._id, isTenantOwner: false,
        permissions: defaultPermissionsForRole('admin'),
    });
});

const snapshot = async () => ({
    item: await lean(Inventory, rec.bItem._id),
    item2: await lean(Inventory, rec.bItem2._id),
    sup: await lean(Supplier, rec.bSup._id),
    po: await lean(PurchaseOrder, rec.bPo._id),
    recipe: await lean(Recipe, rec.bRecipe._id),
    st: await lean(Stocktake, rec.bStocktake._id),
    tr: await lean(StockTransfer, rec.bTransfer._id),
    prod: await lean(Production, rec.bProd._id),
});
let before;
beforeAll(async () => { before = await snapshot(); });
describe('inventory items', () => {
    test("A list / search / sort never contains B's items; counts exclude B", async () => {
        for (const q of ['', '?search=Secret', '?search=B-Secret-Flour&limit=100', '?category=Raw%20Ingredients&sortBy=name', '?status=in-stock', '?branch=' + B.branch._id, '?branch=all']) {
            // eslint-disable-next-line no-await-in-loop
            const r = await adminA().get(`/inventory${q}`);
            // A foreign ?branch= is refused (404 BRANCH_NOT_FOUND); the rest answer 200.
            expect(q.includes(String(B.branch._id)) ? 404 : 200).toBe(r.status);
            expect(txt(r)).not.toContain('B-Secret');
            expect(txt(r)).not.toContain(String(rec.bItem._id));
            if (q === '') expect(r.body.pagination.total).toBe(2);
        }
    });

    test('summary, alerts, reports, food-cost exclude B', async () => {
        for (const u of ['/inventory/summary', '/inventory/alerts', '/inventory/reports/stock', '/inventory/reports/consumption',
            '/inventory/food-cost', '/inventory/actual-vs-theoretical', '/inventory/menu-issues', '/inventory/reports/valuation', '/inventory/next-id']) {
            // eslint-disable-next-line no-await-in-loop
            const r = await adminA().get(u);
            expect([200, 404]).toContain(r.status);
            expect(txt(r)).not.toContain('B-Secret');
            expect(txt(r)).not.toContain(String(rec.bItem._id));
        }
        const s = await adminA().get('/inventory/summary');
        // A has 2 items of 100 x 10 = 2000; B's 100 x 77 would add 7700
        expect(JSON.stringify(s.body)).not.toContain('7700');
        expect(JSON.stringify(s.body)).not.toContain('9700');
    });

    test.each([
        ['get', (id) => adminA().get(`/inventory/${id}`)],
        ['put', (id) => adminA().put(`/inventory/${id}`).send({ name: 'pwned', minStock: 1 })],
        ['adjust', (id) => adminA().patch(`/inventory/${id}/adjust`).send({ type: 'restock', quantity: 5, reason: 'x' })],
        ['delete', (id) => adminA().delete(`/inventory/${id}`)],
    ])('A cannot %s a B inventory item', async (_l, call) => {
        const r = await call(rec.bItem._id);
        expect(DENIED).toContain(r.status);
        expect(txt(r)).not.toContain('B-Secret');
        const s = await lean(Inventory, rec.bItem._id);
        expect(s).not.toBeNull();
        expect(s.name).toBe('B-Secret-Flour');
        expect(s.currentStock).toBe(100);
        expect(s.adjustmentHistory || []).toHaveLength(0);
    });

    test.each([
        ['object injection', '{"$ne":null}'],
        ['array', '[1,2]'],
        ['garbage', 'not-an-id'],
    ])('item id %s is rejected, not matched', async (_l, id) => {
        for (const call of [
            () => adminA().get(`/inventory/${encodeURIComponent(id)}`),
            () => adminA().delete(`/inventory/${encodeURIComponent(id)}`),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect(r.status).not.toBe(200);
            expect(txt(r)).not.toContain('B-Secret');
        }
        expect(await Inventory.countDocuments({ restaurant: B.restaurant._id })).toBe(2);
        expect(await Inventory.countDocuments({ restaurant: A.restaurant._id })).toBe(2);
    });

    test('query-string operator injection on list cannot widen to B', async () => {
        const r = await adminA().get('/inventory?category[$ne]=zzz&search[$ne]=x&restaurant=' + B.restaurant._id + '&restaurantId=' + B.restaurant._id);
        expect([200, 400]).toContain(r.status);
        expect(txt(r)).not.toContain('B-Secret');
        const r2 = await adminA().get('/inventory').set('X-Restaurant-Slug', B.slug).set('X-Restaurant-Id', String(B.restaurant._id));
        expect(txt(r2)).not.toContain('B-Secret');
    });

    test('create ignores mass-assigned restaurant and does not accept B branch', async () => {
        const r = await adminA().post('/inventory').send({
            name: 'A-New', category: 'Raw Ingredients', unit: 'kg', minStock: 1, costPerUnit: 1, currentStock: 3,
            restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id), tenant: String(B.restaurant._id),
            branch: String(B.branch._id), itemId: 'INV-001',
        });
        expect([201, 400]).toContain(r.status);
        expect(await Inventory.countDocuments({ restaurant: B.restaurant._id })).toBe(2);
        const made = await Inventory.findOne({ name: 'A-New' }).lean();
        if (made) {
            expect(String(made.restaurant)).toBe(String(A.restaurant._id));
            expect(made.branch ? String(made.branch) : null).not.toBe(String(B.branch._id));
        }
    });

    test("update cannot re-point A's item at B's branch", async () => {
        const r = await adminA().put(`/inventory/${rec.aItem2._id}`).send({ branch: String(B.branch._id), restaurant: String(B.restaurant._id) });
        expect([200, 400]).toContain(r.status);
        const s = await lean(Inventory, rec.aItem2._id);
        expect(String(s.restaurant)).toBe(String(A.restaurant._id));
        expect(String(s.branch)).not.toBe(String(B.branch._id));
    });

    test('CSV import: restaurant column / B itemIds cannot overwrite or create in B', async () => {
        const csv = [
            'Item ID,Name,Category,Unit,Current Stock,Min Stock,Max Stock,Cost Per Unit,Supplier,Restaurant,Branch',
            `INV-001,B-Secret-Flour,Raw Ingredients,kg,1,1,0,1,,${B.restaurant._id},${B.branch._id}`,
            `${rec.bItem._id},Hacked,Raw Ingredients,kg,1,1,0,1,,${B.restaurant._id},${B.branch._id}`,
        ].join('\n');
        const r = await adminA().post('/inventory/import').attach('file', Buffer.from(csv), { filename: 'i.csv', contentType: 'text/csv' });
        expect(r.status).toBeLessThan(500);
        const s = await lean(Inventory, rec.bItem._id);
        expect(s.name).toBe('B-Secret-Flour');
        expect(s.currentStock).toBe(100);
        expect(await Inventory.countDocuments({ restaurant: B.restaurant._id })).toBe(2);
        expect(await Inventory.countDocuments({ restaurant: B.restaurant._id, name: 'Hacked' })).toBe(0);
        expect(await Inventory.countDocuments({ branch: B.branch._id, restaurant: A.restaurant._id })).toBe(0);
    });

    test('branch-pinned A admin cannot see sibling-branch (Main) items or B items', async () => {
        const api = ctx.api.as(branchAdminA);
        const r = await api.get('/inventory');
        expect(r.status).toBe(200);
        expect(txt(r)).not.toContain('B-Secret');
        expect(txt(r)).not.toContain('A-Flour');
        expect((await api.get(`/inventory/${rec.aItem._id}`)).status).toBe(404);
        expect((await api.get(`/inventory/${rec.bItem._id}`)).status).toBe(404);
        expect((await api.patch(`/inventory/${rec.aItem._id}/adjust`).send({ type: 'restock', quantity: 1 })).status).toBe(404);
    });

    test('Regression (fixed 2026-11): malformed inventory id answers 500 (CastError text echoed) instead of 400', async () => {
        // routes/inventoryRoute.js GET /:id has no objectIdParam validator; controllers/inventory/items.js getItemById -> 500.
        const r = await adminA().get('/inventory/not-an-id');
        expect(r.status).toBe(400);
    });

    test('positive control: B owner reads its item', async () => {
        const r = await adminB().get(`/inventory/${rec.bItem._id}`);
        expect(r.status).toBe(200);
        expect(txt(r)).toContain('B-Secret-Flour');
    });
});

describe('recipes', () => {
    test("A recipes list / by-menu-item never returns B's recipe", async () => {
        const l = await adminA().get('/inventory/recipes');
        expect(l.status).toBe(200);
        expect(txt(l)).not.toContain('B-Secret');
        expect(txt(l)).not.toContain(String(rec.bRecipe._id));
        const g = await adminA().get(`/inventory/recipes/${B.items.paneer._id}`);
        expect(g.status).toBe(404);
        expect(txt(g)).not.toContain('B-Secret');
    });

    test('A cannot delete B recipe by menu item id', async () => {
        const r = await adminA().delete(`/inventory/recipes/${B.items.paneer._id}`);
        expect(r.status).toBe(404);
        expect(await lean(Recipe, rec.bRecipe._id)).not.toBeNull();
    });

    test("recipe for A's menu item referencing B's stock item is refused", async () => {
        const r = await adminA().post('/inventory/recipes').send({
            menuItemId: String(A.items.naan._id), ingredients: [{ inventoryItem: String(rec.bItem._id), quantity: 1, unit: 'kg' }],
        });
        expect(r.status).toBe(400);
        expect(await Recipe.countDocuments({ menuItem: A.items.naan._id })).toBe(0);
    });

    test("recipe mixing A and B stock items keeps only A's", async () => {
        const r = await adminA().post('/inventory/recipes').send({
            menuItemId: String(A.items.naan._id),
            ingredients: [{ inventoryItem: String(rec.aItem._id), quantity: 1, unit: 'kg' }, { inventoryItem: String(rec.bItem._id), quantity: 1, unit: 'kg' }],
        });
        expect(r.status).toBe(200);
        const saved = await Recipe.findOne({ menuItem: A.items.naan._id }).lean();
        expect(saved.ingredients.map((i) => String(i.inventoryItem))).toEqual([String(rec.aItem._id)]);
        const mi = await lean(MenuItem, A.items.naan._id);
        expect(JSON.stringify(mi.ingredients)).not.toContain('B-Secret');
    });

    test("recipe on B's menu item by A is refused and does not touch B menu item", async () => {
        const mBefore = await lean(MenuItem, B.items.paneer._id);
        const r = await adminA().post('/inventory/recipes').send({
            menuItemId: String(B.items.paneer._id), ingredients: [{ inventoryItem: String(rec.aItem._id), quantity: 1, unit: 'kg' }],
        });
        expect(r.status).toBe(404);
        const rb = await lean(Recipe, rec.bRecipe._id);
        expect(rb.ingredients).toHaveLength(1);
        expect(String(rb.ingredients[0].inventoryItem)).toBe(String(rec.bItem._id));
        expect(JSON.stringify(await lean(MenuItem, B.items.paneer._id))).toBe(JSON.stringify(mBefore));
    });

    test("Regression (fixed 2026-11): recipe save accepts another tenant's branch id in body.branch", async () => {
        // controllers/inventory/recipes.js: ownerBranch = pinnedBranchId || req.body.branch (never validated against the tenant).
        const r = await adminA().post('/inventory/recipes').send({
            menuItemId: String(A.items.thali._id), branch: String(B.branch._id),
            ingredients: [{ inventoryItem: String(rec.aItem._id), quantity: 1, unit: 'kg' }],
        });
        const saved = await Recipe.findOne({ menuItem: A.items.thali._id }).lean();
        const refsB = saved && saved.branch && String(saved.branch) === String(B.branch._id);
        expect(refsB || false).toBe(false);
        expect([200, 400, 404]).toContain(r.status);
    });

    test('recipe CSV import cannot reference B menu / stock items', async () => {
        const t = await adminA().get('/inventory/recipes/template');
        expect(t.status).toBe(200);
        const csv = [
            'Menu Item,Ingredient,Quantity,Unit',
            'Paneer Tikka,B-Secret-Flour,1,kg',
            `${B.items.paneer.name},B-Secret-Rice,1,kg`,
        ].join('\n');
        const r = await adminA().post('/inventory/recipes/import').attach('file', Buffer.from(csv), { filename: 'r.csv', contentType: 'text/csv' });
        expect(r.status).toBeLessThan(500);
        const rb = await lean(Recipe, rec.bRecipe._id);
        expect(rb.ingredients).toHaveLength(1);
        expect(await Recipe.countDocuments({ restaurant: A.restaurant._id, 'ingredients.inventoryItem': { $in: [rec.bItem._id, rec.bItem2._id] } })).toBe(0);
    });

    test('deleting an A stock item does not strip B recipes (same-id pull is tenant scoped)', async () => {
        // an A item that shares nothing with B; B recipe must stay intact after A deletes
        const tmp = await inv(A, { itemId: 'INV-009', name: 'A-Tmp' });
        const r = await adminA().delete(`/inventory/${tmp._id}`);
        expect(r.status).toBe(200);
        const rb = await lean(Recipe, rec.bRecipe._id);
        expect(rb.ingredients).toHaveLength(1);
    });
});

describe('suppliers', () => {
    test('list excludes B, with B outstanding not summed', async () => {
        const r = await adminA().get('/suppliers');
        expect(r.status).toBe(200);
        expect(txt(r)).not.toContain('B-Secret');
        expect(r.body.suppliers).toHaveLength(1);
        expect(r.body.suppliers[0].totalBilled).toBe(0);
        const s = await adminA().get('/suppliers?search=Secret');
        expect(s.body.suppliers).toHaveLength(0);
        const c = await adminA().get('/suppliers/next-code');
        expect(c.status).toBe(200);
    });

    test.each([
        ['get', (id) => adminA().get(`/suppliers/${id}`)],
        ['put', (id) => adminA().put(`/suppliers/${id}`).send({ name: 'pwned' })],
        ['delete', (id) => adminA().delete(`/suppliers/${id}`)],
    ])('A cannot %s a B supplier', async (_l, call) => {
        const r = await call(rec.bSup._id);
        expect(DENIED).toContain(r.status);
        expect(txt(r)).not.toContain('B-Secret');
        const s = await lean(Supplier, rec.bSup._id);
        expect(s.name).toBe('B-Secret-Supplier');
        expect(s.isActive).toBe(true);
    });

    test('create with mass-assigned restaurant / B branch lands in A only', async () => {
        const r = await adminA().post('/suppliers').send({
            name: 'A-New-Supplier', restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id),
            branch: String(B.branch._id), code: 'SUP-001',
        });
        expect([201, 400]).toContain(r.status);
        expect(await Supplier.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
        const made = await Supplier.findOne({ name: 'A-New-Supplier' }).lean();
        if (made) {
            expect(String(made.restaurant)).toBe(String(A.restaurant._id));
            expect(made.branch ? String(made.branch) : null).not.toBe(String(B.branch._id));
        }
    });

    test("supplier update cannot re-point at B's branch", async () => {
        const r = await adminA().put(`/suppliers/${rec.aSup._id}`).send({ name: 'A-Supplier', branch: String(B.branch._id) });
        expect([200, 400]).toContain(r.status);
        const s = await lean(Supplier, rec.aSup._id);
        expect(s.branch ? String(s.branch) : null).not.toBe(String(B.branch._id));
    });

    test('object-injection id never matches a row', async () => {
        const r = await adminA().get(`/suppliers/${encodeURIComponent('{"$ne":null}')}`);
        expect(r.status).not.toBe(200);
        expect(txt(r)).not.toContain('B-Secret');
    });

    test('Regression (fixed 2026-11): malformed supplier id answers 500 (Mongoose CastError text echoed) instead of 400', async () => {
        // routes/supplierRoute.js has no id validator on GET /:id; controllers/supplierController.js getOne -> 500.
        const r = await adminA().get('/suppliers/not-an-id');
        expect(r.status).toBe(400);
    });
});

describe('purchase orders', () => {
    test('list / summary / reports exclude B', async () => {
        for (const u of ['/purchase-orders', '/purchase-orders?search=B-Secret', `/purchase-orders?supplier=${rec.bSup._id}`,
            '/purchase-orders/summary', '/purchase-orders/reports/purchase', '/purchase-orders/reports/payments', '/purchase-orders/next-number']) {
            // eslint-disable-next-line no-await-in-loop
            const r = await adminA().get(u);
            expect(r.status).toBe(200);
            expect(txt(r)).not.toContain('B-Secret');
            expect(txt(r)).not.toContain(String(rec.bPo._id));
            expect(txt(r)).not.toContain('770');
        }
    });

    test.each([
        ['get', (id) => adminA().get(`/purchase-orders/${id}`)],
        ['put', (id) => adminA().put(`/purchase-orders/${id}`).send({ notes: 'pwned' })],
        ['receive', (id) => adminA().post(`/purchase-orders/${id}/receive`).send({ lines: [{ inventoryItem: String(rec.bItem._id), qty: 5 }] })],
        ['pay', (id) => adminA().post(`/purchase-orders/${id}/payment`).send({ amount: 10, mode: 'cash' })],
        ['cancel', (id) => adminA().patch(`/purchase-orders/${id}/cancel`).send({})],
    ])('A cannot %s a B purchase order', async (_l, call) => {
        const r = await call(rec.bPo._id);
        expect(DENIED).toContain(r.status);
        expect(txt(r)).not.toContain('B-Secret');
        const s = await lean(PurchaseOrder, rec.bPo._id);
        expect(s.status).toBe('ordered');
        expect(s.amountPaid || 0).toBe(0);
        expect(s.receipts).toHaveLength(0);
        expect(s.notes || '').toBe('');
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
    });

    test("PO create referencing B's supplier or B's items is refused", async () => {
        const n = await PurchaseOrder.countDocuments({});
        const r1 = await adminA().post('/purchase-orders').send({
            supplier: String(rec.bSup._id), lines: [{ inventoryItem: String(rec.aItem._id), orderedQty: 1, rate: 1 }],
        });
        expect(DENIED).toContain(r1.status);
        const r2 = await adminA().post('/purchase-orders').send({
            supplier: String(rec.aSup._id), lines: [{ inventoryItem: String(rec.bItem._id), orderedQty: 1, rate: 1 }],
        });
        expect(DENIED).toContain(r2.status);
        expect(txt(r1) + txt(r2)).not.toContain('B-Secret');
        expect(await PurchaseOrder.countDocuments({})).toBe(n);
    });

    test("receiving an A PO with a B stock item line cannot raise B's stock", async () => {
        const c = await adminA().post('/purchase-orders').send({
            supplier: String(rec.aSup._id), lines: [{ inventoryItem: String(rec.aItem._id), orderedQty: 5, rate: 2 }],
            restaurant: String(B.restaurant._id),
        });
        expect(c.status).toBe(201);
        expect(String(c.body.order.restaurant)).toBe(String(A.restaurant._id));
        const r = await adminA().post(`/purchase-orders/${c.body.order._id}/receive`).send({
            lines: [{ inventoryItem: String(rec.bItem._id), qty: 50 }],
        });
        expect(r.status).toBeLessThan(500);
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
        // PO update re-pointing a line at B's item is refused too.
        const u = await adminA().put(`/purchase-orders/${c.body.order._id}`).send({
            lines: [{ inventoryItem: String(rec.bItem._id), orderedQty: 1, rate: 1 }],
        });
        expect(DENIED).toContain(u.status);
    });

    test('branch-pinned A admin does not see B or Main-branch POs', async () => {
        const r = await ctx.api.as(branchAdminA).get('/purchase-orders');
        expect(r.status).toBe(200);
        expect(txt(r)).not.toContain('B-Secret');
        expect((await ctx.api.as(branchAdminA).get(`/purchase-orders/${rec.bPo._id}`)).status).toBe(404);
    });
});

describe('stocktakes', () => {
    test('list excludes B; get / counts / submit / apply on B id denied', async () => {
        const l = await adminA().get('/inventory/stocktakes');
        expect(l.status).toBe(200);
        expect(txt(l)).not.toContain('B-Secret');
        for (const call of [
            () => adminA().get(`/inventory/stocktakes/${rec.bStocktake._id}`),
            () => adminA().put(`/inventory/stocktakes/${rec.bStocktake._id}/counts`).send({ counts: [{ item: String(rec.bItem._id), countedQty: 1 }] }),
            () => adminA().post(`/inventory/stocktakes/${rec.bStocktake._id}/submit`).send({}),
            () => adminA().post(`/inventory/stocktakes/${rec.bStocktake._id}/apply`).send({}),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect(DENIED).toContain(r.status);
            expect(txt(r)).not.toContain('B-Secret');
        }
        const s = await lean(Stocktake, rec.bStocktake._id);
        expect(s.status).toBe('draft');
        expect(s.lines[0].countedQty).toBeNull();
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
    });

    test("new A stocktake contains only A's items even with B restaurant / B branch in the body", async () => {
        const r = await adminA().post('/inventory/stocktakes').send({
            name: 'A-count', restaurant: String(B.restaurant._id), branch: String(B.branch._id), category: { $ne: null },
        });
        expect([201, 400]).toContain(r.status);
        expect(txt(r)).not.toContain('B-Secret');
        const made = await Stocktake.findOne({ name: 'A-count' }).lean();
        if (made) {
            expect(String(made.restaurant)).toBe(String(A.restaurant._id));
            expect(made.lines.map((l) => String(l.item))).not.toContain(String(rec.bItem._id));
        }
    });

    test("stocktake create does not store another tenant's branch id from body.branch", async () => {
        // controllers/stocktakeController.js resolveBranchId(): body.branch only isValidObjectId-checked, never verified against tenant.
        const r = await adminA().post('/inventory/stocktakes').send({ name: 'A-count-branch', branch: String(B.branch._id) });
        const made = await Stocktake.findOne({ name: 'A-count-branch' }).lean();
        const stored = made && made.branch ? String(made.branch) : null;
        expect(stored).not.toBe(String(B.branch._id));
        expect([201, 400, 404]).toContain(r.status);
    });

    test('deduction-health report and retry exclude / refuse B', async () => {
        const r = await adminA().get('/inventory/reports/deduction-health');
        expect(r.status).toBe(200);
        expect(txt(r)).not.toContain('B-Secret');
        const x = await adminA().post('/inventory/reports/deduction-health/retry').send({ orderId: String(oid()), restaurant: String(B.restaurant._id) });
        expect(x.status).toBeLessThan(500);
    });
});

describe('stock transfers', () => {
    test("list / get / valuation never show B's", async () => {
        const l = await adminA().get('/inventory/transfers');
        expect(l.status).toBe(200);
        expect(txt(l)).not.toContain('B-Secret');
        expect(txt(l)).not.toContain('TRF-001');
        const g = await adminA().get(`/inventory/transfers/${rec.bTransfer._id}`);
        expect(DENIED).toContain(g.status);
        const v = await adminA().get('/inventory/reports/valuation');
        expect(v.status).toBe(200);
        expect(txt(v)).not.toContain('B-Secret');
        expect(txt(v)).not.toContain(String(B.restaurant._id));
    });

    test.each(['send', 'receive', 'cancel'])('A cannot %s a B transfer', async (verb) => {
        const r = await adminA().post(`/inventory/transfers/${rec.bTransfer._id}/${verb}`).send({});
        expect(DENIED).toContain(r.status);
        const s = await lean(StockTransfer, rec.bTransfer._id);
        expect(s.status).toBe('draft');
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
    });

    test("transfer create using B branches or B items is refused", async () => {
        const n = await StockTransfer.countDocuments({});
        const mk = (body) => adminA().post('/inventory/transfers').send(body);
        const line = (i) => ({ item: String(i._id), qty: 1 });
        const r1 = await mk({ fromBranch: String(B.branch._id), toBranch: String(B2branch._id), lines: [line(rec.bItem)] });
        const r2 = await mk({ fromBranch: String(A.branch._id), toBranch: String(B2branch._id), lines: [line(rec.aItem)] });
        const r3 = await mk({ fromBranch: String(A.branch._id), toBranch: String(A2branch._id), lines: [line(rec.bItem)] });
        for (const r of [r1, r2, r3]) { expect(DENIED).toContain(r.status); expect(txt(r)).not.toContain('B-Secret'); }
        expect(await StockTransfer.countDocuments({})).toBe(n);
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
    });

    test('branch-pinned A admin cannot create a transfer from Main', async () => {
        const r = await ctx.api.as(branchAdminA).post('/inventory/transfers').send({
            fromBranch: String(A.branch._id), toBranch: String(A2branch._id), lines: [{ item: String(rec.aItem._id), qty: 1 }],
        });
        expect([400, 403]).toContain(r.status);
    });
});

describe('production', () => {
    test('list / summary exclude B', async () => {
        for (const u of ['/production', '/production/summary', `/production?branch=${B.branch._id}`, '/production?branch=all']) {
            // eslint-disable-next-line no-await-in-loop
            const r = await adminA().get(u);
            expect(u.includes(String(B.branch._id)) ? 404 : 200).toBe(r.status);
            expect(txt(r)).not.toContain('B-Secret');
            expect(txt(r)).not.toContain('PRD-001');
        }
        const s = await adminA().get('/production/summary');
        expect(JSON.stringify(s.body)).not.toContain('999');
    });

    test("batch from B's recipe id / B's menu item is refused, B stock unchanged", async () => {
        for (const body of [{ recipeId: String(rec.bRecipe._id), batchQuantity: 1 }, { menuItemId: String(B.items.paneer._id), batchQuantity: 1 }]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await adminA().post('/production').send(body);
            expect(r.status).toBe(404);
        }
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
        expect(await Production.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
    });

    test("A recipe + B output item is refused; B stock not incremented", async () => {
        const r = await adminA().post('/production').send({
            recipeId: String(rec.aRecipe._id), batchQuantity: 1, outputItem: String(rec.bItem._id), outputQty: 25, restaurant: String(B.restaurant._id),
        });
        expect(r.status).toBe(400);
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
    });

    test('legit A batch is stamped to A and touches only A stock', async () => {
        const r = await adminA().post('/production').send({
            recipeId: String(rec.aRecipe._id), batchQuantity: 1, restaurant: String(B.restaurant._id),
        });
        expect(r.status).toBe(201);
        expect(String(r.body.production.restaurant)).toBe(String(A.restaurant._id));
        expect((await lean(Inventory, rec.bItem._id)).currentStock).toBe(100);
        expect((await lean(Inventory, rec.aItem._id)).currentStock).toBe(99);
    });
});

describe('final state', () => {
    test("after every attack above, B's records are unchanged", async () => {
        const after = await snapshot();
        for (const k of Object.keys(before)) expect(after[k]).toEqual(before[k]);
    });
});
