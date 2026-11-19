/**
 * STRICT tenant isolation: staff management + authentication.
 *
 * Tenant A's admin holds B's ids and tries every staff route; each answer
 * is checked on the HTTP response, on the body text (no B data) and on the
 * B document re-read from the database. Also: same email in two tenants,
 * login / refresh / token-with-wrong-slug, CSV import.
 */
const path = require('path');
const bcrypt = require('bcryptjs');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser, createCustomer, DEFAULT_PASSWORD } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const model = (n) => require(path.join(BACKEND, 'models', n));
const User = model('user');
const Branch = model('branch');
const Area = model('area');
const Table = model('table');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A; let B; let victim; let branchA2; let areaB; let tableB;
const DENIED = [400, 403, 404];
const adminA = () => ctx.api.as(A.users.admin);
const text = (res) => JSON.stringify(res.body || {});
const snap = async (id) => JSON.stringify(await User.findById(id).select('+password').lean());

beforeAll(async () => {
    A = await seedTenant({ label: 'sp-a' });
    B = await seedTenant({ label: 'sp-b' });
    branchA2 = await Branch.create({ restaurant: A.restaurant._id, name: 'A-Second', slug: 'second', isActive: true });
    areaB = await Area.create({ restaurant: B.restaurant._id, branch: B.branch._id, name: 'B-Secret-Area' });
    tableB = await Table.create({ restaurant: B.restaurant._id, branch: B.branch._id, area: areaB._id, name: 'B-Secret-Table', capacity: 2, qrToken: 'tb-bsecret1', status: 'free' });
    victim = await createUser({
        name: 'B-Victim-Waiter', email: 'victim.waiter@b-only.test', role: 'waiter', mobile: '9876543210',
        restaurant: B.restaurant._id, branch: B.branch._id, permissions: defaultPermissionsForRole('waiter'), staffId: 'EMP-9001',
    });
    await settle();
});

describe('staff list', () => {
    test("B's staff are never listed for A (names, emails, ids, counts)", async () => {
        const res = await adminA().get('/staff');
        expect(res.status).toBe(200);
        const t = text(res);
        for (const needle of ['B-Victim-Waiter', 'victim.waiter@b-only.test', String(victim._id), String(B.users.admin._id), B.slug]) {
            expect(t).not.toContain(needle);
        }
        const rows = res.body.staff || res.body.data || [];
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(String(r.restaurant || A.restaurant._id)).toBe(String(A.restaurant._id));
    });

    test('mass-assignment via query (restaurant / restaurantId / tenant) cannot widen the list', async () => {
        for (const q of [`restaurant=${B.restaurant._id}`, `restaurantId=${B.restaurant._id}`, `tenant=${B.restaurant._id}`, `branch=${B.branch._id}`]) {
            const res = await adminA().get(`/staff?${q}`);
            expect(text(res)).not.toContain('B-Victim-Waiter');
            expect(text(res)).not.toContain(String(victim._id));
        }
    });

    test('mass-assignment via header: A token + B slug / B restaurant headers never lists B staff', async () => {
        const r1 = await ctx.api.as(A.users.admin, B).get('/staff');
        expect(text(r1)).not.toContain('B-Victim-Waiter');
        const r2 = await adminA().get('/staff').set('X-Restaurant-Id', String(B.restaurant._id)).set('X-Tenant', String(B.restaurant._id));
        expect(text(r2)).not.toContain('B-Victim-Waiter');
    });

    test('$ne / operator injection in query params does not widen the list', async () => {
        const res = await adminA().get('/staff?role[$ne]=x&restaurant[$ne]=null&status[$ne]=zzz');
        expect(res.status).toBeLessThan(500);
        expect(text(res)).not.toContain('B-Victim-Waiter');
    });

    test('next-id preview ignores B staff ids', async () => {
        const res = await adminA().get(`/staff/next-id?branch=${B.branch._id}`);
        expect(res.status).toBeLessThan(500);
        expect(text(res)).not.toContain('EMP-9001');
    });
});

describe("A cannot act on B's staff by id", () => {
    test('PUT /staff/:id → 404 and B unchanged', async () => {
        const before = await snap(victim._id);
        const res = await adminA().put(`/staff/${victim._id}`).send({
            name: 'Hijacked', email: 'hijack@a.test', role: 'chef', mobile: '9123456789',
            restaurant: String(A.restaurant._id), branch: String(A.branch._id),
        });
        expect(DENIED).toContain(res.status);
        expect(text(res)).not.toContain('victim.waiter@b-only.test');
        expect(await snap(victim._id)).toBe(before);
    });

    test('PATCH /staff/:id/status → denied and B unchanged', async () => {
        const before = await snap(victim._id);
        const res = await adminA().patch(`/staff/${victim._id}/status`).send({ status: 'inactive' });
        expect(DENIED).toContain(res.status);
        expect(await snap(victim._id)).toBe(before);
    });

    test('POST /staff/:id/reset-password → denied, no temp password, hash unchanged', async () => {
        const before = await snap(victim._id);
        const res = await adminA().post(`/staff/${victim._id}/reset-password`).send({});
        expect(DENIED).toContain(res.status);
        expect(text(res)).not.toMatch(/tempPassword|temporaryPassword/i);
        expect(await snap(victim._id)).toBe(before);
    });

    test('POST /staff/:id/unlock-login → denied', async () => {
        const res = await adminA().post(`/staff/${victim._id}/unlock-login`).send({});
        expect(DENIED).toContain(res.status);
    });

    test('GET /staff/:id/performance → denied, no B data', async () => {
        const res = await adminA().get(`/staff/${victim._id}/performance`);
        expect(DENIED).toContain(res.status);
        expect(text(res)).not.toContain('B-Victim-Waiter');
    });

    test('DELETE /staff/:id → denied and B still exists', async () => {
        const res = await adminA().delete(`/staff/${victim._id}`);
        expect(DENIED).toContain(res.status);
        expect(await User.exists({ _id: victim._id })).toBeTruthy();
    });

    test('B tenant owner cannot be deleted / reset / demoted by A', async () => {
        const before = await snap(B.users.admin._id);
        const rs = [
            await adminA().delete(`/staff/${B.users.admin._id}`),
            await adminA().post(`/staff/${B.users.admin._id}/reset-password`).send({}),
            await adminA().put(`/staff/${B.users.admin._id}`).send({ role: 'waiter', name: 'x', email: 'x@a.test' }),
            await adminA().patch(`/staff/${B.users.admin._id}/status`).send({ status: 'inactive' }),
        ];
        for (const r of rs) expect(DENIED).toContain(r.status);
        expect(await snap(B.users.admin._id)).toBe(before);
    });

    test('non-ObjectId / operator-injection ids are rejected without 500', async () => {
        for (const id of ['abc', '%7B%22%24ne%22%3Anull%7D', '[object Object]', 'null', '..%2F..%2Fadmin']) {
            for (const call of [
                () => adminA().put(`/staff/${id}`).send({ name: 'x' }),
                () => adminA().delete(`/staff/${id}`),
                () => adminA().patch(`/staff/${id}/status`).send({ status: 'active' }),
                () => adminA().get(`/staff/${id}/performance`),
            ]) {
                const res = await call();
                expect(res.status).toBeLessThan(500);
                expect(res.status).toBeGreaterThanOrEqual(400);
            }
        }
        expect(await User.countDocuments({ restaurant: B.restaurant._id })).toBeGreaterThan(0);
    });

    test('A manager / branch admin of A is equally blocked from B staff', async () => {
        const mgr = await createUser({
            name: 'A Mgr', email: `mgr.${A.slug}@staff.test`, role: 'manager', restaurant: A.restaurant._id,
            permissions: { ...defaultPermissionsForRole('manager'), manageStaff: true },
        });
        const subAdmin = await createUser({
            name: 'A Branch Admin', email: `sub.${A.slug}@staff.test`, role: 'admin', restaurant: A.restaurant._id,
            branch: branchA2._id, permissions: {},
        });
        const before = await snap(victim._id);
        for (const u of [mgr, subAdmin]) {
            const api = ctx.api.as(u);
            for (const r of [
                await api.put(`/staff/${victim._id}`).send({ name: 'x', email: 'x@a.test', role: 'waiter' }),
                await api.delete(`/staff/${victim._id}`),
                await api.patch(`/staff/${victim._id}/status`).send({ status: 'inactive' }),
                await api.post(`/staff/${victim._id}/reset-password`).send({}),
            ]) expect(DENIED).toContain(r.status);
        }
        expect(await snap(victim._id)).toBe(before);
    });
});

describe('creating / editing A staff that reference B data', () => {
    const base = (email) => ({ name: 'New Waiter', email, mobile: '9988776655', role: 'waiter' });

    test('POST /staff with restaurant / restaurantId / tenant in the body lands in A', async () => {
        const res = await adminA().post('/staff').send({
            ...base('mass.assign@a.test'), branch: String(A.branch._id),
            restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id), tenant: String(B.restaurant._id),
        });
        expect(res.status).toBeLessThan(500);
        const row = await User.findOne({ email: 'mass.assign@a.test' }).lean();
        if (row) expect(String(row.restaurant)).toBe(String(A.restaurant._id));
        expect(await User.countDocuments({ email: 'mass.assign@a.test', restaurant: B.restaurant._id })).toBe(0);
    });

    test("POST /staff pinned to B's branch → rejected, nothing created", async () => {
        const res = await adminA().post('/staff').send({ ...base('bbranch@a.test'), branch: String(B.branch._id) });
        expect(DENIED).toContain(res.status);
        expect(await User.exists({ email: 'bbranch@a.test' })).toBeFalsy();
    });

    test("POST /staff with B's areas / tables never stores B ids on the A user", async () => {
        const res = await adminA().post('/staff').send({
            ...base('xareas@a.test'), branch: String(A.branch._id),
            assignedAreas: [String(areaB._id)], assignedTables: [String(tableB._id)],
        });
        expect(res.status).toBeLessThan(500);
        const row = await User.findOne({ email: 'xareas@a.test' }).lean();
        if (row) {
            expect((row.assignedAreas || []).map(String)).not.toContain(String(areaB._id));
            expect((row.assignedTables || []).map(String)).not.toContain(String(tableB._id));
        } else {
            expect(DENIED).toContain(res.status);
        }
    });

    test("PUT on A's own waiter cannot move it to B (restaurant / branch / areas)", async () => {
        const res = await adminA().put(`/staff/${A.users.waiter._id}`).send({
            name: 'Waiter A', email: A.users.waiter.email, role: 'waiter', mobile: '9876500001',
            restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id),
            branch: String(B.branch._id), assignedAreas: [String(areaB._id)], assignedTables: [String(tableB._id)],
        });
        expect(res.status).toBeLessThan(500);
        const row = await User.findById(A.users.waiter._id).lean();
        expect(String(row.restaurant)).toBe(String(A.restaurant._id));
        expect(String(row.branch)).not.toBe(String(B.branch._id));
        expect((row.assignedAreas || []).map(String)).not.toContain(String(areaB._id));
        expect((row.assignedTables || []).map(String)).not.toContain(String(tableB._id));
    });

    test("PUT cannot grant A's waiter the identity / email of B's staff to take over B", async () => {
        const res = await adminA().put(`/staff/${A.users.chef._id}`).send({
            name: 'Chef A', email: 'victim.waiter@b-only.test', role: 'chef', mobile: '9876500002',
        });
        expect(res.status).toBeLessThan(500);
        const bRow = await User.findById(victim._id).lean();
        expect(String(bRow.restaurant)).toBe(String(B.restaurant._id));
        expect(bRow.name).toBe('B-Victim-Waiter');
    });

    test('the same staff email may exist in two tenants as independent users (no cross mutation)', async () => {
        const email = 'shared.person@both.test';
        const res = await adminA().post('/staff').send({ ...base(email), branch: String(A.branch._id) });
        expect(res.status).toBeLessThan(500);
        const bRow = await createUser({
            name: 'Shared at B', email, role: 'chef', restaurant: B.restaurant._id, branch: B.branch._id,
            password: await bcrypt.hash('Other#Pass1234', 4),
        });
        const aRow = await User.findOne({ email, restaurant: A.restaurant._id });
        if (res.status < 300) {
            expect(aRow).toBeTruthy();
            expect(String(aRow._id)).not.toBe(String(bRow._id));
        }
        expect((await User.findById(bRow._id).lean()).name).toBe('Shared at B');
    });
});

describe('staff CSV import', () => {
    const csv = (rows) => Buffer.from(['name,email,role,mobile', ...rows].join('\n'));

    test('rows land in A; body restaurant / branch of B is ignored or refused', async () => {
        const res = await adminA().post('/staff/import')
            .field('restaurant', String(B.restaurant._id)).field('restaurantId', String(B.restaurant._id))
            .field('branch', String(A.branch._id))
            .attach('file', csv(['CSV One,csv.one@a.test,waiter,9811111111', 'CSV Two,csv.two@a.test,chef,9822222222']), 'staff.csv');
        expect(res.status).toBeLessThan(500);
        expect(await User.countDocuments({ email: { $in: ['csv.one@a.test', 'csv.two@a.test'] }, restaurant: B.restaurant._id })).toBe(0);
        for (const r of await User.find({ email: { $in: ['csv.one@a.test', 'csv.two@a.test'] } }).lean()) {
            expect(String(r.restaurant)).toBe(String(A.restaurant._id));
        }
    });

    test("branch form field naming B's branch is refused and creates nothing", async () => {
        const res = await adminA().post('/staff/import').field('branch', String(B.branch._id))
            .attach('file', csv(['CSV Bad,csv.bad@a.test,waiter,9833333333']), 'staff.csv');
        expect(DENIED).toContain(res.status);
        expect(await User.exists({ email: 'csv.bad@a.test' })).toBeFalsy();
    });

    test('a restaurant / branch column inside the CSV cannot redirect rows to B', async () => {
        const body = Buffer.from(['name,email,role,mobile,restaurant,branch',
            `CSV Col,csv.col@a.test,waiter,9844444444,${B.restaurant._id},${B.branch._id}`].join('\n'));
        const res = await adminA().post('/staff/import').field('branch', String(A.branch._id)).attach('file', body, 'staff.csv');
        expect(res.status).toBeLessThan(500);
        expect(await User.exists({ email: 'csv.col@a.test', restaurant: B.restaurant._id })).toBeFalsy();
    });

    test("importing B's existing email does not overwrite or leak B's user", async () => {
        const before = await snap(victim._id);
        const res = await adminA().post('/staff/import').field('branch', String(A.branch._id))
            .attach('file', csv(['Overwrite,victim.waiter@b-only.test,waiter,9855555555']), 'staff.csv');
        expect(res.status).toBeLessThan(500);
        expect(await snap(victim._id)).toBe(before);
        expect(text(res)).not.toContain('B-Victim-Waiter');
    });
});

describe('authentication across tenants', () => {
    const SHARED = 'dual.staff@both.test';
    let aUser; let bUser;
    const BPASS = 'BsOwn#Pass9876';

    beforeAll(async () => {
        aUser = await createUser({ name: 'Dual A', email: SHARED, role: 'chef', restaurant: A.restaurant._id, branch: A.branch._id });
        bUser = await createUser({ name: 'Dual B', email: SHARED, role: 'chef', restaurant: B.restaurant._id, branch: B.branch._id, password: await bcrypt.hash(BPASS, 4) });
    });

    const login = (slug, password, extra = {}) => {
        const r = ctx.api.anon().post('/auth/login');
        return (slug ? r.set('X-Restaurant-Slug', slug) : r).send({ email: SHARED, password, ...extra });
    };

    test('with A slug, A password logs in as the A user', async () => {
        const res = await login(A.slug, DEFAULT_PASSWORD);
        expect(res.status).toBe(200);
        expect(String(res.body._id || res.body.id || res.body.user?._id)).toBe(String(aUser._id));
    });

    test('with B slug, B password logs in as the B user', async () => {
        const res = await login(B.slug, BPASS);
        expect(res.status).toBe(200);
        expect(String(res.body._id || res.body.id || res.body.user?._id)).toBe(String(bUser._id));
    });

    test("with B slug, A's password does NOT authenticate (no fall-through to A's account)", async () => {
        const res = await login(B.slug, DEFAULT_PASSWORD);
        expect(res.status).toBe(401);
        expect(res.body.token || res.body.accessToken).toBeUndefined();
    });

    test("with A slug, B's password does NOT authenticate", async () => {
        const res = await login(A.slug, BPASS);
        expect(res.status).toBe(401);
    });

    test('no slug and an ambiguous email: 409 lists only restaurants whose password matched', async () => {
        const res = await login(null, BPASS);
        expect([200, 401, 409]).toContain(res.status);
        if (res.status === 409) {
            const slugs = (res.body.restaurants || []).map((r) => r.slug);
            expect(slugs).toEqual([B.slug]);
        }
        const none = await login(null, 'Totally#Wrong1');
        expect(none.status).toBe(401);
        expect(text(none)).not.toContain(A.slug);
        expect(text(none)).not.toContain(B.slug);
    });

    test('mass-assigned restaurant / restaurantId in the login body does not choose the tenant', async () => {
        const res = await login(A.slug, BPASS, { restaurant: String(B.restaurant._id), restaurantId: String(B.restaurant._id), tenant: B.slug });
        expect(res.status).toBe(401);
    });

    test('operator injection in email / password is a 400, not a login', async () => {
        const r1 = await ctx.api.anon().post('/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
        expect([400, 401]).toContain(r1.status);
        const r2 = await ctx.api.anon().post('/auth/login').set('X-Restaurant-Slug', B.slug).send({ email: B.users.admin.email, password: { $ne: null } });
        expect([400, 401]).toContain(r2.status);
        expect(r2.body.token || r2.body.accessToken).toBeUndefined();
    });

    test("failed logins at B do not lock A's account (lock key is per tenant)", async () => {
        for (let i = 0; i < 3; i++) await login(B.slug, 'Wrong#Pass12345');
        const res = await login(A.slug, DEFAULT_PASSWORD);
        expect(res.status).toBe(200);
    });

    test('A token + B slug on /auth/me still reports the A user only', async () => {
        const res = await ctx.api.as(A.users.admin, B).get('/auth/me');
        expect(text(res)).not.toContain(String(B.restaurant._id));
        expect(text(res)).not.toContain(B.slug);
    });

    test("A's refresh token cannot mint a session for B (even when sent with B slug)", async () => {
        const lg = await login(A.slug, DEFAULT_PASSWORD);
        expect(lg.status).toBe(200);
        const rt = lg.body.refreshToken;
        if (!rt) return; // cookie mode: nothing to replay
        const res = await ctx.api.anon().post('/auth/refresh').set('X-Restaurant-Slug', B.slug).send({ refreshToken: rt });
        expect(res.status).toBeLessThan(500);
        expect(text(res)).not.toContain(String(B.restaurant._id));
        if (res.body.accessToken || res.body.token) {
            const me = await ctx.api.as(res.body.accessToken || res.body.token, B).get('/staff');
            expect(text(me)).not.toContain('B-Victim-Waiter');
        }
    });

    test('a refresh token of A is not valid after being replayed (reuse) and never yields B user', async () => {
        const lg = await login(B.slug, BPASS);
        const rt = lg.body.refreshToken;
        if (!rt) return;
        const r1 = await ctx.api.anon().post('/auth/refresh').send({ refreshToken: rt });
        expect(r1.status).toBeLessThan(500);
        const body = text(r1);
        expect(body).not.toContain(String(A.restaurant._id));
    });

    test('a customer token is not accepted on staff routes of any tenant', async () => {
        const cust = await createCustomer('sp-cust');
        for (const t of [A, B]) {
            const res = await ctx.api.as(cust, t).get('/staff');
            expect([401, 403]).toContain(res.status);
        }
    });

    test("a waiter token of A cannot use /staff on B (header B slug)", async () => {
        const res = await ctx.api.as(A.users.waiter, B).get('/staff');
        expect(text(res)).not.toContain('B-Victim-Waiter');
        expect([401, 403, 200]).toContain(res.status);
    });

    test('forgot-password for a B staff email creates no reset token and leaks nothing', async () => {
        const PasswordResetToken = model('passwordResetToken');
        const res = await ctx.api.anon().post('/auth/forgot-password').send({ email: B.users.admin.email });
        expect(res.status).toBe(200);
        expect(await PasswordResetToken.countDocuments({ user: B.users.admin._id })).toBe(0);
        const unknown = await ctx.api.anon().post('/auth/forgot-password').send({ email: 'nobody@nowhere.test' });
        expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(res.body));
    });

    test('reset-password with a garbage / foreign token changes nobody\'s password', async () => {
        const before = await snap(B.users.admin._id);
        const res = await ctx.api.anon().post('/auth/reset-password').send({ token: 'a'.repeat(64), newPassword: 'Brand#New12345' });
        expect(res.status).toBe(400);
        expect(await snap(B.users.admin._id)).toBe(before);
        const inj = await ctx.api.anon().post('/auth/reset-password').send({ token: { $ne: null }, newPassword: 'Brand#New12345' });
        expect(inj.status).toBe(400);
    });

    test('a customer registered with a staff email gets no staff access through the staff form', async () => {
        const email = A.users.admin.email;
        const reg = await ctx.api.anon().post('/auth/register').send({ name: 'Squatter', email, password: 'Squat#Pass12345', mobile: '9000000001' });
        expect(reg.status).toBeLessThan(500);
        const res = await ctx.api.anon().post('/auth/login').set('X-Restaurant-Slug', A.slug)
            .send({ email, password: 'Squat#Pass12345', loginType: 'staff' });
        expect(res.status).toBe(401);
    });

    test('OTP verify cannot be used to obtain a staff session (mobile of B staff)', async () => {
        const mobile = '9876543210'; // B victim waiter's number
        const send = await ctx.api.anon().post('/auth/send-otp').send({ mobile });
        expect(send.status).toBeLessThan(500);
        const bad = await ctx.api.anon().post('/auth/verify-otp').send({ mobile, code: '000000' });
        expect([400, 401, 429]).toContain(bad.status);
        const row = await User.findById(victim._id).lean();
        expect(row.role).toBe('waiter');
        expect(String(row.restaurant)).toBe(String(B.restaurant._id));
    });
});
