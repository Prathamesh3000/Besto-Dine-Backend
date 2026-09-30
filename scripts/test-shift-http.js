/**
 * test-shift-http.js — HTTP-level integration test that runs against
 * the actual Express server. Catches wiring issues the function-level
 * test (test-shift-and-staffid.js) can't see:
 *   - optionalAuth populating req.user on /auth/logout
 *   - GET /staff returning the isOnDuty field
 *   - Rate-limit guards not blocking the test flow
 *
 * Flow:
 *   1. POST /auth/login as a known staff member (TEST_EMAIL / TEST_PASSWORD).
 *   2. Assert: a Shift was opened for them (DB read).
 *   3. GET /staff with the token. Assert: their row has isOnDuty=true.
 *   4. POST /auth/logout with the token. Assert: shift is now completed
 *      with a non-zero totalHours and an [Auto-closed on logout] note.
 *   5. GET /staff again with a fresh login. Assert: isOnDuty=false.
 *
 * Override credentials via env:
 *   TEST_EMAIL=neha.chef@example.com TEST_PASSWORD=... TEST_TENANT_SLUG=hotel-tip-top \
 *     node scripts/test-shift-http.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Shift = require('../models/shift');
const Restaurant = require('../models/restaurant');

const API = process.env.API_BASE || 'http://localhost:5000/api/v1';
const TENANT_SLUG = process.env.TEST_TENANT_SLUG || 'hotel-tip-top';
const EMAIL = process.env.TEST_EMAIL || 'neha.chef@example.com';
const PASSWORD = process.env.TEST_PASSWORD || '';

const results = [];
function record(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const tag = passed ? '✔ PASS' : '✘ FAIL';
    console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body, token, tenantSlug } = {}) {
    const headers = { 'Accept': 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (tenantSlug) headers['X-Restaurant-Slug'] = tenantSlug;
    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

async function run() {
    if (!PASSWORD) {
        console.error('TEST_PASSWORD env var is required (the staff member\'s real login password).');
        console.error('Usage: TEST_PASSWORD=... node scripts/test-shift-http.js');
        process.exit(1);
    }

    const uri = process.env.MONGO_URL;
    if (!uri) { console.error('MONGO_URL is not set'); process.exit(1); }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });

    const tenant = await Restaurant.findOne({ slug: TENANT_SLUG });
    if (!tenant) { console.error(`Tenant ${TENANT_SLUG} not found`); process.exit(2); }
    const staffUser = await User.findOne({
        email: EMAIL.toLowerCase(),
        restaurant: tenant._id,
    });
    if (!staffUser) {
        console.error(`Staff ${EMAIL} not found inside tenant ${TENANT_SLUG}`);
        process.exit(3);
    }

    console.log(`Subject: ${staffUser.name} (${staffUser.email}) · role=${staffUser.role}\n`);

    // 0. Clean slate — close any leftover active shift from a previous run.
    await Shift.updateMany(
        { staff: staffUser._id, status: 'active', restaurant: tenant._id },
        { $set: { status: 'completed', clockOut: new Date(), totalHours: 0, note: '[Test cleanup — pre-run reset]' } },
    );

    console.log('─── 1. POST /auth/login ───');
    const login1 = await call('/auth/login', {
        method: 'POST',
        body: { email: EMAIL, password: PASSWORD, loginType: 'staff' },
        tenantSlug: TENANT_SLUG,
    });
    record('1.1: login returns 200',
        login1.status === 200 && !!login1.body?.token,
        `status=${login1.status}, code=${login1.body?.code || ''}, msg="${login1.body?.message || ''}"`);
    if (!login1.body?.token) { await finish(); return; }
    const token1 = login1.body.token;

    // Auto-shift opens asynchronously after the login response is sent.
    // Give it a beat so the DB read below is deterministic.
    await sleep(250);
    const openedShift = await Shift.findOne({
        staff: staffUser._id, status: 'active', restaurant: tenant._id,
    });
    record('1.2: login opened an active Shift',
        !!openedShift && /Auto-opened on login/.test(openedShift?.note || ''),
        openedShift ? `shift _id=${openedShift._id}, note="${openedShift.note.slice(0, 40)}…"` : 'no active shift found');

    console.log('\n─── 2. GET /staff (isOnDuty=true) ───');
    const list1 = await call('/staff', { token: token1, tenantSlug: TENANT_SLUG });
    const meRow1 = (list1.body?.staff || []).find(s => String(s._id) === String(staffUser._id));
    record('2.1: GET /staff returns 200 with staff array',
        list1.status === 200 && Array.isArray(list1.body?.staff),
        `status=${list1.status}, length=${list1.body?.staff?.length}`);
    record('2.2: subject\'s row is present in /staff response',
        !!meRow1,
        meRow1 ? `found row with role=${meRow1.role}` : 'subject not in list');
    record('2.3: subject\'s row has isOnDuty=true while shift is active',
        meRow1?.isOnDuty === true,
        `isOnDuty=${meRow1?.isOnDuty}`);

    console.log('\n─── 3. POST /auth/logout ───');
    // Slide clockIn back ~1h so we can detect non-zero totalHours.
    await Shift.updateOne(
        { _id: openedShift._id },
        { $set: { clockIn: new Date(Date.now() - 60 * 60 * 1000) } },
    );

    const logoutRes = await call('/auth/logout', {
        method: 'POST',
        token: token1,
        tenantSlug: TENANT_SLUG,
    });
    record('3.1: logout returns 200',
        logoutRes.status === 200,
        `status=${logoutRes.status}, msg="${logoutRes.body?.message || ''}"`);
    await sleep(250);
    const closedShift = await Shift.findOne({ _id: openedShift._id });
    record('3.2: shift status flipped to completed',
        closedShift?.status === 'completed' && !!closedShift?.clockOut,
        `status=${closedShift?.status}, clockOut=${closedShift?.clockOut?.toISOString()}`);
    record('3.3: totalHours computed (≈1.0h)',
        closedShift && Math.abs((closedShift.totalHours || 0) - 1) < 0.1,
        `totalHours=${closedShift?.totalHours}`);
    record('3.4: [Auto-closed on logout] audit note appended',
        /Auto-closed on logout/.test(closedShift?.note || ''),
        `note="${(closedShift?.note || '').slice(0, 60)}…"`);

    console.log('\n─── 4. Re-login and confirm isOnDuty toggles back ───');
    const login2 = await call('/auth/login', {
        method: 'POST',
        body: { email: EMAIL, password: PASSWORD, loginType: 'staff' },
        tenantSlug: TENANT_SLUG,
    });
    // After re-login, BEFORE the next read, the previous shift is
    // closed but a new one is open. So isOnDuty should still be true.
    await sleep(250);
    const list2 = await call('/staff', { token: login2.body?.token, tenantSlug: TENANT_SLUG });
    const meRow2 = (list2.body?.staff || []).find(s => String(s._id) === String(staffUser._id));
    record('4.1: subject is still On Duty after fresh login (new shift opened)',
        meRow2?.isOnDuty === true,
        `isOnDuty=${meRow2?.isOnDuty}`);

    // Now log out and re-check WITHOUT logging back in.
    await call('/auth/logout', { method: 'POST', token: login2.body?.token, tenantSlug: TENANT_SLUG });
    await sleep(250);
    // Use the still-valid logout-cleared token: it's actually still
    // valid as a JWT (statelessness) — logout only clears the cookie.
    // So the read after logout below should succeed and report Off Duty.
    const list3 = await call('/staff', { token: login2.body?.token, tenantSlug: TENANT_SLUG });
    const meRow3 = (list3.body?.staff || []).find(s => String(s._id) === String(staffUser._id));
    record('4.2: subject is Off Duty after logout',
        meRow3?.isOnDuty === false,
        `isOnDuty=${meRow3?.isOnDuty}`);

    await finish();
}

async function finish() {
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    console.log(`\n══════════ HTTP Summary: ${passed} passed, ${failed} failed (${results.length} total) ══════════`);
    if (failed > 0) {
        console.log('\nFailures:');
        for (const r of results.filter(r => !r.passed)) {
            console.log(`  ✘ ${r.name}: ${r.detail}`);
        }
        process.exitCode = 1;
    }
    await mongoose.disconnect();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

run().catch(err => { console.error('HTTP test crashed:', err); process.exit(99); });
