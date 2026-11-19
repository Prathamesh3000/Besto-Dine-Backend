/**
 * Dashboard stats (GET /telemetry/stats) — menu + offer counts per branch.
 *
 * Bug (browser QA 2026-11-16): the admin dashboard showed "Menu 0 active /
 * 0 inactive" and "Active Offers 0" once a branch id was sent, even though the
 * Menu page listed 12 items. Menu items and coupons stored with branch:null are
 * "shared across all branches" and belong to the tenant's Main branch
 * (utils/tenantScope.branchScopeClause) — the dashboard counted only rows whose
 * branch equalled the selected one, so a Main view lost every shared row.
 *
 * Rules pinned here:
 *   - branch=all            → every row in the tenant
 *   - branch=<Main id>      → that branch's rows PLUS the shared (branch:null) ones
 *   - branch=<sub-branch>   → strictly that branch's rows (no leak from Main/shared)
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Branch = require(path.join(BACKEND, 'models/branch'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));

const ctx = useIntegrationApp();
let A;
let sub;
let seeded = 0;   // active, shared (branch:null) items seedTenant creates itself

const item = (name, extra = {}) => MenuItem.create({
    restaurant: A.restaurant._id, branch: null, category: A.category._id, name,
    description: 'x', basePrice: 50, vegType: 'veg', prepStation: 'kitchen', status: 'active', ...extra,
});
const coupon = (code, extra = {}) => Coupon.create({
    restaurant: A.restaurant._id, branch: null, code, title: code, discountValue: 10,
    startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() + 7 * 86400000), isActive: true, ...extra,
});

beforeAll(async () => {
    A = await seedTenant({ label: 'tel' });                 // A.branch is the Main branch
    sub = await Branch.create({ restaurant: A.restaurant._id, name: 'Kothrud', slug: 'kothrud', isActive: true });
    seeded = await MenuItem.countDocuments({ restaurant: A.restaurant._id, branch: null, status: 'active' });

    // Shared (branch:null): two active, one hidden — the staging shape (active + 1 hidden).
    await item('Shared Chai');
    await item('Shared Naan');
    await item('Shared Hidden Soda', { status: 'archived' });
    // Owned by the sub-branch only.
    await item('Kothrud Special', { branch: sub._id });

    await coupon('SHARED10');                               // tenant-wide
    await coupon('KOTHRUD5', { branch: sub._id });          // sub-branch only
});

test('safety: runs on a throw-away in-memory database, never bestodine / bestodine_staging / :27018', () => {
    const mongoose = require('mongoose');
    expect(mongoose.connection.name).toMatch(/^bd_it_\d+_[0-9a-f]{8}$/);
    expect(mongoose.connection.name).toBe(process.env.INTEGRATION_DB_NAME);
    expect(mongoose.connection.host).toBe('127.0.0.1');
    expect(mongoose.connection.port).not.toBe(27018);      // the staging DB
    expect(['bestodine', 'bestodine_staging']).not.toContain(mongoose.connection.name);
});

const stats = async (branch) => {
    const res = await ctx.api.as(A.users.admin).get(`/telemetry/stats?earningsPeriod=daily&bookingTime=today&branch=${branch}`);
    expect(res.status).toBe(200);
    return res.body.stats;
};

describe('GET /telemetry/stats menu + offer counts', () => {
    test('branch=all counts every menu item and coupon in the tenant', async () => {
        const s = await stats('all');
        expect(s.totalMenu).toBe(seeded + 4);
        expect(s.activeMenu).toBe(seeded + 3);
        expect(s.inactiveMenu).toBe(1);
        expect(s.activeOffers).toBe(2);
    });

    test('the Main branch includes the shared (branch:null) items and coupons', async () => {
        const s = await stats(String(A.branch._id));
        expect(s.totalMenu).toBe(seeded + 3);                // shared: seeded + 2 active + 1 hidden; NOT Kothrud's
        expect(s.activeMenu).toBe(seeded + 2);
        expect(s.inactiveMenu).toBe(1);
        expect(s.activeOffers).toBe(1);                      // SHARED10 only
    });

    test('a sub-branch stays strict — shared and Main rows do not leak in', async () => {
        const s = await stats(String(sub._id));
        expect(s.totalMenu).toBe(1);                         // Kothrud Special only
        expect(s.activeMenu).toBe(1);
        expect(s.inactiveMenu).toBe(0);
        expect(s.activeOffers).toBe(1);                      // KOTHRUD5 only
    });
});
