/**
 * test-shift-http-runner.js — wrapper that provisions a temp staff
 * user with a known password, runs the HTTP test against them, and
 * cleans up. Lets the test harness run autonomously without needing
 * a real staff credential.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const Shift = require('../models/shift');

const TENANT_SLUG = 'hotel-tip-top';
const TEMP_EMAIL = `shift-test-${Date.now()}@bestodine.local`;
const TEMP_PASSWORD = 'TestShift!7Aa';
const TEMP_NAME = 'Shift HTTP Test';

(async () => {
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 30000, family: 4 });

    const tenant = await Restaurant.findOne({ slug: TENANT_SLUG });
    if (!tenant) { console.error(`Tenant ${TENANT_SLUG} missing`); process.exit(2); }
    const mainBranch = await Branch.findOne({ restaurant: tenant._id, slug: 'main' });
    if (!mainBranch) { console.error('Main branch missing'); process.exit(2); }

    // Pass plain password — User pre('save') hook handles bcrypt at 12 rounds.
    // Use a high EMP-XXX to avoid clobbering anything in the fresh
    // sequence — gets deleted in cleanup anyway.
    const tempStaffId = `EMP-${Date.now().toString().slice(-3)}`;
    const temp = await User.create({
        name: TEMP_NAME,
        email: TEMP_EMAIL,
        password: TEMP_PASSWORD,
        role: 'admin',           // branch admin — can call GET /staff for their own branch
        staffId: tempStaffId,
        restaurant: tenant._id,
        branch: mainBranch._id,
        status: 'active',
        mustChangePassword: false,        // <-- critical: avoid the password-required gate during /staff calls
    });
    console.log(`✔ Created temp staff: ${TEMP_EMAIL} (id=${temp._id}, staffId=${tempStaffId})\n`);

    await mongoose.disconnect();

    let exitCode = 0;
    try {
        const proc = spawnSync('node', ['scripts/test-shift-http.js'], {
            stdio: 'inherit',
            env: {
                ...process.env,
                TEST_EMAIL: TEMP_EMAIL,
                TEST_PASSWORD: TEMP_PASSWORD,
                TEST_TENANT_SLUG: TENANT_SLUG,
            },
        });
        exitCode = proc.status ?? 0;
    } finally {
        // Always clean up, even if the test crashed.
        await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 30000, family: 4 });
        await Shift.deleteMany({ staff: temp._id });
        await User.deleteOne({ _id: temp._id });
        console.log(`\n✔ Cleaned up temp staff + shifts`);
        await mongoose.disconnect();
    }
    process.exit(exitCode);
})().catch(e => { console.error(e); process.exit(99); });
