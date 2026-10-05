/**
 * services/orderItemsService.js through the real HTTP stack — appending
 * items (POST /orders/:id/append), repeating one item
 * (POST /orders/:orderId/repeat/:itemId) and repeating a whole order
 * (POST /orders/:id/repeat-all) — plus QA #13 (table capacity) as seen
 * from the ordering endpoints.
 *
 * orderFlow.test.js already covers: append bill recompute with tax /
 * service charge, chef append refusal, append on a deleted table, the
 * 1-seat capacity scan/order gate. Nothing here repeats those.
 *
 * Every money assertion is exact to the paisa.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const { computeBill, toTaxConfig } = require(path.join(BACKEND, 'utils/billing'));
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Inventory = require(path.join(BACKEND, 'models/inventory'));
const Recipe = require(path.join(BACKEND, 'models/recipe'));

const ctx = useIntegrationApp();
let A; // GST 5 %, service charge 10 %, flat ₹20 packaging
let B;

beforeAll(async () => {
    A = await seedTenant({ label: 'oci2' });
    B = await seedTenant({ label: 'oci2b' });
});

const bill = (subtotal, orderType = 'dine-in') =>
    computeBill({ subtotal, taxConfig: toTaxConfig(A.settings.taxes), orderType });
const r2 = (n) => Math.round(n * 100) / 100;
const paneer = (quantity = 1) => ({ menuItem: String(A.items.paneer._id), quantity });
const naan = (quantity = 1) => ({ menuItem: String(A.items.naan._id), quantity });
const reload = (id) => Order.findById(id).lean();

/** Guest scans `table` and orders `items`; returns { order, scanToken, sessionId }. */
async function guestOrder(table, items = [paneer(2)], { scanToken } = {}) {
    let token = scanToken;
    let sessionId;
    if (!token) ({ scanToken: token, sessionId } = await scanTable(ctx.api, table));
    const sub = items.reduce((s, i) => s + (i.menuItem === String(A.items.paneer._id) ? 200 : 40) * i.quantity, 0);
    const res = await ctx.api.guest(A, token).post('/orders')
        .send({ type: 'dine-in', tableId: String(table._id), items, total: bill(sub).total });
    expect(res.status).toBe(201);
    return { order: res.body.order, scanToken: token, sessionId };
}

/** Logged-in customer scans `table` and orders. */
async function customerOrder(cust, table, items = [paneer(2)]) {
    const { scanToken } = await scanTable(ctx.api, table);
    const sub = items.reduce((s, i) => s + (i.menuItem === String(A.items.paneer._id) ? 200 : 40) * i.quantity, 0);
    const res = await ctx.api.customerAtTable(cust, A, scanToken).post('/orders')
        .send({ type: 'dine-in', tableId: String(table._id), items, total: bill(sub).total });
    expect(res.status).toBe(201);
    return { order: res.body.order, scanToken };
}

/** Admin settles the order in cash (served + Paid) — frees the table and its seats. */
async function settleOrder(orderId) {
    await Order.updateOne({ _id: orderId }, { $set: { status: 'served' } });
    const o = await reload(orderId);
    const res = await ctx.api.as(A.users.admin).patch(`/orders/${orderId}/status`)
        .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: o.total });
    expect(res.status).toBe(200);
}

const append = (who, orderId, items) => ctx.api.as(who).post(`/orders/${orderId}/append`).send({ items });

describe('append: who may append', () => {
    test.each([
        ['waiter', () => A.users.waiter],
        ['captain', () => A.users.captain],
        ['tenant owner (admin)', () => A.users.admin],
    ])('%s can append; bill recomputed exactly', async (_l, who) => {
        const table = await createTable(A, { name: `Ap-${_l.slice(0, 6)}` });
        const { order } = await guestOrder(table);
        const res = await append(who(), order._id, [naan(2)]);
        expect(res.status).toBe(200);
        expect(res.body.addedCount).toBe(1);
        expect(res.body.deltaTotal).toBe(80);
        const saved = await reload(order._id);
        // 400 + 80 = 480 → 480 + 24 + 48 + 20 = 572
        expect(saved.total).toBe(572);
        expect(saved.total).toBe(bill(480).total);
        expect(saved.gst).toBe(24);
        expect(saved.serviceCharge).toBe(48);
    });

    test.each([
        ['the owning customer (bearer)', async (ctxo) => ctx.api.as(ctxo.cust, A), 403],
        ['a different customer', async () => ctx.api.as(await createCustomer('ap-other'), A), 403],
        ['the guest holding the scan token', async (ctxo) => ctx.api.guest(A, ctxo.scanToken), 401],
        ['a guest from another scan session', async (ctxo) => ctx.api.guest(A, (await scanTable(ctx.api, ctxo.table)).scanToken), 401],
    ])('%s is refused (%i) and the order is untouched', async (_l, mk, status) => {
        const table = await createTable(A, { name: `ApNo-${_l.replace(/\W/g, '').slice(0, 20)}` });
        const cust = await createCustomer('ap-owner');
        const { order, scanToken } = await customerOrder(cust, table);
        const before = await reload(order._id);
        const api = await mk({ cust, scanToken, table });
        const res = await api.post(`/orders/${order._id}/append`).send({ items: [naan(1)] });
        expect(res.status).toBe(status);
        const after = await reload(order._id);
        expect(after.items).toHaveLength(before.items.length);
        expect(after.total).toBe(before.total);
    });

    test("tenant B's waiter cannot append to a tenant A order (404, untouched)", async () => {
        const table = await createTable(A, { name: 'ApCross' });
        const { order } = await guestOrder(table);
        const res = await append(B.users.waiter, order._id, [{ menuItem: String(B.items.naan._id), quantity: 1 }]);
        expect(res.status).toBe(404);
        expect((await reload(order._id)).items).toHaveLength(1);
    });

    test('an empty items array → 400', async () => {
        const table = await createTable(A, { name: 'ApEmpty' });
        const { order } = await guestOrder(table);
        const res = await append(A.users.waiter, order._id, []);
        expect(res.status).toBe(400);
    });
});

describe('append: order state', () => {
    test('appending to a SERVED order re-opens it to the kitchen and re-occupies the table', async () => {
        const table = await createTable(A, { name: 'ApServed' });
        const { order } = await guestOrder(table);
        await Order.updateOne({ _id: order._id }, { $set: { status: 'served', servedAt: new Date() } });
        // alerts are sub-documents since the models/table.js alerts fix.
        await Table.updateOne({ _id: table._id }, { $set: { status: 'free', alerts: [{ reason: 'Water', type: 'water' }] } });

        const res = await append(A.users.waiter, order._id, [naan(1)]);
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.status).toBe('new');
        expect(saved.servedAt).toBeFalsy();
        expect(saved.total).toBe(bill(440).total); // 440 + 22 + 44 + 20 = 526
        expect(saved.total).toBe(526);
        const t = await Table.findById(table._id).lean();
        expect(t.status).toBe('occupied');
        expect(String(t.activeOrder)).toBe(String(order._id));
        expect(t.alerts).toHaveLength(0);
    });

    test('appending to a READY order moves it back to preparing; the new line is stamped later than the original', async () => {
        const table = await createTable(A, { name: 'ApReady' });
        const { order } = await guestOrder(table);
        await Order.updateOne({ _id: order._id }, { $set: { status: 'ready', preparationCompletedAt: new Date() } });
        const original = (await reload(order._id)).items[0].addedAt;

        const res = await append(A.users.captain, order._id, [naan(1)]);
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.status).toBe('preparing');
        expect(saved.preparationCompletedAt).toBeFalsy();
        expect(new Date(saved.items[0].addedAt).getTime()).toBe(new Date(original).getTime());
        expect(new Date(saved.items[1].addedAt).getTime()).toBeGreaterThan(new Date(original).getTime());
    });

    test('appending to a CANCELLED order → 400 ORDER_NOT_APPENDABLE', async () => {
        const table = await createTable(A, { name: 'ApCanc' });
        const { order } = await guestOrder(table);
        await Order.updateOne({ _id: order._id }, { $set: { status: 'cancelled' } });
        const res = await append(A.users.waiter, order._id, [naan(1)]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ORDER_NOT_APPENDABLE');
        expect((await reload(order._id)).items).toHaveLength(1);
    });

    // Regression (fixed 2026-10): appendOrderItems refuses a Paid / Refunded order
    // (409 ORDER_ALREADY_PAID); the paid bill never grows.
    test('appending to a settled (served + Paid) order is accepted; the extra items are never charged', async () => {
        const table = await createTable(A, { name: 'ApPaid' });
        const { order } = await guestOrder(table);
        await settleOrder(order._id);
        const paid = await reload(order._id);
        expect(paid.paymentStatus).toBe('Paid');
        expect(paid.amountPaid).toBe(paid.total);

        const res = await append(A.users.waiter, order._id, [naan(2)]);
        const after = await reload(order._id);
        // Expected: refused (409/400) — a paid bill must not grow.
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(after.total).toBe(paid.total);
    });

    test('a branch-pinned waiter of another branch cannot append (403 BRANCH_SCOPE_VIOLATION)', async () => {
        const Branch = require(path.join(BACKEND, 'models/branch'));
        const Area = require(path.join(BACKEND, 'models/area'));
        const second = await Branch.create({ restaurant: A.restaurant._id, name: 'Two', slug: 'two', isActive: true });
        const area = await Area.create({ restaurant: A.restaurant._id, branch: second._id, name: 'Two Hall' });
        const table = await createTable(A, { name: 'ApTwo', branch: second._id, area: area._id });
        const { order } = await guestOrder(table);
        const res = await append(A.users.waiter, order._id, [naan(1)]); // waiter pinned to main
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_SCOPE_VIOLATION');
    });
});

describe('append: items and money', () => {
    test('client-sent price / name are ignored for menu items', async () => {
        const table = await createTable(A, { name: 'ApCanon' });
        const { order } = await guestOrder(table);
        const res = await append(A.users.waiter, order._id, [{ ...naan(1), price: 0.01, name: 'Caviar' }]);
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.items[1]).toMatchObject({ name: 'Garlic Naan', price: 40, quantity: 1 });
        expect(saved.total).toBe(bill(440).total);
    });

    test('appending the same dish merges into the existing line', async () => {
        const table = await createTable(A, { name: 'ApMerge' });
        const { order } = await guestOrder(table);
        const res = await append(A.users.waiter, order._id, [paneer(3)]);
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.items).toHaveLength(1);
        expect(saved.items[0].quantity).toBe(5);
        expect(saved.total).toBe(bill(1000).total); // 1000 + 50 + 100 + 20 = 1170
        expect(saved.total).toBe(1170);
    });

    test('an out-of-stock item refuses the append; nothing changes', async () => {
        const item = await MenuItem.create({ restaurant: A.restaurant._id, category: A.category._id, name: 'Gone Kulfi', description: 'x', basePrice: 60, inStock: false });
        const table = await createTable(A, { name: 'ApOOS' });
        const { order } = await guestOrder(table);
        const res = await append(A.users.waiter, order._id, [naan(1), { menuItem: String(item._id), quantity: 1 }]);
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('Gone Kulfi');
        const saved = await reload(order._id);
        expect(saved.items).toHaveLength(1);
        expect(saved.total).toBe(bill(400).total);
    });

    test('recipe stock pre-flight: an ingredient shortage refuses the append (INSUFFICIENT_STOCK)', async () => {
        const curry = await MenuItem.create({ restaurant: A.restaurant._id, category: A.category._id, name: 'Stock Curry', description: 'x', basePrice: 150 });
        const inv = await Inventory.create({
            restaurant: A.restaurant._id, itemId: `INV-${Date.now()}`, name: 'Cottage Cheese', category: 'Dairy & Eggs',
            unit: 'kg', currentStock: 1, minStock: 0, costPerUnit: 300,
        });
        await Recipe.create({ restaurant: A.restaurant._id, menuItem: curry._id, ingredients: [{ inventoryItem: inv._id, quantity: 0.4, unit: 'kg' }] });

        const table = await createTable(A, { name: 'ApStock' });
        const { order } = await guestOrder(table);
        const short = await append(A.users.waiter, order._id, [{ menuItem: String(curry._id), quantity: 3 }]); // needs 1.2 kg
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('INSUFFICIENT_STOCK');
        expect(short.body.shortages[0]).toMatchObject({ name: 'Cottage Cheese', available: 1 });
        expect((await reload(order._id)).items).toHaveLength(1);

        const ok = await append(A.users.waiter, order._id, [{ menuItem: String(curry._id), quantity: 2 }]); // 0.8 kg
        expect(ok.status).toBe(200);
        expect((await reload(order._id)).total).toBe(bill(700).total);
    });

    test('the same Idempotency-Key replays the first append instead of adding the items twice', async () => {
        const table = await createTable(A, { name: 'ApIdem' });
        const { order } = await guestOrder(table);
        const key = `append-${Date.now()}-abcdef`;
        const send = () => ctx.api.as(A.users.waiter).post(`/orders/${order._id}/append`)
            .set('Idempotency-Key', key).send({ items: [naan(1)] });
        expect((await send()).status).toBe(200);
        await settle(100);
        expect((await send()).status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.items.find((i) => i.name === 'Garlic Naan').quantity).toBe(1);
        expect(saved.total).toBe(bill(440).total);
    });

    // Regression (fixed 2026-10): buildAppendItems refuses any line that does not
    // resolve to an own-tenant menu item (400 ITEM_NOT_FOUND) — no client prices.
    test.each([
        ['an unknown menu id with a NEGATIVE price', () => ({ menuItem: '64b0000000000000000000aa', name: 'Adjustment', price: -300, quantity: 1 })],
        ["tenant B's menu item at ₹1", () => ({ menuItem: String(B.items.paneer._id), name: 'Paneer Tikka', price: 1, quantity: 1 })],
        ['a line without any menuItem at ₹0', () => ({ name: 'Free Dessert', price: 0, quantity: 1 })],
    ])('append accepts %s priced from the client', async (_l, line) => {
        const table = await createTable(A, { name: `ApGhost-${_l.length}` });
        const { order } = await guestOrder(table);
        const before = await reload(order._id);
        const res = await append(A.users.waiter, order._id, [line()]);
        const after = await reload(order._id);
        // Expected: refused like createOrder (400 ITEM_NOT_FOUND), bill unchanged.
        expect(res.status).toBe(400);
        expect(after.total).toBe(before.total);
    });

    // Regression (fixed 2026-10): appendItemsMerging no longer caps a merged line
    // at 99; it allows the 999 per-item limit and refuses beyond it.
    test('appending 1 more of a 150-qty line shrinks it to 99 and lowers the bill', async () => {
        const table = await createTable(A, { name: 'ApCap', capacity: 10 });
        const { order } = await guestOrder(table, [paneer(150)]);
        expect((await reload(order._id)).total).toBe(bill(30000).total); // 34520
        const res = await append(A.users.waiter, order._id, [paneer(1)]);
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        // Expected: 151 portions, bill for 30200 = 30200 + 1510 + 3020 + 20 = 34750.
        expect(saved.items[0].quantity).toBe(151);
        expect(saved.total).toBe(34750);
    });
});

describe('repeat one item', () => {
    test('repeating an item of an ACTIVE order merges it in; the bill is recomputed exactly', async () => {
        const cust = await createCustomer('rp-item');
        const table = await createTable(A, { name: 'RpItem' });
        const { order } = await customerOrder(cust, table, [paneer(2), naan(1)]);
        const paneerLine = order.items.find((i) => i.name === 'Paneer Tikka');

        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat/${paneerLine._id}`).send({ quantity: 2 });
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.items.find((i) => i.name === 'Paneer Tikka').quantity).toBe(4);
        // 4 × 200 + 40 = 840 → 840 + 42 + 84 + 20 = 986
        expect(saved.total).toBe(986);
        expect(saved.total).toBe(bill(840).total);
        expect(saved.gst).toBe(42);
        expect(saved.serviceCharge).toBe(84);
        expect(saved.additionalChargesTotal).toBe(20);
    });

    // Updated 2026-10: the per-request repeat quantity is still clamped to
    // 99, but the merged line is no longer silently capped at 99 (it may
    // hold up to the 999 per-item limit), so 1 + 99 = 100.
    test.each([
        [0, 1], [-5, 1], [500, 99], ['abc', 1],
    ])('quantity %p is clamped to %p (merged line not capped at 99)', async (sent, expected) => {
        const cust = await createCustomer('rp-qty');
        const table = await createTable(A, { name: `RpQty-${String(sent)}` });
        const { order } = await customerOrder(cust, table, [naan(1)]);
        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat/${order.items[0]._id}`).send({ quantity: sent });
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        const qty = 1 + expected;
        expect(saved.items[0].quantity).toBe(qty);
        expect(saved.total).toBe(bill(40 * qty).total);
    });

    test('repeating from a CLOSED order creates a new fully-billed order on the table', async () => {
        const cust = await createCustomer('rp-closed');
        const table = await createTable(A, { name: 'RpClosed' });
        const { order } = await customerOrder(cust, table, [paneer(1), naan(2)]);
        await settleOrder(order._id);
        const naanLine = order.items.find((i) => i.name === 'Garlic Naan');

        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat/${naanLine._id}`).send({ quantity: 3 });
        expect(res.status).toBe(200);
        const fresh = await reload(res.body.order._id);
        expect(fresh._id.toString()).not.toBe(order._id);
        expect(fresh.items).toHaveLength(1);
        expect(fresh.items[0]).toMatchObject({ name: 'Garlic Naan', quantity: 3, price: 40 });
        expect(fresh.total).toBe(bill(120).total); // 120 + 6 + 12 + 20 = 158
        expect(fresh.total).toBe(158);
        expect(String(fresh.table)).toBe(String(table._id));
        expect(String(fresh.branch)).toBe(String(A.branch._id));
        expect((await Table.findById(table._id).lean()).status).toBe('occupied');
    });

    test('unknown item id → 404; another customer → 403', async () => {
        const cust = await createCustomer('rp-own');
        const table = await createTable(A, { name: 'RpOwn' });
        const { order } = await customerOrder(cust, table);
        const missing = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat/64b0000000000000000000bb`).send({});
        expect(missing.status).toBe(404);
        const other = await ctx.api.as(await createCustomer('rp-thief'), A).post(`/orders/${order._id}/repeat/${order.items[0]._id}`).send({});
        expect(other.status).toBe(403);
        expect((await reload(order._id)).items[0].quantity).toBe(2);
    });
});

describe('repeat a whole order', () => {
    test('closed source → a fresh order with the full bill; selections trim and re-quantify', async () => {
        const cust = await createCustomer('rp-all');
        const table = await createTable(A, { name: 'RpAll' });
        const { order } = await customerOrder(cust, table, [paneer(2), naan(3)]);
        await settleOrder(order._id);

        const all = await ctx.api.as(cust, A).post(`/orders/${order.orderId}/repeat-all`).send({});
        expect(all.status).toBe(201);
        const fresh = await reload(all.body.order._id);
        // 400 + 120 = 520 → 520 + 26 + 52 + 20 = 618
        expect(fresh.total).toBe(618);
        expect(fresh.total).toBe(bill(520).total);
        expect(String(fresh.user)).toBe(String(cust._id));
        await settleOrder(fresh._id);

        // Updated 2026-10: the first repeat detached the settled source bill
        // from the table, so this repeat names the diner's current table
        // (as the app does) — a dine-in repeat without a table is now
        // refused (TABLE_REQUIRED) instead of creating a table-less order.
        const trimmed = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`)
            .send({ targetTableId: String(table._id), selections: [{ index: 1, quantity: 1, instructions: '  extra butter  ' }, { index: 1, quantity: 9 }, { index: 7, quantity: 1 }, { index: 0, quantity: 0 }] });
        expect(trimmed.status).toBe(201);
        const t = await reload(trimmed.body.order._id);
        expect(t.items).toHaveLength(1);
        expect(t.items[0]).toMatchObject({ name: 'Garlic Naan', quantity: 1, instructions: 'extra butter' });
        expect(t.total).toBe(bill(40).total); // 40 + 2 + 4 + 20 = 66
    });

    test('selections that pick nothing → 400', async () => {
        const cust = await createCustomer('rp-none');
        const table = await createTable(A, { name: 'RpNone' });
        const { order } = await customerOrder(cust, table);
        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`).send({ selections: [{ index: 5, quantity: 1 }] });
        expect(res.status).toBe(400);
    });

    test('active source on the same table → items folded into it (appended), bill exact', async () => {
        const cust = await createCustomer('rp-act');
        const table = await createTable(A, { name: 'RpAct' });
        const { order } = await customerOrder(cust, table, [paneer(1)]);
        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`).send({});
        expect(res.status).toBe(200);
        expect(res.body.appended).toBe(true);
        const saved = await reload(order._id);
        expect(saved.items[0].quantity).toBe(2);
        expect(saved.total).toBe(bill(400).total);
    });

    test('another customer → 403; unknown order → 404', async () => {
        const cust = await createCustomer('rp-all-own');
        const table = await createTable(A, { name: 'RpAllOwn' });
        const { order } = await customerOrder(cust, table);
        const other = await ctx.api.as(await createCustomer('rp-all-thief'), A).post(`/orders/${order._id}/repeat-all`).send({});
        expect(other.status).toBe(403);
        const missing = await ctx.api.as(cust, A).post('/orders/ORD-000000-NOPE00/repeat-all').send({});
        expect(missing.status).toBe(404);
    });

    test('repeating onto a different, FULL table is refused (TABLE_CAPACITY_REACHED)', async () => {
        const cust = await createCustomer('rp-full');
        const home = await createTable(A, { name: 'RpHome' });
        const { order } = await customerOrder(cust, home);
        await settleOrder(order._id);
        const full = await createTable(A, { name: 'RpFull', capacity: 1 });
        await guestOrder(full);
        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`).send({ targetTableId: String(full._id) });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TABLE_CAPACITY_REACHED');
    });

    // Regression (fixed 2026-10): repeat / repeat-all require staff, the owner, or
    // the guest's own scan session (orderAccessForCaller) — 401/403 otherwise.
    test("an anonymous caller can repeat-all a customer's open order by its printed order number", async () => {
        const cust = await createCustomer('rp-victim');
        const table = await createTable(A, { name: 'RpAnon' });
        const { order } = await customerOrder(cust, table, [paneer(1)]);
        const before = await reload(order._id);

        const res = await ctx.api.anon().post(`/orders/${order.orderId}/repeat-all`)
            .set('X-Restaurant-Slug', A.slug).send({});
        const after = await reload(order._id);
        // Expected: 401/403 and the victim's bill unchanged.
        expect([401, 403]).toContain(res.status);
        expect(after.total).toBe(before.total);
    });

    // Regression (fixed 2026-10): a Paid source is never reopened by a repeat; the
    // repeat becomes a new unpaid order.
    test('repeat-all on a prepaid order still in the kitchen appends to the PAID bill', async () => {
        const cust = await createCustomer('rp-prepaid');
        const res0 = await ctx.api.as(cust, A).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', items: [paneer(1)], total: bill(200, 'takeaway').total,
        });
        expect(res0.status).toBe(201);
        const id = res0.body.order._id;
        await Order.updateOne({ _id: id }, { $set: { paymentStatus: 'Paid', amountPaid: 230, paymentMethod: 'online' } });
        expect((await reload(id)).total).toBe(230); // 200 + 10 + 20

        const res = await ctx.api.as(cust, A).post(`/orders/${id}/repeat-all`).send({});
        expect(res.status).toBeLessThan(500);
        const paidOrder = await reload(id);
        // Expected: the paid bill is not reopened — the repeat becomes a new
        // unpaid order (or is refused); the paid order stays at ₹230.
        expect(paidOrder.total).toBe(230);
        expect(paidOrder.amountPaid).toBe(paidOrder.total);
    });
});

describe('repeat: counter (no-prep) items and edge cases', () => {
    let water;
    beforeAll(async () => {
        water = await MenuItem.create({
            restaurant: A.restaurant._id, category: A.category._id, name: 'Mineral Water',
            description: 'bottled', basePrice: 30, prepStation: 'counter',
        });
    });
    const waterLine = (quantity) => ({ menuItem: water._id, name: 'Mineral Water', price: 30, quantity, prepStation: 'counter', category: 'Drinks' });

    test('repeating a single counter item creates a READY counter order with the full bill (never the kitchen)', async () => {
        const cust = await createCustomer('rp-ctr1');
        const table = await createTable(A, { name: 'RpCtr1' });
        const { order } = await customerOrder(cust, table, [paneer(1)]);
        await Order.updateOne({ _id: order._id }, { $push: { items: waterLine(1) } });
        const src = await reload(order._id);
        const line = src.items.find((i) => i.name === 'Mineral Water');

        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat/${line._id}`).send({ quantity: 3 });
        expect(res.status).toBe(200);
        expect(res.body.isSplit).toBe(true);
        const ctr = await reload(res.body.order._id);
        expect(String(ctr._id)).not.toBe(order._id);
        expect(ctr.status).toBe('ready');
        expect(ctr.items).toHaveLength(1);
        expect(ctr.items[0]).toMatchObject({ name: 'Mineral Water', quantity: 3, price: 30 });
        expect(ctr.total).toBe(bill(90).total); // 90 + 4.5 + 9 + 20 = 123.5
        expect(ctr.total).toBe(123.5);
        expect(String(ctr.table)).toBe(String(table._id));
        // The source (kitchen) order is untouched.
        expect((await reload(order._id)).total).toBe(src.total);
    });

    test('repeat-all of a counter-only order → one READY order, 201', async () => {
        const cust = await createCustomer('rp-ctr2');
        const table = await createTable(A, { name: 'RpCtr2' });
        const { order } = await customerOrder(cust, table, [naan(1)]);
        await Order.updateOne({ _id: order._id }, { $set: { items: [waterLine(2)] } });
        await settleOrder(order._id);

        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`).send({});
        expect(res.status).toBe(201);
        const ctr = await reload(res.body.order._id);
        expect(ctr.status).toBe('ready');
        expect(ctr.total).toBe(bill(60).total); // 89
        expect(await Order.countDocuments({ user: cust._id })).toBe(2);
    });

    // Regression (fixed 2026-10): the kitchen target is chosen before the counter
    // doc exists; a fresh mixed repeat splits like createOrder (bare counter doc).
    test('repeat-all of a mixed kitchen + counter order merges the kitchen items into the counter doc', async () => {
        const cust = await createCustomer('rp-mixed');
        const table = await createTable(A, { name: 'RpMixed' });
        const { order } = await customerOrder(cust, table, [paneer(1)]);
        await Order.updateOne({ _id: order._id }, { $push: { items: waterLine(2) } });
        await settleOrder(order._id);

        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`).send({});
        expect(res.status).toBeLessThan(300);
        expect(res.body.isSplit).toBe(true);
        // Evidence (inspected): received 200, appended:true, order._id ===
        // splitOrder._id, that doc = [Mineral Water×2, Paneer Tikka×1],
        // status 'preparing', total 319.
        // Expected: two docs — counter READY with only the water, kitchen
        // with only the paneer — summing to the fresh-cart bill (319).
        expect(res.body.order._id).not.toBe(res.body.splitOrder._id);
        const counter = await reload(res.body.splitOrder._id);
        expect(counter.status).toBe('ready');
        expect(counter.items.map((i) => i.name)).toEqual(['Mineral Water']);
        const kitchen = await reload(res.body.order._id);
        expect(r2(kitchen.total + counter.total)).toBe(bill(260).total);
    });

    test('repeating an item of a READY order moves it back to preparing', async () => {
        const cust = await createCustomer('rp-ready');
        const table = await createTable(A, { name: 'RpReady' });
        const { order } = await customerOrder(cust, table, [paneer(1)]);
        await Order.updateOne({ _id: order._id }, { $set: { status: 'ready', preparationCompletedAt: new Date() } });
        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat/${order.items[0]._id}`).send({ quantity: 1 });
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.status).toBe('preparing');
        expect(saved.preparationCompletedAt).toBeFalsy();
        expect(saved.total).toBe(bill(400).total);
    });

    test.each([
        ['a malformed targetTableId', async () => ({ targetTableId: 'not-an-id' }), 400],
        ['a deleted target table', async () => {
            const t = await createTable(A, { name: `RpDel-${Date.now()}` });
            await Table.updateOne({ _id: t._id }, { $set: { isDeleted: true } });
            return { targetTableId: String(t._id) };
        }, 409],
    ])('repeat-all onto %s → %i', async (_l, mkBody, status) => {
        const cust = await createCustomer('rp-target');
        const table = await createTable(A, { name: `RpTgt-${status}` });
        const { order } = await customerOrder(cust, table);
        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`).send(await mkBody());
        expect(res.status).toBe(status);
        expect((await reload(order._id)).items[0].quantity).toBe(2);
    });

    test('repeat-all of an order with no items → 400', async () => {
        const cust = await createCustomer('rp-empty');
        const table = await createTable(A, { name: 'RpEmpty' });
        const { order } = await customerOrder(cust, table);
        await Order.updateOne({ _id: order._id }, { $set: { items: [] } });
        const res = await ctx.api.as(cust, A).post(`/orders/${order._id}/repeat-all`).send({});
        expect(res.status).toBe(400);
    });
});

describe('createOrder: contact fields and scan-token proof', () => {
    const takeaway = (extra) => ({ type: 'takeaway', pickupLocation: 'Counter', items: [paneer(1)], total: bill(200, 'takeaway').total, ...extra });

    test.each([
        ['a name over 80 characters', { customerName: 'x'.repeat(81) }],
        ['a name with markup', { customerName: '<script>alert(1)</script>' }],
        ['a phone with letters', { phone: '98765abcde' }],
        ['a phone with too few digits', { phone: '12-34-5' }],
        ['a phone with too many digits', { phone: '+1234567890123456' }],
        ['a delivery address over 500 characters', { delivery: { requested: true, address: 'a'.repeat(501) } }],
    ])('%s → 400, no order', async (_l, extra) => {
        const before = await Order.countDocuments({ restaurant: A.restaurant._id });
        const res = await ctx.api.guest(A).post('/orders').send(takeaway(extra));
        expect(res.status).toBe(400);
        expect(await Order.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('a valid guest name / phone are normalised and stored; control characters stripped', async () => {
        const res = await ctx.api.guest(A).post('/orders').send(takeaway({ customerName: "  Ana\u0007 O'Brien-Dé ", phone: ' (022) 555-0199 ' }));
        expect(res.status).toBe(201);
        const saved = await reload(res.body.order._id);
        expect(saved.customerName).toBe("Ana O'Brien-Dé");
        expect(saved.phone).toBe('0225550199');
    });

    test.each([
        ['a garbage scan token', () => 'not-a-jwt', 401, 'SCAN_TOKEN_INVALID'],
        ["a scan token from tenant B's table", async () => (await scanTable(ctx.api, B.tables.main)).scanToken, 403, 'SCAN_TOKEN_MISMATCH'],
    ])('guest dine-in with %s → %i %s', async (_l, mkToken, status, code) => {
        const table = await createTable(A, { name: `ScanBad-${code}` });
        const token = await mkToken();
        const res = await ctx.api.guest(A, token).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: [paneer(1)], total: bill(200).total });
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(await Order.countDocuments({ table: table._id })).toBe(0);
    });
});

describe('QA #13 — table capacity from the ordering endpoints', () => {
    test('2-seat table: two parties order; a 3rd guest / 3rd customer is refused at scan, claim and order', async () => {
        const table = await createTable(A, { name: 'Cap13', capacity: 2 });
        const c2 = await createCustomer('cap13-2');
        const c3 = await createCustomer('cap13-3');

        const p1 = await guestOrder(table);
        const p2 = await customerOrder(c2, table);
        expect(p2.order).toBeTruthy();

        const g3 = await scanTable(ctx.api, table);
        expect(g3.res.status).toBe(409);
        expect(g3.res.body.code).toBe('TABLE_CAPACITY_REACHED');

        const claim = await ctx.api.as(c3, A).post(`/tables/${table._id}/claim`).send({});
        expect(claim.status).toBe(409);
        expect(claim.body.code).toBe('TABLE_CAPACITY_REACHED');

        const noToken = await ctx.api.as(c3, A).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: [paneer(1)], total: bill(200).total });
        expect(noToken.status).toBe(401);

        // Seated parties keep ordering.
        const again = await ctx.api.guest(A, p1.scanToken).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: [naan(1)], total: bill(40).total });
        expect(again.status).toBe(201);

        const orders = await Order.find({ table: table._id }).lean();
        const parties = new Set(orders.map((o) => (o.user ? `u:${o.user}` : `s:${o.scanSessionId}`)));
        expect(parties.size).toBe(2);
        expect((await Table.findById(table._id).select('+seats').lean()).seats).toHaveLength(2);
    });

    test('three CONCURRENT first orders on a 2-seat table whose seats were released: at most 2 parties order', async () => {
        const table = await createTable(A, { name: 'Cap13c', capacity: 2 });
        const tokens = [];
        for (let i = 0; i < 2; i++) tokens.push((await scanTable(ctx.api, table)).scanToken);
        // Release every seat (e.g. idle pruning) and let a third phone scan in.
        await Table.updateOne({ _id: table._id }, { $set: { seats: [] } });
        tokens.push((await scanTable(ctx.api, table)).scanToken);
        await Table.updateOne({ _id: table._id }, { $set: { seats: [] } });

        const results = await Promise.all(tokens.map((tk) => ctx.api.guest(A, tk).post('/orders')
            .send({ type: 'dine-in', tableId: String(table._id), items: [paneer(1)], total: bill(200).total })));
        const ok = results.filter((r) => r.status === 201);
        expect(ok).toHaveLength(2);
        expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'TABLE_CAPACITY_REACHED')).toBe(true);
    });

    test('a settled earlier visit cannot be repeated onto a table that is now full (detached bill → seat claim)', async () => {
        // When a new party ORDERS after X settled, createOrder detaches X's
        // paid bill from the table (detachStalePaidBill), so X's repeat
        // targets the table as a NEW party and must claim a seat.
        const table = await createTable(A, { name: 'Cap13d', capacity: 2 });
        const x = await createCustomer('cap13-d');
        const visit = await customerOrder(x, table, [naan(1)]);
        await settleOrder(visit.order._id);
        await guestOrder(table);
        await guestOrder(table);
        expect((await reload(visit.order._id)).table).toBeNull();

        const res = await ctx.api.as(x, A).post(`/orders/${visit.order._id}/repeat-all`)
            .send({ targetTableId: String(table._id) });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TABLE_CAPACITY_REACHED');
    });

    // Regression (fixed 2026-10): repeat claims a seat on the source's own table
    // too, and the stale-paid detach no longer frees the table (wiping seats).
    test('#13 a third diner orders at a full 2-seat table via Repeat Order of an earlier visit', async () => {
        const table = await createTable(A, { name: 'Cap13r', capacity: 2 });
        const x = await createCustomer('cap13-x');
        // Earlier visit: X ate here and paid; the table is freed.
        const visit = await customerOrder(x, table, [naan(1)]);
        await settleOrder(visit.order._id);
        expect((await Table.findById(table._id).lean()).status).toBe('free');

        // Two new parties scan in and take both seats.
        const s1 = await scanTable(ctx.api, table);
        const s2 = await scanTable(ctx.api, table);
        expect([s1.res.status, s2.res.status]).toEqual([200, 200]);
        expect((await scanTable(ctx.api, table)).res.status).toBe(409); // full

        // X — a third party, no seat, no scan — repeats the earlier order.
        const res = await ctx.api.as(x, A).post(`/orders/${visit.order._id}/repeat-all`)
            .send({ targetTableId: String(table._id) });

        // Evidence (inspected): received 201, table.seats == [] afterwards,
        // and of the two seated parties one order is 201, the other 409
        // TABLE_CAPACITY_REACHED.
        // Expected: refused, the table is full.
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TABLE_CAPACITY_REACHED');
        // …and both seated parties can still order.
        for (const tk of [s1.scanToken, s2.scanToken]) {
            const o = await ctx.api.guest(A, tk).post('/orders')
                .send({ type: 'dine-in', tableId: String(table._id), items: [paneer(1)], total: bill(200).total });
            expect(o.status).toBe(201);
        }
    });

    // Regression (fixed 2026-10): a repeat only folds into an open round of the
    // same party (owner / scan session), never another party's bill.
    test("Repeat Order by customer X lands on guest G's open bill at the same table", async () => {
        const table = await createTable(A, { name: 'RpCross', capacity: 4 });
        const x = await createCustomer('rp-cross-x');
        const visit = await customerOrder(x, table, [naan(1)]);
        await Order.updateOne({ _id: visit.order._id }, { $set: { status: 'served' } }); // eaten, not yet paid
        const g = await guestOrder(table, [paneer(1)]);
        const gBefore = await reload(g.order._id);
        expect(gBefore.total).toBe(bill(200).total); // 200 + 10 + 20 + 20 = 250

        const res = await ctx.api.as(x, A).post(`/orders/${visit.order._id}/repeat-all`).send({});
        expect(res.status).toBeLessThan(500);
        const gAfter = await reload(g.order._id);
        // Expected: G's bill untouched; X's repeat is X's own order.
        // (The literal here used to read 245, a typo for bill(200) = 250.)
        expect(gAfter.total).toBe(gBefore.total);
        expect(gAfter.items).toHaveLength(1);
    });

    // Regression (fixed 2026-10): a dine-in repeat without a table is refused
    // (400 TABLE_REQUIRED) instead of creating a ghost table-less order.
    test('repeating an item of a detached past dine-in order creates a table-less dine-in order', async () => {
        const table = await createTable(A, { name: 'RpGhost' });
        const x = await createCustomer('rp-ghost');
        const visit = await customerOrder(x, table, [naan(1)]);
        await settleOrder(visit.order._id);
        await guestOrder(table); // next party orders → X's paid bill detached
        expect((await reload(visit.order._id)).table).toBeNull();

        const res = await ctx.api.as(x, A).post(`/orders/${visit.order._id}/repeat/${visit.order.items[0]._id}`).send({});
        if (res.status < 300) {
            const created = await reload(res.body.order._id);
            // Expected: never a dine-in order without a table.
            expect(created.type === 'dine-in' && !created.table).toBe(false);
        } else {
            expect(res.status).toBe(400);
        }
    });
});

afterAll(async () => {
    await settle();
});
