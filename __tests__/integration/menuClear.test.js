/**
 * Clear full menu: POST /menu/clear. Owner only, dry run first, typed
 * confirmation, tenant-isolated, optional category removal.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Category = require(path.join(BACKEND, 'models/category'));

const ctx = useIntegrationApp();
let A;
let B;

const csv = 'name,description,category,baseprice\nTikka,Tikka,Starters,200\nNaan,Naan,Breads,40\nLassi,Lassi,Drinks,60\n';
const load = (t) => ctx.api.as(t.users.admin, t).post('/menu/import')
    .attach('file', Buffer.from(csv), { filename: 'm.csv', contentType: 'text/csv' });

beforeAll(async () => {
    A = await seedTenant({ label: 'clr-a' });
    B = await seedTenant({ label: 'clr-b' });
});

const count = (t) => MenuItem.countDocuments({ restaurant: t.restaurant._id });

test('dry run reports counts and changes nothing', async () => {
    await load(A);
    await load(B);
    const before = await count(A);
    expect(before).toBeGreaterThanOrEqual(3);
    const res = await ctx.api.as(A.users.admin, A).post('/menu/clear').send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toBe(before);
    expect(res.body.data.confirmPhrase).toBe('CLEAR MENU');
    expect(await count(A)).toBe(before);
});

test('refuses without the typed phrase', async () => {
    const before = await count(A);
    const none = await ctx.api.as(A.users.admin, A).post('/menu/clear').send({});
    const wrong = await ctx.api.as(A.users.admin, A).post('/menu/clear').send({ confirm: 'yes' });
    expect(none.status).toBe(400);
    expect(wrong.body.code).toBe('CONFIRM_REQUIRED');
    expect(await count(A)).toBe(before);
});

test('non-owner staff are refused', async () => {
    const before = await count(A);
    const res = await ctx.api.as(A.users.waiter, A).post('/menu/clear').send({ confirm: 'CLEAR MENU' });
    expect([401, 403]).toContain(res.status);
    expect(await count(A)).toBe(before);
});

test('clears one restaurant only; categories stay unless asked', async () => {
    const bBefore = await count(B);
    const catsBefore = await Category.countDocuments({ restaurant: A.restaurant._id });
    const res = await ctx.api.as(A.users.admin, A).post('/menu/clear').send({ confirm: 'clear menu' });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toBeGreaterThanOrEqual(3);
    expect(await count(A)).toBe(0);
    expect(await count(B)).toBe(bBefore);
    expect(await Category.countDocuments({ restaurant: A.restaurant._id })).toBe(catsBefore);
});

test('includeCategories also removes the now-empty categories', async () => {
    await load(A);
    expect(await count(A)).toBeGreaterThanOrEqual(3);
    const res = await ctx.api.as(A.users.admin, A).post('/menu/clear').send({ confirm: 'CLEAR MENU', includeCategories: true });
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toBeGreaterThanOrEqual(3);
    expect(await Category.countDocuments({ restaurant: A.restaurant._id, name: { $in: ['Starters', 'Breads', 'Drinks'] } })).toBe(0);
    expect(await Category.countDocuments({ restaurant: B.restaurant._id, name: 'Starters' })).toBeGreaterThanOrEqual(1);
});
