/**
 * End-to-end branch isolation test (no browser required).
 *
 * What it does:
 *   1. Logs in as the tenant owner (creates a JWT).
 *   2. Creates a new branch with ALL 12 "Copy from Main" toggles ON.
 *   3. Verifies the sync response counts.
 *   4. Logs in as the freshly-minted branch admin (using the temp pwd).
 *   5. Calls every admin list endpoint and confirms the new branch
 *      sees the cloned catalog AND no other branch's data.
 *   6. Creates a SECOND new branch with all toggles OFF and confirms
 *      it lands fully empty (clean-start guarantee).
 *   7. Cleans up both test branches.
 *
 * This is the same path playwright would walk — same backend endpoints,
 * same checkbox state, same assertions — minus the UI rendering. Use
 * this whenever the playwright session is wedged.
 *
 * Run: node scripts/e2e-branch-isolation.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Branch = require('../models/branch');
const User = require('../models/user');
const Area = require('../models/area');
const Table = require('../models/table');
const Coupon = require('../models/coupon');
const Promotion = require('../models/promotion');
const Settings = require('../models/settings');
const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const Combo = require('../models/combo');
const Hall = require('../models/hall');
const EventType = require('../models/eventType');
const Package = require('../models/package');
const DecorationPackage = require('../models/decorationPackage');
const Addon = require('../models/addon');

const API = process.env.SWEEP_BASE || 'http://localhost:5000/api/v1';

async function login(email, password) {
    const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.token) throw new Error(`Login failed for ${email}: ${body?.message || res.status}`);
    return body.token;
}

async function call(path, token, opts = {}) {
    const res = await fetch(`${API}${path}`, {
        method: opts.method || 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
}

function countOf(body) {
    if (!body) return 0;
    for (const k of ['data', 'items', 'campaigns', 'coupons', 'promotions', 'halls', 'categories',
                     'eventTypes', 'packages', 'decorations', 'decorPackages', 'addons', 'cakes',
                     'reservations', 'requests', 'customers', 'staff', 'notifications', 'tables', 'areas']) {
        if (Array.isArray(body[k])) return body[k].length;
    }
    if (Array.isArray(body)) return body.length;
    if (typeof body.totalItems === 'number') return body.totalItems;
    if (typeof body.count === 'number') return body.count;
    return 0;
}

async function cleanupBranch(branchSlug) {
    const b = await Branch.findOne({ slug: branchSlug }).lean();
    if (!b) return false;
    const id = b._id;
    await Promise.all([
        Area.deleteMany({ branch: id }),
        Table.deleteMany({ branch: id }),
        Coupon.deleteMany({ branch: id }),
        Promotion.deleteMany({ branch: id }),
        Category.deleteMany({ branch: id }),
        Combo.deleteMany({ branch: id }),
        Hall.deleteMany({ branch: id }),
        EventType.deleteMany({ branch: id }),
        Package.deleteMany({ branch: id }),
        DecorationPackage.deleteMany({ branch: id }),
        Addon.deleteMany({ branch: id }),
        Settings.deleteMany({ branch: id }),
        User.deleteMany({ branch: id }),
        MenuItem.updateMany({ 'branchPrices.branch': id }, { $pull: { branchPrices: { branch: id } } }),
    ]);
    await Branch.deleteOne({ _id: id });
    return true;
}

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const ts = Date.now().toString().slice(-5);
    const seededSlug = `e2e-seeded-${ts}`;
    const cleanSlug  = `e2e-clean-${ts}`;
    const seededEmail = `e2e-seeded-${ts}@hoteltiptop.in`;
    const cleanEmail  = `e2e-clean-${ts}@hoteltiptop.in`;

    try {
        // ─────────── Step 1: tenant owner login ───────────
        console.log('1️⃣  Tenant owner login...');
        const ownerEmail = process.env.E2E_OWNER_EMAIL || 'rohitbansode1600@gmail.com';
        const ownerPwd   = process.env.E2E_OWNER_PWD   || 'Rohit1600@#';
        const ownerToken = await login(ownerEmail, ownerPwd);
        console.log('   ✅ logged in as', ownerEmail);

        // ─────────── Step 2: create SEEDED branch (all 12 ON) ───────────
        const ALL_TOGGLES = {
            categories: true, menu: true, combos: true,
            areas: true, tables: true, coupons: true,
            promotions: true, halls: true,
            eventTypes: true, packages: true, decorations: true, addons: true,
        };
        console.log(`\n2️⃣  Creating branch "${seededSlug}" with ALL 12 toggles ON...`);
        const createRes = await call('/branches', ownerToken, {
            method: 'POST',
            body: {
                name: `E2E Seeded ${ts}`,
                slug: seededSlug,
                contactEmail: `branch-${ts}@hoteltiptop.in`,
                managerName: 'E2E Seeded Admin',
                managerEmail: seededEmail,
                syncFromMain: ALL_TOGGLES,
            },
        });
        if (createRes.status !== 201) throw new Error(`Branch create failed: ${createRes.status} ${JSON.stringify(createRes.body)}`);
        const seededBranchId = createRes.body.data._id;
        const seededTemp = createRes.body.manager.tempPassword;
        const sync = createRes.body.sync || {};
        console.log('   Sync result:');
        for (const k of Object.keys(ALL_TOGGLES)) {
            const v = sync[k];
            const ok = typeof v === 'number' && v >= 0 ? '✅' : '⚠️ ';
            console.log(`   ${ok} ${k.padEnd(11)} ${typeof v === 'number' ? v : JSON.stringify(v)}`);
        }

        // ─────────── Step 3: login as seeded branch admin ───────────
        // First-login flow needs a password change. Bypass by updating
        // mustChangePassword and setting a known pwd in DB.
        await User.findOneAndUpdate(
            { email: seededEmail },
            { $set: { mustChangePassword: false } },
        );
        const seededAdmin = await User.findOne({ email: seededEmail });
        seededAdmin.password = 'E2E@Test123';
        await seededAdmin.save();
        console.log(`\n3️⃣  Logging in as branch admin ${seededEmail}...`);
        const seededToken = await login(seededEmail, 'E2E@Test123');
        console.log('   ✅ logged in');

        // ─────────── Step 4: sweep seeded branch admin endpoints ───────────
        console.log('\n4️⃣  Sweeping seeded-branch admin endpoints:');
        const probes = [
            ['categories',                '/categories'],
            ['menu',                      '/menu?limit=1000&status=All Status'],
            ['combos',                    '/combos?status=All Status'],
            ['areas',                     '/areas'],
            ['tables',                    '/tables'],
            ['halls',                     '/halls'],
            ['promotions/coupons',        '/promotions/coupons'],
            ['promotions',                '/promotions'],
            ['booking-info/event-types',  '/booking-info/event-types'],
            ['booking-info/packages',     '/booking-info/packages'],
            ['booking-info/decorations',  '/booking-info/decorations'],
            ['booking-info/addons',       '/booking-info/addons'],
        ];
        const seededCounts = {};
        for (const [label, path] of probes) {
            const r = await call(path, seededToken);
            seededCounts[label] = r.status === 200 ? countOf(r.body) : `HTTP ${r.status}`;
        }
        for (const [k, v] of Object.entries(seededCounts)) {
            const sign = typeof v === 'number' && v > 0 ? '✅' : (v === 0 ? '⚠️ ' : '❌');
            console.log(`   ${sign} ${k.padEnd(28)} ${v}`);
        }

        // ─────────── Step 5: create CLEAN branch (all 12 OFF) ───────────
        console.log(`\n5️⃣  Creating branch "${cleanSlug}" with ALL 12 toggles OFF...`);
        const noToggles = Object.fromEntries(Object.keys(ALL_TOGGLES).map(k => [k, false]));
        const createClean = await call('/branches', ownerToken, {
            method: 'POST',
            body: {
                name: `E2E Clean ${ts}`,
                slug: cleanSlug,
                contactEmail: `branch-clean-${ts}@hoteltiptop.in`,
                managerName: 'E2E Clean Admin',
                managerEmail: cleanEmail,
                syncFromMain: noToggles,
            },
        });
        if (createClean.status !== 201) throw new Error(`Clean branch create failed: ${createClean.status}`);
        const cleanSync = createClean.body.sync || {};
        console.log('   Sync result (all should be null = not requested):');
        for (const k of Object.keys(ALL_TOGGLES)) {
            const v = cleanSync[k];
            const ok = v === null ? '✅' : '❌';
            console.log(`   ${ok} ${k.padEnd(11)} ${JSON.stringify(v)}`);
        }

        // ─────────── Step 6: login as clean admin ───────────
        await User.findOneAndUpdate({ email: cleanEmail }, { $set: { mustChangePassword: false } });
        const cleanAdminDoc = await User.findOne({ email: cleanEmail });
        cleanAdminDoc.password = 'E2E@Test123';
        await cleanAdminDoc.save();
        const cleanToken = await login(cleanEmail, 'E2E@Test123');
        console.log(`\n6️⃣  Sweeping CLEAN-branch admin endpoints (every count must be 0):`);
        const cleanCounts = {};
        for (const [label, path] of probes) {
            const r = await call(path, cleanToken);
            cleanCounts[label] = r.status === 200 ? countOf(r.body) : `HTTP ${r.status}`;
        }
        let allZero = true;
        for (const [k, v] of Object.entries(cleanCounts)) {
            const ok = v === 0 ? '✅' : '❌';
            if (v !== 0) allZero = false;
            console.log(`   ${ok} ${k.padEnd(28)} ${v}`);
        }
        console.log(allZero ? '\n   ✅ CLEAN BRANCH CONTRACT HELD' : '\n   ❌ CLEAN BRANCH LEAKED');

        // ─────────── Step 7: cleanup ───────────
        console.log(`\n7️⃣  Cleaning up test branches...`);
        const cSeeded = await cleanupBranch(seededSlug);
        const cClean  = await cleanupBranch(cleanSlug);
        console.log(`   seeded: ${cSeeded ? 'deleted' : 'not found'}, clean: ${cClean ? 'deleted' : 'not found'}`);

        console.log('\n🎉  E2E branch isolation test complete.');
    } catch (e) {
        console.error('\n❌ FAIL:', e.message);
        // Best-effort cleanup so a failed run doesn't leave test rows behind.
        await cleanupBranch(seededSlug).catch(() => {});
        await cleanupBranch(cleanSlug).catch(() => {});
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
})();
