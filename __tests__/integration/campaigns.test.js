/**
 * controllers/campaignController.js + routes/campaignRoute.js (checklist
 * §7.3) — Bonus Points campaigns:
 *
 *   GET    /campaigns            list (tenant + strict branch scope)
 *   GET    /campaigns/stats      counts / sums mirroring the list scope
 *   POST   /campaigns            create (name + positive points; custom
 *                                needs dates; branch ownership)
 *   PATCH  /campaigns/:id/toggle enabled flip
 *   PUT    /campaigns/:id        update
 *   DELETE /campaigns/:id        delete
 *
 * Every route: protect → adminOnly → attachTenant → campaigns gate (plan
 * snapshots that pre-date the `campaigns` key fall back to couponPromotions).
 *
 * Tests whose name starts with "BUG:" pin behaviour the code gets wrong
 * today; they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');
const { V1 } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Campaign = require(path.join(BACKEND, 'models/campaign'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;
let B;
let C;          // plan without campaigns
let fc;
let kt;
let fcAdmin;

const rid = () => crypto.randomBytes(4).toString('hex');

beforeAll(async () => {
    A = await seedTenant({ label: 'cm-a' });
    B = await seedTenant({ label: 'cm-b' });
    C = await seedTenant({ label: 'cm-c' });
    await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { 'subscription.features.campaigns': false } });
    fc = await Branch.create({ restaurant: A.restaurant._id, name: 'FC Road', slug: 'fc-road', isActive: true });
    kt = await Branch.create({ restaurant: A.restaurant._id, name: 'Kothrud', slug: 'kothrud', isActive: true });
    fcAdmin = await createUser({
        name: 'FC admin', email: `cm.fc.${rid()}@staff.test`, role: 'admin',
        restaurant: A.restaurant._id, branch: fc._id, permissions: defaultPermissionsForRole('admin'),
    });
});

const api = (user) => ctx.api.as(user);
const body = (extra = {}) => ({ name: `Bonus ${rid()}`, type: 'birthday', points: 50, ...extra });
const makeCampaign = async (t, fields = {}) => (await Campaign.create({
    restaurant: t.restaurant._id, name: `Seeded ${rid()}`, type: 'birthday', points: 10, ...fields,
})).toObject();

describe('access', () => {
    test.each(['waiter', 'chef', 'captain'])('%s → 403 on every route', async (role) => {
        const c = await makeCampaign(A);
        const u = A.users[role];
        expect((await api(u).get('/campaigns')).status).toBe(403);
        expect((await api(u).get('/campaigns/stats')).status).toBe(403);
        expect((await api(u).post('/campaigns').send(body())).status).toBe(403);
        expect((await api(u).patch(`/campaigns/${c._id}/toggle`)).status).toBe(403);
        expect((await api(u).put(`/campaigns/${c._id}`).send({ name: 'x' })).status).toBe(403);
        expect((await api(u).delete(`/campaigns/${c._id}`)).status).toBe(403);
        expect((await Campaign.findById(c._id).lean()).name).toBe(c.name);
    });

    test('customer → 403, anonymous on a tenant → 401', async () => {
        const cust = await createCustomer('cm-cust');
        expect((await ctx.api.as(cust, A).get('/campaigns')).status).toBe(403);
        expect((await ctx.api.guest(A).get('/campaigns')).status).toBe(401);
    });

    test('plan without campaigns → 403 FEATURE_LOCKED, nothing created', async () => {
        const res = await api(C.users.admin).post('/campaigns').send(body());
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FEATURE_LOCKED');
        expect(res.body.feature).toBe('campaigns');
        expect(await Campaign.countDocuments({ restaurant: C.restaurant._id })).toBe(0);
    });

    test('legacy snapshot without a campaigns key follows couponPromotions', async () => {
        await Restaurant.updateOne({ _id: C.restaurant._id }, {
            $unset: { 'subscription.features.campaigns': 1 },
            $set: { 'subscription.features.couponPromotions': false },
        });
        expect((await api(C.users.admin).get('/campaigns')).status).toBe(403);

        await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { 'subscription.features.couponPromotions': true } });
        expect((await api(C.users.admin).get('/campaigns')).status).toBe(200);

        // restore the "no campaigns" fixture for later tests
        await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { 'subscription.features.campaigns': false } });
    });
});

describe('create', () => {
    test('owner creates a tenant-level campaign: enabled, tenant + creator from the token, status virtual', async () => {
        const res = await api(A.users.admin).post('/campaigns').send(body({ description: 'Happy birthday', restaurant: String(B.restaurant._id) }));
        expect(res.status).toBe(201);
        expect(res.body.campaign.status).toBe('Active');
        const saved = await Campaign.findById(res.body.campaign._id).lean();
        expect(saved).toMatchObject({ type: 'birthday', points: 50, enabled: true, description: 'Happy birthday', totalPointsIssued: 0, customersAffected: 0 });
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
        expect(saved.branch).toBeNull();
        expect(String(saved.createdBy)).toBe(String(A.users.admin._id));
    });

    test('custom campaign stores its schedule; type defaults to custom', async () => {
        const startDate = '2026-11-01T00:00:00.000Z';
        const endDate = '2026-11-15T00:00:00.000Z';
        const res = await api(A.users.admin).post('/campaigns').send({ name: 'Diwali bonus', points: '25', startDate, endDate });
        expect(res.status).toBe(201);
        const saved = await Campaign.findById(res.body.campaign._id).lean();
        expect(saved.type).toBe('custom');
        expect(saved.points).toBe(25);
        expect(saved.startDate.toISOString()).toBe(startDate);
        expect(saved.endDate.toISOString()).toBe(endDate);
    });

    test.each([
        ['missing name', { name: undefined }, 'Name and points are required'],
        ['missing points', { points: undefined }, 'Name and points are required'],
        ['points 0', { points: 0 }, 'Name and points are required'],
        ['negative points', { points: -5 }, 'Points must be a positive number'],
        ['non-numeric points', { points: 'lots' }, 'Points must be a positive number'],
        ['custom without dates', { type: 'custom' }, 'Custom campaigns require start and end dates'],
        ['custom with only a start date', { type: 'custom', startDate: '2026-11-01' }, 'Custom campaigns require start and end dates'],
    ])('%s → 400 "%s", nothing stored', async (_l, extra, message) => {
        const before = await Campaign.countDocuments({ restaurant: A.restaurant._id });
        const res = await api(A.users.admin).post('/campaigns').send(body(extra));
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
        expect(await Campaign.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
    });

    test('branch admin campaigns are owned by their branch, whatever the body says', async () => {
        const res = await api(fcAdmin).post('/campaigns').send(body({ branch: String(kt._id) }));
        expect(res.status).toBe(201);
        expect(String((await Campaign.findById(res.body.campaign._id).lean()).branch)).toBe(String(fc._id));
    });

    test('owner may target a tenant branch', async () => {
        const res = await api(A.users.admin).post('/campaigns').send(body({ branch: String(kt._id) }));
        expect(res.status).toBe(201);
        expect(String(res.body.campaign.branch)).toBe(String(kt._id));
    });

    // Regression (fixed 2026-10): createCampaign checks an owner's body.branch with resolveOwnedBranch.
    test("owner cannot attach a campaign to ANOTHER tenant's branch", async () => {
        const res = await api(A.users.admin).post('/campaigns').send(body({ branch: String(B.branch._id) }));
        expect(res.status).toBe(400);
        expect(await Campaign.countDocuments({ restaurant: A.restaurant._id, branch: B.branch._id })).toBe(0);
    });

    // Regression (fixed 2026-10): validateCampaign refuses endDate < startDate.
    test('custom campaign with endDate before startDate is refused', async () => {
        const res = await api(A.users.admin).post('/campaigns')
            .send(body({ type: 'custom', startDate: '2026-12-10', endDate: '2026-12-01' }));
        expect(res.status).toBe(400);
    });

    // Regression (fixed 2026-10): type / dates / branch are validated up front and Validation/CastErrors map to 400.
    test.each([
        ['unknown type', { type: 'weekly' }],
        ['unparseable date', { startDate: 'soon', endDate: 'later', type: 'custom' }],
        ['malformed branch id', { branch: 'nope' }],
    ])('%s → 400 (not 500)', async (_l, extra) => {
        const res = await api(A.users.admin).post('/campaigns').send(body(extra));
        expect(res.status).toBe(400);
    });

    // Not a crash, but worth pinning: parseInt silently truncates.
    test('points "12.9" / "10abc" are truncated to 12 / 10 by parseInt', async () => {
        const a = await api(A.users.admin).post('/campaigns').send(body({ points: '12.9' }));
        const b = await api(A.users.admin).post('/campaigns').send(body({ points: '10abc' }));
        expect(a.body.campaign.points).toBe(12);
        expect(b.body.campaign.points).toBe(10);
    });
});

describe('list / stats scope', () => {
    let T;
    let tFc;
    let tFcAdmin;
    beforeAll(async () => {
        T = await seedTenant({ label: 'cm-stats' });
        tFc = await Branch.create({ restaurant: T.restaurant._id, name: 'FC', slug: 'fc', isActive: true });
        tFcAdmin = await createUser({
            name: 'T fc', email: `cm.tfc.${rid()}@staff.test`, role: 'admin',
            restaurant: T.restaurant._id, branch: tFc._id, permissions: defaultPermissionsForRole('admin'),
        });
        await makeCampaign(T, { branch: null, enabled: true, totalPointsIssued: 1200, customersAffected: 40 });
        await makeCampaign(T, { branch: null, enabled: false, totalPointsIssued: 300, customersAffected: 7 });
        await makeCampaign(T, { branch: tFc._id, enabled: true, totalPointsIssued: 55, customersAffected: 3 });
        await makeCampaign(A, { totalPointsIssued: 99999, customersAffected: 999 });
    });

    test('owner list = every campaign of the tenant, newest first, no other tenant', async () => {
        const res = await api(T.users.admin).get('/campaigns');
        expect(res.status).toBe(200);
        expect(res.body.campaigns).toHaveLength(3);
        expect(res.body.campaigns.every((c) => String(c.restaurant) === String(T.restaurant._id))).toBe(true);
        const times = res.body.campaigns.map((c) => new Date(c.createdAt).getTime());
        expect([...times].sort((x, y) => y - x)).toEqual(times);
    });

    test('owner stats: exact counts and sums', async () => {
        const res = await api(T.users.admin).get('/campaigns/stats');
        expect(res.body.stats).toEqual({ activeCampaigns: 2, totalCampaigns: 3, totalPointsIssued: 1555, totalCustomersImpacted: 50 });
    });

    test('branch admin list + stats cover only their branch (no tenant-level leak)', async () => {
        const list = await api(tFcAdmin).get('/campaigns?branch=all');
        expect(list.body.campaigns).toHaveLength(1);
        expect(String(list.body.campaigns[0].branch)).toBe(String(tFc._id));
        const stats = await api(tFcAdmin).get('/campaigns/stats');
        expect(stats.body.stats).toEqual({ activeCampaigns: 1, totalCampaigns: 1, totalPointsIssued: 55, totalCustomersImpacted: 3 });
    });

    test.each([
        ['?branch=tenant-only', '?branch=tenant-only', { activeCampaigns: 1, totalCampaigns: 2, totalPointsIssued: 1500, totalCustomersImpacted: 47 }],
        ['?branch=<fc>', () => `?branch=${tFc._id}`, { activeCampaigns: 1, totalCampaigns: 1, totalPointsIssued: 55, totalCustomersImpacted: 3 }],
    ])('owner stats with %s narrow like the list', async (_l, q, expected) => {
        const qs = typeof q === 'function' ? q() : q;
        const res = await api(T.users.admin).get(`/campaigns/stats${qs}`);
        expect(res.body.stats).toEqual(expected);
        const list = await api(T.users.admin).get(`/campaigns${qs}`);
        expect(list.body.campaigns).toHaveLength(expected.totalCampaigns);
    });

    test('empty tenant stats are zeros', async () => {
        const E = await seedTenant({ label: 'cm-empty' });
        const res = await api(E.users.admin).get('/campaigns/stats');
        expect(res.body.stats).toEqual({ activeCampaigns: 0, totalCampaigns: 0, totalPointsIssued: 0, totalCustomersImpacted: 0 });
    });
});

describe('toggle / update / delete', () => {
    test('toggle flips enabled both ways and the status virtual follows', async () => {
        const c = await makeCampaign(A);
        const off = await api(A.users.admin).patch(`/campaigns/${c._id}/toggle`);
        expect(off.status).toBe(200);
        expect(off.body.campaign).toMatchObject({ enabled: false, status: 'Inactive' });
        expect((await Campaign.findById(c._id).lean()).enabled).toBe(false);
        const on = await api(A.users.admin).patch(`/campaigns/${c._id}/toggle`);
        expect(on.body.campaign).toMatchObject({ enabled: true, status: 'Active' });
        expect((await Campaign.findById(c._id).lean()).enabled).toBe(true);
    });

    test('update changes name / points / schedule; restaurant in body is ignored', async () => {
        const c = await makeCampaign(A);
        const res = await api(A.users.admin).put(`/campaigns/${c._id}`).send({
            name: 'Renamed', points: 75, startDate: '2026-12-01T00:00:00.000Z', endDate: '2026-12-31T00:00:00.000Z',
            restaurant: String(B.restaurant._id),
        });
        expect(res.status).toBe(200);
        const saved = await Campaign.findById(c._id).lean();
        expect(saved).toMatchObject({ name: 'Renamed', points: 75 });
        expect(saved.endDate.toISOString()).toBe('2026-12-31T00:00:00.000Z');
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
    });

    test('$-operator smuggling in the update body is stripped (no tenant hop)', async () => {
        const c = await makeCampaign(A);
        const res = await api(A.users.admin).put(`/campaigns/${c._id}`)
            .send({ $set: { restaurant: String(B.restaurant._id) }, name: 'Still mine' });
        expect(res.status).toBe(200);
        const saved = await Campaign.findById(c._id).lean();
        expect(String(saved.restaurant)).toBe(String(A.restaurant._id));
        expect(saved.name).toBe('Still mine');
    });

    // Regression (fixed 2026-10): updateCampaign applies CAMPAIGN_UPDATE_FIELDS allowlist (no counters / createdBy).
    test('update cannot overwrite server counters or createdBy', async () => {
        const c = await makeCampaign(A, { totalPointsIssued: 10, customersAffected: 1, createdBy: A.users.admin._id });
        await api(A.users.admin).put(`/campaigns/${c._id}`)
            .send({ totalPointsIssued: 1000000, customersAffected: 5000, createdBy: String(A.users.waiter._id) });
        const saved = await Campaign.findById(c._id).lean();
        expect(saved.totalPointsIssued).toBe(10);
        expect(saved.customersAffected).toBe(1);
        expect(String(saved.createdBy)).toBe(String(A.users.admin._id));
    });

    // Regression (fixed 2026-10): updateCampaign runs resolveOwnedBranch and validates points / type → 400.
    test("owner update cannot move a campaign to another tenant's branch", async () => {
        const c = await makeCampaign(A);
        const res = await api(A.users.admin).put(`/campaigns/${c._id}`).send({ branch: String(B.branch._id) });
        expect(res.status).toBe(400);
        expect((await Campaign.findById(c._id).lean()).branch).toBeNull();
    });

    test.each([
        ['points 0', { points: 0 }],
        ['unknown type', { type: 'weekly' }],
    ])('update with %s → 400 (value is not stored)', async (_l, upd) => {
        const c = await makeCampaign(A);
        const res = await api(A.users.admin).put(`/campaigns/${c._id}`).send(upd);
        expect((await Campaign.findById(c._id).lean()).points).toBe(10);
        expect(res.status).toBe(400);
    });

    test('update with only an endDate before the stored startDate → 400 (merged check)', async () => {
        const c = await makeCampaign(A, { type: 'custom', startDate: new Date('2026-12-10'), endDate: new Date('2026-12-20') });
        const res = await api(A.users.admin).put(`/campaigns/${c._id}`).send({ endDate: '2026-12-01' });
        expect(res.status).toBe(400);
        expect((await Campaign.findById(c._id).lean()).endDate.toISOString()).toBe('2026-12-20T00:00:00.000Z');
    });

    test('branch admin cannot re-assign their campaign to another branch (branch silently dropped)', async () => {
        const c = await makeCampaign(A, { branch: fc._id });
        const res = await api(fcAdmin).put(`/campaigns/${c._id}`).send({ branch: String(kt._id), name: 'FC promo' });
        expect(res.status).toBe(200);
        const saved = await Campaign.findById(c._id).lean();
        expect(String(saved.branch)).toBe(String(fc._id));
        expect(saved.name).toBe('FC promo');
    });

    test.each([
        ['another tenant admin', () => B.users.admin, () => ({})],
        ['a branch admin on a sibling branch campaign', () => fcAdmin, () => ({ branch: kt._id })],
        ['a branch admin on a tenant-level campaign', () => fcAdmin, () => ({ branch: null })],
    ])('%s → 404 on toggle / update / delete, campaign untouched', async (_l, user, fields) => {
        const c = await makeCampaign(A, fields());
        const u = user();
        expect((await api(u).patch(`/campaigns/${c._id}/toggle`)).status).toBe(404);
        expect((await api(u).put(`/campaigns/${c._id}`).send({ name: 'Hijacked' })).status).toBe(404);
        expect((await api(u).delete(`/campaigns/${c._id}`)).status).toBe(404);
        const saved = await Campaign.findById(c._id).lean();
        expect(saved).toMatchObject({ name: c.name, enabled: true });
    });

    test('delete removes it; second delete → 404', async () => {
        const c = await makeCampaign(A);
        expect((await api(A.users.admin).delete(`/campaigns/${c._id}`)).status).toBe(200);
        expect(await Campaign.findById(c._id)).toBeNull();
        expect((await api(A.users.admin).delete(`/campaigns/${c._id}`)).status).toBe(404);
    });

    // Regression (fixed 2026-10): routes/campaignRoute.js validates :id with objectIdParam → 400.
    test.each(['patch', 'put', 'delete'])('%s with a malformed id → 4xx, not 500', async (method) => {
        const url = method === 'patch' ? '/campaigns/not-an-id/toggle' : '/campaigns/not-an-id';
        const res = await api(A.users.admin)[method](url).send({ name: 'x' });
        expect(res.status).toBeLessThan(500);
    });
});
