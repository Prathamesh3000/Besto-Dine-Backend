/**
 * Reports, exports and notification ownership:
 *   - GET /analytics/{summary,top-items,peak-hours,sales-history} — exact
 *     money sums, cancelled / refunded exclusion, branch scope, timezone
 *   - GET /telemetry/{stats,reports,forecast} — exact totals, IST day
 *     boundaries, range validation, garbage input, branch pin
 *   - GET /crm/customers(/:id) — LTV sums, no credential leakage, branch scope
 *   - GET /tenant/export — bundle completeness (every tenant-scoped
 *     collection), no secrets, xlsx formula-injection, cooldown
 *   - /superadmin/restaurants/:id/backup(s) — create / list / download /
 *     delete, no secrets, filename sanitising
 *   - /notifications — list / mark-read / delete / clear only reach the
 *     caller's own notifications (personal + branch scope), POST validation
 *
 * Orders are inserted directly through the Order model with known money
 * fields; createdAt is then rewritten through the raw collection so the
 * timezone boundaries are exact.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser, createCustomer, createTable, setWallet } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();

const rand = (n = 4) => crypto.randomBytes(n).toString('hex');
const oid = () => `RX-${rand(6)}`;

// ── Time helpers (IST = UTC+05:30, no DST) ──────────────────────────────
const IST_OFFSET_MS = 330 * 60 * 1000;
/** Wall-clock time in IST → UTC Date. */
const ist = (y, m, d, hh = 0, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS);
const istKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD of a Date in IST. */
const istKey = (d) => istKeyFmt.format(d);

/** Insert an order with exact money fields, then pin its createdAt. */
async function mkOrder(t, { createdAt, ...fields } = {}) {
    const doc = await Order.create({
        restaurant: t.restaurant._id,
        branch: t.branch._id,
        orderId: oid(),
        type: 'dine-in',
        customerName: 'Walk-in',
        items: [{ name: 'Paneer Tikka', price: 200, quantity: 1 }],
        total: 200,
        status: 'served',
        paymentStatus: 'Paid',
        ...fields,
    });
    if (createdAt) await Order.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
    return doc;
}

const subAdmin = (t, branch, label) => createUser({
    name: `sub admin ${label}`,
    email: `sub.${label}.${t.slug}@staff.test`,
    role: 'admin',
    restaurant: t.restaurant._id,
    branch: branch._id,
    permissions: defaultPermissionsForRole('admin'),
});

/** supertest parser that keeps a binary body as a Buffer. */
const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// ════════════════════════════════════════════════════════════════════════
// Report dataset (tenant R) — all dates in 2025 so no "last 30 days"
// window ever touches them.
//
//   O1  10 Aug 11:30 IST  served   Paid      1000  cash   Paneer×3 @200, Naan×5 @40, tip 50, rating 4
//   O2  10 Aug 23:30 IST  served   Paid       500  upi    Paneer×2 @200, coupon 30 + manual 20, rating 5
//   O3  10 Aug 13:30 IST  CANCELLED Paid      700  card   Thali×2 @250    (cancelled, refund pending)
//   O4  10 Aug 14:30 IST  served   Refunded   300  online Naan×2 @40      (fully refunded)
//   O5  10 Aug 15:30 IST  served   Pending    250  —      Thali×1 @250
//   O6  11 Aug 00:30 IST  served   Paid       400  wallet Naan×10 @40     (next IST day)
//   O7   9 Aug 23:59 IST  served   Paid       999  netbanking Combo×1     (previous IST day)
//   O8  12 Aug 12:30 IST  served   Paid       250  cash   Lassi×1 @250    (branch 2)
// ════════════════════════════════════════════════════════════════════════
let R; let R2; let subR2;
let cust1; let cust2; let cust3;

// ── CRM (tenant C) ──
let C; let C2; let subC2; let custA; let custB; let custW; let custX;

// ── Telemetry stats / sales history (tenant S) ──
let S; let dayD; let dayKeyD;

// ── Tenant whose configured timezone is New York ──
let Z;

beforeAll(async () => {
    // ── R: report dataset ───────────────────────────────────────────────
    R = await seedTenant({ label: 'rp-r' });
    R2 = await Branch.create({ restaurant: R.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    subR2 = await subAdmin(R, R2, 'r2');
    cust1 = await createCustomer('rp1');
    cust2 = await createCustomer('rp2');
    cust3 = await createCustomer('rp3');

    await mkOrder(R, {
        createdAt: ist(2025, 8, 10, 11, 30), user: cust1._id, total: 1000, paymentMethod: 'cash',
        amountPaid: 1000, tipAmount: 50, rating: 4,
        items: [{ name: 'Paneer Tikka', price: 200, quantity: 3, category: 'Mains', vegType: 'veg' },
            { name: 'Garlic Naan', price: 40, quantity: 5, category: 'Breads', vegType: 'veg' }],
    });
    await mkOrder(R, {
        createdAt: ist(2025, 8, 10, 23, 30), user: cust1._id, total: 500, paymentMethod: 'upi',
        amountPaid: 500, couponDiscount: 30, manualDiscount: 20, rating: 5,
        items: [{ name: 'Paneer Tikka', price: 200, quantity: 2, category: 'Mains', vegType: 'veg' }],
    });
    await mkOrder(R, {
        createdAt: ist(2025, 8, 10, 13, 30), user: cust2._id, total: 700, paymentMethod: 'card',
        amountPaid: 700, status: 'cancelled',
        items: [{ name: 'Veg Thali', price: 250, quantity: 2, category: 'Mains', vegType: 'veg' }],
    });
    await mkOrder(R, {
        createdAt: ist(2025, 8, 10, 14, 30), total: 300, paymentMethod: 'online', amountPaid: 300,
        paymentStatus: 'Refunded', refundedAmount: 300,
        items: [{ name: 'Garlic Naan', price: 40, quantity: 2, category: 'Breads', vegType: 'veg' }],
    });
    await mkOrder(R, {
        createdAt: ist(2025, 8, 10, 15, 30), user: cust3._id, total: 250, paymentStatus: 'Pending',
        items: [{ name: 'Veg Thali', price: 250, quantity: 1, category: 'Mains', vegType: 'veg' }],
    });
    await mkOrder(R, {
        createdAt: ist(2025, 8, 11, 0, 30), total: 400, paymentMethod: 'wallet', amountPaid: 400,
        items: [{ name: 'Garlic Naan', price: 40, quantity: 10, category: 'Breads', vegType: 'veg' }],
    });
    await mkOrder(R, {
        createdAt: ist(2025, 8, 9, 23, 59), total: 999, paymentMethod: 'netbanking', amountPaid: 999,
        items: [{ name: 'Combo', price: 999, quantity: 1, category: 'Combos', vegType: 'non-veg' }],
    });
    await mkOrder(R, {
        createdAt: ist(2025, 8, 12, 12, 30), branch: R2._id, total: 250, paymentMethod: 'cash', amountPaid: 250,
        items: [{ name: 'Lassi', price: 250, quantity: 1, category: 'Drinks', vegType: 'veg' }],
    });

    // ── C: CRM ──────────────────────────────────────────────────────────
    C = await seedTenant({ label: 'rp-c' });
    C2 = await Branch.create({ restaurant: C.restaurant._id, name: 'Second', slug: 'second', isActive: true });
    subC2 = await subAdmin(C, C2, 'c2');
    custA = await createCustomer('crmA', { mobile: '9111100001' });
    custB = await createCustomer('crmB');
    custW = await createCustomer('crmW');
    custX = await createCustomer('crmX');
    await mkOrder(C, { user: custA._id, total: 1000, paymentMethod: 'cash', note: 'less spicy please' });
    // A large order that was cancelled before anyone paid — no money changed hands.
    await mkOrder(C, { user: custA._id, total: 20000, status: 'cancelled', paymentStatus: 'Pending' });
    await mkOrder(C, { user: custB._id, branch: C2._id, total: 300, paymentMethod: 'upi' });
    await mkOrder(C, { user: null, total: 80 });             // guest order
    await setWallet(C, custA, { balance: 150, loyaltyPoints: 20 });
    await setWallet(C, custW, { balance: 500, loyaltyPoints: 0 });

    // ── S: today stats + 30-day history ─────────────────────────────────
    S = await seedTenant({ label: 'rp-s' });
    dayD = new Date(Date.now() - 5 * 86400000);
    dayKeyD = istKey(dayD);
    const [y, m, d] = dayKeyD.split('-').map(Number);
    await mkOrder(S, { createdAt: ist(y, m, d, 0, 30), total: 300, paymentMethod: 'cash' });
    await mkOrder(S, { createdAt: ist(y, m, d, 12, 0), total: 200, paymentMethod: 'cash' });
    await mkOrder(S, { createdAt: ist(y, m, d, 13, 0), total: 50, paymentStatus: 'Pending' });
    const d8 = new Date(Date.now() - 8 * 86400000);
    await mkOrder(S, { createdAt: d8, total: 900, status: 'cancelled' });   // cancelled, still 'Paid'
    // Today
    await mkOrder(S, { total: 1200, paymentMethod: 'cash' });
    await mkOrder(S, { total: 800, status: 'cancelled' });                  // cancelled, still 'Paid'
    await mkOrder(S, { total: 100, status: 'new', paymentStatus: 'Pending' });

    // ── Z: New-York tenant ──────────────────────────────────────────────
    Z = await seedTenant({ label: 'rp-z' });
    await Restaurant.updateOne({ _id: Z.restaurant._id }, { $set: { timezone: 'America/New_York' } });
    // 10 Aug 22:00 EDT = 11 Aug 02:00 UTC = 11 Aug 07:30 IST.
    await mkOrder(Z, { createdAt: new Date('2025-08-11T02:00:00Z'), total: 600, paymentMethod: 'cash' });
});

// ════════════════════════════════════════════════════════════════════════
describe('GET /analytics/*', () => {
    test('summary: revenue = Paid and not cancelled, orders exclude cancelled, customers distinct', async () => {
        const res = await ctx.api.as(R.users.admin).get('/analytics/summary');
        expect(res.status).toBe(200);
        // O1 1000 + O2 500 + O6 400 + O7 999 + O8 250 (O3 cancelled, O4 refunded, O5 unpaid)
        expect(res.body.summary.revenue).toBe(3149);
        expect(res.body.summary.orders).toBe(7);
        expect(res.body.summary.customers).toBe(3);
    });

    test('summary: ?branch=<id> narrows; a branch-pinned admin cannot widen with ?branch=all', async () => {
        const main = await ctx.api.as(R.users.admin).get(`/analytics/summary?branch=${R.branch._id}`);
        expect(main.body.summary.revenue).toBe(2899);
        expect(main.body.summary.orders).toBe(6);

        const pinned = await ctx.api.as(subR2).get('/analytics/summary?branch=all');
        expect(pinned.status).toBe(200);
        expect(pinned.body.summary).toEqual({ revenue: 250, orders: 1, customers: 0 });

        const garbage = await ctx.api.as(R.users.admin).get('/analytics/summary?branch=not-an-id');
        expect(garbage.status).toBe(200);
        expect(garbage.body.summary.revenue).toBe(3149);
    });

    test('top-items: quantities exact and cancelled order lines excluded', async () => {
        const res = await ctx.api.as(R.users.admin).get('/analytics/top-items');
        expect(res.status).toBe(200);
        const by = Object.fromEntries(res.body.topItems.map((r) => [r._id, r]));
        expect(by['Paneer Tikka']).toEqual({ _id: 'Paneer Tikka', totalQuantity: 5, totalRevenue: 1000 });
        // Only O5's Thali — the two on cancelled O3 are not "sold".
        expect(by['Veg Thali']).toEqual({ _id: 'Veg Thali', totalQuantity: 1, totalRevenue: 250 });
        expect(res.body.topItems[0]._id).toBe('Garlic Naan');
    });

    // Regression (fixed 2026-10): getTopItems excludes paymentStatus 'Refunded' orders.
    test('top-items revenue excludes fully refunded orders', async () => {
        const res = await ctx.api.as(R.users.admin).get('/analytics/top-items');
        const naan = res.body.topItems.find((r) => r._id === 'Garlic Naan');
        // O1 5×40 + O6 10×40 = 600 (O4's refunded 2×40 must not count).
        expect(naan.totalRevenue).toBe(600);
    });

    // Regression (fixed 2026-10): getPeakHours buckets $hour in the tenant timezone (default Asia/Kolkata).
    test('peak-hours buckets by the tenant timezone, not UTC', async () => {
        const res = await ctx.api.as(R.users.admin).get('/analytics/peak-hours');
        expect(res.status).toBe(200);
        // Non-cancelled orders at IST 11:30, 23:30, 14:30, 15:30, 00:30, 23:59, 12:30.
        expect(res.body.peakHours).toEqual([
            { _id: 0, count: 1 }, { _id: 11, count: 1 }, { _id: 12, count: 1 },
            { _id: 14, count: 1 }, { _id: 15, count: 1 }, { _id: 23, count: 2 },
        ]);
    });

    test('sales-history: only Paid, non-cancelled orders in the last 30 days are summed', async () => {
        const res = await ctx.api.as(S.users.admin).get('/analytics/sales-history');
        expect(res.status).toBe(200);
        // Today's 1200 + day D's 300 + 200 (pending 50 and both cancelled excluded).
        const sum = res.body.sales.reduce((s, r) => s + r.total, 0);
        const count = res.body.sales.reduce((s, r) => s + r.count, 0);
        expect(sum).toBe(1700);
        expect(count).toBe(3);
    });

    // Regression (fixed 2026-10): getSalesHistory formats days in the tenant timezone.
    test('sales-history books a 00:30 IST order on its IST day', async () => {
        const res = await ctx.api.as(S.users.admin).get('/analytics/sales-history');
        const dayRow = res.body.sales.find((r) => r._id === dayKeyD);
        expect(dayRow).toEqual({ _id: dayKeyD, total: 500, count: 2 });
    });

    test.each([
        ['waiter', (t) => t.users.waiter],
        ['customer', () => cust1],
    ])('%s cannot read analytics (403)', async (_label, who) => {
        const res = await ctx.api.as(who(R), R).get('/analytics/summary');
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('GET /telemetry/reports', () => {
    const report = (user, q) => ctx.api.as(user).get(`/telemetry/reports${q}`);

    test('IST day boundaries: 23:30 IST counts on that day; 00:30 next day and 23:59 previous day do not', async () => {
        const res = await report(R.users.admin, '?from=2025-08-10&to=2025-08-10');
        expect(res.status).toBe(200);
        expect(res.body.range).toEqual({ from: '2025-08-10', to: '2025-08-10', days: 1 });
        expect(res.body.earnings.bucket).toBe('Hourly');

        const pay = Object.fromEntries(res.body.patterns.byPayment.map((r) => [r.label, r]));
        expect(pay.upi).toEqual({ label: 'upi', orders: 1, earnings: 500 });      // O2 at 23:30 IST
        expect(pay.cash).toEqual({ label: 'cash', orders: 1, earnings: 1000 });
        expect(pay.wallet).toBeUndefined();                                        // O6 00:30 next day
        expect(pay.netbanking).toBeUndefined();                                    // O7 23:59 prev day

        const hour = Object.fromEntries(res.body.patterns.byHour.map((r) => [r.hour, r]));
        expect(hour[23]).toEqual({ hour: 23, label: '11:00 PM', orders: 1, earnings: 500 });
        expect(hour[11]).toEqual({ hour: 11, label: '11:00 AM', orders: 1, earnings: 1000 });
        const series = Object.fromEntries(res.body.earnings.data.map((r) => [r.label, r.value]));
        expect(series['11:00 PM']).toBe(500);
        expect(series['11:00 AM']).toBe(1000);
    });

    test('order-level totals: counts, tips, discounts, refunds, rating are exact', async () => {
        const res = await report(R.users.admin, '?from=2025-08-10&to=2025-08-10');
        const t = res.body.totals;
        expect(t.orders).toBe(5);
        expect(t.cancelledOrders).toBe(1);
        expect(t.cancellationRate).toBe(20);
        expect(t.tips).toBe(50);
        expect(t.discounts).toBe(50);
        expect(t.refunds).toBe(300);
        expect(t.itemsSold).toBe(13);                   // 8 + 2 + 2 + 1, cancelled O3 excluded
        expect(t.avgRating).toBe(4.5);
        expect(t.ratingCount).toBe(2);
        // Previous equal-length window = 9 Aug IST → only O7.
        expect(res.body.trend.prev).toEqual({ from: '2025-08-09', to: '2025-08-09', earnings: 999, orders: 1, avgOrderValue: 999 });
    });

    test('top items: cancelled lines excluded, revenue = price × qty', async () => {
        const res = await report(R.users.admin, '?from=2025-08-10&to=2025-08-10');
        const by = Object.fromEntries(res.body.topItems.map((r) => [r.name, r]));
        expect(by['Paneer Tikka']).toMatchObject({ count: 5, revenue: 1000, category: 'Mains' });
        expect(by['Veg Thali']).toMatchObject({ count: 1, revenue: 250 });
        expect(res.body.patterns.byVegType).toEqual({ veg: 13, nonVeg: 0, unspecified: 0 });
    });

    // Regression (fixed 2026-10): telemetry earnings (PAID facets, range/forecast/stats aggregations) exclude status 'cancelled'.
    test('report earnings exclude a cancelled (refund-pending) order', async () => {
        const res = await report(R.users.admin, '?from=2025-08-10&to=2025-08-10');
        expect(res.body.totals.earnings).toBe(1500);
        expect(res.body.totals.paidOrders).toBe(2);
        expect(res.body.totals.avgOrderValue).toBe(750);
    });

    test('branch-pinned admin is locked to their branch even with ?branch=all; owner can narrow', async () => {
        const pinned = await report(subR2, '?from=2025-08-12&to=2025-08-12&branch=all');
        expect(pinned.status).toBe(200);
        expect(pinned.body.totals.earnings).toBe(250);
        expect(pinned.body.totals.orders).toBe(1);

        const ownerMain = await report(R.users.admin, `?from=2025-08-12&to=2025-08-12&branch=${R.branch._id}`);
        expect(ownerMain.body.totals.orders).toBe(0);
        expect(ownerMain.body.totals.earnings).toBe(0);

        const ownerAll = await report(R.users.admin, '?from=2025-08-12&to=2025-08-12');
        expect(ownerAll.body.totals.earnings).toBe(250);
    });

    test('multi-day range buckets daily and lands each order on its IST day', async () => {
        const res = await report(R.users.admin, '?from=2025-08-09&to=2025-08-11');
        expect(res.body.earnings.bucket).toBe('Daily');
        expect(res.body.range.days).toBe(3);
        const byLabel = Object.fromEntries(res.body.earnings.data.map((r) => [r.label, r.value]));
        expect(byLabel['Aug 9']).toBe(999);
        expect(byLabel['Aug 11']).toBe(400);
    });

    test('range > 92 days buckets monthly', async () => {
        const res = await report(R.users.admin, '?from=2025-01-01&to=2025-12-31');
        expect(res.status).toBe(200);
        expect(res.body.earnings.bucket).toBe('Monthly');
        expect(res.body.earnings.data).toHaveLength(12);
        expect(res.body.earnings.data.find((r) => r.label === 'Aug 25')).toBeDefined();
    });

    test.each([
        ['from after to', '?from=2025-08-11&to=2025-08-10', 400],
        ['range > 2 years', '?from=2020-01-01&to=2025-01-01', 400],
    ])('rejects %s', async (_label, q, status) => {
        const res = await report(R.users.admin, q);
        expect(res.status).toBe(status);
        expect(res.body.success).toBe(false);
    });

    test.each([
        ['malformed date', '?from=10/08/2025&to=yesterday'],
        ['array params', '?from[]=2025-08-10&to[$gt]=x'],
        ['huge value', `?from=${'9'.repeat(5000)}`],
        ['garbage branch', '?branch=%00%24where'],
    ])('garbage input (%s) falls back to defaults without crashing', async (_label, q) => {
        const res = await report(R.users.admin, q);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('waiter gets 403', async () => {
        expect((await report(R.users.waiter, '')).status).toBe(403);
    });

    // Regression (fixed 2026-10): telemetry reportTz(req) buckets in Restaurant.timezone, falling back to ANALYTICS_TIMEZONE / Asia/Kolkata.
    test('reports use the tenant timezone (America/New_York)', async () => {
        const res = await report(Z.users.admin, '?from=2025-08-10&to=2025-08-10');
        expect(res.status).toBe(200);
        expect(res.body.totals.earnings).toBe(600);
        expect(res.body.patterns.byHour.map((r) => r.hour)).toEqual([22]);
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('GET /telemetry/stats and /telemetry/forecast', () => {
    test.each(['daily', 'weekly', 'monthly'])('stats earningsPeriod=%s → 200 with exact today counts', async (period) => {
        const res = await ctx.api.as(S.users.admin).get(`/telemetry/stats?earningsPeriod=${period}`);
        expect(res.status).toBe(200);
        expect(res.body.stats.todayOrders).toBe(3);
        expect(res.body.stats.pendingOrders).toBe(1);
        expect(res.body.stats.totalMenu).toBe(3);
        expect(res.body.earningsLabel).toBe(period === 'daily' ? 'Hourly' : 'Daily');
    });

    test('stats ?branch=<id>: live orders follow the table branch; pinned admin is locked to theirs', async () => {
        const S2 = await Branch.create({ restaurant: S.restaurant._id, name: 'Second', slug: `second-${rand(2)}`, isActive: true });
        const t2 = await createTable(S, { name: 'S2-T', branch: S2._id });
        // Stamped on the main branch but seated at a Second-branch table:
        // the live card must follow the table, not the stamped branch.
        await mkOrder(S, { table: t2._id, total: 10, status: 'new', paymentStatus: 'Pending' });
        const sub = await subAdmin(S, S2, 's2');

        const main = await ctx.api.as(S.users.admin).get(`/telemetry/stats?branch=${S.branch._id}`);
        expect(main.status).toBe(200);
        expect(main.body.liveOrders.map((o) => o.price).sort()).toEqual(['100.00', '1200.00', '800.00']);
        expect(main.body.liveOrders.every((o) => o.table === 'Takeaway')).toBe(true);

        const pinned = await ctx.api.as(sub).get('/telemetry/stats?branch=all');
        expect(pinned.status).toBe(200);
        expect(pinned.body.liveOrders.map((o) => [o.table, o.price])).toEqual([['S2-T', '10.00']]);
        expect(pinned.body.stats.todayOrders).toBe(0);
        expect(pinned.body.stats.totalMenu).toBe(0);
        await Order.deleteMany({ table: t2._id });
    });

    test('stats rejects an unknown earningsPeriod', async () => {
        const res = await ctx.api.as(S.users.admin).get('/telemetry/stats?earningsPeriod=yearly');
        expect(res.status).toBe(400);
    });

    // Regression (fixed 2026-10): getStats todayEarnings only sums Paid, non-cancelled orders.
    test('stats todayEarnings excludes a cancelled order', async () => {
        const res = await ctx.api.as(S.users.admin).get('/telemetry/stats');
        expect(res.body.stats.todayEarnings).toBe('₹1,200.00');
    });

    // Regression (fixed 2026-10): getStats only treats a 24-hex ?branch as an active branch; garbage is ignored.
    test.each([['abc'], ['%5Bobject%5D'], ['123']])('stats ?branch=%s ignores the bad id (200, not 500)', async (b) => {
        const res = await ctx.api.as(S.users.admin).get(`/telemetry/stats?branch=${b}`);
        expect(res.status).toBe(200);
    });

    test('forecast: history totals exact, clamps lookback/horizon', async () => {
        const res = await ctx.api.as(S.users.admin).get('/telemetry/forecast?lookback=14&horizon=7');
        expect(res.status).toBe(200);
        expect(res.body.lookbackDays).toBe(14);
        expect(res.body.horizonDays).toBe(7);
        expect(res.body.history).toHaveLength(14);
        expect(res.body.forecast).toHaveLength(7);
        const d = res.body.history.find((h) => h.date === dayKeyD);
        expect(d.value).toBe(500);                       // 300 + 200, pending 50 excluded
        const sum7 = res.body.forecast.reduce((s, f) => s + f.value, 0);
        expect(res.body.summary.next7).toBe(sum7);
        for (const f of res.body.forecast) expect(f.value).toBeGreaterThanOrEqual(0);
    });

    test.each([
        ['lookback=abc&horizon=xyz', 60, 30],
        ['lookback=99999&horizon=99999', 180, 60],
        ['lookback=-5&horizon=-5', 14, 7],
    ])('forecast clamps %s', async (q, lb, hz) => {
        const res = await ctx.api.as(S.users.admin).get(`/telemetry/forecast?${q}`);
        expect(res.status).toBe(200);
        expect(res.body.lookbackDays).toBe(lb);
        expect(res.body.horizonDays).toBe(hz);
    });

    test('forecast with a lot of daily history yields a back-tested accuracy', async () => {
        const F = await seedTenant({ label: 'rp-f' });
        const now = Date.now();
        for (let i = 1; i <= 40; i++) {
            await mkOrder(F, { createdAt: new Date(now - i * 86400000), total: 1000 + (i % 7) * 100 });
        }
        const res = await ctx.api.as(F.users.admin).get('/telemetry/forecast?lookback=45&horizon=30');
        expect(res.status).toBe(200);
        expect(typeof res.body.summary.accuracy).toBe('number');
        expect(['high', 'medium', 'low']).toContain(res.body.summary.confidence);
        expect(res.body.summary.next30).toBe(res.body.forecast.reduce((s, f) => s + f.value, 0));
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('GET /crm/customers', () => {
    const LIST_KEYS = ['allergy', 'email', 'id', 'lastVisit', 'loyaltyPoints', 'memberSince', 'name', 'phone',
        'spending', 'status', 'tagCategory', 'visitCount', 'walletBalance'];

    test('owner list: customers with orders or wallet only, exact wallet figures, no credentials', async () => {
        const res = await ctx.api.as(C.users.admin).get('/crm/customers');
        expect(res.status).toBe(200);
        const ids = res.body.customers.map((c) => String(c.id)).sort();
        expect(ids).toEqual([custA, custB, custW].map((u) => String(u._id)).sort());
        expect(ids).not.toContain(String(custX._id));
        for (const c of res.body.customers) expect(Object.keys(c).sort()).toEqual(LIST_KEYS);

        const a = res.body.customers.find((c) => String(c.id) === String(custA._id));
        expect(a.walletBalance).toBe(150);
        expect(a.loyaltyPoints).toBe(20);
        expect(a.phone).toBe('9111100001');
        const w = res.body.customers.find((c) => String(c.id) === String(custW._id));
        expect(w).toMatchObject({ visitCount: 0, spending: 0, walletBalance: 500, tagCategory: 'New' });
        const b = res.body.customers.find((c) => String(c.id) === String(custB._id));
        expect(b).toMatchObject({ visitCount: 1, spending: 300 });

        expect(res.body.stats).toMatchObject({ totalCustomers: 3, guestUsers: 1 });
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/\$2[aby]\$/);
        expect(text).not.toMatch(/password|tokenVersion|googleId/i);
    });

    test('branch-pinned admin sees only customers who ordered at their branch', async () => {
        const res = await ctx.api.as(subC2).get('/crm/customers');
        expect(res.status).toBe(200);
        expect(res.body.customers.map((c) => String(c.id))).toEqual([String(custB._id)]);
        expect(res.body.stats.guestUsers).toBe(0);
    });

    // Regression (fixed 2026-10): CRM totalSpent / detail totals exclude cancelled orders.
    test('CRM spending (LTV) excludes a cancelled order and does not mis-tag the customer VIP', async () => {
        const res = await ctx.api.as(C.users.admin).get('/crm/customers');
        const a = res.body.customers.find((c) => String(c.id) === String(custA._id));
        expect(a.spending).toBe(1000);
        expect(a.tagCategory).toBe('New');
    });

    test('detail: exact history, wallet, preferences; no password', async () => {
        const res = await ctx.api.as(C.users.admin).get(`/crm/customers/${custA._id}`);
        expect(res.status).toBe(200);
        expect(res.body.customer.walletBalance).toBe(150);
        expect(res.body.customer.loyaltyPoints).toBe(20);
        expect(res.body.orders).toHaveLength(2);
        expect(res.body.suggestions.map((s) => s.text)).toEqual(['less spicy please']);
        expect(res.body.preferences.favoriteItems).toEqual([{ name: 'Paneer Tikka', count: 2 }]);
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/\$2[aby]\$/);
        expect(text).not.toMatch(/"password"/);
    });

    test('detail: branch-pinned admin sees their own branch customer with branch-only totals', async () => {
        const b = await ctx.api.as(subC2).get(`/crm/customers/${custB._id}`);
        expect(b.status).toBe(200);
        expect(b.body.customer.totalSpend).toBe(300);
        expect(b.body.preferences.avgOrderValue).toBe(300);
    });

    // Regression (fixed 2026-10): getCustomerDetail ignores the tenant-level wallet as footprint for a branch-pinned admin.
    test('branch-pinned admin cannot open a customer who never ordered at their branch (wallet-only footprint)', async () => {
        const res = await ctx.api.as(subC2).get(`/crm/customers/${custA._id}`);
        // (The old "evidence" line asserted the leaked 200 body's orders: [];
        // with the fix the 404 carries no profile at all.)
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain(custA.email);
    });

    test.each([
        ['invalid id', () => 'not-an-id', 400],
        ['unknown id', () => String(new mongoose.Types.ObjectId()), 404],
        ['customer with no footprint in tenant', () => String(custX._id), 404],
    ])('detail: %s', async (_label, id, status) => {
        expect((await ctx.api.as(C.users.admin).get(`/crm/customers/${id()}`)).status).toBe(status);
    });

    test('waiter is refused', async () => {
        expect((await ctx.api.as(C.users.waiter).get('/crm/customers')).status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('GET /tenant/export', () => {
    let E; let E2; let subE2; let tableE;
    let zip; let exportRes;
    const FORMULAS = ['=HYPERLINK("http://evil","x")', "+cmd|' /C calc'!A0", '@SUM(1)', '-2+3'];

    beforeAll(async () => {
        E = await seedTenant({ label: 'rp-e' });
        E2 = await Branch.create({ restaurant: E.restaurant._id, name: 'Second', slug: 'second', isActive: true });
        subE2 = await subAdmin(E, E2, 'e2');
        tableE = await createTable(E, { name: 'Export-T' });
        for (const name of FORMULAS) {
            await MenuItem.create({
                restaurant: E.restaurant._id, category: E.category._id, name, basePrice: 10,
                description: 'x', prepStation: 'kitchen', vegType: 'veg',
            });
        }
        // A customer homed on this tenant — must not be exported as a "user".
        await createCustomer('exp', { restaurant: E.restaurant._id, name: FORMULAS[0] });
        await mkOrder(E, { customerName: FORMULAS[1], total: 123.45, razorpayOrderId: 'order_X', razorpayPaymentId: 'pay_X' });

        exportRes = await ctx.api.as(E.users.admin).get('/tenant/export').buffer(true).parse(binary);
        zip = exportRes.status === 200 ? await JSZip.loadAsync(exportRes.body) : null;
    });

    const readJson = async (name) => JSON.parse(await zip.file(`json/${name}.json`).async('string'));

    test('owner gets a zip attachment with manifest, README, xlsx and json/', async () => {
        expect(exportRes.status).toBe(200);
        expect(exportRes.headers['content-type']).toMatch(/application\/zip/);
        expect(exportRes.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="${E.slug}-data-export-\\d{4}-\\d{2}-\\d{2}\\.zip"`));
        expect(zip.file('manifest.json')).toBeTruthy();
        expect(zip.file('README.txt')).toBeTruthy();
        expect(zip.file(`${E.slug}-data-export.xlsx`)).toBeTruthy();
        const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
        expect(manifest.restaurant.slug).toBe(E.slug);
        expect(manifest.exportVersion).toBe('2.0');
    });

    test('completeness: every tenant-scoped collection is present with this tenant\'s exact row count', async () => {
        const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
        const tenantModels = mongoose.modelNames()
            .map((n) => mongoose.model(n))
            .filter((m) => m.schema.path('restaurant') && m.modelName !== 'IdempotencyRecord');
        expect(tenantModels.length).toBeGreaterThan(10);
        for (const m of tenantModels) {
            const key = m.collection.collectionName;
            const filter = m.modelName === 'User'
                ? { restaurant: E.restaurant._id, role: { $nin: ['customer', 'superadmin'] } }
                : { restaurant: E.restaurant._id };
            const expected = await m.countDocuments(filter);
            expect({ key, count: manifest.counts[key] }).toEqual({ key, count: expected });
            expect(zip.file(`json/${key}.json`)).toBeTruthy();
        }
        expect(manifest.counts.restaurant).toBe(1);
        const orders = await readJson('orders');
        expect(orders).toHaveLength(1);
        expect(orders[0].total).toBe(123.45);
        expect(await readJson('menuitems')).toHaveLength(3 + FORMULAS.length);
    });

    test('users.json holds staff only, without password / tokenVersion leaks of hashes', async () => {
        const users = await readJson('users');
        expect(users.map((u) => u.role).sort()).toEqual(['admin', 'admin', 'captain', 'chef', 'waiter']);
        for (const u of users) expect(u).not.toHaveProperty('password');
    });

    test('no secrets anywhere in the bundle (bcrypt hashes, table qrTokens)', async () => {
        const qrTokens = (await mongoose.connection.db.collection('tables')
            .find({ restaurant: E.restaurant._id }).toArray()).map((t) => t.qrToken);
        expect(qrTokens).toContain(tableE.qrToken);
        for (const name of Object.keys(zip.files)) {
            const entry = zip.file(name);
            if (!entry) continue;
            let text;
            if (name.endsWith('.xlsx')) {
                const inner = await JSZip.loadAsync(await entry.async('nodebuffer'));
                text = (await Promise.all(Object.values(inner.files).filter((f) => !f.dir)
                    .map((f) => f.async('string')))).join('\n');
            } else {
                text = await entry.async('string');
            }
            expect({ name, bcrypt: /\$2[aby]\$\d\d\$/.test(text) }).toEqual({ name, bcrypt: false });
            for (const tok of qrTokens) expect({ name, qr: text.includes(tok) }).toEqual({ name, qr: false });
            expect({ name, pw: /"password"\s*:/.test(text) }).toEqual({ name, pw: false });
        }
    });

    test('xlsx: formula-looking values are stored as text, never as formulas', async () => {
        const xlsxBuf = await zip.file(`${E.slug}-data-export.xlsx`).async('nodebuffer');
        const inner = await JSZip.loadAsync(xlsxBuf);
        const sheets = Object.keys(inner.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
        expect(sheets.length).toBeGreaterThan(5);
        for (const s of sheets) {
            const xml = await inner.file(s).async('string');
            expect({ s, formula: /<f[\s>]/.test(xml) }).toEqual({ s, formula: false });
        }
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(xlsxBuf);
        const ws = wb.getWorksheet('menuitems');
        const header = ws.getRow(1).values;
        const nameCol = header.indexOf('name');
        const seen = [];
        ws.eachRow((row, i) => {
            if (i === 1) return;
            const cell = row.getCell(nameCol);
            if (FORMULAS.includes(cell.value)) {
                expect(cell.type).toBe(ExcelJS.ValueType.String);
                seen.push(cell.value);
            }
        });
        expect(seen.sort()).toEqual([...FORMULAS].sort());
    });

    test('second export within 5 minutes → 429 EXPORT_COOLDOWN', async () => {
        const res = await ctx.api.as(E.users.admin).get('/tenant/export');
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('EXPORT_COOLDOWN');
    });

    test.each([
        ['branch sub-admin', () => subE2],
        ['waiter', () => E.users.waiter],
    ])('%s cannot export (403)', async (_label, who) => {
        const res = await ctx.api.as(who()).get('/tenant/export');
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('Super Admin tenant backups', () => {
    let full; let support; let B; let backupDir; let backupsRootExisted;

    beforeAll(async () => {
        B = await seedTenant({ label: 'rp-bk' });
        await mkOrder(B, { total: 77 });
        full = await createUser({ name: 'Root', email: `root.${rand()}@platform.test`, role: 'superadmin', superadminLevel: 'full' });
        support = await createUser({ name: 'Help', email: `help.${rand()}@platform.test`, role: 'superadmin', superadminLevel: 'support' });
        backupsRootExisted = fs.existsSync(path.join(BACKEND, 'backups'));
        backupDir = path.join(BACKEND, 'backups', B.slug);
    });

    afterAll(() => {
        fs.rmSync(backupDir, { recursive: true, force: true });
        const root = path.join(BACKEND, 'backups');
        if (!backupsRootExisted && fs.existsSync(root) && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
    });

    const base = () => `/superadmin/restaurants/${B.restaurant._id}`;

    test('create → list → download (no secrets) → delete', async () => {
        const created = await ctx.api.as(full).post(`${base()}/backup`);
        expect(created.status).toBe(201);
        expect(created.body.data.counts).toEqual({ orders: 1, menuItems: 3, categories: 1, tables: 2, branches: 1, staff: 4 });
        const { filename } = created.body.data;

        const list = await ctx.api.as(support).get(`${base()}/backups`);
        expect(list.status).toBe(200);
        expect(list.body.data.map((f) => f.filename)).toEqual([filename]);

        const dl = await ctx.api.as(support).get(`${base()}/backups/${filename}`).buffer(true).parse(binary);
        expect(dl.status).toBe(200);
        const text = dl.body.toString('utf-8');
        const payload = JSON.parse(text);
        expect(payload.orders[0].total).toBe(77);
        expect(text).not.toMatch(/\$2[aby]\$/);
        expect(text).not.toContain(B.tables.main.qrToken);
        for (const s of payload.staff) expect(s).not.toHaveProperty('password');

        const del = await ctx.api.as(full).delete(`${base()}/backups/${filename}`);
        expect(del.status).toBe(200);
        expect((await ctx.api.as(full).get(`${base()}/backups`)).body.data).toEqual([]);
    });

    test.each([
        ['traversal to a non-json file', '..%2F..%2Fapp.js', 400],
        ['traversal to a json file outside the tenant dir', '..%2F..%2Fpackage.json', 404],
        ['missing file', 'backup-nope.json', 404],
    ])('download rejects %s', async (_label, file, status) => {
        const res = await ctx.api.as(full).get(`${base()}/backups/${file}`);
        expect(res.status).toBe(status);
    });

    test('support-level superadmin cannot create or delete; tenant admin cannot list', async () => {
        expect((await ctx.api.as(support).post(`${base()}/backup`)).status).toBe(403);
        expect((await ctx.api.as(support).delete(`${base()}/backups/x.json`)).status).toBe(403);
        expect((await ctx.api.as(B.users.admin).get(`${base()}/backups`)).status).toBe(403);
    });

    test('invalid / unknown restaurant id', async () => {
        expect((await ctx.api.as(full).get('/superadmin/restaurants/nope/backups')).status).toBe(400);
        expect((await ctx.api.as(full).get('/superadmin/restaurants/nope/backups/a.json')).status).toBe(400);
        const ghost = new mongoose.Types.ObjectId();
        expect((await ctx.api.as(full).post(`/superadmin/restaurants/${ghost}/backup`)).status).toBe(404);
        expect((await ctx.api.as(full).get(`/superadmin/restaurants/${ghost}/backups`)).status).toBe(404);
        expect((await ctx.api.as(full).get(`/superadmin/restaurants/${ghost}/backups/a.json`)).status).toBe(404);
        expect((await ctx.api.as(full).delete(`/superadmin/restaurants/${ghost}/backups/a.json`)).status).toBe(404);
        expect((await ctx.api.as(full).delete(`${base()}/backups/missing.json`)).status).toBe(404);
        expect((await ctx.api.as(full).delete(`${base()}/backups/evil.txt`)).status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════════════
describe('/notifications ownership', () => {
    let N; let N2; let waiter2; let subMain; let c1; let c2;

    const mkNote = (fields) => Notification.create({
        restaurant: N.restaurant._id, title: 't', description: 'd', status: 'unread', ...fields,
    });
    const statusOf = async (doc) => (await Notification.findById(doc._id).lean())?.status ?? 'deleted';

    beforeAll(async () => {
        N = await seedTenant({ label: 'rp-n' });
        N2 = await Branch.create({ restaurant: N.restaurant._id, name: 'Second', slug: 'second', isActive: true });
        waiter2 = await createUser({
            name: 'waiter two', email: `w2.${N.slug}@staff.test`, role: 'waiter',
            restaurant: N.restaurant._id, branch: N.branch._id, permissions: defaultPermissionsForRole('waiter'),
        });
        subMain = await subAdmin(N, N.branch, 'nmain');
        c1 = await createCustomer('n1');
        c2 = await createCustomer('n2');
    });

    test('list shows only own personal notes + own-role broadcasts', async () => {
        const mine = await mkNote({ recipient: N.users.waiter._id, recipientRole: 'waiter', title: 'mine' });
        const theirs = await mkNote({ recipient: waiter2._id, recipientRole: 'waiter', title: 'theirs' });
        const chefCast = await mkNote({ recipient: null, recipientRole: 'chef', branch: N.branch._id, title: 'chef' });
        const res = await ctx.api.as(N.users.waiter).get('/notifications');
        expect(res.status).toBe(200);
        const ids = res.body.notifications.map((n) => String(n._id));
        expect(ids).toContain(String(mine._id));
        expect(ids).not.toContain(String(theirs._id));
        expect(ids).not.toContain(String(chefCast._id));
    });

    test('waiter A cannot mark-read, delete or clear waiter B\'s personal notification', async () => {
        const theirs = await mkNote({ recipient: waiter2._id, recipientRole: 'waiter' });
        const api = ctx.api.as(N.users.waiter);
        expect((await api.put(`/notifications/${theirs._id}/read`)).status).toBe(200);
        expect(await statusOf(theirs)).toBe('unread');
        expect((await api.put('/notifications/all/read')).status).toBe(200);
        expect(await statusOf(theirs)).toBe('unread');
        expect((await api.delete(`/notifications/${theirs._id}`)).status).toBe(200);
        expect(await statusOf(theirs)).toBe('unread');
        expect((await api.delete('/notifications/clear')).status).toBe(200);
        expect(await statusOf(theirs)).toBe('unread');

        // B can act on their own.
        const apiB = ctx.api.as(waiter2);
        await apiB.put(`/notifications/${theirs._id}/read`);
        expect(await statusOf(theirs)).toBe('read');
        await apiB.delete(`/notifications/${theirs._id}`);
        expect(await statusOf(theirs)).toBe('deleted');
    });

    test('customer A cannot see / mark / delete customer B\'s notification', async () => {
        const forC2 = await mkNote({ recipient: c2._id, recipientRole: 'customer' });
        const api = ctx.api.as(c1, N);
        const list = await api.get('/notifications');
        expect(list.status).toBe(200);
        expect(list.body.notifications.map((n) => String(n._id))).not.toContain(String(forC2._id));
        await api.put(`/notifications/${forC2._id}/read`);
        await api.delete(`/notifications/${forC2._id}`);
        await api.delete('/notifications/clear');
        expect(await statusOf(forC2)).toBe('unread');
        const own = await ctx.api.as(c2, N).get('/notifications');
        expect(own.body.notifications.map((n) => String(n._id))).toContain(String(forC2._id));
    });

    test('branch-pinned admin cannot see / mark / delete another branch\'s admin broadcast; owner can see it', async () => {
        const other = await mkNote({ recipient: null, recipientRole: 'admin', branch: N2._id, title: 'other branch' });
        const own = await mkNote({ recipient: null, recipientRole: 'admin', branch: N.branch._id, title: 'own branch' });
        const api = ctx.api.as(subMain);
        const ids = (await api.get('/notifications')).body.notifications.map((n) => String(n._id));
        expect(ids).toContain(String(own._id));
        expect(ids).not.toContain(String(other._id));
        await api.put(`/notifications/${other._id}/read`);
        await api.delete(`/notifications/${other._id}`);
        await api.put('/notifications/all/read');
        await api.delete('/notifications/clear');
        expect(await statusOf(other)).toBe('unread');

        const ownerAll = (await ctx.api.as(N.users.admin).get('/notifications')).body.notifications.map((n) => String(n._id));
        expect(ownerAll).toContain(String(other._id));
        const ownerMain = (await ctx.api.as(N.users.admin).get(`/notifications?branch=${N.branch._id}`)).body.notifications.map((n) => String(n._id));
        expect(ownerMain).not.toContain(String(other._id));
        const ownerTenant = (await ctx.api.as(N.users.admin).get('/notifications?branch=tenant-only')).body.notifications.map((n) => String(n._id));
        expect(ownerTenant).not.toContain(String(other._id));
    });

    test('invalid id → 400', async () => {
        expect((await ctx.api.as(N.users.waiter).put('/notifications/nope/read')).status).toBe(400);
        expect((await ctx.api.as(N.users.waiter).delete('/notifications/nope')).status).toBe(400);
    });

    test('POST: staff can create; customer cannot', async () => {
        const ok = await ctx.api.as(N.users.admin).post('/notifications')
            .send({ title: '  Hello ', description: ' World ', recipientRole: 'waiter', priority: 'high' });
        expect(ok.status).toBe(201);
        expect(ok.body.notification).toMatchObject({ title: 'Hello', description: 'World', recipientRole: 'waiter', priority: 'high', category: 'System', branch: null });
        const cust = await ctx.api.as(c1, N).post('/notifications').send({ title: 'x', description: 'y' });
        expect(cust.status).toBe(403);
        await settle();
    });

    test.each([
        ['missing title', { description: 'y' }],
        ['blank description', { title: 'x', description: '   ' }],
        ['title too long', { title: 'x'.repeat(501), description: 'y' }],
        ['bad enum', { title: 'x', description: 'y', priority: 'apocalyptic' }],
        ['bad recipient', { title: 'x', description: 'y', recipient: 'nope' }],
        ['meta array', { title: 'x', description: 'y', meta: [1, 2] }],
        ['non-string title', { title: { $gt: '' }, description: 'y' }],
        ['foreign branch', { title: 'x', description: 'y', branch: String(new mongoose.Types.ObjectId()) }],
    ])('POST rejects %s with 400', async (_label, body) => {
        const res = await ctx.api.as(N.users.admin).post('/notifications').send(body);
        expect(res.status).toBe(400);
    });

    test('POST: pinned staff cannot target another branch', async () => {
        const res = await ctx.api.as(N.users.waiter).post('/notifications')
            .send({ title: 'x', description: 'y', branch: String(N2._id) });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
    });
});
