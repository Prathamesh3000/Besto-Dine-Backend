/**
 * End-to-end branch-isolation sweep — calls every admin list/aggregate
 * endpoint with a branch-pinned admin's JWT and reports how many docs
 * each returns plus what other branches still hold in the DB. Any
 * non-zero count where the DB has main-branch data is a leak.
 *
 * Usage: node scripts/sweep-admin-leaks.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { signAccessToken } = require('../middlewares/authMiddleware');
const User = require('../models/user');
const Branch = require('../models/branch');

const API = process.env.SWEEP_BASE || 'http://localhost:5000/api/v1';
const FC_EMAIL = process.env.SWEEP_ADMIN_EMAIL || 'fcroad@hoteltiptop.in';

async function signTokenFor(user) {
    // Same signer as login (typ/tv claims) so tokenVersion checks pass.
    return signAccessToken(user);
}

async function call(path, token) {
    const url = API + path;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    let body;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

function countOf(label, body) {
    if (!body) return 0;
    if (Array.isArray(body)) return body.length;
    const candidates = ['data', label, 'items', 'records', 'orders', 'customers', 'tables',
        'areas', 'reservations', 'staff', 'requests', 'notifications', 'reservations',
        'waiters', 'campaigns', 'coupons', 'promotions', 'history', 'shifts',
        'halls', 'eventTypes', 'packages', 'decorations', 'addons', 'cakes', 'decorPackages'];
    for (const k of candidates) {
        if (Array.isArray(body[k])) return body[k].length;
    }
    if (typeof body.totalItems === 'number') return body.totalItems;
    if (typeof body.count === 'number') return body.count;
    return 0;
}

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const admin = await User.findOne({ email: FC_EMAIL }).populate('branch', 'name slug').lean();
    if (!admin) { console.error(`No admin ${FC_EMAIL}`); process.exit(1); }
    const branch = await Branch.findById(admin.branch._id).lean();
    const token = await signTokenFor(admin);
    console.log(`Sweeping as ${admin.email} (branch=${admin.branch.slug})\n`);

    const endpoints = [
        ['areas',                    '/areas'],
        ['tables',                   '/tables'],
        ['admin/bootstrap',          '/admin/bootstrap'],
        ['menu',                     '/menu?limit=1000&status=All Status'],
        ['categories',               '/categories'],
        ['combos',                   '/combos?status=All Status'],
        ['orders/live',              '/orders/live'],
        ['orders/past',              '/orders/past?limit=50'],
        ['orders/refunds',           '/orders/refunds?status=all&limit=50'],
        ['refund-requests',          '/refund-requests?status=all&limit=50'],
        ['reservations',             '/reservations'],
        ['requests',                 '/requests'],
        ['crm/customers',            '/crm/customers'],
        ['notifications',            '/notifications'],
        ['promotions',               '/promotions'],
        ['promotions/coupons',       '/promotions/coupons'],
        ['promotions/coupons/active','/promotions/coupons/active'],
        ['promotions/coupons/perf',  '/promotions/coupons/performance?filter=week'],
        ['promotions/coupons/redemp','/promotions/coupons/redemptions'],
        ['campaigns',                '/campaigns'],
        ['campaigns/stats',          '/campaigns/stats'],
        ['wallet/admin/stats',       '/wallet/admin/stats'],
        ['wallet/admin/manual-hist', '/wallet/admin/manual-history'],
        ['wallet/admin/reports',     '/wallet/admin/reports'],
        ['inventory',                '/inventory'],
        ['inventory/summary',        '/inventory/summary'],
        ['advance-bookings',         '/advance-bookings'],
        ['halls',                    '/halls'],
        ['staff',                    '/staff'],
        ['tips/pending-by-waiter',   '/tips/pending-by-waiter'],
        ['tips/ledger',              '/tips/ledger'],
        ['telemetry/stats',          '/telemetry/stats?earningsPeriod=daily&bookingTime=today&branch=all'],
        ['shifts',                   '/shifts'],
        ['decoration-packages',      '/decoration-packages'],
        ['booking-info/event-types', '/booking-info/event-types'],
        ['booking-info/packages',    '/booking-info/packages'],
        ['booking-info/decorations', '/booking-info/decorations'],
        ['booking-info/addons',      '/booking-info/addons'],
        ['booking-info/admin-addons','/booking-info/admin-addons'],
        ['booking-info/cakes',       '/booking-info/cakes'],
        ['payments',                 '/payments'],
        ['invoices',                 '/invoices'],
        ['booking-info',             '/booking-info'],
    ];

    const results = [];
    for (const [label, path] of endpoints) {
        const t0 = Date.now();
        const r = await call(path, token);
        const elapsed = Date.now() - t0;
        if (r.status >= 400) {
            results.push({ label, path, status: r.status, count: '—', note: r.body?.message?.slice(0, 60) || '' });
        } else {
            results.push({ label, path, status: r.status, count: countOf(label, r.body), note: '' });
        }
    }

    console.log('Endpoint                       Status  Count   Note');
    console.log('-----------------------------------------------------------------');
    for (const r of results) {
        const lbl = r.label.padEnd(30);
        const status = String(r.status).padEnd(7);
        const count = String(r.count).padEnd(7);
        console.log(`${lbl} ${status} ${count} ${r.note || ''}`);
    }

    const leaks = results.filter(r => typeof r.count === 'number' && r.count > 0);
    console.log('\n⚠️  Endpoints returning data (need DB cross-check for leaks):');
    leaks.forEach(l => console.log(' -', l.label, '=', l.count));

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
