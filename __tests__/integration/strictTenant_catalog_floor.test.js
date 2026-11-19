/**
 * STRICT tenant isolation - catalogue + floor:
 * menu, categories, combos, areas, tables (merge / unmerge / QR re-issue /
 * assign / claim / CSV), branches (sub-admin, sync menu / areas).
 *
 * Tenant B rows are written straight to the DB. Tenant A's owner, A's
 * waiter / chef / captain / customer and A's branch-pinned admin try B's ids
 * in params / body / query / headers. Every denial is verified on the HTTP
 * status, on the body (no B marker) and on the B document re-read from DB.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const model = (n) => require(path.join(BACKEND, 'models', n));
const Branch = model('branch');
const Area = model('area');
const Category = model('category');
const MenuItem = model('menuItem');
const Combo = model('combo');
const Table = model('table');
const User = model('user');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A; let B; let A2; let B2; let bTable2; let bCombo; let bBranchAdmin; let branchAdminA;
const DENIED = [400, 403, 404];
const adminA = () => ctx.api.as(A.users.admin);
const adminB = () => ctx.api.as(B.users.admin);
const txt = (r) => JSON.stringify(r.body || {}) + String(r.text || '');
const lean = (M, id) => M.findById(id).lean();
const sel = (M, id, f) => M.findById(id).select(f).lean();

beforeAll(async () => {
    A = await seedTenant({ label: 'cat-a' });
    B = await seedTenant({ label: 'cat-b' });
    A2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A-Second', slug: 'a-second', isActive: true });
    B2 = await Branch.create({ restaurant: B.restaurant._id, name: 'B-Secret-Branch', slug: 'b-secret', isActive: true });
    bTable2 = await createTable(B, { name: 'B-Secret-T2' });
    bCombo = await Combo.create({ restaurant: B.restaurant._id, branch: B.branch._id, name: 'B-Secret-Combo', description: 'b only', price: 321 });
    branchAdminA = await createUser({
        name: 'Branch Admin A', email: `ba.${A.slug}@staff.test`, role: 'admin', restaurant: A.restaurant._id,
        branch: A2._id, isTenantOwner: false, permissions: defaultPermissionsForRole('admin'),
    });
    bBranchAdmin = await createUser({
        name: 'B-Secret-SubAdmin', email: `bsub.${B.slug}@staff.test`, role: 'admin', restaurant: B.restaurant._id,
        branch: B2._id, isTenantOwner: false, permissions: defaultPermissionsForRole('admin'),
    });
});

const bSnap = async () => ({
    cat: await lean(Category, B.category._id),
    items: await MenuItem.find({ restaurant: B.restaurant._id }).sort('_id').lean(),
    area: await lean(Area, B.area._id),
    t1: await sel(Table, B.tables.main._id, '+qrToken'),
    t2: await sel(Table, bTable2._id, '+qrToken'),
    ts: await sel(Table, B.tables.small._id, '+qrToken'),
    combo: await lean(Combo, bCombo._id),
    b1: await lean(Branch, B.branch._id),
    b2: await lean(Branch, B2._id),
    users: await User.find({ restaurant: B.restaurant._id }).sort('_id').select('-token').lean(),
});
let before;
beforeAll(async () => { before = await bSnap(); });

// The category BUG tests below leave A items pointing at B's category; clean so other tests stay independent.
const cleanCategoryPollution = async () => {
    await MenuItem.deleteMany({ restaurant: A.restaurant._id, category: B.category._id });
    await MenuItem.updateOne({ _id: A.items.naan._id }, { $set: { category: A.category._id } });
};

describe('menu items', () => {
    afterEach(cleanCategoryPollution);

    test("A (guest + owner) never sees B's menu in list / search / trending / by-id / customizations", async () => {
        const bItem = B.items.paneer;
        for (const caller of [ctx.api.guest(A), adminA()]) {
            for (const u of ['/menu', '/menu?search=Paneer', '/menu/search?q=Paneer', '/menu/trending', `/menu?category=${B.category._id}`,
                `/menu?branch=${B.branch._id}`, '/menu?limit=500']) {
                // eslint-disable-next-line no-await-in-loop
                const r = await caller.get(u);
                expect([200, 400, 404]).toContain(r.status);
                expect(txt(r)).not.toContain(String(bItem._id));
                expect(txt(r)).not.toContain(String(B.category._id));
            }
            const one = await caller.get(`/menu/${bItem._id}`);
            expect(one.status).toBe(404);
            const c = await caller.get(`/menu/${bItem._id}/customizations`);
            expect([403, 404]).toContain(c.status);
            expect(txt(c)).not.toContain(String(bItem._id));
        }
        // A's own menu list returns only A's three items.
        const mine = await adminA().get('/menu');
        expect(mine.status).toBe(200);
        const list = mine.body.data || mine.body.items || [];
        expect(list.length).toBe(3);
    });

    test.each([
        ['put', (id) => adminA().put(`/menu/${id}`).send({ name: 'pwned', basePrice: 1, category: String(A.category._id), description: 'x', vegType: 'veg' })],
        ['delete', (id) => adminA().delete(`/menu/${id}`)],
        ['get branch-prices', (id) => adminA().get(`/menu/${id}/branch-prices`)],
        ['set branch-prices', (id) => adminA().put(`/menu/${id}/branch-prices`).send({ branchPrices: [{ branch: String(A2._id), basePrice: 1 }] })],
    ])('A cannot %s a B menu item', async (_l, call) => {
        const r = await call(B.items.paneer._id);
        expect(DENIED).toContain(r.status);
        expect(txt(r)).not.toContain('Paneer');
        const after = (await bSnap()).items;
        expect(after).toEqual(before.items);
    });

    test("menu create: category from B is not accepted, B branch refused, restaurant ignored", async () => {
        const r = await adminA().post('/menu').send({
            name: 'A-X-Item', category: String(B.category._id), description: 'd', basePrice: 10, vegType: 'veg', prepStation: 'kitchen',
            restaurant: String(B.restaurant._id),
        });
        const made = await MenuItem.findOne({ name: 'A-X-Item' }).lean();
        if (made) {
            expect(String(made.restaurant)).toBe(String(A.restaurant._id));
        }
        expect([201, 400, 404]).toContain(r.status);
        const r2 = await adminA().post('/menu').send({
            name: 'A-Y-Item', category: String(A.category._id), branch: String(B2._id), description: 'd', basePrice: 10, vegType: 'veg',
        });
        expect(r2.status).toBe(400);
        expect(await MenuItem.countDocuments({ name: 'A-Y-Item' })).toBe(0);
    });

    test("Regression (fixed 2026-11): menu create stores another tenant's category id on A's item", async () => {
        // controllers/menuController.js createMenuItem: pickAllowed(req.body, MENU_ITEM_FIELDS) copies `category`
        // without checking it belongs to the tenant (only `branch` goes through resolveBranch).
        const r = await adminA().post('/menu').send({
            name: 'A-Z-Item', category: String(B.category._id), description: 'd', basePrice: 10, vegType: 'veg', prepStation: 'kitchen',
        });
        const made = await MenuItem.findOne({ name: 'A-Z-Item' }).lean();
        expect(made ? String(made.category) : null).not.toBe(String(B.category._id));
        expect([201, 400, 404]).toContain(r.status);
    });

    test("Regression (fixed 2026-11): menu update re-points A's item at another tenant's category", async () => {
        // controllers/menuController.js updateMenuItem: same allowlist copy, no category ownership check.
        const r = await adminA().put(`/menu/${A.items.naan._id}`).send({
            name: 'Garlic Naan', category: String(B.category._id), description: 'd', basePrice: 40, vegType: 'veg',
        });
        const now = await lean(MenuItem, A.items.naan._id);
        expect(String(now.category)).not.toBe(String(B.category._id));
        expect([200, 400, 404]).toContain(r.status);
    });

    test('branch-prices set with a B branch id writes nothing for it', async () => {
        const r = await adminA().put(`/menu/${A.items.paneer._id}/branch-prices`).send({
            branchPrices: [{ branch: String(B2._id), basePrice: 1 }, { branch: String(A2._id), basePrice: 150 }],
        });
        expect(r.status).toBe(200);
        const now = await lean(MenuItem, A.items.paneer._id);
        expect(now.branchPrices.map((x) => String(x.branch))).toEqual([String(A2._id)]);
        expect(txt(r)).not.toContain('B-Secret');
    });

    test('menu CSV import: B category name / restaurant column cannot reach B', async () => {
        const csv = ['name,description,category,basePrice,vegType,restaurant,branch',
            `Imp-1,d,${B.category.name},10,veg,${B.restaurant._id},${B2._id}`,
            `Imp-2,d,${A.category.name},10,veg,${B.restaurant._id},`].join('\n');
        const r = await adminA().post('/menu/import').attach('file', Buffer.from(csv), { filename: 'm.csv', contentType: 'text/csv' });
        expect(r.status).toBeLessThan(500);
        expect(await MenuItem.countDocuments({ restaurant: B.restaurant._id })).toBe(3);
        const made = await MenuItem.find({ name: /^Imp-/ }).lean();
        for (const m of made) {
            expect(String(m.restaurant)).toBe(String(A.restaurant._id));
            expect(String(m.category)).not.toBe(String(B.category._id));
            expect(m.branch ? String(m.branch) : null).not.toBe(String(B2._id));
        }
    });

    test('menu clear (owner) leaves B menu intact', async () => {
        const mk = await MenuItem.create({ restaurant: A.restaurant._id, category: A.category._id, name: 'A-Temp', description: 'd', basePrice: 1, vegType: 'veg', prepStation: 'kitchen' });
        const r = await adminA().post('/menu/clear').send({ restaurant: String(B.restaurant._id), confirm: true });
        expect(r.status).toBeLessThan(500);
        expect(await MenuItem.countDocuments({ restaurant: B.restaurant._id })).toBe(3);
        expect(await Category.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
        await MenuItem.deleteOne({ _id: mk._id });
    });

    test('mass-assigned restaurant via query/header does not switch tenant for A staff', async () => {
        const r = await adminA().get(`/menu?restaurant=${B.restaurant._id}&restaurantId=${B.restaurant._id}`).set('X-Restaurant-Slug', B.slug);
        expect(txt(r)).not.toContain(String(B.items.paneer._id));
    });

    test('positive control: B guest sees B item', async () => {
        const r = await ctx.api.guest(B).get(`/menu/${B.items.paneer._id}`);
        expect(r.status).toBe(200);
    });
});

describe('categories', () => {
    test('list/get exclude B; mutations by id denied', async () => {
        const l = await adminA().get('/categories');
        expect(txt(l)).not.toContain(String(B.category._id));
        for (const call of [
            () => adminA().put(`/categories/${B.category._id}`).send({ name: 'pwned' }),
            () => adminA().delete(`/categories/${B.category._id}`),
            () => adminA().put(`/categories/${B.category._id}`).send({ status: 'inactive' }),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect(DENIED).toContain(r.status);
        }
        expect(await lean(Category, B.category._id)).toEqual(before.cat);
    });

    test('reorder cannot change displayOrder of B categories', async () => {
        const r = await adminA().put('/categories/reorder').send({ categories: [{ _id: String(B.category._id), id: String(B.category._id), displayOrder: 99 }] });
        expect(r.status).toBeLessThan(500);
        expect(await lean(Category, B.category._id)).toEqual(before.cat);
    });

    test('create with B branch is refused; restaurant body ignored', async () => {
        const r = await adminA().post('/categories').send({ name: 'A-Cat', branch: String(B2._id), restaurant: String(B.restaurant._id) });
        expect(r.status).toBe(400);
        const r2 = await adminA().post('/categories').send({ name: 'A-Cat2', restaurant: String(B.restaurant._id) });
        expect([201, 200]).toContain(r2.status);
        const made = await Category.findOne({ name: 'A-Cat2' }).lean();
        expect(String(made.restaurant)).toBe(String(A.restaurant._id));
        expect(await Category.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
    });

    test('update re-pointing A category to B branch is refused', async () => {
        const r = await adminA().put(`/categories/${A.category._id}`).send({ name: A.category.name, branch: String(B2._id) });
        expect(r.status).toBe(400);
        const now = await lean(Category, A.category._id);
        expect(now.branch ? String(now.branch) : null).not.toBe(String(B2._id));
    });

    test('malformed id is 400 (validator)', async () => {
        expect((await adminA().get('/categories/not-an-id')).status).toBe(400);
        expect((await adminA().get(`/categories/${encodeURIComponent('{"$ne":null}')}`)).status).toBe(400);
    });
});

describe('combos', () => {
    test("list/get exclude B's combo; update / delete by id denied", async () => {
        const l = await adminA().get('/combos');
        expect(txt(l)).not.toContain('B-Secret');
        for (const call of [
            () => ctx.api.guest(A).get(`/combos/${bCombo._id}`),
            () => adminA().put(`/combos/${bCombo._id}`).send({ name: 'pwned', price: 1 }),
            () => adminA().delete(`/combos/${bCombo._id}`),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect(DENIED).toContain(r.status);
            expect(txt(r)).not.toContain('B-Secret');
        }
        expect(await lean(Combo, bCombo._id)).toEqual(before.combo);
    });

    test("combo create/update referencing B menu items or B branch is refused", async () => {
        const bad = { menuItemId: String(B.items.paneer._id) };
        for (const body of [
            { name: 'A-Combo', description: 'd', price: 10, categories: [{ name: 'c', items: [bad] }] },
            { name: 'A-Combo', description: 'd', price: 10, branch: String(B2._id) },
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await adminA().post('/combos').send(body);
            expect(r.status).toBe(400);
        }
        expect(await Combo.countDocuments({ name: 'A-Combo' })).toBe(0);
        const ok = await adminA().post('/combos').send({ name: 'A-Combo-ok', description: 'ok', price: 10, restaurant: String(B.restaurant._id) });
        expect(ok.status).toBe(201);
        const id = ok.body.data._id;
        expect(String((await lean(Combo, id)).restaurant)).toBe(String(A.restaurant._id));
        const u = await adminA().put(`/combos/${id}`).send({ categories: [{ name: 'c', items: [bad] }] });
        expect(u.status).toBe(400);
        const u2 = await adminA().put(`/combos/${id}`).send({ branch: String(B2._id) });
        expect(u2.status).toBe(400);
        expect(txt(u) + txt(u2)).not.toContain('Paneer');
    });

    test('combo CSV import cannot attach B menu items / restaurant', async () => {
        const csv = ['name,price,restaurant,branch', `Imp-Combo,10,${B.restaurant._id},${B2._id}`].join('\n');
        const r = await adminA().post('/combos/import').attach('file', Buffer.from(csv), { filename: 'c.csv', contentType: 'text/csv' });
        expect(r.status).toBeLessThan(500);
        expect(await Combo.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
        const made = await Combo.find({ name: 'Imp-Combo' }).lean();
        for (const m of made) {
            expect(String(m.restaurant)).toBe(String(A.restaurant._id));
            expect(m.branch ? String(m.branch) : null).not.toBe(String(B2._id));
        }
    });
});

describe('areas', () => {
    test('list excludes B (guest + admin + ?branch override)', async () => {
        for (const caller of [ctx.api.guest(A), adminA()]) {
            for (const u of ['/areas', `/areas?branch=${B.branch._id}`, '/areas?branch=all']) {
                // eslint-disable-next-line no-await-in-loop
                const r = await caller.get(u);
                expect(txt(r)).not.toContain(String(B.area._id));
                expect(txt(r)).not.toContain(B.area.name);
            }
        }
    });

    test('update / delete B area denied, B area + tables untouched', async () => {
        for (const call of [
            () => adminA().put(`/areas/${B.area._id}`).send({ name: 'pwned', isActive: false }),
            () => adminA().delete(`/areas/${B.area._id}`),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect(DENIED).toContain(r.status);
        }
        const now = await bSnap();
        expect(now.area).toEqual(before.area);
        expect(now.t1).toEqual(before.t1);
    });

    test('create with B branch refused; restaurant body ignored', async () => {
        const r = await adminA().post('/areas').send({ name: 'A-Roof', branch: String(B2._id) });
        expect(r.status).toBe(400);
        const ok = await adminA().post('/areas').send({ name: 'A-Roof2', restaurant: String(B.restaurant._id) });
        expect(ok.status).toBeLessThan(300);
        expect(String((await Area.findOne({ name: 'A-Roof2' }).lean()).restaurant)).toBe(String(A.restaurant._id));
        expect(await Area.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
    });

    test('malformed id on update/delete does not 500-leak', async () => {
        const r = await adminA().delete(`/areas/${encodeURIComponent('{"$ne":null}')}`);
        expect(DENIED).toContain(r.status);
        expect(await Area.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
    });
});

describe('tables', () => {
    test("A staff list excludes B tables; scan of a B QR token with A's slug is refused", async () => {
        for (const u of [adminA(), ctx.api.as(A.users.waiter)]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await u.get('/tables');
            expect(r.status).toBe(200);
            expect(txt(r)).not.toContain(String(B.tables.main._id));
            expect(txt(r)).not.toContain('B-Secret-T2');
            // eslint-disable-next-line no-await-in-loop
            const bk = await u.get('/tables/bookable');
            expect(txt(bk)).not.toContain(String(B.tables.main._id));
        }
        // The QR token IS the capability (global, random): guessing / using a table _id as a token must fail.
        for (const tok of [String(B.tables.main._id), 'tb-000000000000', 'tb-%7B%22%24ne%22%3Anull%7D']) {
            // eslint-disable-next-line no-await-in-loop
            const bad = await ctx.api.raw.get(`/api/v1/tables/scan/${tok}`).set('X-Restaurant-Slug', A.slug);
            expect(DENIED).toContain(bad.status);
            expect(txt(bad)).not.toContain(B.tables.main.name);
        }
        const avail = await ctx.api.guest(A).get(`/tables/${B.tables.main._id}/availability`);
        // Answers exactly like a non-existent id: 200 available:false, nothing about B's table.
        expect(avail.body.available).toBe(false);
    });

    test.each([
        ['put', (id) => adminA().put(`/tables/${id}`).send({ name: 'pwned', status: 'disabled' })],
        ['delete', (id) => adminA().delete(`/tables/${id}`)],
        ['qr re-issue', (id) => adminA().post(`/tables/${id}/qr-token`).send({})],
        ['free', (id) => adminA().post(`/tables/${id}/free`).send({})],
        ['assign', (id) => adminA().put(`/tables/${id}/assign`).send({ waiterId: String(A.users.waiter._id), waiter: String(A.users.waiter._id) })],
        ['assignments', (id) => adminA().get(`/tables/${id}/assignments`)],
        ['claim (A customer)', (id) => ctx.api.as(A.cust || A.users.waiter, A).post(`/tables/${id}/claim`).send({})],
    ])('A cannot %s a B table', async (_l, call) => {
        const r = await call(B.tables.main._id);
        expect(DENIED).toContain(r.status);
        expect(txt(r)).not.toContain(B.tables.main.qrToken);
        expect(txt(r)).not.toContain(B.tables.main.name);
        const now = await bSnap();
        expect(now.t1).toEqual(before.t1);
    });

    test('A free-all does not free B tables', async () => {
        await Table.updateOne({ _id: B.tables.main._id }, { $set: { status: 'occupied' } });
        const snap = await sel(Table, B.tables.main._id, '+qrToken');
        const r = await adminA().post('/tables/free-all').send({ restaurant: String(B.restaurant._id) });
        expect(r.status).toBeLessThan(500);
        expect((await lean(Table, B.tables.main._id)).status).toBe('occupied');
        await Table.updateOne({ _id: B.tables.main._id }, { $set: { status: 'free' } });
        expect(snap).toBeTruthy();
        before = await bSnap(); // the test's own direct writes bumped updatedAt
    });

    test('merge across tenants: A + B ids, B+B ids, repeated ids all refused; B tables stay free', async () => {
        const mk = (ids) => adminA().post('/tables/merge').send({ tableIds: ids.map(String) });
        for (const ids of [
            [A.tables.main._id, B.tables.main._id],
            [B.tables.main._id, bTable2._id],
            [A.tables.main._id, A.tables.main._id, B.tables.main._id],
            [B.tables.main._id, A.tables.small._id],
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await mk(ids);
            expect(DENIED).toContain(r.status);
            expect(txt(r)).not.toContain(B.tables.main.qrToken);
        }
        const now = await bSnap();
        expect(now.t1).toEqual(before.t1);
        expect(now.t2).toEqual(before.t2);
        const a = await lean(Table, A.tables.main._id);
        expect(a.status).not.toBe('merged');
        expect(a.mergedWith || []).toHaveLength(0);
    });

    test('unmerge a B merged group is refused and B group stays merged', async () => {
        await Table.updateOne({ _id: B.tables.main._id }, { $set: { status: 'merged', mergedWith: [bTable2._id] } });
        await Table.updateOne({ _id: bTable2._id }, { $set: { status: 'merged', mergedWith: [B.tables.main._id] } });
        const r = await adminA().post('/tables/unmerge').send({ tableId: String(B.tables.main._id) });
        expect(DENIED).toContain(r.status);
        expect((await lean(Table, B.tables.main._id)).status).toBe('merged');
        expect((await lean(Table, bTable2._id)).status).toBe('merged');
        // B can unmerge its own group (positive control) -> state restored for later snapshots
        const ok = await adminB().post('/tables/unmerge').send({ tableId: String(B.tables.main._id) });
        expect(ok.status).toBe(200);
        before = await bSnap();
    });

    test('A table merge group never gets B ids in mergedWith (object injection in ids)', async () => {
        const r = await adminA().post('/tables/merge').send({ tableIds: [{ $ne: null }, String(A.tables.main._id)] });
        expect(DENIED).toContain(r.status);
        const r2 = await adminA().post('/tables/unmerge').send({ tableId: { $ne: null } });
        expect(DENIED).toContain(r2.status);
        const r3 = await adminA().post('/tables/unmerge').send({ tableId: [String(B.tables.main._id)] });
        expect(DENIED).toContain(r3.status);
    });

    test("Regression (fixed 2026-11): table create stores another tenant's area id", async () => {
        // controllers/tableController.js createTable: `area` only passes requiredObjectId (format) - never verified
        // against Area of this tenant; table.save() persists B's area id on A's table.
        const r = await adminA().post('/tables').send({ name: 'A-XArea', capacity: 2, area: String(B.area._id) });
        const made = await Table.findOne({ name: 'A-XArea' }).lean();
        expect(made ? String(made.area) : null).not.toBe(String(B.area._id));
        expect(DENIED).toContain(r.status);
    });

    test("Regression (fixed 2026-11): table update re-points A's table at another tenant's area", async () => {
        // controllers/tableController.js updateTable: `area` in TABLE_UPDATE_FIELDS is assigned unchecked.
        const r = await adminA().put(`/tables/${A.tables.small._id}`).send({ area: String(B.area._id) });
        const now = await lean(Table, A.tables.small._id);
        expect(String(now.area)).not.toBe(String(B.area._id));
        expect(DENIED).toContain(r.status);
    });

    test('table create with B branch refused; mass-assigned restaurant ignored; OK path stamps A', async () => {
        const r = await adminA().post('/tables').send({ name: 'A-XB', capacity: 2, area: String(A.area._id), branch: String(B2._id) });
        expect(r.status).toBe(400);
        const ok = await adminA().post('/tables').send({ name: 'A-OK', capacity: 2, area: String(A.area._id), restaurant: String(B.restaurant._id) });
        expect([201, 400]).toContain(ok.status);
        const made = await Table.findOne({ name: 'A-OK' }).lean();
        if (made) expect(String(made.restaurant)).toBe(String(A.restaurant._id));
        const u = await adminA().put(`/tables/${A.tables.main._id}`).send({ branch: String(B2._id) });
        expect(u.status).toBe(400);
        const u2 = await adminA().put(`/tables/${A.tables.main._id}`).send({ restaurant: String(B.restaurant._id), qrToken: 'tb-hijack' });
        expect(u2.status).toBe(400);
    });

    test('tables CSV import: B area name / restaurant column create nothing in B', async () => {
        const csv = ['area,name,capacity,restaurant,branch', `${B.area.name},CSV-1,2,${B.restaurant._id},${B2._id}`,
            `${A.area.name},CSV-2,2,${B.restaurant._id},`].join('\n');
        const r = await adminA().post('/tables/import').attach('file', Buffer.from(csv), { filename: 't.csv', contentType: 'text/csv' });
        expect(r.status).toBeLessThan(500);
        expect(await Table.countDocuments({ restaurant: B.restaurant._id })).toBe(3);
        for (const t of await Table.find({ name: /^CSV-/ }).lean()) {
            expect(String(t.restaurant)).toBe(String(A.restaurant._id));
            expect(String(t.area)).not.toBe(String(B.area._id));
        }
    });

    test('branch-pinned A admin: cannot touch Main-branch tables / B tables', async () => {
        const api = ctx.api.as(branchAdminA);
        const l = await api.get('/tables');
        expect(txt(l)).not.toContain(String(B.tables.main._id));
        expect(txt(l)).not.toContain(String(A.tables.main._id));
        for (const call of [
            () => api.put(`/tables/${A.tables.main._id}`).send({ name: 'pwned' }),
            () => api.post(`/tables/${A.tables.main._id}/free`).send({}),
            () => api.put(`/tables/${B.tables.main._id}`).send({ name: 'pwned' }),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect(DENIED).toContain(r.status);
        }
        const m = await api.post('/tables/merge').send({ tableIds: [String(A.tables.main._id), String(A.tables.small._id)] });
        expect(DENIED).toContain(m.status);
    });

    test('waiter / chef roles cannot qr re-issue or delete even own tables; B tables unaffected', async () => {
        for (const u of [A.users.waiter, A.users.chef]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await ctx.api.as(u).post(`/tables/${B.tables.main._id}/qr-token`).send({});
            expect(DENIED).toContain(r.status);
            // eslint-disable-next-line no-await-in-loop
            const d = await ctx.api.as(u).delete(`/tables/${B.tables.main._id}`);
            expect(DENIED).toContain(d.status);
        }
        expect((await bSnap()).t1).toEqual(before.t1);
    });

    test('positive control: B owner re-issues its own QR', async () => {
        const r = await adminB().post(`/tables/${B.tables.small._id}/qr-token`).send({});
        expect(r.status).toBe(200);
        before = await bSnap();
    });
});

describe('branches', () => {
    test('A owner list/get never shows B branches (incl. ?tenant overrides)', async () => {
        for (const u of ['/branches', `/branches?restaurant=${B.restaurant._id}`, '/branches?includeInactive=true']) {
            // eslint-disable-next-line no-await-in-loop
            const r = await adminA().get(u);
            expect(r.status).toBe(200);
            expect(txt(r)).not.toContain('B-Secret-Branch');
            expect(txt(r)).not.toContain(String(B.branch._id));
        }
    });

    test.each([
        ['get', (id) => adminA().get(`/branches/${id}`)],
        ['disable-check', (id) => adminA().get(`/branches/${id}/disable-check`)],
        ['put', (id) => adminA().put(`/branches/${id}`).send({ name: 'pwned' })],
        ['disable', (id) => adminA().delete(`/branches/${id}`)],
        ['hard-delete', (id) => adminA().delete(`/branches/${id}/permanent`)],
        ['reactivate', (id) => adminA().patch(`/branches/${id}/reactivate`).send({})],
        ['sync-menu', (id) => adminA().post(`/branches/${id}/sync-menu`).send({ resetPrices: true })],
        ['sync-areas', (id) => adminA().post(`/branches/${id}/sync-areas`).send({})],
        ['subadmin create', (id) => adminA().post(`/branches/${id}/subadmin`).send({ name: 'X', email: `x.${Date.now()}@staff.test` })],
        ['subadmin patch', (id) => adminA().patch(`/branches/${id}/subadmin`).send({ name: 'pwned' })],
        ['subadmin reset pwd', (id) => adminA().post(`/branches/${id}/subadmin/reset-password`).send({})],
    ])('A owner cannot %s on a B branch (with a B sub-admin present)', async (_l, call) => {
        const r = await call(B2._id);
        if (_l === 'disable-check') {
            expect(r.status).toBe(200);
            expect(txt(r)).not.toContain('B-Secret');
            expect(r.body.blockers).toEqual({});
        } else {
            expect(DENIED).toContain(r.status);
            expect(txt(r)).not.toContain('B-Secret');
        }
        const now = await bSnap();
        expect(now.b2).toEqual(before.b2);
        expect(now.users).toEqual(before.users);
        expect(await MenuItem.countDocuments({ restaurant: B.restaurant._id })).toBe(3);
    });

    test('sync-menu-all / sync-areas-all from A change nothing in B', async () => {
        const r1 = await adminA().post('/branches/sync-menu-all').send({ resetPrices: true, restaurant: String(B.restaurant._id) });
        const r2 = await adminA().post('/branches/sync-areas-all').send({ restaurant: String(B.restaurant._id) });
        expect(r1.status).toBeLessThan(500);
        expect(r2.status).toBeLessThan(500);
        const now = await bSnap();
        expect(now.items).toEqual(before.items);
        expect(now.area).toEqual(before.area);
        expect(await Area.countDocuments({ restaurant: B.restaurant._id })).toBe(1);
    });

    test('create branch: mass-assigned restaurant lands in A; slug clash with B is allowed per tenant', async () => {
        const r = await adminA().post('/branches').send({
            name: 'A-New-Br', slug: 'b-secret', restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id),
            managerName: 'Mgr', managerEmail: `mgr.${A.slug}@staff.test`, managerPhone: '9999999999',
        });
        expect(r.status).toBeLessThan(500);
        const made = await Branch.findOne({ name: 'A-New-Br' }).lean();
        if (made) expect(String(made.restaurant)).toBe(String(A.restaurant._id));
        expect(await Branch.countDocuments({ restaurant: B.restaurant._id })).toBe(2);
        expect((await bSnap()).b2).toEqual(before.b2);
    });

    test('update A branch with restaurant / isActive mass-assignment cannot move it to B', async () => {
        const r = await adminA().put(`/branches/${A2._id}`).send({ name: 'A-Second', restaurant: String(B.restaurant._id) });
        expect(r.status).toBeLessThan(500);
        expect(String((await lean(Branch, A2._id)).restaurant)).toBe(String(A.restaurant._id));
    });

    test('branch-pinned A admin cannot reach sibling branches or B branches', async () => {
        const api = ctx.api.as(branchAdminA);
        const l = await api.get('/branches');
        expect(txt(l)).not.toContain('B-Secret');
        for (const call of [
            () => api.get(`/branches/${B2._id}`),
            () => api.put(`/branches/${B2._id}`).send({ name: 'pwned' }),
            () => api.put(`/branches/${A.branch._id}`).send({ name: 'pwned' }),
            () => api.delete(`/branches/${A.branch._id}`),
            () => api.post(`/branches/${A.branch._id}/sync-menu`).send({}),
            () => api.post(`/branches/${B2._id}/sync-areas`).send({}),
            () => api.post(`/branches/${B2._id}/subadmin/reset-password`).send({}),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect(DENIED).toContain(r.status);
        }
        expect((await lean(Branch, A.branch._id)).name).toBe('Main');
        expect((await bSnap()).b2).toEqual(before.b2);
    });

    test('A waiter/chef/captain cannot manage branches', async () => {
        for (const u of [A.users.waiter, A.users.chef, A.users.captain]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await ctx.api.as(u).put(`/branches/${B2._id}`).send({ name: 'pwned' });
            expect(DENIED).toContain(r.status);
            // eslint-disable-next-line no-await-in-loop
            const r2 = await ctx.api.as(u).post('/branches').send({ name: 'x' });
            expect(DENIED).toContain(r2.status);
        }
    });

    test('A customer (with B slug header) cannot use admin catalogue writes', async () => {
        const cust = await createCustomer('cat-cust');
        const api = ctx.api.as(cust, B);
        for (const call of [
            () => api.post('/menu').send({ name: 'x', category: String(B.category._id), basePrice: 1, description: 'd' }),
            () => api.put(`/categories/${B.category._id}`).send({ name: 'pwned' }),
            () => api.delete(`/combos/${bCombo._id}`),
            () => api.post(`/tables/${B.tables.main._id}/qr-token`).send({}),
            () => api.get('/tables'),
        ]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await call();
            expect([401, 403, 404]).toContain(r.status);
        }
        expect((await bSnap()).items).toEqual(before.items);
    });

    test('positive control: B owner reads own branch', async () => {
        const r = await adminB().get(`/branches/${B2._id}`);
        expect(r.status).toBe(200);
        expect(txt(r)).toContain('B-Secret-Branch');
    });
});

describe('final state', () => {
    test('B catalogue rows are unchanged after all attacks', async () => {
        const now = await bSnap();
        expect(now.items).toEqual(before.items);
        expect(now.cat).toEqual(before.cat);
        expect(now.area).toEqual(before.area);
        expect(now.combo).toEqual(before.combo);
        expect(now.b1).toEqual(before.b1);
        expect(mongoose.connection.readyState).toBe(1);
    });
});
