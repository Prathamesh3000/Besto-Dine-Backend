/**
 * Admin bulk imports — every "Download template → upload CSV" flow in the
 * admin panel, exercised exactly as the modals do: GET the master
 * template from the server, POST it back unchanged as multipart `file`.
 *
 * A template must import cleanly (every row created, no row errors):
 * that is the contract the admin relies on when they fill the template
 * in. Re-importing must not duplicate, other tenants must see nothing,
 * and bad uploads must come back as 400s with a reason, not 500s.
 *
 * Endpoints (routes/*.js):
 *   /menu, /combos, /inventory, /inventory/recipes, /tables, /staff,
 *   /booking-info/event-types, /booking-info/packages, /halls,
 *   /decoration-packages — each with GET …/template + POST …/import.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Category = require(path.join(BACKEND, 'models/category'));
const Combo = require(path.join(BACKEND, 'models/combo'));
const Inventory = require(path.join(BACKEND, 'models/inventory'));
const Recipe = require(path.join(BACKEND, 'models/recipe'));
const Table = require(path.join(BACKEND, 'models/table'));
const Area = require(path.join(BACKEND, 'models/area'));
const User = require(path.join(BACKEND, 'models/user'));
const EventType = require(path.join(BACKEND, 'models/eventType'));
const Package = require(path.join(BACKEND, 'models/package'));
const Hall = require(path.join(BACKEND, 'models/hall'));
const DecorationPackage = require(path.join(BACKEND, 'models/decorationPackage'));
const { parseCsv } = require(path.join(BACKEND, 'utils/csvParser'));

const ctx = useIntegrationApp();
let A;
let B;

const Restaurant = require(path.join(BACKEND, 'models/restaurant'));

beforeAll(async () => {
    A = await seedTenant({ label: 'imp-a' });
    B = await seedTenant({ label: 'imp-b' });
    // The staff sheet has 7 people and the seed already has 4; the default
    // plan limit (maxStaff 5) would rightly refuse the batch with 403 —
    // raise it before the first request so the tenant cache sees it.
    await Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { 'subscription.limits.maxStaff': 100 } });
});

const admin = (t = A) => ctx.api.as(t.users.admin, t);

/** GET the template as the modal does; returns { text, dataRows }. */
async function fetchTemplate(route, t = A) {
    const res = await admin(t).get(`${route}/template`).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/csv/);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment/);
    const text = res.body.toString('utf8');
    const rows = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => String(c).trim() !== ''));
    expect(rows.length).toBeGreaterThan(1);
    return { text, buffer: res.body, header: rows[0], dataRows: rows.length - 1 };
}

/** POST a CSV buffer as multipart `file`, like every Bulk* modal. */
function upload(route, buffer, { filename = 'template.csv', contentType = 'text/csv', t = A, fields = {} } = {}) {
    let r = admin(t).post(`${route}/import`);
    // BulkAddStaffModal / BulkAddCsvModal send the branch the admin is
    // viewing; floor staff (waiter / captain / chef) must land on a branch.
    const allFields = route === '/staff' ? { branch: String(t.branch._id), ...fields } : fields;
    for (const [k, v] of Object.entries(allFields)) r = r.field(k, v);
    return r.attach('file', buffer, { filename, contentType });
}

const createdCount = (body) => Number(body.created ?? body.createdCount ?? 0);
const errorsOf = (body) => body.errors || body.errorRows || [];

// Round trips. Order matters: recipes need the menu + inventory rows;
// combos need the menu rows. Each entry: [label, route, Model(s) counted].
const FLOWS = [
    ['menu items', '/menu', () => MenuItem.countDocuments({ restaurant: A.restaurant._id })],
    ['inventory items', '/inventory', () => Inventory.countDocuments({ restaurant: A.restaurant._id })],
    ['recipes', '/inventory/recipes', () => Recipe.countDocuments({ restaurant: A.restaurant._id })],
    ['combos', '/combos', () => Combo.countDocuments({ restaurant: A.restaurant._id })],
    ['tables', '/tables', () => Table.countDocuments({ restaurant: A.restaurant._id })],
    ['event types', '/booking-info/event-types', () => EventType.countDocuments({ restaurant: A.restaurant._id })],
    ['packages', '/booking-info/packages', () => Package.countDocuments({ restaurant: A.restaurant._id })],
    ['halls', '/halls', () => Hall.countDocuments({ restaurant: A.restaurant._id })],
    ['decoration packages', '/decoration-packages', () => DecorationPackage.countDocuments({ restaurant: A.restaurant._id })],
    ['staff', '/staff', () => User.countDocuments({ restaurant: A.restaurant._id, role: { $ne: 'customer' } })],
];

describe('template → import round trip (tenant A)', () => {
    const results = {};

    test.each(FLOWS)('%s: the master template imports with every row accepted', async (label, route, count) => {
        const seededBefore = await count();
        const tpl = await fetchTemplate(route);
        const res = await upload(route, tpl.buffer);
        expect([200, 201]).toContain(res.status);
        expect(res.body.success).toBe(true);
        const errors = errorsOf(res.body);
        // Print the first offending rows in the failure message.
        expect({ label, errorCount: errors.length, first: errors.slice(0, 5) }).toEqual({ label, errorCount: 0, first: [] });
        const created = createdCount(res.body);
        expect(created).toBeGreaterThan(0);
        const after = await count();
        results[label] = { dataRows: tpl.dataRows, created, docsAdded: after - seededBefore, body: res.body };
        // Every data row became something (recipes group many rows into one
        // recipe per menu item, so compare docs, not rows, there).
        if (label !== 'recipes') expect(created).toBe(tpl.dataRows);
        expect(after - seededBefore).toBe(created);
    });

    test('menu import also created the categories the rows refer to', async () => {
        const cats = await Category.find({ restaurant: A.restaurant._id }).select('name').lean();
        const names = cats.map((c) => c.name);
        expect(names).toEqual(expect.arrayContaining(['Beverages']));
        expect(names.length).toBeGreaterThan(3);
    });

    test('tables import created the areas named in the sheet', async () => {
        const areas = await Area.find({ restaurant: A.restaurant._id }).select('name').lean();
        expect(areas.map((a) => a.name)).toEqual(expect.arrayContaining(['Indoor Dining']));
    });

    test('staff import returns one temporary password per created account', async () => {
        const r = results.staff;
        expect(r).toBeTruthy();
        expect(Array.isArray(r.body.tempPasswords)).toBe(true);
        expect(r.body.tempPasswords).toHaveLength(r.created);
        for (const tp of r.body.tempPasswords) {
            expect(tp.email).toMatch(/@/);
            expect(String(tp.tempPassword).length).toBeGreaterThanOrEqual(8);
        }
    });

    test('recipes reference items that exist: every recipe has at least one ingredient', async () => {
        const recipes = await Recipe.find({ restaurant: A.restaurant._id }).select('ingredients menuItem').lean();
        expect(recipes.length).toBeGreaterThan(0);
        expect(recipes.every((r) => Array.isArray(r.ingredients) && r.ingredients.length > 0)).toBe(true);
    });
});

describe('re-importing the same template is idempotent', () => {
    test.each(FLOWS.filter(([l]) => l !== 'staff'))('%s: second upload creates nothing new and reports no errors', async (label, route, count) => {
        const before = await count();
        const tpl = await fetchTemplate(route);
        const res = await upload(route, tpl.buffer);
        expect([200, 201]).toContain(res.status);
        expect(res.status).toBeLessThan(500);
        expect(errorsOf(res.body).length).toBe(0);
        const after = await count();
        expect(after).toBe(before);
    });

    test('staff: a second upload refuses the duplicate emails as row errors / skips, never duplicates accounts', async () => {
        const before = await User.countDocuments({ restaurant: A.restaurant._id, role: { $ne: 'customer' } });
        const tpl = await fetchTemplate('/staff');
        const res = await upload('/staff', tpl.buffer);
        expect(res.status).toBeLessThan(500);
        const after = await User.countDocuments({ restaurant: A.restaurant._id, role: { $ne: 'customer' } });
        expect(after).toBe(before);
    });
});

describe('tenant isolation', () => {
    test('tenant B sees none of what A imported, and can import the same sheets itself', async () => {
        expect(await MenuItem.countDocuments({ restaurant: B.restaurant._id })).toBe(3); // seed only
        expect(await Hall.countDocuments({ restaurant: B.restaurant._id })).toBe(0);
        expect(await Table.countDocuments({ restaurant: B.restaurant._id })).toBe(2);
        const tpl = await fetchTemplate('/halls', B);
        const res = await upload('/halls', tpl.buffer, { t: B });
        expect(res.status).toBe(200);
        expect(createdCount(res.body)).toBe(tpl.dataRows);
        expect(await Hall.countDocuments({ restaurant: B.restaurant._id })).toBe(tpl.dataRows);
        // A's halls untouched
        expect(await Hall.countDocuments({ restaurant: A.restaurant._id })).toBe(tpl.dataRows);
    });

    test('waiters cannot download templates or import', async () => {
        for (const [, route] of FLOWS) {
            const res = await ctx.api.as(A.users.waiter, A).get(`${route}/template`);
            expect([401, 403]).toContain(res.status);
            const up = await ctx.api.as(A.users.waiter, A).post(`${route}/import`).attach('file', Buffer.from('a,b\n1,2\n'), { filename: 'x.csv', contentType: 'text/csv' });
            expect([401, 403]).toContain(up.status);
        }
    });
});

describe('bad uploads are client errors with a reason', () => {
    test.each(FLOWS)('%s: no file → 400', async (_label, route) => {
        const res = await admin().post(`${route}/import`).send({});
        expect(res.status).toBe(400);
        expect(String(res.body.message)).toMatch(/csv|file/i);
    });

    test.each(FLOWS)('%s: a non-CSV file → 400 "Only .csv files are allowed"', async (_label, route) => {
        const res = await upload(route, Buffer.from('PK\u0003\u0004 not a csv'), {
            filename: 'items.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Only .csv files are allowed');
    });

    test('a CSV over 1 MB → 400 "File is too large"', async () => {
        const big = Buffer.from(`area,name,capacity\n${'Indoor,T1,4\n'.repeat(90000)}`);
        expect(big.length).toBeGreaterThan(1024 * 1024);
        const res = await upload('/tables', big);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('File is too large');
    });

    test.each(FLOWS)('%s: header-only CSV → 400', async (_label, route) => {
        const tpl = await fetchTemplate(route);
        const headerOnly = Buffer.from(`${tpl.text.split(/\r?\n/)[0]}\n`);
        const res = await upload(route, headerOnly);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/header row and at least one data row/);
    });

    test('a sheet with the wrong columns is refused with the missing column names', async () => {
        const res = await upload('/menu', Buffer.from('foo,bar\n1,2\n'));
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/name|description|category|basePrice/);
    });
});
