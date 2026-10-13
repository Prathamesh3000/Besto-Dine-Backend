/**
 * Per-account login lockout through the real HTTP stack
 * (routes/authRoute.js → controllers/authController.login →
 * utils/loginAttempts.js → `login_attempts` collection) plus the admin
 * unlock route (routes/staffRoute.js → staffController.unlockStaffLogin).
 *
 * The per-IP limiters are pass-through in the integration suites
 * (helpers/mocks.js) — they are pinned by __tests__/authLimiters.test.js.
 * Everything here is therefore the per-ACCOUNT behaviour, which is what
 * must hold when 25 staff share one NAT address.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser, DEFAULT_PASSWORD } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const LoginAttempt = require(path.join(BACKEND, 'models/loginAttempt'));
const logger = require(path.join(BACKEND, 'utils/logger'));
const loginAttempts = require(path.join(BACKEND, 'utils/loginAttempts'));

const ctx = useIntegrationApp();
let A;
let B;

beforeAll(async () => {
    A = await seedTenant({ label: 'locka' });
    B = await seedTenant({ label: 'lockb' });
});

const login = (tenant, email, password) => ctx.api.anon().post('/auth/login')
    .set('X-Restaurant-Slug', tenant.slug)
    .send({ email, password, loginType: 'staff' });

async function failN(tenant, email, n) {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push((await login(tenant, email, `wrong-${i}`)).status); // eslint-disable-line no-await-in-loop
    return statuses;
}

const keyFor = (tenant, user) => loginAttempts.accountKey({ user: { role: user.role, restaurant: tenant.restaurant._id, email: user.email } });

const warns = (name) => logger.__records.filter((r) => r.level === 'warn' && r.args[0] === name);

/** A fresh staff row in `tenant` with DEFAULT_PASSWORD. */
const freshStaff = (tenant, label, role = 'waiter', extra = {}) => createUser({
    name: `${label} ${tenant.label}`,
    email: `${label}.${tenant.slug}@staff.test`,
    role,
    restaurant: tenant.restaurant._id,
    branch: tenant.branch._id,
    ...extra,
});

describe('per-account lockout', () => {
    test('10 wrong passwords lock the account: the 11th attempt is 429 ACCOUNT_LOCKED even with the right password, with Retry-After and the generic message', async () => {
        const u = await freshStaff(A, 'lock10');
        expect(await failN(A, u.email, 9)).toEqual(Array(9).fill(401));
        // 9 fails: still open — the right password gets in
        // (we check the row, not a login, so the counter is not reset here)
        expect((await LoginAttempt.findById(keyFor(A, u)).lean()).fails).toBe(9);

        const tenth = await login(A, u.email, 'wrong-9');
        expect(tenth.status).toBe(401);
        expect(tenth.body.message).toBe('Invalid email or password');

        const row = await LoginAttempt.findById(keyFor(A, u)).lean();
        expect(row.fails).toBe(10);
        expect(row.lockedUntil).toBeInstanceOf(Date);
        const lockMs = row.lockedUntil.getTime() - Date.now();
        expect(lockMs).toBeGreaterThan(14 * 60 * 1000);
        expect(lockMs).toBeLessThanOrEqual(15 * 60 * 1000);
        // TTL field follows the lock — the row (and lock) expire together
        expect(row.expiresAt.getTime()).toBe(row.lockedUntil.getTime());

        const locked = await login(A, u.email, DEFAULT_PASSWORD);
        expect(locked.status).toBe(429);
        expect(locked.body).toEqual({ success: false, code: 'ACCOUNT_LOCKED', message: 'Invalid email or password' });
        const retry = Number(locked.headers['retry-after']);
        expect(retry).toBeGreaterThan(14 * 60);
        expect(retry).toBeLessThanOrEqual(15 * 60);
        expect(JSON.stringify(locked.body)).not.toMatch(/token/i);

        // a wrong password while locked is the same 429 (no oracle) and does not re-lock
        const wrongWhileLocked = await login(A, u.email, 'still-wrong');
        expect(wrongWhileLocked.status).toBe(429);
        expect(wrongWhileLocked.body.code).toBe('ACCOUNT_LOCKED');
        expect((await LoginAttempt.findById(keyFor(A, u)).lean()).lockedUntil.getTime()).toBe(row.lockedUntil.getTime());

        // logging: one lock warning, masked key, no password anywhere
        const locks = warns('auth.account.locked').filter((r) => r.args[1]?.accountKey?.endsWith(`@staff.test`) && r.args[1].accountKey.startsWith(`${A.restaurant._id}:l***@`));
        expect(locks).toHaveLength(1);
        expect(locks[0].args[1]).toMatchObject({ fails: 10, ip: expect.any(String) });
        expect(locks[0].args[1].lockedUntil).toBeInstanceOf(Date);
        expect(JSON.stringify(locks[0].args)).not.toContain(u.email);
        expect(JSON.stringify(logger.__records)).not.toMatch(/wrong-\d|still-wrong|Integration#Pass/);
        expect(warns('auth.login.locked-attempt').length).toBeGreaterThanOrEqual(2);
    });

    test('a second account on the same IP logs in fine while the first is locked (per-account, not per-IP)', async () => {
        const locked = await freshStaff(A, 'lock-neighbour-1');
        const colleague = await freshStaff(A, 'lock-neighbour-2', 'chef');
        await failN(A, locked.email, 10);
        expect((await login(A, locked.email, DEFAULT_PASSWORD)).status).toBe(429);
        const ok = await login(A, colleague.email, DEFAULT_PASSWORD);
        expect(ok.status).toBe(200);
        expect(ok.body.token).toEqual(expect.any(String));
        // and the same email at another tenant is a different account
        const twin = await createUser({
            name: 'twin', email: locked.email, role: 'waiter', restaurant: B.restaurant._id, branch: B.branch._id,
        });
        expect((await login(B, twin.email, DEFAULT_PASSWORD)).status).toBe(200);
    });

    test('a correct login before the 10th failure resets the counter', async () => {
        const u = await freshStaff(A, 'lock-reset');
        await failN(A, u.email, 9);
        expect((await login(A, u.email, DEFAULT_PASSWORD)).status).toBe(200);
        expect(await LoginAttempt.findById(keyFor(A, u)).lean()).toBeNull();
        await failN(A, u.email, 9);
        expect((await login(A, u.email, DEFAULT_PASSWORD)).status).toBe(200);
    });

    test('after the lock expires (lockedUntil in the past) the right password works and the counter starts over', async () => {
        const u = await freshStaff(A, 'lock-expire');
        await failN(A, u.email, 10);
        expect((await login(A, u.email, DEFAULT_PASSWORD)).status).toBe(429);
        const past = new Date(Date.now() - 1000);
        await LoginAttempt.updateOne({ _id: keyFor(A, u) }, { $set: { lockedUntil: past, firstFailAt: new Date(Date.now() - 16 * 60 * 1000) } });

        // one more typo after expiry: fresh window, no lock
        expect((await login(A, u.email, 'typo')).status).toBe(401);
        const row = await LoginAttempt.findById(keyFor(A, u)).lean();
        expect(row.fails).toBe(1);
        expect(row.lockedUntil).toBeNull();

        const ok = await login(A, u.email, DEFAULT_PASSWORD);
        expect(ok.status).toBe(200);
        expect(await LoginAttempt.findById(keyFor(A, u)).lean()).toBeNull();
    });

    test('the login_attempts collection has a TTL index on expiresAt', async () => {
        const indexes = await LoginAttempt.collection.indexes();
        const ttl = indexes.find((i) => i.key?.expiresAt === 1);
        expect(ttl).toBeDefined();
        expect(ttl.expireAfterSeconds).toBe(0);
    });

    test('superadmin is never locked; repeated failures only log a warning', async () => {
        const root = await createUser({
            name: 'Root', email: 'root.lock@bestodine.test', role: 'superadmin', superadminLevel: 'full',
        });
        for (let i = 0; i < 12; i++) expect((await login(A, root.email, `wrong-${i}`)).status).toBe(401); // eslint-disable-line no-await-in-loop
        const row = await LoginAttempt.findById(`superadmin:${root.email}`).lean();
        expect(row.fails).toBe(12);
        expect(row.lockedUntil).toBeNull();
        expect((await login(A, root.email, DEFAULT_PASSWORD)).status).toBe(200);
        const w = warns('auth.superadmin.repeated-fails');
        expect(w.length).toBeGreaterThanOrEqual(3); // fails 10, 11, 12
        expect(w[0].args[1].accountKey).toBe('superadmin:r***@bestodine.test');
        expect(warns('auth.account.locked').some((r) => r.args[1]?.accountKey?.startsWith('superadmin:'))).toBe(false);
    });

    test('customers lock on their own global key', async () => {
        const cust = await createUser({ name: 'Diner', email: 'diner.lock@customers.test', role: 'customer' });
        const cl = (pw) => ctx.api.anon().post('/auth/login').send({ email: cust.email, password: pw, loginType: 'customer' });
        for (let i = 0; i < 10; i++) expect((await cl(`w${i}`)).status).toBe(401); // eslint-disable-line no-await-in-loop
        const locked = await cl(DEFAULT_PASSWORD);
        expect(locked.status).toBe(429);
        expect(locked.body.code).toBe('ACCOUNT_LOCKED');
        expect((await LoginAttempt.findById(`customer:${cust.email}`).lean()).lockedUntil).toBeInstanceOf(Date);
    });
});

describe('POST /staff/:id/unlock-login', () => {
    test('admin of the same tenant clears the lock; the staff member logs in at once; the unlock is logged with the actor', async () => {
        const u = await freshStaff(A, 'lock-admin-unlock');
        await failN(A, u.email, 10);
        expect((await login(A, u.email, DEFAULT_PASSWORD)).status).toBe(429);

        const res = await ctx.api.as(A.users.admin).post(`/staff/${u._id}/unlock-login`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, unlocked: true });
        expect(await LoginAttempt.findById(keyFor(A, u)).lean()).toBeNull();
        expect((await login(A, u.email, DEFAULT_PASSWORD)).status).toBe(200);

        const logs = logger.__records.filter((r) => r.args[0] === 'auth.account.unlocked' && r.args[1]?.staffId === String(u._id));
        expect(logs).toHaveLength(1);
        expect(logs[0].args[1]).toMatchObject({
            actorId: String(A.users.admin._id), via: 'unlock-login', hadLock: true,
            accountKey: `${A.restaurant._id}:l***@staff.test`,
        });

        // idempotent — unlocking an unlocked account is a 200 with unlocked:false
        const again = await ctx.api.as(A.users.admin).post(`/staff/${u._id}/unlock-login`);
        expect(again.status).toBe(200);
        expect(again.body.unlocked).toBe(false);
    });

    test('tenant-scoped: another tenant\'s admin gets 404 and the lock stays; floor staff get 403', async () => {
        const u = await freshStaff(A, 'lock-foreign');
        await failN(A, u.email, 10);
        const foreign = await ctx.api.as(B.users.admin).post(`/staff/${u._id}/unlock-login`);
        expect(foreign.status).toBe(404);
        expect((await LoginAttempt.findById(keyFor(A, u)).lean()).lockedUntil).toBeInstanceOf(Date);
        expect((await login(A, u.email, DEFAULT_PASSWORD)).status).toBe(429);

        expect((await ctx.api.as(A.users.waiter).post(`/staff/${u._id}/unlock-login`)).status).toBe(403);
        expect((await ctx.api.guest(A).post(`/staff/${u._id}/unlock-login`)).status).toBe(401); // no token
        expect((await ctx.api.as(A.users.admin).post('/staff/not-an-id/unlock-login')).status).toBe(400);
    });

    test('an admin password reset also clears the lock — the temp password works immediately', async () => {
        const u = await freshStaff(A, 'lock-pwreset');
        await failN(A, u.email, 10);
        expect((await login(A, u.email, DEFAULT_PASSWORD)).status).toBe(429);

        const reset = await ctx.api.as(A.users.admin).post(`/staff/${u._id}/reset-password`);
        expect(reset.status).toBe(200);
        expect(reset.body.tempPassword).toEqual(expect.any(String));
        expect(await LoginAttempt.findById(keyFor(A, u)).lean()).toBeNull();
        const ok = await login(A, u.email, reset.body.tempPassword);
        expect(ok.status).toBe(200);
        expect(logger.__records.some((r) => r.args[0] === 'auth.account.unlocked' && r.args[1]?.via === 'reset-password' && r.args[1]?.staffId === String(u._id))).toBe(true);
    });
});

describe('owner acceptance: the worse day', () => {
    test('25 staff × (3 wrong + 1 right) from one IP → all 25 log in, zero 429s', async () => {
        const staff = [];
        for (let i = 1; i <= 25; i++) staff.push(await freshStaff(A, `worseday-${String(i).padStart(2, '0')}`, i % 3 === 0 ? 'chef' : 'waiter')); // eslint-disable-line no-await-in-loop
        let loggedIn = 0;
        let legit429 = 0;
        let any429 = 0;
        for (const s of staff) {
            for (let t = 1; t <= 3; t++) {
                const r = await login(A, s.email, `typo-${t}`); // eslint-disable-line no-await-in-loop
                if (r.status === 429) any429 += 1;
                else expect(r.status).toBe(401);
            }
            const ok = await login(A, s.email, DEFAULT_PASSWORD); // eslint-disable-line no-await-in-loop
            if (ok.status === 200) loggedIn += 1;
            if (ok.status === 429) legit429 += 1;
        }
        expect(loggedIn).toBe(25);
        expect(legit429).toBe(0);
        expect(any429).toBe(0);
        // every counter was reset by the successful login
        expect(await LoginAttempt.countDocuments({ _id: { $regex: /worseday-/ } })).toBe(0);
    }, 120000);
});
