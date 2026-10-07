/**
 * Inventory + recipes (checklist 8.1), through the real HTTP stack:
 * item CRUD + validation, stock adjustments with audit history and the
 * exact resulting quantity, low-stock status / alerts / notifications,
 * recipe CRUD + food cost, the order → inventory link
 * (deductInventoryForOrder on → preparing, restoreInventoryForOrder on
 * cancel, the createOrder stock pre-flight), CSV bulk imports and the
 * stock / consumption / valuation reports.
 *
 * Deduction and restore run AFTER the status response (fire-and-forget
 * in services/orderStatusService.js runInventoryHooks), so the tests
 * poll the DB with waitFor() before asserting.
 *
 * Cross-tenant isolation for these resources lives in
 * tenantIsolationSweep*.test.js and is not repeated here.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const { computeBill, toTaxConfig } = req_('utils/billing');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const Inventory = req_('models/inventory');
const Recipe = req_('models/recipe');
const MenuItem = req_('models/menuItem');
const Order = req_('models/order');
const Branch = req_('models/branch');
const Notification = req_('models/notification');
const inventoryController = req_('controllers/inventoryController');

const ctx = useIntegrationApp();
let A;
let second;     // { branch, admin } — Sub Admin pinned to a Second branch

const uniq = () => Math.random().toString(16).slice(2, 8);
const admin = () => ctx.api.as(A.users.admin);
const reloadInv = (id) => Inventory.findById(id).lean();
const reloadOrder = (id) => Order.findById(id).lean();
const patchStatus = (user, id, body) => ctx.api.as(user).patch(`/orders/${id}/status`).send(body);

beforeAll(async () => {
    A = await seedTenant({ label: 'inv' });
    const branch = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    second = {
        branch,
        admin: await createUser({
            name: 'Second Sub Admin', email: `subadmin.${uniq()}@inv.test`, role: 'admin',
            restaurant: A.restaurant._id, branch: branch._id, permissions: {},
        }),
    };
});

async function waitFor(fn, { timeout = 4000, step = 40 } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await settle(step);
    }
    return last;
}

/** Inventory row straight into the DB (pre-save hook sets status). */
function mkInv(fields = {}) {
    return Inventory.create({
        restaurant: A.restaurant._id,
        branch: null,
        itemId: `INV-T${uniq()}`,
        name: `Ingredient ${uniq()}`,
        category: 'Raw Ingredients',
        unit: 'kg',
        currentStock: 10,
        minStock: 1,
        costPerUnit: 100,
        ...fields,
    });
}

/** A kitchen dish of its own so recipes in one test never leak into another. */
function mkDish(price = 100, extra = {}) {
    return MenuItem.create({
        restaurant: A.restaurant._id, category: A.category._id, name: `Dish ${uniq()}`,
        description: 'inventory test dish', basePrice: price, prepStation: 'kitchen', vegType: 'veg', ...extra,
    });
}

function mkRecipe(dish, ingredients, extra = {}) {
    return Recipe.create({ restaurant: A.restaurant._id, branch: null, menuItem: dish._id, ingredients, yield: 1, ...extra });
}

/** Guest takeaway order; `lines` = [[dish, qty], …]. Returns the HTTP response. */
function placeOrder(lines, user = null) {
    const subtotal = lines.reduce((s, [d, q]) => s + d.basePrice * q, 0);
    const total = computeBill({ subtotal, taxConfig: toTaxConfig(A.settings.taxes), orderType: 'takeaway' }).total;
    const client = user ? ctx.api.as(user) : ctx.api.guest(A);
    return client.post('/orders').send({
        type: 'takeaway', pickupLocation: 'Counter',
        items: lines.map(([d, q]) => ({ menuItem: String(d._id), quantity: q })),
        total,
    });
}

async function placeOk(lines, user = null) {
    const res = await placeOrder(lines, user);
    expect(res.status).toBe(201);
    return res.body.order;
}

/** Chef → preparing, then wait until the async deduction claimed the order. */
async function startPreparing(order) {
    const res = await patchStatus(A.users.chef, order._id, { status: 'preparing' });
    expect(res.status).toBe(200);
    const done = await waitFor(async () => (await reloadOrder(order._id)).inventoryDeducted === true);
    expect(done).toBe(true);
    await settle(150); // the claim lands before the per-ingredient writes
}

// ═══════════════════════════════════════════════════════════════════════
describe('inventory item CRUD + validation', () => {
    test('admin creates an item: 201, INV-### id, status computed, initial restock history', async () => {
        const name = `Basmati ${uniq()}`;
        const res = await admin().post('/inventory').send({
            name: `  ${name}  `, category: 'Raw Ingredients', unit: 'kg',
            currentStock: 2.5, minStock: 3, maxStock: 50, costPerUnit: 92.5,
        });
        expect(res.status).toBe(201);
        expect(res.body.item.itemId).toMatch(/^INV-\d{3,}$/);

        const saved = await reloadInv(res.body.item._id);
        expect(saved).toMatchObject({
            name, unit: 'kg', currentStock: 2.5, minStock: 3, maxStock: 50, costPerUnit: 92.5,
            status: 'low-stock', branch: null,
        });
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
        expect(saved.adjustmentHistory).toHaveLength(1);
        expect(saved.adjustmentHistory[0]).toMatchObject({
            type: 'restock', quantity: 2.5, previousStock: 0, newStock: 2.5, reason: 'Initial stock',
        });
        expect(String(saved.adjustmentHistory[0].adjustedBy)).toBe(String(A.users.admin._id));
    });

    test('an item created with zero stock is out-of-stock and has no history entry', async () => {
        const res = await admin().post('/inventory').send({
            name: `Saffron ${uniq()}`, category: 'Spices & Seasonings', unit: 'g', minStock: 5, costPerUnit: 300,
        });
        expect(res.status).toBe(201);
        const saved = await reloadInv(res.body.item._id);
        expect(saved.currentStock).toBe(0);
        expect(saved.status).toBe('out-of-stock');
        expect(saved.adjustmentHistory).toEqual([]);
    });

    const base = () => ({ name: `Val ${uniq()}`, category: 'Other', unit: 'pcs', minStock: 1, costPerUnit: 1 });
    test.each([
        ['negative currentStock', { currentStock: -5 }, 'Current stock cannot be negative'],
        ['negative minStock', { minStock: -1 }, 'Min stock must be a non-negative number'],
        ['negative maxStock', { maxStock: -1 }, 'Max stock must be a non-negative number'],
        ['non-numeric cost', { costPerUnit: 'abc' }, 'Cost per unit must be a non-negative number'],
        ['min above max', { minStock: 20, maxStock: 10 }, 'Min stock (20) cannot exceed max stock (10)'],
        ['initial stock above max', { currentStock: 11, maxStock: 10 }, 'Initial stock (11) cannot exceed max stock (10)'],
        ['blank name', { name: '   ' }, 'Item name cannot be empty'],
        ['101-char name', { name: 'x'.repeat(101) }, 'Item name must be under 100 characters'],
        ['past expiry', { expiryDate: '2020-01-01' }, 'Expiry date cannot be in the past'],
        ['negative shelf life', { shelfLifeDays: -3 }, 'Shelf life (days) must be a non-negative number'],
    ])('create rejects %s → 400', async (_label, override, message) => {
        const before = await Inventory.countDocuments({ restaurant: A.restaurant._id });
        const res = await admin().post('/inventory').send({ ...base(), ...override });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        expect(await Inventory.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    // Regression (fixed 2026-10): createItem checks name presence + unit/category enums up front (and maps ValidationError to 400).
    test.each([
        ['unit "lbs" (not in the units enum)', { unit: 'lbs' }],
        ['category "Meat" (not in the category enum)', { category: 'Meat' }],
        ['missing name', { name: undefined }],
    ])('create with %s returns a 400 validation error', async (_label, override) => {
        const res = await admin().post('/inventory').send({ ...base(), ...override });
        expect(res.status).toBe(400);
    });

    test('duplicate name in the same category is refused (case-insensitive); another category is fine', async () => {
        const name = `Jaggery ${uniq()}`;
        const first = await admin().post('/inventory').send({ name, category: 'Other', unit: 'kg', minStock: 0, costPerUnit: 60 });
        expect(first.status).toBe(201);
        const dup = await admin().post('/inventory').send({ name: name.toUpperCase(), category: 'Other', unit: 'kg', minStock: 0, costPerUnit: 60 });
        expect(dup.status).toBe(400);
        expect(dup.body.message).toBe('An item with this name already exists in this category');
        const other = await admin().post('/inventory').send({ name, category: 'Raw Ingredients', unit: 'kg', minStock: 0, costPerUnit: 60 });
        expect(other.status).toBe(201);
    });

    test('PUT updates fields but never touches currentStock; effective min > max is refused', async () => {
        const inv = await mkInv({ currentStock: 7, minStock: 2, maxStock: 20 });
        const res = await admin().put(`/inventory/${inv._id}`).send({ costPerUnit: 55.75, currentStock: 9999, minStock: 8 });
        expect(res.status).toBe(200);
        let saved = await reloadInv(inv._id);
        expect(saved).toMatchObject({ costPerUnit: 55.75, currentStock: 7, minStock: 8, status: 'low-stock' });

        const bad = await admin().put(`/inventory/${inv._id}`).send({ minStock: 25 }); // max stays 20
        expect(bad.status).toBe(400);
        expect(bad.body.message).toBe('Min stock (25) cannot exceed max stock (20)');
        saved = await reloadInv(inv._id);
        expect(saved.minStock).toBe(8);
    });

    test('DELETE removes the item and pulls it out of every recipe', async () => {
        const keep = await mkInv();
        const gone = await mkInv();
        const dish = await mkDish();
        const recipe = await mkRecipe(dish, [
            { inventoryItem: keep._id, quantity: 1, unit: 'kg' },
            { inventoryItem: gone._id, quantity: 2, unit: 'kg' },
        ]);
        const res = await admin().delete(`/inventory/${gone._id}`);
        expect(res.status).toBe(200);
        expect(await reloadInv(gone._id)).toBeNull();
        const r = await Recipe.findById(recipe._id).lean();
        expect(r.ingredients.map((i) => String(i.inventoryItem))).toEqual([String(keep._id)]);
        expect((await admin().delete(`/inventory/${gone._id}`)).status).toBe(404);
    });

    test('a chef (manageStock) may read stock but not create / adjust / delete items', async () => {
        const inv = await mkInv();
        const chef = ctx.api.as(A.users.chef);
        expect((await chef.get('/inventory')).status).toBe(200);
        expect((await chef.get('/inventory/alerts')).status).toBe(200);
        expect((await chef.post('/inventory').send({ name: 'x', category: 'Other', unit: 'kg', minStock: 0, costPerUnit: 0 })).status).toBe(403);
        expect((await chef.patch(`/inventory/${inv._id}/adjust`).send({ type: 'usage', quantity: 1 })).status).toBe(403);
        expect((await chef.delete(`/inventory/${inv._id}`)).status).toBe(403);
        expect((await ctx.api.as(A.users.waiter).get('/inventory')).status).toBe(403);
        expect((await reloadInv(inv._id)).currentStock).toBe(10);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('stock adjustments: exact quantity + audit history', () => {
    test.each([
        // type, start, qty, expected stock, history type
        ['restock', 10, 2.5, 12.5, 'restock'],
        ['return', 10, 0.75, 10.75, 'return'],
        ['usage', 10, 3.25, 6.75, 'usage'],
        ['waste', 10, 0.5, 9.5, 'waste'],
        ['correction', 10, 4, 4, 'correction'],
        ['correction', 10, 0, 0, 'correction'],
        ['order-deduction', 10, 1, 9, 'usage'],
    ])('%s of %p from %p → %p (history type %s)', async (type, start, qty, expected, histType) => {
        const inv = await mkInv({ currentStock: start, minStock: 1, maxStock: 0 });
        const res = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type, quantity: qty, reason: ` ${type} test ` });
        expect(res.status).toBe(200);
        expect(res.body.item).toMatchObject({ previousStock: start, currentStock: expected });

        const saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBe(expected);
        const h = saved.adjustmentHistory.at(-1);
        expect(h).toMatchObject({ type: histType, quantity: qty, previousStock: start, newStock: expected, reason: `${type} test` });
        expect(String(h.adjustedBy)).toBe(String(A.users.admin._id));
        if (type === 'restock' || type === 'return') expect(saved.lastRestocked).toBeTruthy();
    });

    test.each([
        ['missing type', { quantity: 1 }, 'Type and quantity are required'],
        ['missing quantity', { type: 'usage' }, 'Type and quantity are required'],
        ['unknown type', { type: 'theft', quantity: 1 }, 'Invalid adjustment type'],
        ['zero usage', { type: 'usage', quantity: 0 }, 'Quantity must be a positive number'],
        ['negative restock', { type: 'restock', quantity: -2 }, 'Quantity must be a positive number'],
        ['negative correction', { type: 'correction', quantity: -1 }, 'Correction quantity must be 0 or greater'],
        ['non-numeric', { type: 'waste', quantity: 'lots' }, 'Quantity must be a positive number'],
        ['501-char reason', { type: 'usage', quantity: 1, reason: 'r'.repeat(501) }, 'Reason must be under 500 characters'],
    ])('rejects %s → 400 and leaves stock alone', async (_label, body, message) => {
        const inv = await mkInv({ currentStock: 5 });
        const res = await admin().patch(`/inventory/${inv._id}/adjust`).send(body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        const saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBe(5);
        expect(saved.adjustmentHistory).toHaveLength(0);
    });

    test('usage beyond the current stock is refused (no negative stock)', async () => {
        const inv = await mkInv({ currentStock: 2, unit: 'L' });
        const res = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'waste', quantity: 2.001 });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Insufficient stock. Current: 2 L, Trying to deduct: 2.001');
        expect((await reloadInv(inv._id)).currentStock).toBe(2);
    });

    test('restock / correction above maxStock are refused; exactly maxStock is allowed', async () => {
        const inv = await mkInv({ currentStock: 8, maxStock: 10 });
        const over = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'restock', quantity: 2.5 });
        expect(over.status).toBe(400);
        expect(over.body.message).toBe('Cannot exceed max stock of 10 kg. Current: 8, Trying to add: 2.5');
        const corr = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'correction', quantity: 11 });
        expect(corr.status).toBe(400);
        const ok = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'restock', quantity: 2 });
        expect(ok.status).toBe(200);
        expect((await reloadInv(inv._id)).currentStock).toBe(10);
    });

    test('unknown item id → 404', async () => {
        const res = await admin().patch(`/inventory/${new mongoose.Types.ObjectId()}/adjust`).send({ type: 'usage', quantity: 1 });
        expect(res.status).toBe(404);
    });

    test('sequential usage keeps an exact running total and a complete audit trail', async () => {
        const inv = await mkInv({ currentStock: 10, minStock: 0 });
        for (const q of [1.25, 2.5, 0.125]) {
            expect((await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'usage', quantity: q })).status).toBe(200);
        }
        const saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBe(6.125);
        expect(saved.adjustmentHistory.map((h) => [h.previousStock, h.quantity, h.newStock]))
            .toEqual([[10, 1.25, 8.75], [8.75, 2.5, 6.25], [6.25, 0.125, 6.125]]);
    });

    test('two concurrent usages of the whole stock: exactly one wins (optimistic currentStock guard)', async () => {
        const inv = await mkInv({ currentStock: 3, minStock: 0 });
        const [a, b] = await Promise.all([
            admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'usage', quantity: 3 }),
            admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'usage', quantity: 3 }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, expect.any(Number)]);
        expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
        const saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBe(0);
        expect(saved.adjustmentHistory).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('low-stock thresholds, alerts and notifications', () => {
    test('usage crossing minStock → low-stock, then to zero → out-of-stock; each transition notifies once', async () => {
        const name = `Ghee ${uniq()}`;
        const inv = await mkInv({ name, currentStock: 10, minStock: 4 });

        let res = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'usage', quantity: 6 }); // 4 = min → low
        expect(res.body.item.status).toBe('low-stock');
        expect((await reloadInv(inv._id)).status).toBe('low-stock');

        res = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'usage', quantity: 1 }); // still low: no new alert
        expect(res.body.item.status).toBe('low-stock');

        res = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'usage', quantity: 3 });
        expect(res.body.item.status).toBe('out-of-stock');
        expect((await reloadInv(inv._id)).status).toBe('out-of-stock');

        const notes = await Notification.find({ restaurant: A.restaurant._id, description: { $regex: name } }).sort({ createdAt: 1 }).lean();
        expect(notes.map((n) => n.title)).toEqual(['Low stock alert', 'Out of stock']);
        expect(notes[0].description).toContain(`${name} dropped to 4 kg`);
        expect(notes[1].priority).toBe('high');

        res = await admin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'restock', quantity: 20 });
        expect(res.body.item.status).toBe('in-stock');
    });

    test('GET /alerts lists items at/below min (status recomputed even when the stored one is stale)', async () => {
        const low = await mkInv({ name: `AlertLow ${uniq()}`, currentStock: 9, minStock: 5 });
        // Stale row: stock dropped by a raw write that bypassed the hook.
        await Inventory.updateOne({ _id: low._id }, { $set: { currentStock: 2 } });
        const fine = await mkInv({ name: `AlertFine ${uniq()}`, currentStock: 9, minStock: 5 });

        const res = await admin().get('/inventory/alerts');
        expect(res.status).toBe(200);
        const row = res.body.stockAlerts.find((r) => r._id === String(low._id));
        expect(row).toMatchObject({ currentStock: 2, minStock: 5, status: 'low-stock' });
        expect(res.body.stockAlerts.find((r) => r._id === String(fine._id))).toBeUndefined();
    });

    test('GET /inventory?status=low-stock filters on live numbers and self-heals the stored status', async () => {
        const inv = await mkInv({ name: `Heal ${uniq()}`, currentStock: 9, minStock: 5 });
        await Inventory.updateOne({ _id: inv._id }, { $set: { currentStock: 3 } }); // stored status still in-stock
        const res = await admin().get('/inventory?status=low-stock&limit=100');
        expect(res.status).toBe(200);
        expect(res.body.items.find((i) => i._id === String(inv._id))).toMatchObject({ status: 'low-stock' });
        const healed = await waitFor(async () => (await reloadInv(inv._id)).status === 'low-stock');
        expect(healed).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('recipes', () => {
    test('saveRecipe validation', async () => {
        const dish = await mkDish();
        const inv = await mkInv();
        const cases = [
            [{ ingredients: [{ inventoryItem: String(inv._id), quantity: 1, unit: 'kg' }] }, 400, 'Valid menuItemId is required'],
            [{ menuItemId: String(dish._id), ingredients: [] }, 400, 'At least one ingredient is required'],
            [{ menuItemId: String(new mongoose.Types.ObjectId()), ingredients: [{ inventoryItem: String(inv._id), quantity: 1, unit: 'kg' }] }, 404, 'Menu item not found'],
            [{ menuItemId: String(dish._id), ingredients: [{ inventoryItem: String(new mongoose.Types.ObjectId()), quantity: 1, unit: 'kg' }] }, 400, 'No valid ingredients provided'],
            [{ menuItemId: String(dish._id), ingredients: [{ inventoryItem: String(inv._id), quantity: 0, unit: 'kg' }] }, 400, 'No valid ingredients provided'],
            [{ menuItemId: String(dish._id), ingredients: [{ inventoryItem: String(inv._id), quantity: -2, unit: 'kg' }] }, 400, 'No valid ingredients provided'],
        ];
        for (const [body, status, message] of cases) {
            const res = await admin().post('/inventory/recipes').send(body);
            expect({ status: res.status, message: res.body.message }).toEqual({ status, message });
        }
        expect(await Recipe.countDocuments({ menuItem: dish._id })).toBe(0);
    });

    // Regression (fixed 2026-10): saveRecipe refuses an ingredient unit outside ALLOWED_UNITS with 400.
    test('saveRecipe with an out-of-enum ingredient unit returns 400', async () => {
        const dish = await mkDish();
        const inv = await mkInv();
        const res = await admin().post('/inventory/recipes').send({
            menuItemId: String(dish._id), ingredients: [{ inventoryItem: String(inv._id), quantity: 1, unit: 'tbsp' }],
        });
        expect(res.status).toBe(400);
    });

    test('save then re-save upserts ONE recipe; invalid ingredient rows are dropped; menu item mirrors names', async () => {
        const dish = await mkDish(200);
        const paneer = await mkInv({ name: `Paneer ${uniq()}`, unit: 'kg', costPerUnit: 300 });
        const plates = await mkInv({ name: `Plate ${uniq()}`, unit: 'pcs', costPerUnit: 5 });
        let res = await admin().post('/inventory/recipes').send({
            menuItemId: String(dish._id),
            ingredients: [
                { inventoryItem: String(paneer._id), quantity: 250, unit: 'g' },
                { inventoryItem: String(new mongoose.Types.ObjectId()), quantity: 1, unit: 'kg' }, // dropped
            ],
            yield: 1, notes: 'v1',
        });
        expect(res.status).toBe(200);
        res = await admin().post('/inventory/recipes').send({
            menuItemId: String(dish._id),
            ingredients: [
                { inventoryItem: String(paneer._id), quantity: 250, unit: 'g' },
                { inventoryItem: String(plates._id), quantity: 2, unit: 'pcs' },
            ],
            yield: 1, notes: 'v2', recipeType: 'bogus', prepLossPercent: 500,
        });
        expect(res.status).toBe(200);

        const all = await Recipe.find({ menuItem: dish._id }).lean();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ notes: 'v2', recipeType: 'finished', prepLossPercent: 95, branch: null });
        expect(all[0].ingredients.map((i) => [String(i.inventoryItem), i.quantity, i.unit]))
            .toEqual([[String(paneer._id), 250, 'g'], [String(plates._id), 2, 'pcs']]);
        const mi = await MenuItem.findById(dish._id).lean();
        expect(mi.ingredients).toEqual([paneer.name, plates.name]);
    });

    test.each([
        // yield, prepLoss%, expected food cost, expected margin %
        // ingredients: 250 g of ₹300/kg (= ₹75) + 2 pcs of ₹5 (= ₹10) → ₹85 per batch
        [1, 0, 85, 57.5],
        [2, 0, 42.5, 78.8],
        [2, 15, 50, 75],
    ])('food cost: yield %p, prep loss %p%% → ₹%p, margin %p%% (unit conversion g→kg)', async (y, loss, cost, margin) => {
        const dish = await mkDish(200);
        const paneer = await mkInv({ unit: 'kg', costPerUnit: 300 });
        const plates = await mkInv({ unit: 'pcs', costPerUnit: 5 });
        await mkRecipe(dish, [
            { inventoryItem: paneer._id, quantity: 250, unit: 'g' },
            { inventoryItem: plates._id, quantity: 2, unit: 'pcs' },
        ], { yield: y, prepLossPercent: loss });

        const one = await admin().get(`/inventory/recipes/${dish._id}`);
        expect(one.status).toBe(200);
        expect(one.body.foodCost).toBe(cost);
        expect(one.body.margin).toBe(margin);

        const list = await admin().get('/inventory/recipes');
        const row = list.body.recipes.find((r) => String(r.menuItem._id) === String(dish._id));
        expect(row).toMatchObject({ foodCost: cost, margin });

        const report = await admin().get('/inventory/food-cost');
        const line = report.body.report.find((r) => String(r.menuItemId) === String(dish._id));
        expect(line).toMatchObject({ foodCost: cost, sellingPrice: 200, profitPerUnit: Math.round((200 - cost) * 100) / 100 });
        expect(line.ingredientCosts.map((c) => c.lineCost)).toEqual([75, 10]);
    });

    test('GET /recipes/:menuItemId with no recipe → 404; DELETE removes it, second DELETE → 404', async () => {
        const dish = await mkDish();
        expect((await admin().get(`/inventory/recipes/${dish._id}`)).status).toBe(404);
        const inv = await mkInv();
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 1, unit: 'kg' }]);
        expect((await admin().delete(`/inventory/recipes/${dish._id}`)).status).toBe(200);
        expect(await Recipe.countDocuments({ menuItem: dish._id })).toBe(0);
        expect((await admin().delete(`/inventory/recipes/${dish._id}`)).status).toBe(404);
    });

    test('a chef (manageRecipe) can save a recipe — it is owned by the chef\'s branch — but not delete it', async () => {
        const dish = await mkDish();
        const inv = await mkInv();
        const res = await ctx.api.as(A.users.chef).post('/inventory/recipes').send({
            menuItemId: String(dish._id), ingredients: [{ inventoryItem: String(inv._id), quantity: 0.2, unit: 'kg' }],
        });
        expect(res.status).toBe(200);
        const saved = await Recipe.findOne({ menuItem: dish._id }).lean();
        expect(String(saved.branch)).toBe(String(A.branch._id));
        expect((await ctx.api.as(A.users.chef).delete(`/inventory/recipes/${dish._id}`)).status).toBe(403);
        expect((await ctx.api.as(A.users.waiter).post('/inventory/recipes').send({})).status).toBe(403);
    });

    test('menu-issues: unit mismatch → config, zero stock → out, at min → low (worst wins)', async () => {
        const dOut = await mkDish(); const dLow = await mkDish(); const dCfg = await mkDish(); const dOk = await mkDish();
        const out = await mkInv({ currentStock: 0, minStock: 1 });
        const low = await mkInv({ currentStock: 1, minStock: 1 });
        const bottles = await mkInv({ unit: 'bottle', currentStock: 50, minStock: 1 });
        const ok = await mkInv({ currentStock: 50, minStock: 1 });
        await mkRecipe(dOut, [{ inventoryItem: low._id, quantity: 1, unit: 'kg' }, { inventoryItem: out._id, quantity: 1, unit: 'kg' }]);
        await mkRecipe(dLow, [{ inventoryItem: low._id, quantity: 1, unit: 'kg' }]);
        await mkRecipe(dCfg, [{ inventoryItem: bottles._id, quantity: 300, unit: 'mL' }]);
        await mkRecipe(dOk, [{ inventoryItem: ok._id, quantity: 1, unit: 'kg' }]);

        const res = await admin().get('/inventory/menu-issues');
        expect(res.status).toBe(200);
        expect(res.body.issues[String(dOut._id)].level).toBe('out');
        expect(res.body.issues[String(dLow._id)].level).toBe('low');
        expect(res.body.issues[String(dCfg._id)]).toEqual({
            level: 'config', reasons: [`${bottles.name}: unit mismatch (recipe mL vs stock bottle)`],
        });
        expect(res.body.issues[String(dOk._id)]).toBeUndefined();
    });

    // Admin → Inventory → Recipes lists newest activity first, so a recipe
    // the admin just created (or edited) is the first row on page 1.
    test('GET /inventory/recipes puts the most recently created / edited recipe first', async () => {
        const inv = await mkInv();
        const first = await mkDish();
        const secondDish = await mkDish();
        const body = (dish, qty) => ({ menuItemId: String(dish._id), ingredients: [{ inventoryItem: String(inv._id), quantity: qty, unit: 'kg' }], yield: 1 });

        expect((await admin().post('/inventory/recipes').send(body(first, 0.1))).status).toBe(200);
        await settle(20);
        expect((await admin().post('/inventory/recipes').send(body(secondDish, 0.2))).status).toBe(200);

        let list = await admin().get('/inventory/recipes');
        expect(list.status).toBe(200);
        let ids = list.body.recipes.map((r) => String(r.menuItem._id));
        expect(ids[0]).toBe(String(secondDish._id));
        expect(ids[1]).toBe(String(first._id));

        // Editing the older recipe moves it back to the top.
        await settle(20);
        expect((await admin().post('/inventory/recipes').send(body(first, 0.3))).status).toBe(200);
        list = await admin().get('/inventory/recipes');
        ids = list.body.recipes.map((r) => String(r.menuItem._id));
        expect(ids[0]).toBe(String(first._id));
        expect(ids[1]).toBe(String(secondDish._id));
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('order → inventory: deduction on preparing, restore on cancel', () => {
    test('end to end: 2 lines, g→kg and mL→L conversions, qty × recipe; exact stock + history', async () => {
        const curry = await mkDish(180);
        const bread = await mkDish(40);
        const paneer = await mkInv({ name: `E2E Paneer ${uniq()}`, unit: 'kg', currentStock: 5, minStock: 1 });
        const oil = await mkInv({ name: `E2E Oil ${uniq()}`, unit: 'L', currentStock: 2, minStock: 0.5 });
        const flour = await mkInv({ name: `E2E Flour ${uniq()}`, unit: 'g', currentStock: 1000, minStock: 0 });
        await mkRecipe(curry, [
            { inventoryItem: paneer._id, quantity: 150, unit: 'g' },
            { inventoryItem: oil._id, quantity: 20, unit: 'mL' },
        ]);
        await mkRecipe(bread, [
            { inventoryItem: flour._id, quantity: 0.08, unit: 'kg' },
            { inventoryItem: oil._id, quantity: 5, unit: 'mL' },
        ]);

        const order = await placeOk([[curry, 2], [bread, 3]]);
        expect((await reloadOrder(order._id)).inventoryDeducted).toBe(false);
        // Placing the order alone does not touch stock.
        expect((await reloadInv(paneer._id)).currentStock).toBe(5);

        await startPreparing(order);
        const p = await reloadInv(paneer._id);
        const o = await reloadInv(oil._id);
        const f = await reloadInv(flour._id);
        expect(p.currentStock).toBeCloseTo(4.7, 10);          // 5 − 2 × 0.150
        expect(o.currentStock).toBeCloseTo(1.945, 10);        // 2 − 2 × 0.020 − 3 × 0.005
        expect(f.currentStock).toBeCloseTo(760, 10);          // 1000 − 3 × 80
        expect(p.adjustmentHistory.at(-1)).toMatchObject({ type: 'usage', quantity: 0.3, previousStock: 5 });
        expect(p.adjustmentHistory.at(-1).reason).toBe(`Auto: Order ${order.orderId} — ${curry.name} ×2`);
        expect(String(p.adjustmentHistory.at(-1).adjustedBy)).toBe(String(A.users.chef._id));
        expect(o.adjustmentHistory.slice(-2).map((h) => h.quantity)).toEqual([0.04, 0.015]);
        expect(f.adjustmentHistory.at(-1).quantity).toBe(240);
    });

    test('cancel after preparing restores exactly; a second cancel / restore never restores twice', async () => {
        const dish = await mkDish(150);
        const inv = await mkInv({ unit: 'kg', currentStock: 3, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 400, unit: 'g' }]);
        const order = await placeOk([[dish, 2]]);
        await startPreparing(order);
        expect((await reloadInv(inv._id)).currentStock).toBeCloseTo(2.2, 10);

        expect((await patchStatus(A.users.admin, order._id, { status: 'cancelled' })).status).toBe(200);
        const restored = await waitFor(async () => (await reloadOrder(order._id)).inventoryDeducted === false);
        expect(restored).toBe(true);
        await settle(150);
        let saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBeCloseTo(3, 10);
        expect(saved.adjustmentHistory.at(-1)).toMatchObject({ type: 'return', quantity: 0.8 });
        expect(saved.adjustmentHistory.at(-1).reason).toBe(`Auto: Cancelled Order ${order.orderId} — ${dish.name} ×2`);

        // A second cancel is refused by the state machine, and a direct
        // second restore is a no-op because the flag was already flipped.
        const again = await patchStatus(A.users.admin, order._id, { status: 'cancelled' });
        expect(again.status).toBeGreaterThanOrEqual(400);
        const doc = await Order.findById(order._id);
        const direct = await inventoryController.restoreInventoryForOrder(doc, A.restaurant._id, null);
        expect(direct.restored).toEqual([]);
        expect(direct.skipped).toEqual([{ reason: 'not-deducted', order: order.orderId }]);
        await settle(100);
        saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBeCloseTo(3, 10);
        expect(saved.adjustmentHistory.filter((h) => h.type === 'return')).toHaveLength(1);
    });

    test('cancelling an order that was never prepared does not restore anything', async () => {
        const dish = await mkDish(150);
        const inv = await mkInv({ currentStock: 3 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 1, unit: 'kg' }]);
        const order = await placeOk([[dish, 1]]);
        expect((await patchStatus(A.users.admin, order._id, { status: 'cancelled' })).status).toBe(200);
        await settle(250);
        const saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBe(3);
        expect(saved.adjustmentHistory).toHaveLength(0);
    });

    test('deductInventoryForOrder is idempotent: a second call is skipped as already-deducted', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ currentStock: 10, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 1, unit: 'kg' }]);
        const order = await placeOk([[dish, 1]]);
        const doc = await Order.findById(order._id);

        const first = await inventoryController.deductInventoryForOrder(doc, A.restaurant._id, null);
        expect(first.deducted).toEqual([expect.objectContaining({ deducted: 1, unit: 'kg', remaining: 9, status: 'in-stock' })]);
        const second_ = await inventoryController.deductInventoryForOrder(doc, A.restaurant._id, null);
        expect(second_).toEqual({ deducted: [], errors: [], skipped: [{ reason: 'already-deducted', order: order.orderId }] });
        expect((await reloadInv(inv._id)).currentStock).toBe(9);
    });

    test('missing recipe → skipped; unit mismatch / deleted ingredient → errors list; the rest still deducts', async () => {
        const noRecipe = await mkDish(50);
        const dish = await mkDish(120);
        const good = await mkInv({ unit: 'kg', currentStock: 4, minStock: 0 });
        const bottles = await mkInv({ name: `Soda ${uniq()}`, unit: 'bottle', currentStock: 12, minStock: 0 });
        const ghostId = new mongoose.Types.ObjectId();
        const recipe = await mkRecipe(dish, [
            { inventoryItem: bottles._id, quantity: 330, unit: 'mL' },   // mL ↔ bottle: no conversion
            { inventoryItem: good._id, quantity: 500, unit: 'g' },
        ]);
        const order = await placeOk([[noRecipe, 1], [dish, 2]]);
        // The ingredient is deleted after the order passed the pre-flight.
        await Recipe.updateOne({ _id: recipe._id }, { $set: { ingredients: [
            recipe.ingredients[0], { inventoryItem: ghostId, quantity: 1, unit: 'kg' }, recipe.ingredients[1],
        ] } });
        const doc = await Order.findById(order._id);
        const result = await inventoryController.deductInventoryForOrder(doc, A.restaurant._id, null);

        expect(result.skipped).toEqual([{ menuItem: String(noRecipe._id), name: noRecipe.name, reason: 'No recipe defined' }]);
        expect(result.errors).toEqual([
            { inventoryItem: bottles._id, name: bottles.name, reason: 'Unit mismatch: recipe uses mL, inventory is bottle' },
            { inventoryItem: ghostId, reason: 'Inventory item not found' },
        ]);
        expect(result.deducted).toEqual([expect.objectContaining({ name: good.name, deducted: 1, remaining: 3 })]);
        expect((await reloadInv(bottles._id)).currentStock).toBe(12);
        expect((await reloadInv(good._id)).currentStock).toBe(3);
    });

    test('recipe yield: yield 4, 2 portions → half a batch of each ingredient', async () => {
        const dish = await mkDish(90);
        const inv = await mkInv({ unit: 'kg', currentStock: 10, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 2, unit: 'kg' }], { yield: 4 });
        const order = await placeOk([[dish, 2]]);
        const r = await inventoryController.deductInventoryForOrder(await Order.findById(order._id), A.restaurant._id, null);
        expect(r.deducted[0].deducted).toBe(1);
        expect((await reloadInv(inv._id)).currentStock).toBe(9);
    });

    test('branch-specific recipe wins over the tenant-wide one for an order at that branch', async () => {
        const dish = await mkDish(100);
        const shared = await mkInv({ name: `Shared ${uniq()}`, currentStock: 10, minStock: 0 });
        const mainOnly = await mkInv({ name: `MainOnly ${uniq()}`, branch: A.branch._id, currentStock: 10, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: shared._id, quantity: 1, unit: 'kg' }]);
        await mkRecipe(dish, [{ inventoryItem: mainOnly._id, quantity: 2, unit: 'kg' }], { branch: A.branch._id });

        // A Main-pinned waiter's order inherits the Main branch (guest orders carry branch null).
        const order = await placeOk([[dish, 1]], A.users.waiter);
        expect(String((await reloadOrder(order._id)).branch)).toBe(String(A.branch._id));
        await startPreparing(order);
        expect((await reloadInv(mainOnly._id)).currentStock).toBe(8);
        expect((await reloadInv(shared._id)).currentStock).toBe(10);
    });

    test('insufficient stock at deduction time: clamps to 0, out-of-stock, partial history + error (no crash)', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ name: `Short ${uniq()}`, unit: 'kg', currentStock: 5, minStock: 1 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 300, unit: 'g' }]);
        const order = await placeOk([[dish, 1]]); // pre-flight passes: 0.3 ≤ 5
        // Stock drops before the chef starts (e.g. wastage recorded meanwhile).
        await Inventory.updateOne({ _id: inv._id }, { $set: { currentStock: 0.1 } });

        const r = await inventoryController.deductInventoryForOrder(await Order.findById(order._id), A.restaurant._id, A.users.chef._id);
        expect(r.deducted).toEqual([]);
        expect(r.errors).toEqual([{ inventoryItem: inv._id, name: inv.name, reason: 'Insufficient: needed 0.3 kg, had 0.1' }]);
        const saved = await reloadInv(inv._id);
        expect(saved).toMatchObject({ currentStock: 0, status: 'out-of-stock' });
        expect(saved.adjustmentHistory.at(-1)).toMatchObject({ type: 'usage', quantity: 0.1, previousStock: 0.1, newStock: 0 });
    });

    // Regression (fixed 2026-10): deduction rows are tagged with the order; restoreInventoryForOrder adds back only what those rows say was taken.
    test('cancel after a PARTIAL deduction restores only what was actually deducted', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ unit: 'kg', currentStock: 5, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 300, unit: 'g' }]);
        const order = await placeOk([[dish, 1]]);
        await Inventory.updateOne({ _id: inv._id }, { $set: { currentStock: 0.1 } });
        const doc = await Order.findById(order._id);
        await inventoryController.deductInventoryForOrder(doc, A.restaurant._id, null);
        expect((await reloadInv(inv._id)).currentStock).toBe(0); // only 0.1 kg was really used

        await inventoryController.restoreInventoryForOrder(await Order.findById(order._id), A.restaurant._id, null);
        const saved = await reloadInv(inv._id);
        expect(saved.currentStock).toBeCloseTo(0.1, 10); // was 0.3 before the fix
    });

    test('restore is capped at maxStock (and records only what fit)', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ unit: 'kg', currentStock: 10, maxStock: 10, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 2, unit: 'kg' }]);
        const order = await placeOk([[dish, 1]]);
        await inventoryController.deductInventoryForOrder(await Order.findById(order._id), A.restaurant._id, null);
        await Inventory.updateOne({ _id: inv._id }, { $set: { currentStock: 9 } }); // restocked 1 kg meanwhile
        const r = await inventoryController.restoreInventoryForOrder(await Order.findById(order._id), A.restaurant._id, null);
        expect(r.restored).toEqual([expect.objectContaining({ restored: 1, newStock: 10 })]);
        expect((await reloadInv(inv._id)).currentStock).toBe(10);
    });

    // Regression (fixed 2026-10): deductInventoryForOrder uses a relative $inc guarded by $gte (Inventory.incStock), so concurrent deductions both land.
    test('two orders deducting the same ingredient concurrently both land', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ unit: 'kg', currentStock: 10, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 1, unit: 'kg' }]);
        const o1 = await placeOk([[dish, 1]]);
        const o2 = await placeOk([[dish, 1]]);
        const [d1, d2] = await Promise.all([Order.findById(o1._id), Order.findById(o2._id)]);
        const [r1, r2] = await Promise.all([
            inventoryController.deductInventoryForOrder(d1, A.restaurant._id, null),
            inventoryController.deductInventoryForOrder(d2, A.restaurant._id, null),
        ]);
        expect(r1.deducted).toHaveLength(1);
        expect(r2.deducted).toHaveLength(1);
        const saved = await reloadInv(inv._id);
        expect(saved.adjustmentHistory.filter((h) => h.type === 'usage')).toHaveLength(2);
        expect(saved.currentStock).toBe(8); // was 9 before the fix
    });

    test('a counter-only order (no kitchen work) deducts at creation, not at preparing', async () => {
        const water = await mkDish(20, { prepStation: 'counter' });
        const bottles = await mkInv({ unit: 'bottle', currentStock: 24, minStock: 0 });
        await mkRecipe(water, [{ inventoryItem: bottles._id, quantity: 1, unit: 'bottle' }]);
        const order = await placeOk([[water, 3]]);
        expect(order.status).toBe('ready');
        const saved = await waitFor(async () => {
            const i = await reloadInv(bottles._id);
            return i.currentStock !== 24 ? i : null;
        });
        expect(saved.currentStock).toBe(21);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('createOrder stock pre-flight (INSUFFICIENT_STOCK)', () => {
    test('needs are aggregated across lines: two lines that each fit but not together are refused', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ name: `Beans ${uniq()}`, unit: 'kg', currentStock: 1, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 300, unit: 'g' }]);
        const before = await Order.countDocuments({ restaurant: A.restaurant._id });

        const res = await placeOrder([[dish, 2], [dish, 2]]); // 4 × 0.3 = 1.2 kg > 1 kg
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INSUFFICIENT_STOCK');
        expect(res.body.shortages).toEqual([{ ingredient: String(inv._id), name: inv.name, needed: 1.2, available: 1, unit: 'kg' }]);
        expect(res.body.message).toBe(`Out of stock: ${inv.name} (need 1.2 kg, have 1 kg).`);
        expect(await Order.countDocuments({ restaurant: A.restaurant._id })).toBe(before);

        const ok = await placeOrder([[dish, 2], [dish, 1]]); // 0.9 kg fits
        expect(ok.status).toBe(201);
    });

    test('exactly the available stock is accepted (boundary)', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ unit: 'L', currentStock: 1, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 250, unit: 'mL' }]);
        expect((await placeOrder([[dish, 4]])).status).toBe(201);
        expect((await placeOrder([[dish, 5]])).status).toBe(400);
    });

    test('a unit-mismatched ingredient is skipped (warning only) — the order is NOT blocked', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ unit: 'bottle', currentStock: 0, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 500, unit: 'mL' }]);
        expect((await placeOrder([[dish, 1]])).status).toBe(201);
        const check = await inventoryController.checkInventoryForOrder([{ menuItem: dish._id, quantity: 1 }], A.restaurant._id, A.branch._id);
        expect(check.ok).toBe(true);
        expect(check.warnings).toEqual([expect.objectContaining({ reason: 'Unit mismatch mL↔bottle — ingredient not stock-checked' })]);
    });

    test('a recipe pointing at a deleted ingredient blocks the order (INVENTORY_MISSING)', async () => {
        const dish = await mkDish(100);
        await mkRecipe(dish, [{ inventoryItem: new mongoose.Types.ObjectId(), quantity: 1, unit: 'kg' }]);
        const res = await placeOrder([[dish, 1]]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INSUFFICIENT_STOCK');
        expect(res.body.shortages[0]).toMatchObject({ reason: 'INVENTORY_MISSING', name: '(deleted ingredient)' });
    });

    // Regression (fixed 2026-10): every stock write rounds to 3 decimals (Inventory.roundQty) and the pre-flight compares rounded values.
    test('300 g stock, three 100 g orders — the third is accepted (quantities rounded)', async () => {
        const dish = await mkDish(100);
        const inv = await mkInv({ name: `Drift ${uniq()}`, unit: 'kg', currentStock: 0.3, minStock: 0 });
        await mkRecipe(dish, [{ inventoryItem: inv._id, quantity: 100, unit: 'g' }]);
        for (let i = 0; i < 2; i++) {
            const o = await placeOk([[dish, 1]]);
            await startPreparing(o);
        }
        const left = (await reloadInv(inv._id)).currentStock;
        expect(left).toBeCloseTo(0.1, 10);
        const third = await placeOrder([[dish, 1]]);
        expect({ status: third.status, stored: left }).toEqual({ status: 201, stored: 0.1 });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('cross-branch writes by a branch-pinned Sub Admin', () => {
    // Regression (fixed 2026-10): adjustStock / updateItem / deleteItem apply the same strictBranchFilter as getItemById.
    test('Second-branch Sub Admin cannot read a Main-branch item', async () => {
        const inv = await mkInv({ branch: A.branch._id, currentStock: 10 });
        expect((await ctx.api.as(second.admin).get(`/inventory/${inv._id}`)).status).toBe(404);
    });

    test('Second-branch Sub Admin cannot adjust a Main-branch item\'s stock', async () => {
        const inv = await mkInv({ branch: A.branch._id, currentStock: 10 });
        const res = await ctx.api.as(second.admin).patch(`/inventory/${inv._id}/adjust`).send({ type: 'waste', quantity: 9 });
        expect(res.status).toBe(404);
        expect((await reloadInv(inv._id)).currentStock).toBe(10);
    });

    test('Second-branch Sub Admin cannot update or delete a Main-branch item', async () => {
        const inv = await mkInv({ branch: A.branch._id, currentStock: 10 });
        expect((await ctx.api.as(second.admin).put(`/inventory/${inv._id}`).send({ costPerUnit: 1 })).status).toBe(404);
        expect((await ctx.api.as(second.admin).delete(`/inventory/${inv._id}`)).status).toBe(404);
        const saved = await reloadInv(inv._id);
        expect(saved).not.toBeNull();
        expect(saved.costPerUnit).toBe(100);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('CSV bulk import', () => {
    const upload = (url, csv, name = 'items.csv') =>
        admin().post(url).attach('file', Buffer.from(csv, 'utf8'), { filename: name, contentType: 'text/csv' });

    test('inventory import: good rows created/updated, bad rows reported by CSV row number', async () => {
        const existing = await mkInv({ name: `CsvExisting ${uniq()}`, category: 'Dairy & Eggs', currentStock: 10, minStock: 1 });
        const fresh = `CsvFresh ${uniq()}`;
        const csv = [
            'Name,Category,Unit,MinStock,CostPerUnit,CurrentStock,MaxStock,SupplierName',
            `${fresh},Raw Ingredients,kg,2,45.5,12.75,50,Agro Mart`,          // row 2: created
            `${existing.name.toLowerCase()},Dairy & Eggs,kg,1,99,4,0,`,       // row 3: updated (10 → 4)
            `Bad Unit ${uniq()},Other,lbs,1,1,1,0,`,                          // row 4
            `Neg Stock ${uniq()},Other,kg,1,1,-3,0,`,                         // row 5
            `,Other,kg,1,1,1,0,`,                                             // row 6
            `Min Max ${uniq()},Other,kg,9,1,1,5,`,                            // row 7
            `Bad Cat ${uniq()},Meat,kg,1,1,1,0,`,                             // row 8
            `Bad Cost ${uniq()},Other,kg,1,abc,1,0,`,                         // row 9
        ].join('\r\n');
        const res = await upload('/inventory/import', csv);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, created: 1, updated: 1, errorCount: 6 });
        expect(res.body.errors.map((e) => e.row)).toEqual([4, 5, 6, 7, 8, 9]);
        expect(res.body.errors[0].message).toMatch(/^unit must be one of/);
        expect(res.body.errors[1].message).toBe('currentStock must be a non-negative number');
        expect(res.body.errors[2].message).toBe('name is required');
        expect(res.body.errors[3].message).toBe('minStock (9) cannot exceed maxStock (5)');

        const created = await Inventory.findOne({ restaurant: A.restaurant._id, name: fresh }).lean();
        expect(created).toMatchObject({ unit: 'kg', currentStock: 12.75, minStock: 2, maxStock: 50, costPerUnit: 45.5, status: 'in-stock' });
        expect(created.supplier.name).toBe('Agro Mart');
        expect(created.adjustmentHistory[0]).toMatchObject({ type: 'restock', quantity: 12.75, reason: 'CSV import — initial stock' });

        const upd = await reloadInv(existing._id);
        expect(upd).toMatchObject({ currentStock: 4, costPerUnit: 99 });
        expect(upd.adjustmentHistory.at(-1)).toMatchObject({ type: 'correction', quantity: 6, previousStock: 10, newStock: 4, reason: 'CSV import' });
    });

    test('formula-looking names ("=cmd|…") are stored verbatim (no sanitisation on import)', async () => {
        const evil = `=cmd|' /C calc'!A0 ${uniq()}`;
        const res = await upload('/inventory/import', `name,category,unit,minStock,costPerUnit\n"${evil}",Other,pcs,0,1\n`);
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(1);
        const saved = await Inventory.findOne({ restaurant: A.restaurant._id, name: evil }).lean();
        expect(saved).toBeTruthy(); // documented in the report as a CSV-injection risk for any export
    });

    test.each([
        ['missing required columns', 'name,category,unit\nx,Other,kg\n', 'CSV missing required columns: minStock, costPerUnit'],
        ['header only', 'name,category,unit,minStock,costPerUnit\n', 'CSV must contain a header row and at least one data row'],
    ])('inventory import: %s → 400', async (_l, csv, message) => {
        const res = await upload('/inventory/import', csv);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
    });

    test('inventory import without a file → 400', async () => {
        const res = await admin().post('/inventory/import').send({});
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('CSV file is required (form field: file)');
    });

    test('recipe import: rows grouped per menu item, upserted; bad rows reported', async () => {
        const dish = await mkDish(150);
        const dish2 = await mkDish(150);
        const onion = await mkInv({ name: `RcOnion ${uniq()}`, unit: 'kg' });
        const oil = await mkInv({ name: `RcOil ${uniq()}`, unit: 'L' });
        const csv = [
            'menuItemName,inventoryItemName,quantity,unit,yield,notes',
            `${dish.name},${onion.name},200,g,2,first`,       // row 2
            `${dish.name.toUpperCase()},${oil.name},30,mL,,`, // row 3 (same group, case-insensitive)
            `${dish2.name},Nope ${uniq()},1,kg,,`,            // row 4 unknown ingredient
            `${dish2.name},${onion.name},0,kg,,`,             // row 5 bad qty
            `${dish2.name},${oil.name},1,tbsp,,`,             // row 6 bad unit
            `Ghost Dish ${uniq()},${onion.name},1,kg,,`,      // row 7 unknown menu item
            `,${onion.name},1,kg,,`,                           // row 8 no menu name
        ].join('\n');
        const res = await upload('/inventory/recipes/import', csv, 'recipes.csv');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ created: 1, updated: 0, errorCount: 5 });
        expect(res.body.errors.map((e) => e.row).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8]);

        const r = await Recipe.findOne({ menuItem: dish._id }).lean();
        expect(r).toMatchObject({ yield: 2, notes: 'first', branch: null });
        expect(r.ingredients.map((i) => [String(i.inventoryItem), i.quantity, i.unit]))
            .toEqual([[String(onion._id), 200, 'g'], [String(oil._id), 30, 'mL']]);
        expect(await Recipe.countDocuments({ menuItem: dish2._id })).toBe(0);

        const again = await upload('/inventory/recipes/import', `menuItemName,inventoryItemName,quantity,unit\n${dish.name},${onion.name},250,g\n`, 'recipes.csv');
        expect(again.body).toMatchObject({ created: 0, updated: 1, errorCount: 0 });
        const r2 = await Recipe.findOne({ menuItem: dish._id }).lean();
        expect(r2.ingredients).toHaveLength(1);
        expect(r2.ingredients[0].quantity).toBe(250);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('reports: valuation, stock movement, consumption', () => {
    let T;          // a fresh tenant so totals are not polluted by other tests
    let items;

    beforeAll(async () => {
        T = await seedTenant({ label: 'invrep' });
        const mk = (f) => Inventory.create({ restaurant: T.restaurant._id, branch: null, itemId: `INV-R${uniq()}`, minStock: 1, ...f });
        items = {
            rice: await mk({ name: 'Rep Rice', category: 'Raw Ingredients', unit: 'kg', currentStock: 12.5, costPerUnit: 64.4 }),
            milk: await mk({ name: 'Rep Milk', category: 'Dairy & Eggs', unit: 'L', currentStock: 3, costPerUnit: 56 }),
            box: await mk({ name: 'Rep Box', category: 'Packaging', unit: 'pcs', currentStock: 0, costPerUnit: 7.25 }),
        };
        const adj = (inv, body) => ctx.api.as(T.users.admin).patch(`/inventory/${inv._id}/adjust`).send(body);
        expect((await adj(items.rice, { type: 'usage', quantity: 2.5 })).status).toBe(200);   // 10
        expect((await adj(items.rice, { type: 'waste', quantity: 0.5 })).status).toBe(200);   // 9.5
        expect((await adj(items.rice, { type: 'restock', quantity: 5 })).status).toBe(200);   // 14.5
        expect((await adj(items.milk, { type: 'usage', quantity: 1.25 })).status).toBe(200);  // 1.75
        expect((await adj(items.milk, { type: 'correction', quantity: 2 })).status).toBe(200); // 2
    });

    test('summary: totalValue = Σ qty × cost, live low/out counts, today consumption and wastage', async () => {
        const res = await ctx.api.as(T.users.admin).get('/inventory/summary');
        expect(res.status).toBe(200);
        // 14.5 × 64.4 = 933.8 ; 2 × 56 = 112 ; 0 × 7.25 = 0
        expect(res.body.summary).toMatchObject({
            totalItems: 3, outOfStock: 1, lowStock: 0, inStock: 2, totalValue: 1045.8,
            todayConsumption: 231, todayConsumptionCount: 2,  // 2.5 × 64.4 + 1.25 × 56 = 161 + 70
            todayWastage: 32.2, todayWastageCount: 1,          // 0.5 × 64.4
        });
        expect(res.body.summary.categoryBreakdown['Raw Ingredients']).toEqual({ count: 1, value: 933.8 });
    });

    test('stock report: opening = closing − net movement; received / consumed; closing value', async () => {
        const res = await ctx.api.as(T.users.admin).get('/inventory/reports/stock?days=7');
        expect(res.status).toBe(200);
        const byName = Object.fromEntries(res.body.report.map((r) => [r.name, r]));
        expect(byName['Rep Rice']).toMatchObject({ opening: 12.5, received: 5, consumed: 3, closing: 14.5, closingValue: 933.8 });
        expect(byName['Rep Milk']).toMatchObject({ opening: 3, received: 0, consumed: 1.25, closing: 2, closingValue: 112 });
        expect(res.body.totals.closingValue).toBe(1045.8);
    });

    test('consumption report: usage + waste per item valued at cost; total', async () => {
        const res = await ctx.api.as(T.users.admin).get('/inventory/reports/consumption?days=7');
        expect(res.status).toBe(200);
        expect(res.body.byItem).toEqual([
            { name: 'Rep Rice', unit: 'kg', usage: 2.5, waste: 0.5, cost: 193.2 },
            { name: 'Rep Milk', unit: 'L', usage: 1.25, waste: 0, cost: 70 },
        ]);
        expect(res.body.totalCost).toBe(263.2);
        expect(res.body.byDay).toHaveLength(1);
        expect(res.body.byDay[0].cost).toBe(263.2);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('actual vs theoretical usage', () => {
    let T;
    let dish;
    let inv;
    const tAdmin = () => ctx.api.as(T.users.admin);

    async function tOrder(qty) {
        const total = computeBill({ subtotal: 100 * qty, taxConfig: toTaxConfig(T.settings.taxes), orderType: 'takeaway' }).total;
        const res = await ctx.api.guest(T).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter', items: [{ menuItem: String(dish._id), quantity: qty }], total,
        });
        expect(res.status).toBe(201);
        const order = res.body.order;
        expect((await ctx.api.as(T.users.chef).patch(`/orders/${order._id}/status`).send({ status: 'preparing' })).status).toBe(200);
        await waitFor(async () => (await reloadOrder(order._id)).inventoryDeducted === true);
        await settle(150);
        return order;
    }

    beforeAll(async () => {
        T = await seedTenant({ label: 'avt' });
        dish = await MenuItem.create({
            restaurant: T.restaurant._id, category: T.category._id, name: 'AvT Pulao', description: 'x',
            basePrice: 100, prepStation: 'kitchen', vegType: 'veg',
        });
        inv = await Inventory.create({
            restaurant: T.restaurant._id, itemId: 'INV-AVT', name: 'AvT Rice', category: 'Raw Ingredients',
            unit: 'kg', currentStock: 10, minStock: 0, costPerUnit: 80,
        });
        await Recipe.create({ restaurant: T.restaurant._id, menuItem: dish._id, ingredients: [{ inventoryItem: inv._id, quantity: 200, unit: 'g' }] });
        await tOrder(3);                                                     // 0.6 kg theoretical = actual usage
        expect((await tAdmin().patch(`/inventory/${inv._id}/adjust`).send({ type: 'waste', quantity: 0.1 })).status).toBe(200);
    });

    test('theoretical (recipe × sold, g→kg) vs actual (usage + waste): exact variance and cost impact', async () => {
        const res = await tAdmin().get('/inventory/actual-vs-theoretical?days=7');
        expect(res.status).toBe(200);
        expect(res.body.report).toEqual([expect.objectContaining({
            name: 'AvT Rice', unit: 'kg', theoreticalUsage: 0.6, actualUsage: 0.7, variance: 0.1, variancePercent: 16.7, costImpact: 8,
        })]);
    });

    // Regression (fixed 2026-10): actual-vs-theoretical, consumption report and dashboard usage net out 'return' rows.
    test('a prepared-then-cancelled order nets out to no variance (returns counted)', async () => {
        const order = await tOrder(1);                                       // 0.2 kg usage …
        expect((await tAdmin().patch(`/orders/${order._id}/status`).send({ status: 'cancelled' })).status).toBe(200);
        await waitFor(async () => (await reloadOrder(order._id)).inventoryDeducted === false);
        await settle(150);
        expect((await reloadInv(inv._id)).currentStock).toBeCloseTo(9.3, 10); // … restored
        const res = await tAdmin().get('/inventory/actual-vs-theoretical?days=7');
        const row = res.body.report[0];
        expect({ actualUsage: row.actualUsage, variance: row.variance })
            .toEqual({ actualUsage: 0.7, variance: 0.1 });               // was 0.9 / 0.3 before the fix
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('remaining read / update paths', () => {
    test('GET /:id returns populated history capped at the last 50 entries and self-heals status', async () => {
        const history = Array.from({ length: 60 }, (_, i) => ({
            type: 'restock', quantity: 1, previousStock: i, newStock: i + 1, adjustedBy: A.users.admin._id, date: new Date(),
        }));
        const inv = await mkInv({ currentStock: 60, minStock: 1, adjustmentHistory: history });
        await Inventory.updateOne({ _id: inv._id }, { $set: { currentStock: 0 } }); // stored status still 'in-stock'
        const res = await admin().get(`/inventory/${inv._id}`);
        expect(res.status).toBe(200);
        expect(res.body.item.status).toBe('out-of-stock');
        expect(res.body.item.adjustmentHistory).toHaveLength(50);
        expect(res.body.item.adjustmentHistory[0].previousStock).toBe(10);
        expect(res.body.item.adjustmentHistory[0].adjustedBy.name).toBe(A.users.admin.name);
        expect(await waitFor(async () => (await reloadInv(inv._id)).status === 'out-of-stock')).toBe(true);
        expect((await admin().get(`/inventory/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    });

    test('PUT rename onto an existing name in the target category → 400; branch can be set and cleared', async () => {
        const a = await mkInv({ name: `RenA ${uniq()}`, category: 'Other' });
        const b = await mkInv({ name: `RenB ${uniq()}`, category: 'Other' });
        const dup = await admin().put(`/inventory/${b._id}`).send({ name: ` ${a.name.toUpperCase()} ` });
        expect(dup.status).toBe(400);
        expect(dup.body.message).toBe('An item with this name already exists in this category');

        expect((await admin().put(`/inventory/${b._id}`).send({ branch: String(A.branch._id) })).status).toBe(200);
        expect(String((await reloadInv(b._id)).branch)).toBe(String(A.branch._id));
        // An unknown branch id keeps the current branch.
        expect((await admin().put(`/inventory/${b._id}`).send({ branch: String(new mongoose.Types.ObjectId()) })).status).toBe(200);
        expect(String((await reloadInv(b._id)).branch)).toBe(String(A.branch._id));
        expect((await admin().put(`/inventory/${b._id}`).send({ branch: null })).status).toBe(200);
        expect((await reloadInv(b._id)).branch).toBeNull();
        expect((await admin().put(`/inventory/${new mongoose.Types.ObjectId()}`).send({ notes: 1 })).status).toBe(404);
    });

    test('GET / search (regex-escaped), category filter and sort', async () => {
        const tag = uniq();
        await mkInv({ name: `Srch(${tag}) Zeta`, category: 'Beverages', currentStock: 5 });
        await mkInv({ name: `Srch(${tag}) Alpha`, category: 'Beverages', currentStock: 9 });
        await mkInv({ name: `Srch(${tag}) Other`, category: 'Other' });
        const res = await admin().get(`/inventory?search=${encodeURIComponent(`(${tag})`)}&category=Beverages&sortBy=name&sortOrder=asc`);
        expect(res.status).toBe(200);
        expect(res.body.items.map((i) => i.name)).toEqual([`Srch(${tag}) Alpha`, `Srch(${tag}) Zeta`]);
        expect(res.body.pagination.total).toBe(2);
        expect(res.body.items[0].adjustmentHistory).toBeUndefined();
    });

    test('a Sub Admin-created item lands at the creator\'s pinned branch, whatever body.branch says', async () => {
        const res = await ctx.api.as(second.admin).post('/inventory').send({
            name: `Pinned ${uniq()}`, category: 'Other', unit: 'pcs', minStock: 0, costPerUnit: 1, branch: String(A.branch._id),
        });
        expect(res.status).toBe(201);
        expect(String((await reloadInv(res.body.item._id)).branch)).toBe(String(second.branch._id));
    });

    test('restore reports unit mismatch / deleted ingredient as errors without throwing', async () => {
        const dish = await mkDish(100);
        const good = await mkInv({ currentStock: 5, minStock: 0 });
        const order = await placeOk([[dish, 1]]);
        await Order.updateOne({ _id: order._id }, { $set: { inventoryDeducted: true } });
        const bottles = await mkInv({ unit: 'bottle', currentStock: 5 });
        const ghost = new mongoose.Types.ObjectId();
        await mkRecipe(dish, [
            { inventoryItem: bottles._id, quantity: 1, unit: 'L' },
            { inventoryItem: ghost, quantity: 1, unit: 'kg' },
            { inventoryItem: good._id, quantity: 1, unit: 'kg' },
        ]);
        const r = await inventoryController.restoreInventoryForOrder(await Order.findById(order._id), A.restaurant._id, null);
        expect(r.errors).toEqual([
            { inventoryItem: bottles._id, name: bottles.name, reason: 'Unit mismatch: L → bottle' },
            { inventoryItem: ghost, reason: 'Inventory item not found' },
        ]);
        expect(r.restored).toEqual([expect.objectContaining({ restored: 1, newStock: 6 })]);
        expect((await reloadInv(bottles._id)).currentStock).toBe(5);
    });
});
