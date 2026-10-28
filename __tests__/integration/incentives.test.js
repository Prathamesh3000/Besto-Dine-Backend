/**
 * Staff item incentives (CAPTAIN_FLOW_UPDATE_PLAN Phase 5): campaign CRUD,
 * D3 accrual (served AND paid), D2 attribution, reversal, caps, staff-own
 * visibility, admin report + CSV, plan gating, tenant isolation.
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const IncentiveCampaign = require(path.join(BACKEND, 'models/incentiveCampaign'));
const IncentiveEntry = require(path.join(BACKEND, 'models/incentiveEntry'));
const svc = require(path.join(BACKEND, 'services/incentiveService'));
const { revokeTipsForOrder } = require(path.join(BACKEND, 'utils/tipHelpers'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let T;       // main tenant
let U;       // second tenant (isolation)
let waiter2;
let manager;
let seq = 0;

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

beforeAll(async () => {
    T = await seedTenant({ label: 'inc' });
    U = await seedTenant({ label: 'incu' });
    waiter2 = await createUser({
        name: 'Waiter Two', email: `w2.${T.slug}@staff.test`, role: 'waiter',
        restaurant: T.restaurant._id, branch: T.branch._id, permissions: defaultPermissionsForRole('waiter'),
    });
    manager = await createUser({
        name: 'Mgr', email: `mgr.${T.slug}@staff.test`, role: 'manager',
        restaurant: T.restaurant._id, branch: T.branch._id, permissions: defaultPermissionsForRole('manager'),
    });
});

const setFeature = (t, v) => Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { 'subscription.features.incentives': v } });

beforeEach(async () => {
    await svc.idle();
    await IncentiveEntry.deleteMany({});
    await IncentiveCampaign.deleteMany({});
    await setFeature(T, true);
    await setFeature(U, true);
});

const admin = () => ctx.api.as(T.users.admin);

async function mkCampaign(overrides = {}, tenant = T) {
    const res = await ctx.api.as(tenant.users.admin).post('/incentives/campaigns').send({
        name: 'Push Paneer',
        items: [String(tenant.items.paneer._id)],
        rule: { type: 'per_item', ratePerItem: 20 },
        startDate: iso(-1), endDate: iso(1),
        ...overrides,
    });
    if (res.status !== 201) throw new Error(`campaign create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.campaign;
}

async function mkOrder({ tenant = T, waiter = T.users.waiter, status = 'ready', qty = 2, item = 'paneer', paymentStatus = 'Pending', extraItems = [] } = {}) {
    seq += 1;
    const mi = tenant.items[item];
    return Order.create({
        restaurant: tenant.restaurant._id, branch: tenant.branch._id,
        orderId: `INC-${tenant.slug}-${seq}`,
        type: 'takeaway', pickupLocation: 'Counter',
        items: [{ menuItem: String(mi._id), name: mi.name, price: mi.basePrice, quantity: qty }, ...extraItems],
        total: mi.basePrice * qty, status, paymentStatus,
        ...(waiter ? { waiter: waiter._id } : {}),
    });
}

const serve = (order, who = T.users.waiter) => ctx.api.as(who).patch(`/orders/${order._id}/pickup`).send({});
const pay = (order, total) => admin().patch(`/orders/${order._id}/status`)
    .send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: total ?? order.total });
const entries = async (filter = {}) => { await svc.idle(); return IncentiveEntry.find(filter).lean(); };

describe('plan gating + permission', () => {
    test('module off -> FEATURE_LOCKED on admin and staff routes; on -> 200', async () => {
        await setFeature(T, false);
        const a = await admin().get('/incentives/campaigns');
        expect(a.status).toBe(403);
        expect(a.body).toMatchObject({ code: 'FEATURE_LOCKED', feature: 'incentives' });
        const s = await ctx.api.as(T.users.captain).get('/incentives/me');
        expect(s.status).toBe(403);
        expect(s.body.code).toBe('FEATURE_LOCKED');
        await setFeature(T, true);
        expect((await admin().get('/incentives/campaigns')).status).toBe(200);
        expect((await ctx.api.as(T.users.captain).get('/incentives/me')).status).toBe(200);
    });

    test('add-on switches the module on for a plan without it', async () => {
        await setFeature(T, false);
        await Restaurant.updateOne({ _id: T.restaurant._id }, { $set: { addons: [{ key: 'incentives', status: 'active', price: 299 }] } });
        expect((await admin().get('/incentives/campaigns')).status).toBe(200);
        await Restaurant.updateOne({ _id: T.restaurant._id }, { $set: { addons: [] } });
    });

    test('accrual hooks do nothing when the module is off', async () => {
        await mkCampaign();
        await setFeature(T, false);
        const o = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        expect(await svc.accrueForOrder(o)).toEqual({ created: 0, updated: 0, skipped: 0 });
        expect(await IncentiveEntry.countDocuments({})).toBe(0);
    });

    test('manager needs the incentives permission; waiter and customer-style roles are refused', async () => {
        expect(defaultPermissionsForRole('manager').incentives).toBe(false);
        expect((await ctx.api.as(manager).get('/incentives/campaigns')).status).toBe(403);
        await mongoose.model('User').updateOne({ _id: manager._id }, { $set: { 'permissions.incentives': true } });
        const ok = await ctx.api.as({ token: manager.token }).get('/incentives/campaigns');
        expect(ok.status).toBe(200);
        await mongoose.model('User').updateOne({ _id: manager._id }, { $set: { 'permissions.incentives': false } });
        expect((await ctx.api.as(T.users.waiter).get('/incentives/campaigns')).status).toBe(403);
        expect((await ctx.api.as(T.users.chef).get('/incentives/me')).status).toBe(403);
        expect((await admin().get('/incentives/me')).status).toBe(403);
    });
});

describe('campaign CRUD + validation', () => {
    test('create -> list (derived status, spent) -> update (pause) -> delete', async () => {
        const c = await mkCampaign({ maxPerStaffPerDay: 5, budgetCap: 1000, stacking: 'exclusive', staffRoles: ['waiter'] });
        expect(c).toMatchObject({ name: 'Push Paneer', status: 'active', stacking: 'exclusive', maxPerStaffPerDay: 5, budgetCap: 1000, branch: null });
        expect(c.rule).toMatchObject({ type: 'per_item', ratePerItem: 20 });
        expect(c.staffRoles).toEqual(['waiter']);

        const list = await admin().get('/incentives/campaigns');
        expect(list.body.campaigns).toHaveLength(1);
        expect(list.body.campaigns[0]).toMatchObject({ status: 'active', spent: 0 });

        const up = await admin().put(`/incentives/campaigns/${c._id}`).send({ status: 'paused', rule: { ratePerItem: 25 } });
        expect(up.status).toBe(200);
        expect(up.body.campaign).toMatchObject({ status: 'paused' });
        expect(up.body.campaign.rule.ratePerItem).toBe(25);

        const del = await admin().delete(`/incentives/campaigns/${c._id}`);
        expect(del.status).toBe(200);
        expect(await IncentiveCampaign.countDocuments({})).toBe(0);
    });

    test('date-only strings snap to the tenant local day (end inclusive)', async () => {
        const today = svc.dayKey(new Date(), 'Asia/Kolkata');
        const c = await mkCampaign({ startDate: today, endDate: today });
        expect(c.status).toBe('active');
        expect(new Date(c.endDate) - new Date(c.startDate)).toBe(DAY - 1);
    });

    test.each([
        ['missing name', { name: '' }],
        ['no items', { items: [] }],
        ['bad item id', { items: ['nope'] }],
        ['zero rate', { rule: { type: 'per_item', ratePerItem: 0 } }],
        ['negative cap', { budgetCap: -1 }],
        ['end before start', { startDate: iso(2), endDate: iso(1) }],
        ['bad role', { staffRoles: ['chef'] }],
        ['bad stacking', { stacking: 'sometimes' }],
        ['foreign menu item', () => ({ items: [String(U.items.paneer._id)] })],
    ])('rejects %s with 400', async (_label, patch) => {
        const body = {
            name: 'X', items: [String(T.items.paneer._id)], rule: { type: 'per_item', ratePerItem: 10 },
            startDate: iso(-1), endDate: iso(1), ...(typeof patch === 'function' ? patch() : patch),
        };
        const res = await admin().post('/incentives/campaigns').send(body);
        expect(res.status).toBe(400);
        expect(await IncentiveCampaign.countDocuments({})).toBe(0);
    });

    test('tiered rule is not implemented yet -> 400 UNSUPPORTED_RULE', async () => {
        const res = await admin().post('/incentives/campaigns').send({
            name: 'Tiers', items: [String(T.items.paneer._id)], rule: { type: 'tiered', ratePerItem: 5 },
            startDate: iso(-1), endDate: iso(1),
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('UNSUPPORTED_RULE');
    });

    test('a campaign with earnings cannot be deleted (409), only paused / ended', async () => {
        const c = await mkCampaign();
        const o = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o);
        const del = await admin().delete(`/incentives/campaigns/${c._id}`);
        expect(del.status).toBe(409);
        expect(del.body.code).toBe('CAMPAIGN_HAS_ENTRIES');
    });

    test('malformed id -> 400; unknown id -> 404', async () => {
        expect((await admin().put('/incentives/campaigns/zzz').send({})).status).toBe(400);
        expect((await admin().put(`/incentives/campaigns/${new mongoose.Types.ObjectId()}`).send({ name: 'x' })).status).toBe(404);
    });
});

describe('accrual (D3: served AND paid) and attribution (D2)', () => {
    test('served then paid -> pending, then confirmed exactly once', async () => {
        await mkCampaign();
        const o = await mkOrder({ qty: 2 });
        const s = await serve(o);
        expect(s.status).toBe(200);
        let rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: 'pending', quantity: 2, rate: 20, amount: 40, orderId: o.orderId });
        expect(String(rows[0].staff)).toBe(String(T.users.waiter._id));
        expect(rows[0].staffRole).toBe('waiter');

        const p = await pay(o);
        expect(p.status).toBe(200);
        rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: 'confirmed', amount: 40 });
        expect(rows[0].servedAt).toBeTruthy();
        expect(rows[0].paidAt).toBeTruthy();
    });

    test('paid then served -> confirmed once', async () => {
        await mkCampaign();
        const o = await mkOrder({ qty: 3 });
        expect((await pay(o)).status).toBe(200);
        let rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe('pending');
        expect((await serve(o)).status).toBe(200);
        rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: 'confirmed', quantity: 3, amount: 60 });
    });

    test('not served and not paid -> nothing; only paid -> pending', async () => {
        await mkCampaign();
        const o = await mkOrder({ status: 'preparing' });
        expect(await svc.accrueForOrder(o)).toEqual({ created: 0, updated: 0, skipped: 0 });
        expect(await IncentiveEntry.countDocuments({})).toBe(0);
        o.paymentStatus = 'Paid';
        await svc.accrueForOrder(o);
        expect((await entries())[0].state).toBe('pending');
    });

    test('duplicate callbacks and concurrent re-accrual never add a second entry', async () => {
        await mkCampaign();
        const o = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        const results = await Promise.all(Array.from({ length: 6 }, () => svc.accrueForOrder(o)));
        expect(results.reduce((n, r) => n + r.created, 0)).toBe(1);
        // A repeated payment callback for the same order (PATCH paid again) is a no-op too.
        await pay(o);
        await pay(o);
        await svc.accrueForOrder(o);
        const rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe('confirmed');
    });

    test('the unique index itself rejects a second (order, line, campaign) row', async () => {
        await mkCampaign();
        const o = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o);
        const [row] = await entries();
        await expect(IncentiveEntry.collection.insertOne({ ...row, _id: new mongoose.Types.ObjectId() }))
            .rejects.toMatchObject({ code: 11000 });
    });

    test('credits the waiter of record: a captain pickup re-attributes to the captain', async () => {
        await mkCampaign();
        const o = await mkOrder({ qty: 1 });          // placed under the waiter
        await serve(o, T.users.captain);              // captain serves -> waiter of record = captain
        await pay(o);
        const rows = await entries();
        expect(rows).toHaveLength(1);
        expect(String(rows[0].staff)).toBe(String(T.users.captain._id));
        expect(rows[0].staffRole).toBe('captain');
    });

    test('orders without a waiter of record, or with an ineligible role, earn nothing', async () => {
        await mkCampaign({ staffRoles: ['captain'] });
        const noWaiter = await mkOrder({ waiter: null, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(noWaiter);
        const waiterOnly = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(waiterOnly);   // waiter not in staffRoles
        const viaChef = await mkOrder({ waiter: T.users.chef, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(viaChef);
        expect(await IncentiveEntry.countDocuments({})).toBe(0);
    });

    test('a pending entry follows the waiter of record until confirmed', async () => {
        await mkCampaign();
        const o = await mkOrder({ status: 'served' });
        await svc.accrueForOrder(o);
        expect(String((await entries())[0].staff)).toBe(String(T.users.waiter._id));
        o.waiter = waiter2._id;
        o.paymentStatus = 'Paid';
        await svc.accrueForOrder(o);
        const rows = await entries();
        expect(rows[0].state).toBe('confirmed');
        expect(String(rows[0].staff)).toBe(String(waiter2._id));
    });

    test('lines for items outside the campaign do not earn; other lines on the same order do', async () => {
        await mkCampaign();
        const o = await mkOrder({
            status: 'served', paymentStatus: 'Paid',
            extraItems: [{ menuItem: String(T.items.naan._id), name: 'Naan', price: 40, quantity: 4 }],
        });
        await svc.accrueForOrder(o);
        const rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0].itemName).toBe('Paneer Tikka');
    });

    test('date window, pause and branch are respected', async () => {
        await mkCampaign({ name: 'future', startDate: iso(2), endDate: iso(3) });
        await mkCampaign({ name: 'past', startDate: iso(-5), endDate: iso(-3) });
        await mkCampaign({ name: 'paused', status: 'paused' });
        const otherBranch = new mongoose.Types.ObjectId();
        await IncentiveCampaign.create({
            restaurant: T.restaurant._id, branch: otherBranch, name: 'other branch', items: [T.items.paneer._id],
            rule: { type: 'per_item', ratePerItem: 9 }, startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + DAY),
        });
        const o = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o);
        expect(await IncentiveEntry.countDocuments({})).toBe(0);
    });

    test('maxPerStaffPerDay trims the quantity, then stops', async () => {
        await mkCampaign({ maxPerStaffPerDay: 3 });
        const a = await mkOrder({ qty: 2, status: 'served', paymentStatus: 'Paid' });
        const b = await mkOrder({ qty: 2, status: 'served', paymentStatus: 'Paid' });
        const c = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(a);
        await svc.accrueForOrder(b);
        await svc.accrueForOrder(c);
        const rows = await IncentiveEntry.find({}).sort({ createdAt: 1 }).lean();
        expect(rows.map((r) => r.quantity)).toEqual([2, 1]);
        // another staff member has their own allowance
        const d = await mkOrder({ qty: 2, waiter: waiter2, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(d);
        expect(await IncentiveEntry.countDocuments({ staff: waiter2._id })).toBe(1);
    });

    test('budgetCap limits the total paid out; reversed entries free budget', async () => {
        await mkCampaign({ budgetCap: 50 });            // rate 20 -> 2 units
        const a = await mkOrder({ qty: 3, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(a);
        let rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ quantity: 2, amount: 40 });
        const b = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(b);
        expect(await IncentiveEntry.countDocuments({})).toBe(1);   // 10 left < rate 20
        await svc.reverseForOrder(a, 'test');
        await svc.accrueForOrder(b);
        expect(await IncentiveEntry.countDocuments({ state: { $ne: 'reversed' } })).toBe(1);
    });

    test('stacking: campaigns stack by default; an exclusive campaign wins alone (highest rate)', async () => {
        await mkCampaign({ name: 'A', rule: { type: 'per_item', ratePerItem: 10 } });
        await mkCampaign({ name: 'B', rule: { type: 'per_item', ratePerItem: 5 } });
        const o1 = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o1);
        expect(await IncentiveEntry.countDocuments({ order: o1._id })).toBe(2);

        await mkCampaign({ name: 'X1', stacking: 'exclusive', rule: { type: 'per_item', ratePerItem: 30 } });
        await mkCampaign({ name: 'X2', stacking: 'exclusive', rule: { type: 'per_item', ratePerItem: 50 } });
        const o2 = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o2);
        const rows = await IncentiveEntry.find({ order: o2._id }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].rate).toBe(50);
    });
});

describe('reversal', () => {
    test('cancelling a served (pending) order through the API reverses its entries', async () => {
        await mkCampaign();
        const o = await mkOrder({ qty: 2 });
        await serve(o);
        expect((await entries())[0].state).toBe('pending');
        const res = await ctx.api.as(T.users.captain).patch(`/orders/${o._id}/status`)
            .send({ status: 'cancelled', cancellationReason: 'customer left' });
        expect(res.status).toBe(200);
        const rows = await entries();
        expect(rows[0].state).toBe('reversed');
        expect(rows[0].reversedAt).toBeTruthy();
        expect(rows[0].reverseReason).toMatch(/cancel/);
        await settle();
    });

    test('full refund reverses a confirmed entry; a partial refund does not; reversed is terminal', async () => {
        await mkCampaign();
        const o = await mkOrder({ status: 'served', paymentStatus: 'Paid', qty: 1 });
        await svc.accrueForOrder(o);
        expect((await entries())[0].state).toBe('confirmed');

        await Order.updateOne({ _id: o._id }, { $set: { refundedAmount: 50 } });   // partial: still Paid
        await revokeTipsForOrder(o, { reason: 'partial refund' });
        expect((await entries())[0].state).toBe('confirmed');

        await Order.updateOne({ _id: o._id }, { $set: { paymentStatus: 'Refunded', refundedAmount: o.total } });
        await revokeTipsForOrder(o, { reason: 'refund: test' });
        const rows = await entries();
        expect(rows[0].state).toBe('reversed');

        // re-accrual (e.g. a late duplicate callback) never revives it
        const fresh = await Order.findById(o._id);
        await svc.accrueForOrder(fresh);
        expect((await entries())[0].state).toBe('reversed');
        expect(await IncentiveEntry.countDocuments({})).toBe(1);
    });

    test('reconcile reverses entries of voided orders and accrues missed ones', async () => {
        await mkCampaign();
        const voided = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(voided);
        await Order.updateOne({ _id: voided._id }, { $set: { status: 'cancelled' } });   // bypasses every hook
        const missed = await mkOrder({ status: 'served', paymentStatus: 'Paid' });       // never hooked
        const out = await svc.reconcile({ restaurant: T.restaurant._id });
        expect(out.reversed).toBe(1);
        expect(await IncentiveEntry.countDocuments({ order: voided._id, state: 'reversed' })).toBe(1);
        expect(await IncentiveEntry.countDocuments({ order: missed._id, state: 'confirmed' })).toBe(1);
    });

    test('a line removed from the order drops its entry', async () => {
        await mkCampaign();
        const o = await mkOrder({ status: 'served' });
        await svc.accrueForOrder(o);
        const naan = { menuItem: String(T.items.naan._id), name: 'Naan', price: 40, quantity: 1 };
        const fresh = await Order.findById(o._id);
        fresh.items = [naan];
        fresh.paymentStatus = 'Paid';
        await svc.accrueForOrder(fresh);
        expect((await entries())[0].state).toBe('reversed');
    });
});

describe('staff endpoints (own figures only)', () => {
    beforeEach(async () => {
        await mkCampaign({ maxPerStaffPerDay: 0 });
        const w = await mkOrder({ qty: 2, status: 'served', paymentStatus: 'Paid' });                     // confirmed 40
        const w2 = await mkOrder({ qty: 1, status: 'served' });                                           // pending 20
        const cap = await mkOrder({ qty: 5, waiter: T.users.captain, status: 'served', paymentStatus: 'Paid' }); // captain 100
        for (const o of [w, w2, cap]) await svc.accrueForOrder(o);
    });

    test('GET /me returns totals, today and per-item for the caller only', async () => {
        const res = await ctx.api.as(T.users.waiter).get('/incentives/me');
        expect(res.status).toBe(200);
        expect(res.body.totals).toEqual({ estimated: 60, confirmed: 40, pending: 20, reversed: 0 });
        expect(res.body.today).toEqual({ estimated: 60, confirmed: 40, pending: 20, reversed: 0 });
        expect(res.body.byItem).toHaveLength(1);
        expect(res.body.byItem[0]).toMatchObject({
            name: 'Paneer Tikka', rate: 20, quantity: 3, confirmedQty: 2, pendingQty: 1, amount: 60, campaignName: 'Push Paneer',
        });

        const cap = await ctx.api.as(T.users.captain).get('/incentives/me');
        expect(cap.body.totals).toEqual({ estimated: 100, confirmed: 100, pending: 0, reversed: 0 });
        const other = await ctx.api.as(waiter2).get('/incentives/me');
        expect(other.body.totals.estimated).toBe(0);
        expect(other.body.byItem).toEqual([]);
    });

    test('a staff member cannot read another member by query parameter', async () => {
        const res = await ctx.api.as(waiter2).get(`/incentives/me?staff=${T.users.captain._id}`);
        expect(res.body.totals.estimated).toBe(0);
        const ent = await ctx.api.as(waiter2).get(`/incentives/entries?staff=${T.users.captain._id}`);
        expect(ent.body.entries).toEqual([]);
    });

    test('GET /me?shift=true narrows to the current shift; ?from/?to validation', async () => {
        const none = await ctx.api.as(T.users.waiter).get('/incentives/me?shift=true');
        expect(none.status).toBe(200);
        expect(none.body.shift).toBeNull();
        expect(none.body.totals.estimated).toBe(0);
        const Shift = require(path.join(BACKEND, 'models/shift'));
        await Shift.create({ restaurant: T.restaurant._id, staff: T.users.waiter._id, clockIn: new Date(Date.now() - 3600000) });
        const inShift = await ctx.api.as(T.users.waiter).get('/incentives/me?shift=true');
        expect(inShift.body.shift).toBeTruthy();
        expect(inShift.body.totals.estimated).toBe(60);
        await Shift.deleteMany({ staff: T.users.waiter._id });

        expect((await ctx.api.as(T.users.waiter).get('/incentives/me?from=nope')).status).toBe(400);
        expect((await ctx.api.as(T.users.waiter).get('/incentives/me?from=2026-02-02&to=2026-01-01')).status).toBe(400);
        const old = await ctx.api.as(T.users.waiter).get('/incentives/me?from=2020-01-01&to=2020-01-02');
        expect(old.body.totals.estimated).toBe(0);
    });

    test('GET /entries lists own rows with order refs, paginated', async () => {
        const res = await ctx.api.as(T.users.waiter).get('/incentives/entries?limit=1');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 2, pages: 2, page: 1, limit: 1 });
        expect(res.body.entries[0]).toMatchObject({ itemName: 'Paneer Tikka', rate: 20 });
        expect(res.body.entries[0].orderId).toMatch(/^INC-/);
        const p2 = await ctx.api.as(T.users.waiter).get('/incentives/entries?limit=1&page=2');
        expect(p2.body.entries).toHaveLength(1);
        const pend = await ctx.api.as(T.users.waiter).get('/incentives/entries?state=pending');
        expect(pend.body.entries.map((e) => e.state)).toEqual(['pending']);
        expect((await ctx.api.as(T.users.waiter).get('/incentives/entries?state=bogus')).status).toBe(400);
    });

    test('GET /items lists eligible items with status and conditions', async () => {
        await mkCampaign({ name: 'Soon', startDate: iso(3), endDate: iso(5), items: [String(T.items.naan._id)], staffRoles: ['captain'] });
        await mkCampaign({ name: 'Paused', status: 'paused', items: [String(T.items.thali._id)] });
        const res = await ctx.api.as(T.users.waiter).get('/incentives/items');
        expect(res.status).toBe(200);
        const byName = Object.fromEntries(res.body.items.map((i) => [i.campaign.name, i]));
        expect(byName['Push Paneer']).toMatchObject({
            name: 'Paneer Tikka', rate: 20, status: 'active', earningNow: true,
            conditions: { staffRoles: ['captain', 'waiter'], earnedWhen: 'Item served and bill paid' },
        });
        expect(byName.Paused).toMatchObject({ status: 'paused', earningNow: false });
        expect(byName.Paused.message).toMatch(/paused/);
        expect(byName.Soon).toBeUndefined();                    // captain-only campaign
        const cap = await ctx.api.as(T.users.captain).get('/incentives/items');
        expect(cap.body.items.find((i) => i.campaign.name === 'Soon')).toMatchObject({ status: 'upcoming', earningNow: false });
    });
});

describe('admin report + CSV', () => {
    let campA;
    let campB;
    beforeEach(async () => {
        campA = await mkCampaign({ name: 'Paneer push' });
        campB = await mkCampaign({ name: 'Naan push', items: [String(T.items.naan._id)], rule: { type: 'per_item', ratePerItem: 5 } });
        const o1 = await mkOrder({ qty: 2, status: 'served', paymentStatus: 'Paid' });                      // waiter: 40 confirmed
        const o2 = await mkOrder({ qty: 3, waiter: T.users.captain, status: 'served', paymentStatus: 'Pending' }); // captain: 60 pending
        const o3 = await mkOrder({ qty: 4, item: 'naan', waiter: waiter2, status: 'served', paymentStatus: 'Paid' }); // w2: 20 confirmed
        const o4 = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });                      // waiter: 20, then reversed
        for (const o of [o1, o2, o3, o4]) await svc.accrueForOrder(o);
        await svc.reverseForOrder(o4, 'refund');
    });

    test('totals, rollups and drill-down rows', async () => {
        const res = await admin().get('/incentives/report');
        expect(res.status).toBe(200);
        expect(res.body.totals).toEqual({ quantity: 9, estimated: 120, confirmed: 60, pending: 60, reversed: 20 });
        expect(res.body.byCampaign.map((c) => [c.name, c.estimated])).toEqual([['Paneer push', 100], ['Naan push', 20]]);
        expect(res.body.byStaff.find((s) => s.name === T.users.captain.name)).toMatchObject({ pending: 60, estimated: 60 });
        expect(res.body.byItem.map((i) => i.name).sort()).toEqual(['Garlic Naan', 'Paneer Tikka']);
        expect(res.body.byDay).toHaveLength(1);
        expect(res.body.daily.length).toBe(3);
        expect(res.body.rows).toHaveLength(4);
        expect(res.body.rows[0]).toEqual(expect.objectContaining({ orderId: expect.stringMatching(/^INC-/), staffName: expect.any(String), campaignName: expect.any(String) }));
    });

    test('filters: staff, campaign, item, state, date range', async () => {
        const byStaff = await admin().get(`/incentives/report?staff=${T.users.captain._id}`);
        expect(byStaff.body.totals).toMatchObject({ estimated: 60, quantity: 3 });
        const byCamp = await admin().get(`/incentives/report?campaign=${campB._id}`);
        expect(byCamp.body.totals.estimated).toBe(20);
        const byItem = await admin().get(`/incentives/report?item=${T.items.paneer._id}`);
        expect(byItem.body.totals.estimated).toBe(100);
        const byState = await admin().get('/incentives/report?state=reversed');
        expect(byState.body.rows).toHaveLength(1);
        expect(byState.body.totals.reversed).toBe(20);
        const empty = await admin().get('/incentives/report?from=2020-01-01&to=2020-01-31');
        expect(empty.body.totals.estimated).toBe(0);
        expect((await admin().get('/incentives/report?staff=bad')).status).toBe(400);
        expect((await admin().get('/incentives/report?from=2020-01-01&to=2022-01-01')).status).toBe(400);
        expect(campA._id).toBeTruthy();
    });

    test('branch scoping: a branch-pinned admin only sees their branch', async () => {
        const otherBranch = (await require(path.join(BACKEND, 'models/branch')).create({ restaurant: T.restaurant._id, name: 'Second', slug: `second-${seq}`, isActive: true }))._id;
        await IncentiveEntry.updateOne({}, { $set: { branch: otherBranch } });
        const sub = await createUser({
            name: 'Sub', email: `sub.${T.slug}@staff.test`, role: 'admin', isTenantOwner: false,
            restaurant: T.restaurant._id, branch: T.branch._id, permissions: {},
        });
        const mine = await ctx.api.as(sub).get('/incentives/report?branch=all');
        expect(mine.body.rows.every((r) => String(r.branch) === String(T.branch._id))).toBe(true);
        expect(mine.body.rows).toHaveLength(3);
        const owner = await admin().get('/incentives/report?branch=all');
        expect(owner.body.rows).toHaveLength(4);
        const forBranch = await admin().get(`/incentives/report?branch=${otherBranch}`);
        expect(forBranch.body.rows).toHaveLength(1);
        // a pinned admin cannot edit a tenant-wide campaign nor create for another branch
        const edit = await ctx.api.as(sub).put(`/incentives/campaigns/${campA._id}`).send({ name: 'hijack' });
        expect(edit.status).toBe(403);
        expect(edit.body.code).toBe('BRANCH_MISMATCH');
        const create = await ctx.api.as(sub).post('/incentives/campaigns').send({
            name: 'Mine', branch: String(otherBranch), items: [String(T.items.paneer._id)],
            rule: { ratePerItem: 3 }, startDate: iso(-1), endDate: iso(1),
        });
        expect(create.status).toBe(403);
        expect(create.body.code).toBe('BRANCH_MISMATCH');
    });

    test('CSV export: header, rows, content type, formula-injection guard', async () => {
        await IncentiveEntry.updateOne({ itemName: 'Garlic Naan' }, { $set: { itemName: '=HYPERLINK("http://x")' } });
        const res = await admin().get('/incentives/report.csv');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/);
        expect(res.headers['content-disposition']).toMatch(/attachment; filename="incentives-\d{4}-\d{2}-\d{2}_/);
        const lines = res.text.trim().split('\n');
        expect(lines[0]).toBe('Date,Branch,Staff,Role,Campaign,Item,Quantity,Rate,Amount,State,Order,Bill,Served at,Paid at,Reversed at,Reverse reason');
        expect(lines).toHaveLength(5);
        expect(res.text).toContain(`"'=HYPERLINK(""http://x"")"`);
        const filtered = await admin().get(`/incentives/report.csv?campaign=${campB._id}`);
        expect(filtered.text.trim().split('\n')).toHaveLength(2);
    });
});

describe('tenant isolation', () => {
    test("another tenant's admin cannot see, edit, delete or report on this tenant's campaign", async () => {
        const c = await mkCampaign();
        const o = await mkOrder({ status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o);
        const uAdmin = ctx.api.as(U.users.admin);
        expect((await uAdmin.get('/incentives/campaigns')).body.campaigns).toEqual([]);
        expect((await uAdmin.put(`/incentives/campaigns/${c._id}`).send({ name: 'x' })).status).toBe(404);
        expect((await uAdmin.delete(`/incentives/campaigns/${c._id}`)).status).toBe(404);
        const rep = await uAdmin.get('/incentives/report');
        expect(rep.body.totals.estimated).toBe(0);
        expect(rep.body.rows).toEqual([]);
        expect((await ctx.api.as(U.users.waiter).get('/incentives/me')).body.totals.estimated).toBe(0);
        expect((await uAdmin.get(`/incentives/report?campaign=${c._id}`)).body.rows).toEqual([]);
    });

    test('accrual only uses the order tenant campaigns and its own module flag', async () => {
        await mkCampaign({}, U);
        await setFeature(U, false);
        const o = await mkOrder({ tenant: U, waiter: U.users.waiter, status: 'served', paymentStatus: 'Paid' });
        expect((await svc.accrueForOrder(o)).created).toBe(0);
        await setFeature(U, true);
        expect((await svc.accrueForOrder(o)).created).toBe(1);
        const tOrder = await mkOrder({ status: 'served', paymentStatus: 'Paid' });   // T has no campaign now
        expect((await svc.accrueForOrder(tOrder)).created).toBe(0);
    });
});

describe('line growth after accrual (top-up rows)', () => {
    test('an appended quantity is credited as a delta row; re-running is idempotent', async () => {
        await mkCampaign();                                   // rate 20
        const o = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o);
        let rows = await entries();
        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(1);

        // append merges into the same line _id and bumps its quantity
        const fresh = await Order.findById(o._id);
        fresh.items[0].quantity = 2;
        await fresh.save();
        const s1 = await svc.accrueForOrder(await Order.findById(o._id));
        expect(s1.created).toBe(1);
        const s2 = await svc.accrueForOrder(await Order.findById(o._id));
        expect(s2.created).toBe(0);
        rows = await entries();
        expect(rows).toHaveLength(2);
        expect(rows.reduce((n, r) => n + r.quantity, 0)).toBe(2);
        expect(rows.reduce((n, r) => n + r.amount, 0)).toBe(40);
        expect(rows.every((r) => r.state === 'confirmed')).toBe(true);
    });

    test('the top-up respects the per-day cap and the budget cap', async () => {
        await mkCampaign({ maxPerStaffPerDay: 2 });
        const o = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o);
        const g = await Order.findById(o._id);
        g.items[0].quantity = 5;
        await g.save();
        await svc.accrueForOrder(await Order.findById(o._id));
        await svc.accrueForOrder(await Order.findById(o._id));
        let rows = await entries();
        expect(rows.reduce((n, r) => n + r.quantity, 0)).toBe(2);   // day cap 2

        await IncentiveEntry.deleteMany({});
        await IncentiveCampaign.deleteMany({});
        await mkCampaign({ budgetCap: 60 });                       // 3 units at 20
        const o2 = await mkOrder({ qty: 1, status: 'served', paymentStatus: 'Paid' });
        await svc.accrueForOrder(o2);
        const g2 = await Order.findById(o2._id);
        g2.items[0].quantity = 6;
        await g2.save();
        await svc.accrueForOrder(await Order.findById(o2._id));
        rows = await entries();
        expect(rows.reduce((n, r) => n + r.quantity, 0)).toBe(3);
    });
});

describe('reconcile cheap-first', () => {
    test('skips tenants without the incentives feature, processes qualifying ones', async () => {
        await mkCampaign({}, U);
        const uo = await mkOrder({ tenant: U, waiter: U.users.waiter, status: 'served', paymentStatus: 'Paid' });
        await setFeature(U, false);
        let r = await svc.reconcile({ restaurant: U.restaurant._id });
        expect(r.accrued).toBe(0);
        await setFeature(U, true);
        r = await svc.reconcile({ restaurant: U.restaurant._id });
        expect(r.accrued).toBeGreaterThanOrEqual(1);
        expect(await IncentiveEntry.countDocuments({ order: uo._id })).toBe(1);
        // campaign long ended -> skipped
        await IncentiveEntry.deleteMany({});
        await IncentiveCampaign.updateMany({}, { $set: { startDate: iso(-90), endDate: iso(-60) } });
        r = await svc.reconcile({ restaurant: U.restaurant._id });
        expect(r.accrued).toBe(0);
    });
});
