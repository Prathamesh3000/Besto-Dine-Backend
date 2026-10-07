/**
 * Plan module management — end-to-end over HTTP.
 *
 *   - staff apps: chef needs kitchenDisplay, waiter/captain need waiterDashboard
 *   - kiosk orders + kiosk menu need kiosk
 *   - new online payments need paymentGateway; wallet top-ups need walletLoyalty
 *   - staff performance needs staffPerformance
 *   - revenue analytics tiers: basic (≤31-day reports) / standard / advanced (forecast)
 *   - paid add-ons switch a module on; cancelling switches it off
 *   - Super Admin: plan tenant-impact + push, add-on CRUD, override validation, MRR
 *   - login snapshot carries resolved modules + add-ons
 *   - self-signup trials on Gold, not on the ₹0 (quoted) Enterprise plan
 *   - migrations/applyPlanLineup2026 builds Silver / Gold / Premium
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));
const Order = require(path.join(BACKEND, 'models/order'));
const { applyPlanLineup } = require(path.join(BACKEND, 'migrations/applyPlanLineup2026'));

const ctx = useIntegrationApp();
let T;            // tenant whose features individual tests flip
let saFull;
let saSupport;

beforeAll(async () => {
    T = await seedTenant({ label: 'mg' });
    saFull = await createUser({ name: 'Root', email: 'root.mg@platform.test', role: 'superadmin', superadminLevel: 'full' });
    saSupport = await createUser({ name: 'Support', email: 'support.mg@platform.test', role: 'superadmin', superadminLevel: 'support' });
});

const api = (user, tenant) => ctx.api.as(user, tenant);
const setFeatures = (t, patch) => Restaurant.updateOne({ _id: t.restaurant._id }, {
    $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`subscription.features.${k}`, v])),
});
const setAddons = (t, addons) => Restaurant.updateOne({ _id: t.restaurant._id }, { $set: { addons } });
// Every test starts from "all modules on, no add-ons, no overrides".
afterEach(async () => {
    const all = Object.fromEntries([...SubscriptionPlan.FEATURE_KEYS].map(k => [k, true]));
    await setFeatures(T, { ...all, revenueAnalytics: 'advanced' });
    await Restaurant.updateOne({ _id: T.restaurant._id }, { $set: { addons: [], featureOverrides: {} } });
});

const kioskCart = (t) => [
    { menuItem: String(t.items.paneer._id), quantity: 2 },
    { menuItem: String(t.items.thali._id), quantity: 1, selectedSizes: [{ name: 'Full' }] },
];
const kioskOrder = (t) => ctx.api.guest(t).post('/orders').send({
    type: 'dine-in', source: 'kiosk', items: kioskCart(t), total: 738.75,
});
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

describe('staff apps', () => {
    test('chef on a plan without kitchenDisplay: every API call 403s except auth', async () => {
        await setFeatures(T, { kitchenDisplay: false });
        const kds = await api(T.users.chef).get('/orders/kitchen');
        expect(kds.status).toBe(403);
        expect(kds.body).toMatchObject({ code: 'FEATURE_LOCKED', feature: 'kitchenDisplay' });
        expect((await api(T.users.chef).get('/inventory')).status).toBe(403);
        expect((await api(T.users.chef).get('/auth/me')).status).toBe(200);
    });

    test('kitchen display endpoints are gated for admins too; the rest of the admin panel is not', async () => {
        await setFeatures(T, { kitchenDisplay: false });
        expect((await api(T.users.admin).get('/orders/kitchen')).status).toBe(403);
        expect((await api(T.users.admin).get('/orders/live')).status).toBe(200);
    });

    test('waiter and captain on a plan without waiterDashboard → 403; admin unaffected', async () => {
        await setFeatures(T, { waiterDashboard: false });
        for (const role of ['waiter', 'captain']) {
            const res = await api(T.users[role]).get('/orders/live');
            expect(res.status).toBe(403);
            expect(res.body.feature).toBe('waiterDashboard');
        }
        expect((await api(T.users.admin).get('/orders/live')).status).toBe(200);
    });

    test('an active kitchenDisplay add-on lets the chef back in', async () => {
        await setFeatures(T, { kitchenDisplay: false });
        await setAddons(T, [{ key: 'kitchenDisplay', status: 'active', price: 0 }]);
        expect((await api(T.users.chef).get('/orders/kitchen')).status).toBe(200);
    });
});

describe('kiosk', () => {
    test('kiosk order without the kiosk module → 403, nothing created; with it → 201', async () => {
        await setFeatures(T, { kiosk: false });
        const before = await Order.countDocuments({ restaurant: T.restaurant._id });
        const blocked = await kioskOrder(T);
        expect(blocked.status).toBe(403);
        expect(blocked.body).toMatchObject({ code: 'FEATURE_LOCKED', feature: 'kiosk' });
        expect(await Order.countDocuments({ restaurant: T.restaurant._id })).toBe(before);

        await setFeatures(T, { kiosk: true });
        expect((await kioskOrder(T)).status).toBe(201);
    });

    test('kiosk menu bootstrap is gated; the normal menu bootstrap is not', async () => {
        await setFeatures(T, { kiosk: false });
        const kiosk = await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}&kiosk=true`);
        expect(kiosk.status).toBe(403);
        expect(kiosk.body.feature).toBe('kiosk');
        expect((await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}`)).status).toBe(200);
    });

    test('a kiosk add-on unlocks it', async () => {
        await setFeatures(T, { kiosk: false });
        await setAddons(T, [{ key: 'kiosk', status: 'active', price: 499 }]);
        expect((await ctx.api.anon().get(`/public/menu-bootstrap?slug=${T.slug}&kiosk=true`)).status).toBe(200);
    });
});

describe('payments, wallet, staff performance', () => {
    test('new online payment without paymentGateway → 403 (customer copy)', async () => {
        await setFeatures(T, { paymentGateway: false });
        const cust = await createCustomer('mg-pay');
        const res = await api(cust, T).post('/razorpay/create-order').send({ amount: 100 });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'FEATURE_LOCKED', feature: 'paymentGateway' });
        expect(res.body.message).toMatch(/doesn't offer online payments/);
    });

    test('wallet top-up needs walletLoyalty', async () => {
        await setFeatures(T, { walletLoyalty: false });
        const cust = await createCustomer('mg-wal');
        const res = await api(cust, T).post('/razorpay/create-wallet-recharge').send({ amount: 100 });
        expect(res.status).toBe(403);
        expect(res.body.feature).toBe('walletLoyalty');
    });

    test('staff performance needs staffPerformance', async () => {
        const url = `/staff/${T.users.waiter._id}/performance`;
        expect((await api(T.users.admin).get(url)).status).toBe(200);
        await setFeatures(T, { staffPerformance: false });
        const res = await api(T.users.admin).get(url);
        expect(res.status).toBe(403);
        expect(res.body.feature).toBe('staffPerformance');
    });
});

describe('revenue analytics tiers', () => {
    const reports = (from, to) => api(T.users.admin).get(`/telemetry/reports?from=${from}&to=${to}`);

    test('none → reports locked', async () => {
        await setFeatures(T, { revenueAnalytics: 'none' });
        expect((await reports(ymd(-6), ymd(0))).status).toBe(403);
    });

    test('basic → up to 31 days; longer ranges ask for Standard; no forecast', async () => {
        await setFeatures(T, { revenueAnalytics: 'basic' });
        expect((await reports(ymd(-30), ymd(0))).status).toBe(200);
        const long = await reports(ymd(-59), ymd(0));
        expect(long.status).toBe(403);
        expect(long.body).toMatchObject({ code: 'FEATURE_LOCKED', requiredTier: 'standard', currentTier: 'basic', maxDays: 31 });
        expect((await api(T.users.admin).get('/telemetry/forecast')).status).toBe(403);
    });

    test('standard → any range, forecast still locked; advanced → forecast', async () => {
        await setFeatures(T, { revenueAnalytics: 'standard' });
        expect((await reports(ymd(-200), ymd(0))).status).toBe(200);
        const fc = await api(T.users.admin).get('/telemetry/forecast');
        expect(fc.status).toBe(403);
        expect(fc.body.requiredTier).toBe('advanced');

        await setFeatures(T, { revenueAnalytics: 'advanced' });
        expect((await api(T.users.admin).get('/telemetry/forecast')).status).toBe(200);
    });

    test('dashboard stats stay available on every plan', async () => {
        await setFeatures(T, { revenueAnalytics: 'none' });
        expect((await api(T.users.admin).get('/telemetry/stats')).status).toBe(200);
    });
});

describe('login snapshot', () => {
    test('/auth/me returns resolved modules, active add-ons and the raw plan snapshot', async () => {
        await setFeatures(T, { kiosk: false, crm: false });
        await setAddons(T, [{ key: 'kiosk', status: 'active' }, { key: 'eInvoice', status: 'cancelled' }]);
        await Restaurant.updateOne({ _id: T.restaurant._id }, { $unset: { 'subscription.features.campaigns': 1 } });
        const res = await api(T.users.admin).get('/auth/me');
        expect(res.status).toBe(200);
        const t = res.body.user.tenant;
        expect(t.addons).toEqual(['kiosk']);
        expect(t.features.kiosk).toBe(true);           // via add-on
        expect(t.features.crm).toBe(false);
        expect(t.features.campaigns).toBe(true);       // legacy fallback to couponPromotions
        expect(t.planFeatures.kiosk).toBe(false);
    });
});

describe('super admin — push plan to tenants', () => {
    let plan;
    let P;

    beforeAll(async () => {
        plan = await SubscriptionPlan.create({
            name: 'Push Test', slug: 'push-test', price: 300,
            features: { dineIn: true, inventory: false }, limits: { maxTables: 5 },
        });
        P = await seedTenant({ label: 'mgp' });
        await Restaurant.updateOne({ _id: P.restaurant._id }, { $set: {
            'subscription.plan': plan._id,
            'subscription.planName': 'Push Test',
            'subscription.price': 250,                     // negotiated price
            'subscription.features': { dineIn: true, inventory: false },
            'subscription.limits': { maxTables: 5 },
            featureOverrides: { crm: true },
        } });
    });

    test('editing the plan does not touch the tenant; impact shows it is out of sync', async () => {
        const upd = await api(saFull).put(`/superadmin/plans/${plan._id}`).send({ features: { dineIn: true, inventory: true }, limits: { maxTables: 20 } });
        expect(upd.status).toBe(200);
        expect((await api(P.users.admin).get('/inventory')).status).toBe(403);

        const impact = await api(saSupport).get(`/superadmin/plans/${plan._id}/tenant-impact`);
        expect(impact.status).toBe(200);
        expect(impact.body.data).toMatchObject({ assignedCount: 1, outOfSyncCount: 1 });
        expect(impact.body.data.outOfSync[0].slug).toBe(P.slug);
    });

    test('push needs confirm and a full super admin', async () => {
        expect((await api(saFull).post(`/superadmin/plans/${plan._id}/push`).send({})).body.code).toBe('CONFIRM_REQUIRED');
        expect((await api(saSupport).post(`/superadmin/plans/${plan._id}/push`).send({ confirm: true })).status).toBe(403);
    });

    test('push copies modules + limits, keeps the agreed price and overrides', async () => {
        const res = await api(saFull).post(`/superadmin/plans/${plan._id}/push`).send({ confirm: true });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ matched: 1, updated: 1 });

        const r = await Restaurant.findById(P.restaurant._id).lean();
        expect(r.subscription.features.inventory).toBe(true);
        expect(r.subscription.limits.maxTables).toBe(20);
        expect(r.subscription.price).toBe(250);
        expect(r.featureOverrides).toEqual({ crm: true });
        expect((await api(P.users.admin).get('/inventory')).status).toBe(200);

        const again = await api(saSupport).get(`/superadmin/plans/${plan._id}/tenant-impact`);
        expect(again.body.data.outOfSyncCount).toBe(0);
    });
});

describe('super admin — add-ons and overrides', () => {
    const addonsUrl = () => `/superadmin/restaurants/${T.restaurant._id}/addons`;

    test('activate a catalog add-on (default price), duplicate → 409, cancel → module off again', async () => {
        await setFeatures(T, { kiosk: false });
        const cat = await api(saSupport).get('/superadmin/addon-catalog');
        expect(cat.body.data.map(c => c.key)).toEqual(expect.arrayContaining(['kiosk', 'advanceBookingHall', 'eInvoice']));

        const add = await api(saFull).post(addonsUrl()).send({ key: 'kiosk', note: 'paid by UPI' });
        expect(add.status).toBe(201);
        expect(add.body.data.addon).toMatchObject({ key: 'kiosk', price: 499, status: 'active', addedBy: 'root.mg@platform.test' });
        expect((await api(saFull).post(addonsUrl()).send({ key: 'kiosk' })).status).toBe(409);
        expect((await kioskOrder(T)).status).toBe(201);

        const billing = await api(T.users.admin).get('/tenant/billing/current');
        expect(billing.body.data.addons).toEqual([expect.objectContaining({ key: 'kiosk', price: 499 })]);

        const cancel = await api(saFull).delete(`${addonsUrl()}/${add.body.data.addon._id}`);
        expect(cancel.status).toBe(200);
        expect(cancel.body.data.addon.status).toBe('cancelled');
        expect((await kioskOrder(T)).status).toBe(403);
    });

    test('add-on validation and permissions', async () => {
        expect((await api(saFull).post(addonsUrl()).send({ key: 'bogus' })).status).toBe(400);
        expect((await api(saFull).post(addonsUrl()).send({ key: 'revenueAnalytics' })).status).toBe(400);
        expect((await api(saFull).post(addonsUrl()).send({ key: 'crm', price: -5 })).status).toBe(400);
        expect((await api(saFull).post(addonsUrl()).send({ key: 'crm', endDate: '2001-01-01' })).status).toBe(400);
        expect((await api(saSupport).post(addonsUrl()).send({ key: 'crm' })).status).toBe(403);
        expect((await api(T.users.admin).post(addonsUrl()).send({ key: 'crm' })).status).toBe(403);
    });

    test('active add-ons count toward MRR', async () => {
        const before = (await api(saFull).get('/superadmin/restaurants')).body.summary.mrr;
        await setAddons(T, [{ key: 'kiosk', status: 'active', price: 499 }, { key: 'crm', status: 'cancelled', price: 999 }]);
        const after = (await api(saFull).get('/superadmin/restaurants')).body.summary.mrr;
        expect(after - before).toBe(499);
    });

    test('featureOverrides are validated', async () => {
        const url = `/superadmin/restaurants/${T.restaurant._id}`;
        expect((await api(saFull).patch(url).send({ featureOverrides: { bogus: true } })).status).toBe(400);
        expect((await api(saFull).patch(url).send({ featureOverrides: { inventory: 'yes' } })).status).toBe(400);
        expect((await api(saFull).patch(url).send({ featureOverrides: [] })).status).toBe(400);
        expect((await api(saFull).patch(url).send({ featureOverrides: { inventory: false, revenueAnalytics: 'basic' } })).status).toBe(200);
        const inv = await api(T.users.admin).get('/inventory');
        expect(inv.status).toBe(403);
        expect(inv.body.code).toBe('FEATURE_REVOKED');
    });
});

describe('self-signup trial plan', () => {
    test('trials on Gold even when a ₹0 Enterprise plan exists', async () => {
        await SubscriptionPlan.create({ name: 'Enterprise', slug: 'enterprise', price: 0, sortOrder: 4 });
        await SubscriptionPlan.create({ name: 'Gold', slug: 'gold', price: 1799, sortOrder: 2, trialDays: 14 });
        const email = `owner.${Date.now()}@hotels.test`;
        const res = await ctx.api.anon().post('/public/register-restaurant').send({
            restaurantName: `Trial Hub ${Date.now()}`, ownerName: 'Asha Owner', contactEmail: email,
            contactPhone: '+91 98765 43210', city: 'Pune', password: 'Signup#Pass1234', acceptTerms: true,
        });
        expect(res.status).toBe(202);   // accepted, pending approval
        const r = await Restaurant.findOne({ contactEmail: email }).lean();
        expect(r.subscription.planSlug).toBe('gold');
    });
});

describe('migrations/applyPlanLineup2026', () => {
    const silent = () => {};

    test('retires the old line-up, creates Silver / Gold / Premium, and is idempotent', async () => {
        await SubscriptionPlan.deleteMany({});
        const legacyPremium = await SubscriptionPlan.create({
            name: 'Premium', slug: 'premium', price: 1999,
            features: { couponPromotions: true, inventory: true, kiosk: true },
        });
        await SubscriptionPlan.create({ name: 'Basic', slug: 'basic', price: 499, features: { couponPromotions: false } });
        await SubscriptionPlan.create({ name: 'Enterprise', slug: 'enterprise', price: 0, features: { inventory: true } });
        const L = await seedTenant({ label: 'mgl' });
        await Restaurant.updateOne({ _id: L.restaurant._id }, { $set: {
            'subscription.plan': legacyPremium._id, 'subscription.planSlug': 'premium',
            'subscription.planName': 'Premium', 'subscription.price': 1999,
            'subscription.features': { couponPromotions: true, inventory: true },
        } });

        // dry run writes nothing
        const dry = await applyPlanLineup({ SubscriptionPlan, Restaurant }, { dryRun: true, log: silent });
        expect(dry.created).toEqual(['silver', 'gold']);
        expect(await SubscriptionPlan.exists({ slug: 'silver' })).toBeNull();

        const report = await applyPlanLineup({ SubscriptionPlan, Restaurant }, { log: silent });
        expect(report.legacy.map(l => l.to)).toEqual(['basic', 'premium-legacy']);
        expect(report.created).toEqual(['silver', 'gold', 'premium']);

        const legacy = await SubscriptionPlan.findById(legacyPremium._id).lean();
        expect(legacy).toMatchObject({ slug: 'premium-legacy', name: 'Premium (legacy)', isPublic: false });
        expect(legacy.features.campaigns).toBe(true);           // inherited from couponPromotions
        expect(legacy.features.whiteLabelBranding).toBe(false);
        const basic = await SubscriptionPlan.findOne({ slug: 'basic' }).lean();
        expect(basic.features.campaigns).toBe(false);

        const tenant = await Restaurant.findById(L.restaurant._id).lean();
        expect(tenant.subscription).toMatchObject({ planSlug: 'premium-legacy', planName: 'Premium (legacy)', price: 1999 });
        expect(tenant.subscription.features).toEqual({ couponPromotions: true, inventory: true });   // untouched

        const silver = await SubscriptionPlan.findOne({ slug: 'silver' }).lean();
        expect(silver).toMatchObject({ price: 699, isPublic: true });
        expect(silver.features).toMatchObject({ inventory: true, kitchenDisplay: true, crm: false, kiosk: false, revenueAnalytics: 'basic' });
        const premium = await SubscriptionPlan.findOne({ slug: 'premium' }).lean();
        expect(premium.features).toMatchObject({ kiosk: true, advanceBookingHall: true, webhooks: true, revenueAnalytics: 'advanced' });
        const ent = await SubscriptionPlan.findOne({ slug: 'enterprise' }).lean();
        expect(ent.features).toMatchObject({ inventory: true, eInvoice: true, whiteLabelBranding: true });
        expect(ent.price).toBe(0);

        // second run: no rename, plans refreshed, nothing duplicated
        const second = await applyPlanLineup({ SubscriptionPlan, Restaurant }, { log: silent });
        expect(second.legacy).toEqual([]);
        expect(second.refreshed).toEqual(['silver', 'gold', 'premium']);
        expect(await SubscriptionPlan.countDocuments({ slug: 'premium' })).toBe(1);
        expect(await SubscriptionPlan.countDocuments({})).toBe(6);
    });
});
