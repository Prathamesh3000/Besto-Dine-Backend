/**
 * Records stored with branch:null belong to the tenant's Main branch.
 *
 * Before: every admin list filtered strictly by the selected branch, so a
 * table / area / inventory item / order created without a branch (legacy
 * data, or a create path that didn't pick one) was invisible in the Main
 * view and to staff pinned to Main — "we can't fetch tables, menu…".
 *
 * Now (utils/tenantScope.branchScopeClause): a Main-branch view includes
 * branch:null records; any other branch's view stays strict, so nothing
 * leaks into a sub-branch.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Branch = require(path.join(BACKEND, 'models/branch'));
const Table = require(path.join(BACKEND, 'models/table'));
const Area = require(path.join(BACKEND, 'models/area'));
const Inventory = require(path.join(BACKEND, 'models/inventory'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Order = require(path.join(BACKEND, 'models/order'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;
let sub;
let subWaiter;

beforeAll(async () => {
    A = await seedTenant({ label: 'nbm' });          // A.branch is the Main branch (slug 'main')
    sub = await Branch.create({ restaurant: A.restaurant._id, name: 'Kothrud', slug: 'kothrud', isActive: true });
    subWaiter = await createUser({
        name: 'Sub waiter', email: `sub.waiter.${A.slug}@staff.test`, role: 'waiter',
        restaurant: A.restaurant._id, branch: sub._id, permissions: defaultPermissionsForRole('waiter'),
    });
    const rid = A.restaurant._id;
    await Area.create({ restaurant: rid, branch: null, name: 'Legacy Floor' });
    await Table.create({ restaurant: rid, branch: null, name: 'Legacy T1', capacity: 4, area: A.area._id, qrToken: `tb-nbm-${Date.now()}` });
    await Inventory.create({ restaurant: rid, branch: null, itemId: 'INV-900', name: 'Legacy Onion', category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5, minStock: 1, costPerUnit: 30 });
    await MenuItem.create({ restaurant: rid, branch: null, category: A.category._id, name: 'Shared Pohe', description: 'x', basePrice: 25, vegType: 'veg', prepStation: 'kitchen' });
    await Order.collection.insertOne({
        restaurant: rid, branch: null, orderId: 'LEGACY-1', type: 'takeaway', status: 'served', paymentStatus: 'Paid',
        items: [], total: 100, createdAt: new Date(), updatedAt: new Date(),
    });
});

const names = (body) => {
    const arr = [body.tables, body.areas, body.items, body.data, body.orders, body.menuItems]
        .find((v) => Array.isArray(v)) || (Array.isArray(body.data?.items) ? body.data.items : []);
    return arr.map((x) => x.name || x.orderId || x.id);
};
const owner = () => ctx.api.as(A.users.admin);
const main = () => String(A.branch._id);
const subId = () => String(sub._id);

describe('owner viewing Main includes branch:null records; a sub-branch does not', () => {
    test.each([
        ['tables', '/tables', 'Legacy T1'],
        ['areas', '/areas', 'Legacy Floor'],
        ['inventory', '/inventory', 'Legacy Onion'],
        ['past orders', '/orders/past', 'LEGACY-1'],
    ])('%s', async (_l, url, name) => {
        const inMain = await owner().get(`${url}?branch=${main()}&branchScope=auto`);
        expect(inMain.status).toBe(200);
        expect(names(inMain.body)).toContain(name);

        const inSub = await owner().get(`${url}?branch=${subId()}&branchScope=auto`);
        expect(inSub.status).toBe(200);
        expect(names(inSub.body)).not.toContain(name);
    });
});

describe('staff pinned to Main see branch:null records; staff pinned elsewhere do not', () => {
    test('waiter at Main sees the legacy table and the shared menu item', async () => {
        const tables = await ctx.api.as(A.users.waiter).get('/tables');
        expect(tables.status).toBe(200);
        expect(names(tables.body)).toContain('Legacy T1');

        const menu = await ctx.api.as(A.users.waiter).get('/menu');
        expect(menu.status).toBe(200);
        expect(names(menu.body)).toContain('Shared Pohe');
    });

    test('waiter at a sub-branch sees neither', async () => {
        const tables = await ctx.api.as(subWaiter).get('/tables');
        expect(tables.status).toBe(200);
        expect(names(tables.body)).not.toContain('Legacy T1');
        const menu = await ctx.api.as(subWaiter).get('/menu');
        expect(names(menu.body)).not.toContain('Shared Pohe');
    });
});

test('explicit tenant-only still returns exactly the branch:null records', async () => {
    const res = await owner().get('/tables?branch=tenant-only');
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Legacy T1']);
});
