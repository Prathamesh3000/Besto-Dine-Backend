/**
 * Order lifecycle through the real HTTP stack:
 * services/orderStatusService.js (PATCH /orders/:id/status),
 * services/orderLifecycleService.js (customer cancel, rating, admin
 * cleanup endpoints) and the utils/orderLifecycle.js state machine.
 *
 * orderFlow.test.js already covers the basic chef path (new → preparing
 * → ready, 409 going back, waiter pickup, cash settle frees the table,
 * waiter has no status permission, chef can't append). This suite adds:
 * the full from × to transition matrix, the per-role status / cancel
 * matrix, branch pinning, the atomic race guard, mark-paid side effects
 * (auto-serve, sibling rounds, tips, table release, inventory), customer
 * cancel, rating and the two admin cleanup endpoints.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, createUser } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));
const { computeBill, toTaxConfig } = req_('utils/billing');
const { canTransition } = req_('utils/orderLifecycle');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');
const { signTypedToken, TOKEN_TYPES } = req_('middlewares/authMiddleware');
const settingsCache = req_('utils/settingsCache');
const Order = req_('models/order');
const Table = req_('models/table');
const Tip = req_('models/tip');
const Area = req_('models/area');
const Branch = req_('models/branch');
const Settings = req_('models/settings');
const Inventory = req_('models/inventory');
const Recipe = req_('models/recipe');
const RefundRequest = req_('models/refundRequest');

const ctx = useIntegrationApp();
let A;          // tenant under test (Main branch + a Second branch)
let B;          // another tenant
let second;     // { branch, area, chef, captain, waiter, admin } pinned to the Second branch
let manager;    // manager pinned to Main
let chef2;      // second Main-branch chef (race tests)

const STATES = ['new', 'preparing', 'ready', 'served', 'cancelled'];

const bill = (subtotal, orderType = 'dine-in') =>
    computeBill({ subtotal, taxConfig: toTaxConfig(A.settings.taxes), orderType });

const paneer = (qty = 1) => [{ menuItem: String(A.items.paneer._id), quantity: qty }];

const staff = (role, extra = {}) => createUser({
    name: `${role} ${Math.random().toString(16).slice(2, 8)}`,
    email: `${role}.${Math.random().toString(16).slice(2, 10)}@lifecycle.test`,
    role,
    restaurant: A.restaurant._id,
    branch: A.branch._id,
    permissions: defaultPermissionsForRole(role),
    ...extra,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'life' });
    B = await seedTenant({ label: 'lifeb' });
    manager = await staff('manager');
    chef2 = await staff('chef');
    const branch = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    const area = await Area.create({ restaurant: A.restaurant._id, branch: branch._id, name: 'Second Hall' });
    second = {
        branch,
        area,
        chef: await staff('chef', { branch: branch._id }),
        captain: await staff('captain', { branch: branch._id }),
        waiter: await staff('waiter', { branch: branch._id }),
        admin: await staff('admin', { branch: branch._id, permissions: {} }),
    };
});

/** Guest takeaway (no table): 1 × Paneer = 200 + 5% GST + ₹20 = 230. */
async function takeaway() {
    const res = await ctx.api.guest(A).post('/orders').send({
        type: 'takeaway', pickupLocation: 'Counter', items: paneer(), total: bill(200, 'takeaway').total,
    });
    expect(res.status).toBe(201);
    return res.body.order;
}

/** Guest (or logged-in customer) dine-in order at `table`. */
async function dineIn({ table, scanToken, customer, qty = 1 } = {}) {
    const tbl = table || await createTable(A, { capacity: 6 });
    let token = scanToken;
    if (!token) ({ scanToken: token } = await scanTable(ctx.api, tbl));
    const client = customer ? ctx.api.customerAtTable(customer, A, token) : ctx.api.guest(A, token);
    const res = await client.post('/orders').send({
        type: 'dine-in', tableId: String(tbl._id), items: paneer(qty), total: bill(200 * qty).total,
    });
    expect(res.status).toBe(201);
    return { order: res.body.order, table: tbl, scanToken: token };
}

/** Staff-placed walk-in order (no customer, waiter stamped). */
async function staffOrder(user, table) {
    const res = await ctx.api.as(user).post('/orders').send({
        type: 'dine-in', tableId: String(table._id), items: paneer(), total: bill(200).total,
    });
    expect(res.status).toBe(201);
    return res.body.order;
}

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const forceStatus = (id, status) => Order.updateOne({ _id: id }, { $set: { status } });
const reload = (id) => Order.findById(id).lean();
const patchStatus = (user, id, body) => ctx.api.as(user).patch(`/orders/${id}/status`).send(body);

async function waitFor(fn, { timeout = 3000, step = 50 } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await settle(step);
    }
    return last;
}

describe('state machine: every from × to pair via PATCH /orders/:id/status (admin)', () => {
    const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to]));

    test.each(pairs)('%s → %s', async (from, to) => {
        const order = await takeaway();
        await forceStatus(order._id, from);
        const res = await patchStatus(A.users.admin, order._id, { status: to, cancellationReason: 'Guest left early' });
        const saved = await reload(order._id);
        if (canTransition(from, to)) {
            expect(res.status).toBe(200);
            expect(saved.status).toBe(to);
        } else {
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('INVALID_TRANSITION');
            expect(saved.status).toBe(from);
        }
    });

    test('an unknown target status is refused by the machine (409), the order is untouched', async () => {
        const order = await takeaway();
        const res = await patchStatus(A.users.admin, order._id, { status: 'completed' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INVALID_TRANSITION');
        expect((await reload(order._id)).status).toBe('new');
    });

    test('lookup by human orderId works; another tenant\'s admin gets 404', async () => {
        const order = await takeaway();
        const other = await patchStatus(B.users.admin, order._id, { status: 'preparing' });
        expect(other.status).toBe(404);
        const byHuman = await patchStatus(A.users.admin, order.orderId, { status: 'preparing' });
        expect(byHuman.status).toBe(200);
        expect((await reload(order._id)).status).toBe('preparing');
    });

    test('re-serving a served order does not move servedAt', async () => {
        const order = await takeaway();
        await forceStatus(order._id, 'ready');
        expect((await patchStatus(A.users.admin, order._id, { status: 'served' })).status).toBe(200);
        const first = (await reload(order._id)).servedAt;
        expect(first).toBeTruthy();
        await settle(20);
        expect((await patchStatus(A.users.admin, order._id, { status: 'served' })).status).toBe(200);
        expect((await reload(order._id)).servedAt.getTime()).toBe(first.getTime());
    });
});

describe('role matrix', () => {
    const roleUser = (role) => ({
        admin: A.users.admin, manager, captain: A.users.captain, waiter: A.users.waiter, chef: A.users.chef,
    })[role];

    test.each([
        ['admin', 200], ['manager', 200], ['captain', 200], ['chef', 200], ['waiter', 403],
    ])('%s starts preparing → %i', async (role, expected) => {
        const order = await takeaway();
        const res = await patchStatus(roleUser(role), order._id, { status: 'preparing' });
        expect(res.status).toBe(expected);
        const saved = await reload(order._id);
        if (expected === 200) {
            expect(saved.status).toBe('preparing');
            expect(saved.preparationStartedAt).toBeTruthy();
            // Only a chef "owns" the card.
            if (role === 'chef') expect(String(saved.chef)).toBe(String(A.users.chef._id));
            else expect(saved.chef == null).toBe(true);
        } else {
            expect(saved.status).toBe('new');
        }
    });

    test.each([
        // role, from, reason, status, code
        ['waiter', 'new', undefined, 200, null],
        ['chef', 'new', undefined, 200, null],
        ['admin', 'preparing', undefined, 200, null],
        ['waiter', 'ready', undefined, 400, 'CANCEL_REASON_REQUIRED'],
        ['waiter', 'ready', 'Wrong dish plated', 200, null],
        ['chef', 'ready', 'Burnt, remaking', 200, null],
        ['waiter', 'served', 'Guest complained', 403, 'CANCEL_REQUIRES_PRIVILEGE'],
        ['chef', 'served', 'Guest complained', 403, 'CANCEL_REQUIRES_PRIVILEGE'],
        ['captain', 'served', 'Guest complained', 200, null],
        ['manager', 'served', 'Guest complained', 200, null],
        ['admin', 'served', '  ab  ', 400, 'CANCEL_REASON_REQUIRED'],
    ])('%s cancels a %s order (reason %p) → %i %p', async (role, from, reason, expected, code) => {
        const order = await takeaway();
        await forceStatus(order._id, from);
        const user = roleUser(role);
        const body = { status: 'cancelled' };
        if (reason !== undefined) body.cancellationReason = reason;
        const res = await patchStatus(user, order._id, body);
        expect(res.status).toBe(expected);
        if (code) expect(res.body.code).toBe(code);
        const saved = await reload(order._id);
        if (expected === 200) {
            expect(saved.status).toBe('cancelled');
            expect(String(saved.cancelledBy)).toBe(String(user._id));
            expect(saved.cancelledAt).toBeTruthy();
            expect(saved.cancellationReason).toBe(reason ? reason.trim() : undefined);
        } else {
            expect(saved.status).toBe(from);
            expect(saved.cancelledAt).toBeUndefined();
        }
    });

    test('a waiter cancel that also carries payment fields falls back to the permission gate (403)', async () => {
        const order = await takeaway();
        const res = await patchStatus(A.users.waiter, order._id, { status: 'cancelled', paymentStatus: 'Paid' });
        expect(res.status).toBe(403);
        const saved = await reload(order._id);
        expect(saved.status).toBe('new');
        expect(saved.paymentStatus).toBe('Pending');
    });

    test('customers cannot reach the staff status endpoint', async () => {
        const cust = await createCustomer('life-status');
        const order = await takeaway();
        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/status`).send({ status: 'cancelled' });
        expect(res.status).toBe(403);
        expect((await reload(order._id)).status).toBe('new');
    });
});

describe('branch-pinned staff (R-07)', () => {
    test.each([
        ['chef', { status: 'preparing' }],
        ['captain', { status: 'preparing' }],
        ['captain', { paymentStatus: 'Paid', paymentMethod: 'cash' }],
        ['waiter', { status: 'cancelled' }],
        ['admin', { status: 'cancelled' }],
    ])('Second-branch %s cannot update a Main-branch order (%j) → 403 BRANCH_MISMATCH', async (role, body) => {
        const { order } = await dineIn();
        const res = await patchStatus(second[role], order._id, body);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
        const saved = await reload(order._id);
        expect(saved.status).toBe('new');
        expect(saved.paymentStatus).toBe('Pending');
    });

    test('Second-branch chef CAN move a Second-branch order', async () => {
        const table = await createTable(A, { branch: second.branch._id, area: second.area._id });
        const { order } = await dineIn({ table });
        expect(String((await reload(order._id)).branch)).toBe(String(second.branch._id));
        const res = await patchStatus(second.chef, order._id, { status: 'preparing' });
        expect(res.status).toBe(200);
    });

    // Regression (fixed 2026-10): orderAccessForCaller applies the staff branch pin (BRANCH_MISMATCH) on the customer cancel route.
    test('a Second-branch waiter cannot cancel a Main-branch order through PATCH /orders/:id/cancel', async () => {
        const { order } = await dineIn();
        const res = await ctx.api.as(second.waiter).patch(`/orders/${order._id}/cancel`).send({ reason: 'x' });
        expect(res.status).toBe(403);
        expect((await reload(order._id)).status).toBe('new');
    });
});

describe('concurrency', () => {
    test('two chefs start the same order at once: exactly one wins, the other gets 409', async () => {
        const order = await takeaway();
        const [r1, r2] = await Promise.all([
            patchStatus(A.users.chef, order._id, { status: 'preparing' }),
            patchStatus(chef2, order._id, { status: 'preparing' }),
        ]);
        expect([r1.status, r2.status].sort()).toEqual([200, 409]);
        const loser = r1.status === 409 ? r1 : r2;
        expect(loser.body.code).toBe('INVALID_TRANSITION');
        const winner = r1.status === 200 ? A.users.chef : chef2;
        const saved = await reload(order._id);
        expect(saved.status).toBe('preparing');
        expect(String(saved.chef)).toBe(String(winner._id));
    });

    test('chef "start" racing a captain "cancel": one wins and the stored state matches the winner', async () => {
        const order = await takeaway();
        const [start, cancel] = await Promise.all([
            patchStatus(A.users.chef, order._id, { status: 'preparing' }),
            patchStatus(A.users.captain, order._id, { status: 'cancelled' }),
        ]);
        expect([start.status, cancel.status].sort()).toEqual([200, 409]);
        const saved = await reload(order._id);
        expect(saved.status).toBe(start.status === 200 ? 'preparing' : 'cancelled');
    });
});

describe('mark-paid side effects', () => {
    test('paying a READY dine-in order auto-serves it and frees the (single-order) table', async () => {
        const { order, table } = await dineIn();
        await forceStatus(order._id, 'ready');
        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(res.status).toBe(200);
        expect(res.body.order.status).toBe('served');
        const saved = await reload(order._id);
        expect(saved.paymentStatus).toBe('Paid');
        expect(saved.paidAt).toBeTruthy();
        expect(saved.total).toBe(bill(200).total); // no amountPaid → total untouched
        const t = await Table.findById(table._id).select('+seats').lean();
        expect(t.status).toBe('free');
        expect(t.activeOrder).toBeNull();
        expect(t.seats).toEqual([]);
    });

    // Regression (fixed 2026-10): applyPaymentFields stamps servedAt when it auto-promotes a paid dine-in order to served.
    test('an order auto-served by mark-paid gets a servedAt stamp', async () => {
        const { order } = await dineIn();
        await forceStatus(order._id, 'ready');
        await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash' });
        const saved = await reload(order._id);
        expect(saved.status).toBe('served');
        expect(saved.servedAt).toBeTruthy();
    });

    test('paying a takeaway order does NOT auto-serve it', async () => {
        const order = await takeaway();
        await forceStatus(order._id, 'ready');
        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(res.status).toBe(200);
        expect((await reload(order._id)).status).toBe('ready');
    });

    test('a second mark-paid keeps the original paidAt', async () => {
        const order = await takeaway();
        await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash' });
        const first = (await reload(order._id)).paidAt;
        await settle(20);
        await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'upi' });
        expect((await reload(order._id)).paidAt.getTime()).toBe(first.getTime());
    });

    // Regression (fixed 2026-10): mark-paid auto-serves only when the state machine allows → served, so a NEW order stays on the KDS.
    test('paying a dine-in order that is still NEW keeps it new and on the kitchen board', async () => {
        const { order } = await dineIn();
        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash' });
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        const kds = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        const onBoard = kds.body.orders.some((o) => o.id === order.orderId);
        expect({ status: saved.status, onBoard, inventoryDeducted: saved.inventoryDeducted })
            .toEqual({ status: 'new', onBoard: true, inventoryDeducted: false });
    });

    test('settling one dine-in round settles the table\'s other unpaid rounds (amountPaid 0) and frees the table', async () => {
        const first = await dineIn();
        const sib = await dineIn({ table: first.table, scanToken: first.scanToken });
        // Updated 2026-10: paid rounds still NEW stay in the kitchen, so
        // both rounds are made ready before settling to check the
        // auto-serve of siblings. (Since the table-status rule the table
        // frees on payment regardless of kitchen status — see
        // tableStatus.test.js.)
        await forceStatus(first.order._id, 'ready');
        await forceStatus(sib.order._id, 'ready');
        const cancelled = await dineIn({ table: first.table, scanToken: first.scanToken });
        await patchStatus(A.users.admin, cancelled.order._id, { status: 'cancelled' });
        // A different table's unpaid order must not be touched.
        const elsewhere = await dineIn();

        const total = bill(200).total;
        const res = await patchStatus(A.users.admin, first.order._id, {
            paymentStatus: 'Paid', paymentMethod: 'upi', amountPaid: total * 2,
        });
        expect(res.status).toBe(200);

        const s = await reload(sib.order._id);
        expect(s.paymentStatus).toBe('Paid');
        expect(s.paymentMethod).toBe('upi');
        expect(s.amountPaid).toBe(0);
        expect(s.status).toBe('served');
        expect(s.paidAt).toBeTruthy();
        const c = await reload(cancelled.order._id);
        expect(c.status).toBe('cancelled');
        expect(c.paymentStatus).toBe('Pending');
        expect((await reload(elsewhere.order._id)).paymentStatus).toBe('Pending');
        expect((await Table.findById(first.table._id).lean()).status).toBe('free');
    });

    test('tip on a customer order with a waiter creates exactly one pending Tip (to the paisa)', async () => {
        const table = await createTable(A, { capacity: 4 });
        await Table.updateOne({ _id: table._id }, { $set: { assignedWaiter: A.users.waiter._id } });
        const cust = await createCustomer('life-tip');
        const { scanToken } = await scanTable(ctx.api, table, { Authorization: `Bearer ${cust.token}` });
        const { order } = await dineIn({ table, scanToken, customer: cust });
        expect(String((await reload(order._id)).waiter)).toBe(String(A.users.waiter._id));

        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash', tipAmount: 49.99 });
        expect(res.status).toBe(200);
        await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', tipAmount: 49.99 }); // replay
        const tips = await Tip.find({ order: order._id }).lean();
        expect(tips).toHaveLength(1);
        expect(tips[0].amount).toBe(49.99);
        expect(tips[0].status).toBe('pending');
        expect(String(tips[0].waiter)).toBe(String(A.users.waiter._id));
    });

    test('a negative tip is clamped to 0 and creates no Tip', async () => {
        const order = await takeaway();
        await Order.updateOne({ _id: order._id }, { $set: { waiter: A.users.waiter._id } });
        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', tipAmount: -25 });
        expect(res.status).toBe(200);
        expect((await reload(order._id)).tipAmount).toBe(0);
        expect(await Tip.countDocuments({ order: order._id })).toBe(0);
    });

    // Regression (fixed 2026-10): updateOrderStatus creates the Tip on every paid transition, not only for orders with a customer.
    test('a tip settled on a waiter-placed walk-in order reaches the tips ledger', async () => {
        const table = await createTable(A, { capacity: 4 });
        const order = await staffOrder(A.users.waiter, table);
        const saved0 = await reload(order._id);
        expect(saved0.user == null).toBe(true);
        expect(String(saved0.waiter)).toBe(String(A.users.waiter._id));

        const res = await patchStatus(A.users.captain, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash', tipAmount: 50 });
        expect(res.status).toBe(200);
        expect((await reload(order._id)).tipAmount).toBe(50);
        expect(await Tip.countDocuments({ order: order._id })).toBe(1);
    });

    test('inventory: deducted on → preparing (exact grams) and restored on cancel; flag round-trips', async () => {
        const inv = await Inventory.create({
            restaurant: A.restaurant._id, branch: null, itemId: 'INV-LIFE-1', name: 'Paneer block',
            category: 'Dairy & Eggs', unit: 'kg', currentStock: 10, minStock: 1, costPerUnit: 300,
        });
        await Recipe.create({
            restaurant: A.restaurant._id, branch: null, menuItem: A.items.paneer._id,
            ingredients: [{ inventoryItem: inv._id, quantity: 250, unit: 'g' }], yield: 1,
        });
        try {
            const { order } = await dineIn({ qty: 3 });
            expect((await patchStatus(A.users.chef, order._id, { status: 'preparing' })).status).toBe(200);
            const deducted = await waitFor(async () => {
                const i = await Inventory.findById(inv._id).lean();
                return i.currentStock !== 10 ? i : null;
            });
            expect(deducted.currentStock).toBeCloseTo(9.25, 6); // 3 × 250 g
            expect((await reload(order._id)).inventoryDeducted).toBe(true);

            expect((await patchStatus(A.users.chef, order._id, { status: 'cancelled' })).status).toBe(200);
            const restored = await waitFor(async () => {
                const i = await Inventory.findById(inv._id).lean();
                return i.currentStock === 10 ? i : null;
            });
            expect(restored.currentStock).toBe(10);
            expect((await reload(order._id)).inventoryDeducted).toBe(false);
        } finally {
            await Recipe.deleteMany({ menuItem: A.items.paneer._id });
        }
    });

    test('cancelling a NEW order (never deducted) leaves inventoryDeducted false', async () => {
        const order = await takeaway();
        expect((await patchStatus(A.users.admin, order._id, { status: 'cancelled' })).status).toBe(200);
        await settle(100);
        expect((await reload(order._id)).inventoryDeducted).toBe(false);
    });

    // Regression (fixed 2026-10): releaseTableIfSettled (was releaseTableAfterOrderClosed) keeps the table occupied while another unpaid order remains on it.
    test('cancelling one of two open orders on a table keeps the table occupied', async () => {
        const first = await dineIn();
        const other = await dineIn({ table: first.table, scanToken: first.scanToken });
        const res = await patchStatus(A.users.captain, other.order._id, { status: 'cancelled' });
        expect(res.status).toBe(200);
        expect((await reload(first.order._id)).status).toBe('new'); // still live
        const t = await Table.findById(first.table._id).lean();
        expect(t.status).toBe('occupied');
    });
});

describe('customer cancel (PATCH /orders/:id/cancel)', () => {
    test('owner cancels an unpaid NEW order: 200, note stamped, no refund request, table freed', async () => {
        const cust = await createCustomer('life-cancel');
        const table = await createTable(A, { capacity: 4 });
        const { scanToken } = await scanTable(ctx.api, table, { Authorization: `Bearer ${cust.token}` });
        const { order } = await dineIn({ table, scanToken, customer: cust });
        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/cancel`).send({ reason: 'changed mind' });
        expect(res.status).toBe(200);
        expect(res.body.refundRequest).toBeNull();
        const saved = await reload(order._id);
        expect(saved.status).toBe('cancelled');
        expect(saved.note).toContain('Cancelled by customer: changed mind');
        expect(await RefundRequest.countDocuments({ order: order._id })).toBe(0);
        expect((await Table.findById(table._id).lean()).status).toBe('free');
    });

    test.each(['preparing', 'ready', 'served', 'cancelled'])('owner cannot cancel a %s order (403)', async (state) => {
        const cust = await createCustomer(`life-c-${state}`);
        const { order } = await dineIn({ customer: cust });
        await forceStatus(order._id, state);
        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/cancel`).send({});
        expect(res.status).toBe(403);
        expect((await reload(order._id)).status).toBe(state);
    });

    test('guest with an EXPIRED scan token for the right session → 403 SCAN_TOKEN_EXPIRED', async () => {
        const { order, table } = await dineIn();
        const saved = await reload(order._id);
        const expired = signTypedToken(TOKEN_TYPES.SCAN, {
            tableId: String(table._id), restaurantId: String(A.restaurant._id),
            sessionId: saved.scanSessionId, exp: Math.floor(Date.now() / 1000) - 60,
        });
        const res = await ctx.api.guest(A, expired).patch(`/orders/${order._id}/cancel`).send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCAN_TOKEN_EXPIRED');
        expect((await reload(order._id)).status).toBe('new');
    });

    test('a scan token minted for ANOTHER tenant with the same sessionId is refused', async () => {
        const { order, table } = await dineIn();
        const saved = await reload(order._id);
        const forged = signTypedToken(TOKEN_TYPES.SCAN, {
            tableId: String(table._id), restaurantId: String(B.restaurant._id), sessionId: saved.scanSessionId,
        }, { expiresIn: '1h' });
        const res = await ctx.api.guest(A, forged).patch(`/orders/${order._id}/cancel`).send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCAN_SESSION_MISMATCH');
    });

    test('a garbage scan token → 403 SCAN_TOKEN_INVALID', async () => {
        const { order } = await dineIn();
        const res = await ctx.api.guest(A, 'not-a-jwt').patch(`/orders/${order._id}/cancel`).send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCAN_TOKEN_INVALID');
    });

    test('tenant switch earlyCancellation=false blocks customer cancel', async () => {
        const { order, scanToken } = await dineIn();
        await Settings.updateOne({ _id: A.settings._id }, { $set: { 'notifications.earlyCancellation': false } });
        settingsCache._internals.cache.clear();
        try {
            const res = await ctx.api.guest(A, scanToken).patch(`/orders/${order._id}/cancel`).send({});
            expect(res.status).toBe(403);
            expect(res.body.message).toMatch(/disabled/i);
            expect((await reload(order._id)).status).toBe('new');
        } finally {
            await Settings.updateOne({ _id: A.settings._id }, { $set: { 'notifications.earlyCancellation': true } });
            settingsCache._internals.cache.clear();
        }
    });

    test('unknown order id → 404', async () => {
        const res = await ctx.api.guest(A).patch('/orders/ORD-DOES-NOT-EXIST/cancel').send({});
        expect(res.status).toBe(404);
    });
});

describe('rating (PATCH /orders/:id/rating)', () => {
    async function servedCustomerOrder(label) {
        const cust = await createCustomer(label);
        const table = await createTable(A, { capacity: 4 });
        const { scanToken } = await scanTable(ctx.api, table, { Authorization: `Bearer ${cust.token}` });
        const { order } = await dineIn({ table, scanToken, customer: cust });
        await forceStatus(order._id, 'served');
        return { cust, order, scanToken };
    }

    test('owner rates a served order 1-5; feedback trimmed and capped at 500 chars', async () => {
        const { cust, order } = await servedCustomerOrder('rate-ok');
        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/rating`)
            .send({ rating: 4, feedback: `  ${'x'.repeat(600)}  ` });
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.rating).toBe(4);
        expect(saved.feedback).toHaveLength(500);
        expect(saved.ratedAt).toBeTruthy();
    });

    test.each([0, 6, -1, null])('rating %p → 400', async (rating) => {
        const { cust, order } = await servedCustomerOrder(`rate-bad-${rating}`);
        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/rating`).send({ rating });
        expect(res.status).toBe(400);
        expect((await reload(order._id)).rating).toBeUndefined();
    });

    // Regression (fixed 2026-10): rateOrder requires a finite number 1-5, so a non-numeric rating is a 400.
    test('a non-numeric rating is a 400, not a 500', async () => {
        const { cust, order } = await servedCustomerOrder('rate-nan');
        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/rating`).send({ rating: 'great' });
        expect(res.status).toBe(400);
        expect((await reload(order._id)).rating).toBeUndefined();
    });

    test('an order still in the kitchen cannot be rated', async () => {
        const { cust, order } = await servedCustomerOrder('rate-new');
        await forceStatus(order._id, 'new');
        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/rating`).send({ rating: 5 });
        expect(res.status).toBe(400);
    });

    test('another customer cannot rate my order', async () => {
        const { order } = await servedCustomerOrder('rate-owner');
        const other = await createCustomer('rate-intruder');
        const res = await ctx.api.as(other, A).patch(`/orders/${order._id}/rating`).send({ rating: 1 });
        expect(res.status).toBe(403);
        expect((await reload(order._id)).rating).toBeUndefined();
    });

    test('re-rating overwrites the earlier rating (no once-only guard)', async () => {
        const { cust, order } = await servedCustomerOrder('rate-twice');
        await ctx.api.as(cust, A).patch(`/orders/${order._id}/rating`).send({ rating: 5 });
        const again = await ctx.api.as(cust, A).patch(`/orders/${order._id}/rating`).send({ rating: 2 });
        expect(again.status).toBe(200);
        expect((await reload(order._id)).rating).toBe(2);
    });

    // Regression (fixed 2026-10): rateOrder requires ownership via orderAccessForCaller (owner, or guest with the order's scan session).
    test('an anonymous caller (no login, no scan token) cannot rate a customer\'s order', async () => {
        const { order } = await servedCustomerOrder('rate-anon');
        const res = await ctx.api.guest(A).patch(`/orders/${order.orderId}/rating`).send({ rating: 1, feedback: 'spam' });
        expect(res.status).toBe(403);
        expect((await reload(order._id)).rating).toBeUndefined();
    });

    test('a logged-in customer cannot rate a stranger\'s guest order', async () => {
        const { order } = await dineIn();
        await forceStatus(order._id, 'served');
        const stranger = await createCustomer('rate-stranger');
        const res = await ctx.api.as(stranger, A).patch(`/orders/${order._id}/rating`).send({ rating: 1 });
        expect(res.status).toBe(403);
        expect((await reload(order._id)).rating).toBeUndefined();
    });
});

describe('admin cleanup: stale ready orders (POST /orders/admin/cleanup-stale)', () => {
    const age = (id, minutes) => Order.collection.updateOne(
        { _id: oid(id) },
        { $set: { updatedAt: new Date(Date.now() - minutes * 60 * 1000) } },
    );

    test('captain and chef are refused (adminOnly)', async () => {
        for (const u of [A.users.captain, A.users.chef, A.users.waiter]) {
            const res = await ctx.api.as(u).post('/orders/admin/cleanup-stale').send({ dryRun: true });
            expect(res.status).toBe(403);
        }
    });

    test('dryRun previews; real run cancels only stale READY takeaway orders of this tenant/branch', async () => {
        const stale = await takeaway();
        const paidStale = await takeaway();
        const fresh = await takeaway();
        const preparingOld = await takeaway();
        const { order: dineStale } = await dineIn();
        await forceStatus(stale._id, 'ready');
        await forceStatus(paidStale._id, 'ready');
        await Order.updateOne({ _id: paidStale._id }, { $set: { paymentStatus: 'Paid', amountPaid: 230 } });
        await forceStatus(fresh._id, 'ready');
        await forceStatus(preparingOld._id, 'preparing');
        await forceStatus(dineStale._id, 'ready');
        for (const o of [stale, paidStale, preparingOld, dineStale]) await age(o._id, 400);
        // Tenant B's stale order must never be touched.
        const resB = await ctx.api.guest(B).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter',
            items: [{ menuItem: String(B.items.paneer._id), quantity: 1 }], total: 230,
        });
        expect(resB.status).toBe(201);
        await forceStatus(resB.body.order._id, 'ready');
        await age(resB.body.order._id, 400);

        const dry = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-stale').send({ dryRun: true });
        expect(dry.status).toBe(200);
        const ids = dry.body.orders.map((o) => o.orderId).sort();
        expect(ids).toEqual([stale.orderId, paidStale.orderId].sort());
        expect(dry.body.paidCount).toBe(1);
        expect((await reload(stale._id)).status).toBe('ready');

        const run = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-stale').send({});
        expect(run.status).toBe(200);
        expect(run.body.count).toBe(2);
        expect(run.body.paidOrderIds).toEqual([paidStale.orderId]);
        expect((await reload(stale._id)).status).toBe('cancelled');
        expect((await reload(stale._id)).note).toMatch(/Auto-cleaned/);
        expect((await reload(fresh._id)).status).toBe('ready');
        expect((await reload(preparingOld._id)).status).toBe('preparing');
        expect((await reload(dineStale._id)).status).toBe('ready');
        expect((await reload(resB.body.order._id)).status).toBe('ready');
    });

    test('minutesOld is clamped to at least 10 minutes', async () => {
        const o = await takeaway();
        await forceStatus(o._id, 'ready');
        await age(o._id, 5);
        const res = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-stale').send({ minutesOld: 1, dryRun: true });
        expect(res.status).toBe(200);
        expect(res.body.orders.map((x) => x.orderId)).not.toContain(o.orderId);
        await age(o._id, 11);
        const res2 = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-stale').send({ minutesOld: 1, dryRun: true });
        expect(res2.body.orders.map((x) => x.orderId)).toContain(o.orderId);
        await forceStatus(o._id, 'cancelled');
    });

    test('a branch-pinned admin only cleans their own branch', async () => {
        const mainOrder = await takeaway();
        await forceStatus(mainOrder._id, 'ready');
        await age(mainOrder._id, 400);
        const res = await ctx.api.as(second.admin).post('/orders/admin/cleanup-stale').send({ dryRun: true, type: 'all' });
        expect(res.status).toBe(200);
        expect(res.body.orders.map((x) => x.orderId)).not.toContain(mainOrder.orderId);
        await forceStatus(mainOrder._id, 'cancelled');
    });

    // Regression (fixed 2026-10): cleanupStaleReadyOrders frees (or repoints) the table of each cancelled dine-in order.
    test('type=dine-in cleanup cancels the order and frees its table', async () => {
        const { order, table } = await dineIn();
        await forceStatus(order._id, 'ready');
        await age(order._id, 400);
        const res = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-stale').send({ type: 'dine-in' });
        expect(res.status).toBe(200);
        expect((await reload(order._id)).status).toBe('cancelled');
        const t = await Table.findById(table._id).lean();
        expect({ status: t.status, activeOrder: t.activeOrder }).toEqual({ status: 'free', activeOrder: null });
    });
});

describe('admin cleanup: empty-order sweep (POST /orders/admin/cleanup-empty)', () => {
    test('cancels stale EMPTY unpaid orders of this tenant only and frees their table', async () => {
        const { order, table } = await dineIn();
        const { order: withItems } = await dineIn();
        const old = new Date(Date.now() - 60 * 60 * 1000);
        await Order.collection.updateOne({ _id: oid(order._id) }, { $set: { items: [], updatedAt: old } });
        await Order.collection.updateOne({ _id: oid(withItems._id) }, { $set: { updatedAt: old } });

        const resB = await ctx.api.guest(B).post('/orders').send({
            type: 'takeaway', pickupLocation: 'Counter',
            items: [{ menuItem: String(B.items.paneer._id), quantity: 1 }], total: 230,
        });
        const bId = oid(resB.body.order._id);
        await Order.collection.updateOne({ _id: bId }, { $set: { items: [], updatedAt: old } });

        expect((await ctx.api.as(A.users.captain).post('/orders/admin/cleanup-empty').send({})).status).toBe(403);

        const res = await ctx.api.as(A.users.admin).post('/orders/admin/cleanup-empty').send({});
        expect(res.status).toBe(200);
        expect(res.body.cancelled).toBeGreaterThanOrEqual(1);
        const saved = await reload(order._id);
        expect(saved.status).toBe('cancelled');
        expect(saved.cancelReason).toBe('auto-sweeper');
        expect((await Table.findById(table._id).lean()).status).toBe('free');
        expect((await reload(withItems._id)).status).toBe('new');
        expect((await reload(bId)).status).toBe('new');
        await settle();
    });
});

describe('pickup (PATCH /orders/:id/pickup)', () => {
    const pickup = (user, id) => ctx.api.as(user).patch(`/orders/${id}/pickup`).send({});

    test('ready → served; the picking waiter is stamped; a repeat pickup is an idempotent 200', async () => {
        const order = await takeaway();
        await forceStatus(order._id, 'ready');
        const res = await pickup(A.users.waiter, order._id);
        expect(res.status).toBe(200);
        const saved = await reload(order._id);
        expect(saved.status).toBe('served');
        expect(saved.servedAt).toBeTruthy();
        expect(String(saved.waiter)).toBe(String(A.users.waiter._id));
        const again = await pickup(A.users.waiter, order._id);
        expect(again.status).toBe(200);
        expect(again.body.message).toMatch(/already served/);
    });

    test.each(['new', 'cancelled'])('cannot pick up a %s order (400)', async (state) => {
        const order = await takeaway();
        await forceStatus(order._id, state);
        expect((await pickup(A.users.waiter, order._id)).status).toBe(400);
        expect((await reload(order._id)).status).toBe(state);
    });

    test('chef and customer are refused; another tenant gets 404', async () => {
        const order = await takeaway();
        await forceStatus(order._id, 'ready');
        expect((await pickup(A.users.chef, order._id)).status).toBe(403);
        const cust = await createCustomer('pickup');
        expect((await ctx.api.as(cust, A).patch(`/orders/${order._id}/pickup`).send({})).status).toBe(403);
        expect((await pickup(B.users.waiter, order._id)).status).toBe(404);
    });

    test('a captain pickup re-attributes the tip of a paid takeaway; Tip amount exact', async () => {
        const order = await takeaway();
        await Order.updateOne({ _id: order._id }, {
            $set: { status: 'ready', paymentStatus: 'Paid', tipAmount: 35.5, waiter: A.users.waiter._id },
        });
        const res = await pickup(A.users.captain, order._id);
        expect(res.status).toBe(200);
        expect(String((await reload(order._id)).waiter)).toBe(String(A.users.captain._id));
        const tips = await Tip.find({ order: order._id }).lean();
        expect(tips).toHaveLength(1);
        expect(tips[0].amount).toBe(35.5);
        expect(String(tips[0].waiter)).toBe(String(A.users.captain._id));
    });
});

describe('home delivery (PATCH /orders/:id/delivery)', () => {
    async function deliveryOrder() {
        const order = await takeaway();
        await Order.updateOne({ _id: order._id }, { $set: { 'delivery.requested': true, 'delivery.status': 'pending', status: 'ready', branch: A.branch._id } });
        return order;
    }
    const deliver = (user, id, body) => ctx.api.as(user).patch(`/orders/${id}/delivery`).send(body);

    test('naming a partner assigns; out-for-delivery and delivered stamp times; delivered serves the order', async () => {
        const order = await deliveryOrder();
        const a = await deliver(A.users.captain, order._id, { partnerName: '  Ravi\u0007 K  ' });
        expect(a.status).toBe(200);
        let saved = await reload(order._id);
        expect(saved.delivery.partnerName).toBe('Ravi K');
        expect(saved.delivery.status).toBe('assigned');
        expect(saved.delivery.assignedAt).toBeTruthy();

        expect((await deliver(A.users.captain, order._id, { status: 'out-for-delivery' })).status).toBe(200);
        saved = await reload(order._id);
        expect(saved.delivery.outForDeliveryAt).toBeTruthy();

        expect((await deliver(A.users.admin, order._id, { status: 'delivered' })).status).toBe(200);
        saved = await reload(order._id);
        expect(saved.delivery.status).toBe('delivered');
        expect(saved.delivery.deliveredAt).toBeTruthy();
        expect(saved.status).toBe('served');
        expect(saved.servedAt).toBeTruthy();
    });

    test('guards: unknown status 400, not a delivery order 400, cancelled 400, waiter 403, other branch 403', async () => {
        const order = await deliveryOrder();
        expect((await deliver(A.users.captain, order._id, { status: 'teleported' })).status).toBe(400);
        expect((await deliver(A.users.waiter, order._id, { status: 'assigned' })).status).toBe(403);
        const cross = await deliver(second.captain, order._id, { status: 'assigned' });
        expect(cross.status).toBe(403);
        expect(cross.body.code).toBe('BRANCH_SCOPE_VIOLATION');

        const plain = await takeaway();
        const np = await deliver(A.users.captain, plain._id, { status: 'assigned' });
        expect(np.status).toBe(400);
        expect(np.body.code).toBe('NOT_A_DELIVERY_ORDER');

        await forceStatus(order._id, 'cancelled');
        expect((await deliver(A.users.captain, order._id, { status: 'delivered' })).status).toBe(400);
        expect((await reload(order._id)).delivery.status).toBe('pending');
        expect((await deliver(A.users.captain, 'ORD-NOPE', { status: 'assigned' })).status).toBe(404);
    });
});

// Pricing decision: marking Paid never rewrites order.total.
describe('mark-paid cannot change the bill', () => {
    // takeaway: 200 + 10 GST + 20 packaging = 230
    test('amountPaid below what is due → 400 AMOUNT_TOO_LOW, order untouched', async () => {
        const order = await takeaway();
        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 200 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_TOO_LOW');
        expect(res.body.amountDue).toBe(230);
        expect(res.body.message).toMatch(/Discount/);
        const saved = await reload(order._id);
        expect(saved).toMatchObject({ total: 230, paymentStatus: 'Pending' });
    });

    test('within the ₹1 tolerance is accepted; total keeps the bill', async () => {
        const order = await takeaway();
        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 229.5 });
        expect(res.status).toBe(200);
        expect(await reload(order._id)).toMatchObject({ total: 230, amountPaid: 229.5, paymentStatus: 'Paid' });
    });

    test('an overpayment is recorded as paid without inflating the total', async () => {
        const order = await takeaway();
        const res = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 250 });
        expect(res.status).toBe(200);
        expect(await reload(order._id)).toMatchObject({ total: 230, amountPaid: 250, paymentStatus: 'Paid' });
    });

    test('a manualDiscount sent with the settle lowers what is due; total unchanged and the discount recorded', async () => {
        const order = await takeaway();
        // due = 230 − 50 = 180
        const res = await patchStatus(A.users.admin, order._id, {
            paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 180, manualDiscount: 50,
        });
        expect(res.status).toBe(200);
        expect(await reload(order._id)).toMatchObject({ total: 230, manualDiscount: 50, amountPaid: 180, paymentStatus: 'Paid' });
    });

    test('a manualDiscount saved earlier counts towards what is due', async () => {
        const order = await takeaway();
        expect((await patchStatus(A.users.admin, order._id, { manualDiscount: 30 })).status).toBe(200);
        const low = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 150 });
        expect(low.status).toBe(400); // due 200
        const ok = await patchStatus(A.users.admin, order._id, { paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 200 });
        expect(ok.status).toBe(200);
        expect(await reload(order._id)).toMatchObject({ total: 230, manualDiscount: 30, amountPaid: 200 });
    });
});
