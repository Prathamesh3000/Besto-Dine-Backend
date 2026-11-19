/**
 * STRICT tenant campaign / data-model: foreign-reference injection.
 *
 * Tenant A's admin submits writes that carry tenant B's real ObjectIds
 * (area, branch, category, menu item, inventory item, table, ...). Each probe
 * asserts (1) the HTTP answer is a refusal and (2) the database holds no
 * tenant-A document pointing at a tenant-B document. A positive control with
 * the SAME body but A's own id proves the body shape is valid (so a refusal is
 * really about the foreign id).
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const m = (n) => require(path.join(BACKEND, 'models', n));
const Table = m('table');
const Area = m('area');
const MenuItem = m('menuItem');
const Inventory = m('inventory');
const Recipe = m('recipe');
const Combo = m('combo');
const Coupon = m('coupon');
const Hall = m('hall');
const Promotion = m('promotion');
const User = m('user');
const Reservation = m('reservation');

const ctx = useIntegrationApp();
let A;
let B;
let invA;
let invB;
let tableB2;

const REFUSED = (s) => s >= 400 && s < 500;
const rid = () => Math.random().toString(36).slice(2, 8);
const as = (t) => ctx.api.as(t.users.admin);
const DAY = 86400000;

beforeAll(async () => {
    A = await seedTenant({ label: 'ref-a' });
    B = await seedTenant({ label: 'ref-b' });
    invA = await Inventory.create({ restaurant: A.restaurant._id, itemId: 'INV-001', name: 'A flour', unit: 'kg', currentStock: 10, costPerUnit: 1, minStock: 1, category: 'Raw Ingredients' });
    invB = await Inventory.create({ restaurant: B.restaurant._id, itemId: 'INV-001', name: 'B secret flour', unit: 'kg', currentStock: 10, costPerUnit: 1, minStock: 1, category: 'Raw Ingredients' });
    tableB2 = await createTable(B, { name: 'B-second' });
});

describe('tables: area / branch references', () => {
    test('positive control: A can create a table in its own area', async () => {
        const res = await as(A).post('/tables').send({ name: `OK-${rid()}`, capacity: 4, area: String(A.area._id) });
        expect(res.status).toBe(201);
    });

    // controllers/tableController.js:119-170 - `area` from the body is used in
    // the duplicate check and stored on the new Table without checking that the
    // Area belongs to this tenant (only `branch` goes through resolveBranch).
    test('Regression (fixed 2026-11): POST /tables with a tenant-B area is refused and nothing is stored', async () => {
        const name = `FOREIGN-AREA-${rid()}`;
        const res = await as(A).post('/tables').send({ name, capacity: 4, area: String(B.area._id) });
        const stored = await Table.findOne({ name, restaurant: A.restaurant._id }).lean();
        expect(stored).toBeNull();
        expect(REFUSED(res.status)).toBe(true);
    });

    // Same root cause, worse effect: the unique index is {name, area} (no
    // restaurant), so a table A stores in B's area occupies B's name slot. B can
    // then no longer create that name in its own area (denial), and A can probe
    // which table names exist in B's area by the 400 'already exists' answer.
    test('Regression (fixed 2026-11): tenant A cannot occupy a table name inside tenant B area (denial / name oracle)', async () => {
        const name = `SQUAT-${rid()}`;
        await as(A).post('/tables').send({ name, capacity: 2, area: String(B.area._id) });
        const mine = await as(B).post('/tables').send({ name, capacity: 2, area: String(B.area._id) });
        expect(mine.status).toBe(201);
        // oracle: probing an existing B table name through B's area must not differ from a fresh name
        const probeTaken = await as(A).post('/tables').send({ name: `B-Secret-${rid()}`, capacity: 2, area: String(B.area._id) });
        await Table.create({ restaurant: B.restaurant._id, branch: B.branch._id, area: B.area._id, name: 'B-Hidden-Name', capacity: 2, qrToken: `tb-${rid()}${rid()}` });
        const probeHit = await as(A).post('/tables').send({ name: 'B-Hidden-Name', capacity: 2, area: String(B.area._id) });
        expect(REFUSED(probeTaken.status)).toBe(true);
        expect(probeHit.status).toBe(probeTaken.status);
    });

    // controllers/tableController.js:~343 scan lookup runs with skipTenantScope and
    // populates `area` with no tenant filter, so the foreign area accepted by the
    // BUG above is hydrated and returned to an anonymous scanner of A's QR code.
    test('Regression (fixed 2026-11): scanning the QR of an A table that points at a B area does not expose the B area name', async () => {
        const name = `SCANLEAK-${rid()}`;
        await as(A).post('/tables').send({ name, capacity: 2, area: String(B.area._id) });
        const t = await Table.findOne({ name, restaurant: A.restaurant._id }).select('+qrToken').lean();
        if (!t) return; // not stored => nothing to leak (BUG above fixed)
        const res = await ctx.api.raw.get(`/api/v1/tables/scan/${t.qrToken}`);
        expect(JSON.stringify(res.body)).not.toContain(B.area.name);
    });

    test('POST /tables with a tenant-B branch is refused', async () => {
        const res = await as(A).post('/tables').send({
            name: `FB-${rid()}`, capacity: 4, area: String(A.area._id), branch: String(B.branch._id),
        });
        expect(REFUSED(res.status)).toBe(true);
    });

    test('Regression (fixed 2026-11): PUT /tables/:id cannot re-point an A table at a tenant-B area', async () => {
        const t = await Table.create({
            restaurant: A.restaurant._id, branch: A.branch._id, area: A.area._id, name: `UP-${rid()}`, capacity: 2,
            qrToken: `tb-${rid()}${rid()}`,
        });
        const res = await as(A).put(`/tables/${t._id}`).send({ name: t.name, capacity: 2, area: String(B.area._id) });
        const after = await Table.findById(t._id).lean();
        expect(String(after.area)).toBe(String(A.area._id));
        expect(REFUSED(res.status)).toBe(true);
    });
});

describe('areas / halls / coupons / promotions: branch references', () => {
    test('POST /areas with a tenant-B branch is refused', async () => {
        const res = await as(A).post('/areas').send({ name: `Ar-${rid()}`, branch: String(B.branch._id) });
        expect(REFUSED(res.status)).toBe(true);
        expect(await Area.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
    });

    test('POST /halls with a tenant-B branch is refused', async () => {
        const res = await as(A).post('/halls').send({
            name: `H-${rid()}`, type: 'Banquet Hall', minCapacity: 1, maxCapacity: 10, basePrice: 100, branch: String(B.branch._id),
        });
        expect(await Hall.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
        expect(REFUSED(res.status)).toBe(true);
    });

    test('POST /promotions/coupons with a tenant-B branch is refused', async () => {
        const res = await as(A).post('/promotions/coupons').send({
            code: `FB${rid()}`, title: 't', discountType: 'percentage', discountValue: 10,
            startDate: new Date(Date.now() - DAY).toISOString(), endDate: new Date(Date.now() + DAY).toISOString(),
            branch: String(B.branch._id),
        });
        expect(REFUSED(res.status)).toBe(true);
        expect(await Coupon.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
    });

    test('POST /promotions never stores a tenant-B branch on an A promotion', async () => {
        await as(A).post('/promotions').send({
            title: `P-${rid()}`, description: 'x', branch: String(B.branch._id),
            startDate: new Date(Date.now() - DAY).toISOString(), endDate: new Date(Date.now() + DAY).toISOString(),
        });
        expect(await Promotion.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
    });
});

describe('menu items: category / branch references', () => {
    test('positive control: A can create an item in its own category', async () => {
        const res = await as(A).post('/menu').send({ name: `OwnCat-${rid()}`, description: 'd', basePrice: 10, category: String(A.category._id) });
        expect(res.status).toBe(201);
    });

    test('Regression (fixed 2026-11): POST /menu with a tenant-B category is refused and nothing is stored', async () => {
        const name = `FOREIGN-CAT-${rid()}`;
        const res = await as(A).post('/menu').send({ name, description: 'd', basePrice: 10, category: String(B.category._id) });
        const stored = await MenuItem.findOne({ name, restaurant: A.restaurant._id }).lean();
        expect(stored && String(stored.category)).not.toBe(String(B.category._id));
        expect(REFUSED(res.status)).toBe(true);
    });

    test('Regression (fixed 2026-11): PUT /menu/:id cannot move an A item into a tenant-B category', async () => {
        const res = await as(A).put(`/menu/${A.items.naan._id}`).send({ name: 'Garlic Naan', description: 'd', basePrice: 40, category: String(B.category._id) });
        const after = await MenuItem.findById(A.items.naan._id).lean();
        expect(String(after.category)).toBe(String(A.category._id));
        expect(REFUSED(res.status)).toBe(true);
    });

    test('POST /menu with a tenant-B branch is refused', async () => {
        const res = await as(A).post('/menu').send({ name: `FBr-${rid()}`, description: 'd', basePrice: 10, category: String(A.category._id), branch: String(B.branch._id) });
        expect(REFUSED(res.status)).toBe(true);
    });
});

describe('combos: menu item / branch references', () => {
    const body = (extra) => ({ name: `Combo-${rid()}`, description: 'd', price: 100, originalPrice: 120, categories: [], ...extra });

    test('a combo cannot embed tenant B menu item (name/price copy)', async () => {
        const res = await as(A).post('/combos').send(body({ categories: [{ name: 'Mains', items: [{ menuItemId: String(B.items.paneer._id) }] }] }));
        expect(REFUSED(res.status)).toBe(true);
        expect(await Combo.countDocuments({ restaurant: A.restaurant._id, 'categories.items.menuItemId': B.items.paneer._id })).toBe(0);
    });

    test('positive control: the same combo with A own item is accepted', async () => {
        const res = await as(A).post('/combos').send(body({ categories: [{ name: 'Mains', items: [{ menuItemId: String(A.items.paneer._id) }] }] }));
        expect(res.status).toBe(201);
    });

    test('a combo with a tenant-B branch is refused', async () => {
        const res = await as(A).post('/combos').send(body({ branch: String(B.branch._id) }));
        expect(REFUSED(res.status)).toBe(true);
    });
});

describe('recipes: menu item / inventory / branch references', () => {
    const rec = (menuItemId, inventoryItem, extra = {}) => ({
        menuItemId: String(menuItemId), ingredients: [{ inventoryItem: String(inventoryItem), quantity: 1, unit: 'kg' }], ...extra,
    });

    test('positive control: A recipe from A menu item + A inventory', async () => {
        const res = await as(A).post('/inventory/recipes').send(rec(A.items.paneer._id, invA._id));
        expect(res.status).toBe(200);
    });

    test('a recipe for B menu item is refused', async () => {
        const res = await as(A).post('/inventory/recipes').send(rec(B.items.paneer._id, invA._id));
        expect(REFUSED(res.status)).toBe(true);
        expect(await Recipe.countDocuments({ menuItem: B.items.paneer._id, restaurant: A.restaurant._id })).toBe(0);
    });

    test('a recipe using B inventory item is refused and stores no foreign ingredient', async () => {
        const res = await as(A).post('/inventory/recipes').send(rec(A.items.naan._id, invB._id));
        expect(REFUSED(res.status)).toBe(true);
        expect(await Recipe.countDocuments({ 'ingredients.inventoryItem': invB._id })).toBe(0);
    });

    // controllers/inventory/recipes.js ~L149 - `ownerBranch = pinned || req.body.branch`
    // is stored as-is: the branch is never checked against the tenant.
    test('Regression (fixed 2026-11): a recipe saved with a tenant-B branch id is refused', async () => {
        const res = await as(A).post('/inventory/recipes').send(rec(A.items.thali._id, invA._id, { branch: String(B.branch._id) }));
        expect(await Recipe.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
        expect(REFUSED(res.status)).toBe(true);
    });
});

describe('staff / reservations / table merge: foreign references', () => {
    test('adding staff with a tenant-B branch or tenant-B tables is refused', async () => {
        const r1 = await as(A).post('/staff').send({ name: 'Foreign', email: `f1.${rid()}@x.test`, role: 'waiter', branch: String(B.branch._id) });
        const r2 = await as(A).post('/staff').send({ name: 'Foreign2', email: `f2.${rid()}@x.test`, role: 'waiter', assignedTables: [String(tableB2._id)] });
        expect(REFUSED(r1.status)).toBe(true);
        expect(REFUSED(r2.status)).toBe(true);
        expect(await User.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
    });

    test('updating A staff to a tenant-B branch is refused', async () => {
        const res = await as(A).put(`/staff/${A.users.waiter._id}`).send({ branch: String(B.branch._id) });
        const after = await User.findById(A.users.waiter._id).lean();
        expect(String(after.branch)).toBe(String(A.branch._id));
        expect(REFUSED(res.status)).toBe(true);
    });

    test('staff reservation on B table is refused', async () => {
        const res = await ctx.api.as(A.users.admin).post('/reservations').send({
            guestName: 'X', contactNo: '9000000001', guestCount: 2, date: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10),
            time: '20:00', table: String(B.tables.main._id), tableId: String(B.tables.main._id), selectedTable: String(B.tables.main._id),
        });
        expect(REFUSED(res.status)).toBe(true);
        expect(await Reservation.countDocuments({ restaurant: A.restaurant._id, table: B.tables.main._id })).toBe(0);
    });

    test('merging an A table with a B table is refused and B stays untouched', async () => {
        const res = await as(A).post('/tables/merge').send({ tableIds: [String(A.tables.main._id), String(B.tables.main._id)] });
        expect(REFUSED(res.status)).toBe(true);
        const b = await Table.findById(B.tables.main._id).lean();
        expect(b.status).toBe('free');
        expect(b.mergedWith || []).toHaveLength(0);
        const a = await Table.findById(A.tables.main._id).lean();
        expect((a.mergedWith || []).map(String)).not.toContain(String(B.tables.main._id));
    });
});

describe('populate layer: a stored cross-tenant ref', () => {
    let rawTableId;
    beforeAll(async () => {
        const r = await Table.collection.insertOne({
            restaurant: A.restaurant._id, branch: A.branch._id, area: B.area._id, name: `RAW-${rid()}`, capacity: 2,
            qrToken: `tb-${rid()}${rid()}`, isDeleted: false, status: 'free', createdAt: new Date(), updatedAt: new Date(),
        });
        rawTableId = r.insertedId;
    });

    test('populate inside runAsTenant(A) does not hydrate the B area', async () => {
        const { runAsTenant } = require(path.join(BACKEND, 'utils/tenantSafe'));
        const got = await runAsTenant(A.restaurant._id, async () => Table.findById(rawTableId).populate('area', 'name').lean());
        expect(got.area).toBeFalsy();
    });

    // Residual risk of accepting a foreign ref at write time (BUG tests above):
    // any reader with NO tenant context (job, socket, script) hydrates B's data.
    test('BUG: populate outside a tenant context hydrates the B area name into an A table', async () => {
        const got = await Table.findById(rawTableId).populate('area', 'name').lean();
        expect(got.area).toBeFalsy();
    });
});
