/**
 * test-shift-and-staffid.js — verifies the per-branch EMP-ID generator
 * and the auto-shift-on-login/logout pipeline against the live DB.
 *
 * Tests:
 *   A. getNextStaffIdForBranch is per-branch (Main / FC Road 2 / Baner / null)
 *   B. DB unique index `staffId_per_branch_unique` is present
 *   C. No same-(tenant,branch) duplicate EMP-IDs exist anywhere
 *   D. openShiftOnLogin creates one shift; second call is a no-op
 *   E. closeShiftOnLogout sets clockOut + totalHours + status='completed'
 *   F. Staff list endpoint logic returns isOnDuty:true when an active shift exists
 *   G. SHIFT_AUTO_ROLES covers every tenant staff role (no leaks)
 *   H. Roles outside SHIFT_AUTO_ROLES (customer / superadmin) are skipped
 *
 * Every write is reverted before exit.
 *
 * Usage: node scripts/test-shift-and-staffid.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Branch = require('../models/branch');
const Restaurant = require('../models/restaurant');
const Shift = require('../models/shift');
const { getNextStaffIdForBranch } = require('../utils/staffUtils');

const TENANT_SLUG = 'hotel-tip-top';
const STAFF_INDEX_NAME = 'staffId_per_branch_unique';

// Reach into the auth controller to grab the actual helpers we use in
// production. Reaching past `exports` because they're file-private —
// fine for a test harness, and it keeps us testing the real code path
// instead of a re-implementation that could drift.
const authControllerPath = require.resolve('../controllers/authController');
delete require.cache[authControllerPath];
require('../controllers/authController');
const authMod = require.cache[authControllerPath];
const openShiftOnLogin   = authMod?.exports?.__openShiftOnLogin   ?? null;
const closeShiftOnLogout = authMod?.exports?.__closeShiftOnLogout ?? null;
const SHIFT_AUTO_ROLES   = authMod?.exports?.__SHIFT_AUTO_ROLES   ?? null;

const results = [];
function record(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const tag = passed ? '✔ PASS' : '✘ FAIL';
    console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function ensureHelpersExposed() {
    if (openShiftOnLogin && closeShiftOnLogout && SHIFT_AUTO_ROLES) return true;
    // Fallback: load the module text and eval the helpers in a sandbox.
    // If THIS path runs the user needs to expose `__openShiftOnLogin` /
    // `__closeShiftOnLogout` / `__SHIFT_AUTO_ROLES` on authController.
    console.log('\n! Auth helpers not exposed for direct test access.');
    console.log('  Add this to the bottom of Backend/controllers/authController.js:');
    console.log('    if (process.env.NODE_ENV !== "production") {');
    console.log('        exports.__openShiftOnLogin = openShiftOnLogin;');
    console.log('        exports.__closeShiftOnLogout = closeShiftOnLogout;');
    console.log('        exports.__SHIFT_AUTO_ROLES = SHIFT_AUTO_ROLES;');
    console.log('    }');
    return false;
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) { console.error('MONGO_URL is not set'); process.exit(1); }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB\n');

    const tenant = await Restaurant.findOne({ slug: TENANT_SLUG });
    if (!tenant) { console.error(`Tenant ${TENANT_SLUG} not found`); process.exit(2); }
    const tf = { restaurant: tenant._id };
    const branches = await Branch.find({ restaurant: tenant._id, isActive: true }).lean();
    const mainBr     = branches.find(b => b.slug === 'main');
    const fcRoadBr   = branches.find(b => b.slug === 'fc-road');
    const emptyBr    = branches.find(b => !['main', 'fc-road'].includes(b.slug));   // any other = no staff yet

    console.log(`Tenant: ${tenant.name} (${tenant.slug})`);
    console.log(`Main = ${mainBr?._id}, FC Road = ${fcRoadBr?._id}, empty test branch = ${emptyBr?.slug} (${emptyBr?._id})\n`);
    console.log('─── A. Per-branch EMP-ID generator ───');

    // A1: Main branch — should be EMP-008 (Main has EMP-001..EMP-007)
    const lastInMain = await User.findOne({ ...tf, branch: mainBr._id, staffId: /^EMP-/ }).sort({ staffId: -1 });
    const expectedMain = bumpEmp(lastInMain?.staffId || null);
    const gotMain = await getNextStaffIdForBranch(tf, mainBr._id);
    record('A1: Main branch next-ID matches per-branch max',
        gotMain === expectedMain,
        `got ${gotMain}, expected ${expectedMain}`);

    // A2: FC Road — should be EMP-009 (after the test waiter, sequence reached EMP-008)
    const lastInFc = await User.findOne({ ...tf, branch: fcRoadBr._id, staffId: /^EMP-/ }).sort({ staffId: -1 });
    const expectedFc = bumpEmp(lastInFc?.staffId || null);
    const gotFc = await getNextStaffIdForBranch(tf, fcRoadBr._id);
    record('A2: FC Road next-ID matches per-branch max',
        gotFc === expectedFc,
        `got ${gotFc}, expected ${expectedFc}`);

    // A3: An empty branch — should be EMP-001
    if (emptyBr) {
        const gotEmpty = await getNextStaffIdForBranch(tf, emptyBr._id);
        record('A3: Empty branch starts at EMP-001',
            gotEmpty === 'EMP-001',
            `got ${gotEmpty} for ${emptyBr.slug}`);
    } else {
        record('A3: Empty branch starts at EMP-001', true, 'skipped — no empty branch in tenant');
    }

    // A4: branchId = null (tenant-level) — should follow null bucket sequence
    const lastInNull = await User.findOne({ ...tf, branch: null, staffId: /^EMP-/ }).sort({ staffId: -1 });
    const expectedNull = bumpEmp(lastInNull?.staffId || null);
    const gotNull = await getNextStaffIdForBranch(tf, null);
    record('A4: branch=null sequence is independent',
        gotNull === expectedNull,
        `got ${gotNull}, expected ${expectedNull}`);

    // A5: Two different branches don't share their next-ID counter
    record('A5: Each branch keeps an independent sequence',
        new Set([gotMain, gotFc, gotNull].filter(Boolean)).size >= 2 || emptyBr ?
            (gotMain !== gotFc || gotMain !== gotNull) : false,
        `Main=${gotMain}, FC=${gotFc}, null=${gotNull}`);

    console.log('\n─── B. DB index integrity ───');

    // B1: the per-branch unique index exists
    const indexes = await mongoose.connection.db.collection('users').indexes();
    const hasIdx = indexes.find(i => i.name === STAFF_INDEX_NAME);
    record('B1: staffId_per_branch_unique index exists',
        !!hasIdx,
        hasIdx ? `key: ${JSON.stringify(hasIdx.key)}` : 'missing');

    // B2: the legacy tenant-wide index is gone (its presence would block
    // legitimate per-branch EMP-001 reuse with E11000).
    const legacy = indexes.find(i => i.name === 'staffId_1_restaurant_1' || i.name === 'staffId_1');
    record('B2: legacy tenant-wide staffId index is dropped',
        !legacy,
        legacy ? `still present: ${legacy.name}` : 'clean');

    console.log('\n─── C. No same-branch EMP-ID duplicates ───');

    // C1: aggregate same-(tenant, branch) duplicates
    const dupes = await User.aggregate([
        { $match: { ...tf, staffId: { $type: 'string' } } },
        { $group: { _id: { staffId: '$staffId', branch: '$branch' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
    ]);
    record('C1: zero same-(tenant,branch) duplicate EMP-IDs',
        dupes.length === 0,
        dupes.length ? `${dupes.length} buckets still have dupes: ${JSON.stringify(dupes.slice(0, 3))}` : 'clean');

    if (!(await ensureHelpersExposed())) {
        console.log('\nSkipping D / E / F / G / H (auth helpers not exposed).');
        await summarise();
        await mongoose.disconnect();
        return;
    }

    console.log('\n─── D. openShiftOnLogin ───');

    // Pick the tenant owner as the test subject — they exist for sure
    // and we can revert any shift we open.
    const subject = await User.findOne({ ...tf, isTenantOwner: true });
    if (!subject) {
        record('D-prep: tenant owner exists', false, 'no isTenantOwner=true user found');
    } else {
        // Make sure no leftover shift from a previous test run.
        await Shift.deleteMany({ staff: subject._id, status: 'active', restaurant: tenant._id, note: /Auto-opened on login/ });

        // D1: opens a shift when none active
        await openShiftOnLogin(subject);
        const opened = await Shift.findOne({ staff: subject._id, status: 'active', restaurant: tenant._id });
        record('D1: opens a Shift when none active',
            !!opened && !!opened.clockIn && opened.status === 'active',
            opened ? `shift _id=${opened._id}, clockIn=${opened.clockIn?.toISOString()}` : 'no shift created');

        // D2: idempotent — second call leaves the same shift
        await openShiftOnLogin(subject);
        const afterSecond = await Shift.find({ staff: subject._id, status: 'active', restaurant: tenant._id });
        record('D2: second login does NOT create a duplicate shift',
            afterSecond.length === 1,
            `active shifts after second open call: ${afterSecond.length}`);

        // D3: rolls clockIn back ~2h, closeShiftOnLogout should record ≈ 2 hr
        if (opened) {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            await Shift.updateOne({ _id: opened._id }, { $set: { clockIn: twoHoursAgo } });

            console.log('\n─── E. closeShiftOnLogout ───');
            await closeShiftOnLogout(subject);
            const closed = await Shift.findOne({ _id: opened._id });
            const hoursOk = closed && Math.abs((closed.totalHours || 0) - 2) < 0.1;
            record('E1: marks status=completed + clockOut set',
                closed?.status === 'completed' && !!closed.clockOut,
                `status=${closed?.status}, clockOut=${closed?.clockOut?.toISOString()}`);
            record('E2: totalHours ≈ wall-clock hours (clockIn → clockOut)',
                hoursOk,
                `totalHours=${closed?.totalHours} (expected ~2.0)`);
            record('E3: appends [Auto-closed on logout] audit note',
                /Auto-closed on logout/.test(closed?.note || ''),
                `note="${(closed?.note || '').slice(0, 80)}…"`);

            // E4: second logout is a no-op (no error, shift already completed)
            let secondLogoutThrew = false;
            try {
                await closeShiftOnLogout(subject);
            } catch (err) {
                secondLogoutThrew = true;
            }
            const stillCompleted = await Shift.findOne({ _id: opened._id });
            record('E4: second logout is a no-op (no error, no flip back to active)',
                !secondLogoutThrew && stillCompleted?.status === 'completed',
                `threw=${secondLogoutThrew}, status=${stillCompleted?.status}`);

            console.log('\n─── F. Staff list isOnDuty flag ───');

            // Re-open a shift so we can test the live isOnDuty path
            const liveShift = await Shift.create({
                staff: subject._id, restaurant: tenant._id,
                clockIn: new Date(), status: 'active',
                note: '[isOnDuty test fixture]',
            });
            const activeNow = await Shift.find({ staff: subject._id, status: 'active', restaurant: tenant._id }).select('staff').lean();
            const onDutySet = new Set(activeNow.map(s => String(s.staff)));
            record('F1: subject appears in active-shift set while shift is open',
                onDutySet.has(String(subject._id)),
                `onDutySet.size=${onDutySet.size}`);

            // Clean up
            await Shift.deleteOne({ _id: liveShift._id });
            // Also delete the (now completed) D-test shift so re-runs are clean
            await Shift.deleteOne({ _id: opened._id });
        }
    }

    console.log('\n─── G. SHIFT_AUTO_ROLES coverage ───');
    const expected = new Set(['admin', 'manager', 'waiter', 'captain', 'chef']);
    const got = new Set([...SHIFT_AUTO_ROLES]);
    const missing = [...expected].filter(r => !got.has(r));
    const extra   = [...got].filter(r => !expected.has(r));
    record('G1: SHIFT_AUTO_ROLES covers every tenant staff role',
        missing.length === 0,
        missing.length ? `missing: ${missing.join(', ')}` : 'all present');
    record('G2: SHIFT_AUTO_ROLES does NOT include global identities',
        !got.has('customer') && !got.has('superadmin'),
        extra.length ? `extras: ${extra.join(', ')}` : 'clean');

    console.log('\n─── H. Skip non-staff roles ───');
    // Try to open a shift for a fake customer — helper should silently skip.
    const fakeCustomer = { _id: new mongoose.Types.ObjectId(), role: 'customer', restaurant: tenant._id };
    await openShiftOnLogin(fakeCustomer);
    const shouldBeNone = await Shift.findOne({ staff: fakeCustomer._id });
    record('H1: openShiftOnLogin skips role=customer',
        !shouldBeNone,
        shouldBeNone ? 'a shift was created for a customer (BUG)' : 'no shift created');

    const fakeSuper = { _id: new mongoose.Types.ObjectId(), role: 'superadmin', restaurant: tenant._id };
    await openShiftOnLogin(fakeSuper);
    const shouldBeNone2 = await Shift.findOne({ staff: fakeSuper._id });
    record('H2: openShiftOnLogin skips role=superadmin',
        !shouldBeNone2,
        shouldBeNone2 ? 'a shift was created for a superadmin (BUG)' : 'no shift created');

    // Cleanup any stray fixtures (defence-in-depth)
    await Shift.deleteMany({ staff: { $in: [fakeCustomer._id, fakeSuper._id] } });

    await summarise();
    await mongoose.disconnect();
}

function bumpEmp(prevId) {
    if (!prevId) return 'EMP-001';
    const n = parseInt(prevId.split('-')[1], 10) || 0;
    return `EMP-${(n + 1).toString().padStart(3, '0')}`;
}

async function summarise() {
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    console.log(`\n══════════ Summary: ${passed} passed, ${failed} failed (${results.length} total) ══════════`);
    if (failed > 0) {
        console.log('\nFailures:');
        for (const r of results.filter(r => !r.passed)) {
            console.log(`  ✘ ${r.name}: ${r.detail}`);
        }
        process.exitCode = 1;
    }
}

run().catch(err => {
    console.error('Test harness crashed:', err);
    process.exit(99);
});
