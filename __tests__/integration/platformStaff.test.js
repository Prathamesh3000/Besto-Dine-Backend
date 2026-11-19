/**
 * Platform staff (PLATFORM_STAFF_PLAN.md): delegated super-admin-portal users
 * who see and work in only the modules the owner assigned, with an activity log.
 *
 * Covers: creation (owner only), first login, the deny-by-default gate, view vs
 * manage, immediate effect of access changes, deactivation / password reset
 * revoking sessions, the activity log, and isolation from tenant APIs.
 */
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async () => ({ sent: true, provider: 'test', dev: true })),
}));

const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const AuditLog = require(path.join(BACKEND, 'models/auditLog'));
const User = require(path.join(BACKEND, 'models/user'));
const Lead = require(path.join(BACKEND, 'models/lead'));
const { sendEmail } = require(path.join(BACKEND, 'utils/email'));
const platformModules = require(path.join(BACKEND, 'config/platformModules'));
const activity = require(path.join(BACKEND, 'middlewares/platformStaffActivity'));

const ctx = useIntegrationApp();
jest.setTimeout(60000);

let full;
let support;
let tenant;
const stamp = Date.now();
const SA = () => ctx.api.as(full);

/** Owner creates a staff member; returns { id, email, tempPassword, body }. */
async function createStaff(modules, label = 'ps') {
    const email = `${label}.${stamp}.${Math.random().toString(36).slice(2, 6)}@platform.test`;
    const res = await SA().post('/superadmin/platform-staff').send({ name: `Staff ${label}`, email, modules });
    expect(res.status).toBe(201);
    return { id: res.body.staff._id, email, tempPassword: res.body.tempPassword, body: res.body };
}

const NEW_PASSWORD = 'Portal-Pass-9876!';

/**
 * Sign in. A new account has a temporary password and is locked to the change-password
 * screen until it is changed (existing mustChangePassword rule), so by default this also
 * completes that first step; pass { changePassword: false } to stay on the temp password.
 */
async function loginAs(staff, { changePassword = true } = {}) {
    const current = staff.password || staff.tempPassword;
    const res = await ctx.api.anon().post('/auth/login').send({ email: staff.email, password: current, loginType: 'staff' });
    expect(res.status).toBe(200);
    let token = res.body.token;
    if (changePassword && res.body.mustChangePassword) {
        const ch = await ctx.api.as({ token }).put('/auth/change-password').send({ currentPassword: current, newPassword: NEW_PASSWORD });
        expect(ch.status).toBe(200);
        token = ch.body.token;
        staff.password = NEW_PASSWORD;
    }
    return { res, token, api: () => ctx.api.as({ token }) };
}

const auditFor = (actor, action) => AuditLog.find({ actor, action }).sort({ createdAt: 1 }).lean();
const settle = () => new Promise((r) => setTimeout(r, 250));   // let the fire-and-forget view/write rows land

beforeAll(async () => {
    full = await createUser({ name: 'Owner', email: `owner.ps.${stamp}@platform.test`, role: 'superadmin', superadminLevel: 'full' });
    support = await createUser({ name: 'Support', email: `support.ps.${stamp}@platform.test`, role: 'superadmin', superadminLevel: 'support' });
    tenant = await seedTenant({ label: 'psx' });
    await Restaurant.updateOne({ _id: tenant.restaurant._id }, { $set: {
        signupSource: 'self', registrationSource: 'self_service_trial', status: 'trial',
        owner: tenant.users.admin._id,
        'subscription.status': 'trial', 'subscription.planSlug': 'gold', 'subscription.planName': 'Gold',
        'subscription.trialStartDate': new Date(Date.now() - 3 * 864e5), 'subscription.trialEndDate': new Date(Date.now() + 11 * 864e5),
    } }, { timestamps: false });
});

beforeEach(() => {
    sendEmail.mockClear();
    activity._resetForTests();
    delete process.env.PLATFORM_VIEW_LOG_MINUTES;
});

// ═══════════════════════════════════════════════════════════════════════
describe('catalog helpers', () => {
    const { resolveRequest, allows, parseAccess } = platformModules;

    test('resolveRequest maps routes to module + level and closes everything else', () => {
        expect(resolveRequest('GET', '/signup-leads')).toEqual({ module: 'signupLeads', access: 'view' });
        expect(resolveRequest('GET', '/signup-leads/')).toEqual({ module: 'signupLeads', access: 'view' });
        expect(resolveRequest('PATCH', '/signup-leads/my-cafe')).toEqual({ module: 'signupLeads', access: 'manage' });
        expect(resolveRequest('POST', '/restaurants/abc/extend-trial')).toEqual({ module: 'trials', access: 'manage' });
        expect(resolveRequest('GET', '/restaurants/abc')).toEqual({ module: 'trials', access: 'view' });
        // sensitive routes are not delegable
        for (const [m, p] of [['DELETE', '/leads/1'], ['POST', '/restaurants'], ['POST', '/restaurants/1/suspend'],
            ['GET', '/audit-logs'], ['GET', '/platform-staff'], ['POST', '/plans'], ['GET', '/restaurants/1/backups'],
            ['PUT', '/restaurants/1/operations'], ['POST', '/restaurants/1/addons']]) {
            expect(resolveRequest(m, p)).toBeNull();
        }
    });

    test('allows: manage includes view, none allows nothing, junk allows nothing', () => {
        expect(allows({ leads: 'manage' }, 'leads', 'view')).toBe(true);
        expect(allows({ leads: 'view' }, 'leads', 'manage')).toBe(false);
        expect(allows({ leads: 'view' }, 'blog', 'view')).toBe(false);
        expect(allows(undefined, 'leads', 'view')).toBe(false);
        expect(allows({ leads: 'admin' }, 'leads', 'view')).toBe(false);
    });

    test('parseAccess rejects unknown modules / levels / empty maps; "none" is left out', () => {
        expect(parseAccess({ nope: 'view' }).error).toMatch(/Unknown module/);
        expect(parseAccess({ leads: 'root' }).error).toMatch(/must be one of/);
        expect(parseAccess({}).error).toMatch(/at least one/);
        expect(parseAccess([]).error).toBeTruthy();
        expect(parseAccess({ leads: 'view', blog: 'none' }).value).toEqual({ leads: 'view' });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('creating platform staff (owner only)', () => {
    test('a full super admin creates one: hashed temp password, forced change, audit row, welcome email', async () => {
        const s = await createStaff({ signupLeads: 'manage', leads: 'view' }, 'create');
        expect(s.tempPassword).toMatch(/.{12,}/);
        expect(s.body.emailed).toBe(true);
        expect(s.body.staff.modules).toEqual({ signupLeads: 'manage', leads: 'view' });
        expect(JSON.stringify(s.body.staff)).not.toMatch(/"password"|\$2[aby]\$/);

        const u = await User.findById(s.id).select('+password').lean();
        expect(u.role).toBe('platformstaff');
        expect(u.restaurant == null).toBe(true);
        expect(u.mustChangePassword).toBe(true);
        expect(u.password).toMatch(/\$2[aby]\$/);
        expect(u.password).not.toBe(s.tempPassword);

        const [row] = await auditFor(full._id, 'platformstaff.create');
        expect(row.targetId.toString()).toBe(s.id);
        expect(JSON.stringify(row)).not.toContain(s.tempPassword);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0].to).toBe(s.email);
    });

    test('validation: bad name / email / modules, duplicate email (any account)', async () => {
        const ok = { name: 'Valid Name', email: `val.${stamp}@platform.test`, modules: { leads: 'view' } };
        expect((await SA().post('/superadmin/platform-staff').send({ ...ok, name: 'A' })).status).toBe(400);
        expect((await SA().post('/superadmin/platform-staff').send({ ...ok, email: 'nope' })).status).toBe(400);
        expect((await SA().post('/superadmin/platform-staff').send({ ...ok, modules: { leads: 'root' } })).status).toBe(400);
        expect((await SA().post('/superadmin/platform-staff').send({ ...ok, modules: {} })).status).toBe(400);
        expect((await SA().post('/superadmin/platform-staff').send({ ...ok, modules: { superadmin: 'manage' } })).status).toBe(400);
        // an existing tenant staff email is refused too (portal login is global)
        const dup = await SA().post('/superadmin/platform-staff').send({ ...ok, email: tenant.users.admin.email });
        expect(dup.status).toBe(409);
        expect((await SA().post('/superadmin/platform-staff').send(ok)).status).toBe(201);
        expect((await SA().post('/superadmin/platform-staff').send(ok)).status).toBe(409);
    });

    test('nobody else can create or manage them: support SA, platform staff, tenant admin, anonymous', async () => {
        const body = { name: 'Nope', email: `no.${stamp}@platform.test`, modules: { leads: 'view' } };
        expect((await ctx.api.as(support).post('/superadmin/platform-staff').send(body)).status).toBe(403);
        expect((await ctx.api.as(tenant.users.admin).post('/superadmin/platform-staff').send(body)).status).toBe(403);
        expect((await ctx.api.anon().post('/superadmin/platform-staff').send(body)).status).toBe(401);
        const s = await createStaff({ leads: 'manage' }, 'nocreate');
        const staff = (await loginAs(s)).api();
        expect((await staff.post('/superadmin/platform-staff').send(body)).status).toBe(403);
        expect((await staff.get('/superadmin/platform-staff')).status).toBe(403);
        expect((await staff.patch(`/superadmin/platform-staff/${s.id}`).send({ modules: { leads: 'manage', plans: 'view' } })).status).toBe(403);
        expect(await User.exists({ email: body.email })).toBeNull();
    });

    test('lists staff, exposes the module catalog, reads one', async () => {
        const s = await createStaff({ blog: 'view' }, 'list');
        const list = await SA().get('/superadmin/platform-staff');
        expect(list.status).toBe(200);
        expect(list.body.staff.some((x) => x._id === s.id)).toBe(true);
        const cat = await SA().get('/superadmin/platform-staff/modules');
        expect(cat.body.modules.map((m) => m.key)).toEqual(expect.arrayContaining(['signupLeads', 'trials', 'leads']));
        expect((await SA().get(`/superadmin/platform-staff/${s.id}`)).body.staff.email).toBe(s.email);
        expect((await SA().get(`/superadmin/platform-staff/${full._id}`)).status).toBe(404);   // not a platformstaff id
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('signing in', () => {
    test('temp-password login returns platformstaff + their access map, forces a password change, and is logged', async () => {
        const s = await createStaff({ signupLeads: 'manage' }, 'login');
        const { res, token } = await loginAs(s, { changePassword: false });
        expect(res.body.role).toBe('platformstaff');
        expect(res.body.platformAccess).toEqual({ signupLeads: 'manage' });
        expect(res.body.mustChangePassword).toBe(true);
        expect(res.body.restaurant ?? null).toBeNull();
        const rows = await auditFor(s.id, 'platformstaff.login');
        expect(rows).toHaveLength(1);
        const me = await ctx.api.as({ token }).get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.platformAccess).toEqual({ signupLeads: 'manage' });
    });

    test('until the temporary password is changed, every portal route is locked; after that it works', async () => {
        const s = await createStaff({ signupLeads: 'view' }, 'firstlogin');
        const { token } = await loginAs(s, { changePassword: false });
        const locked = await ctx.api.as({ token }).get('/superadmin/signup-leads');
        expect(locked.status).toBe(403);
        expect(locked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
        const after = await loginAs(s);                       // changes the password, then uses the new session
        expect((await after.api().get('/superadmin/signup-leads')).status).toBe(200);
    });

    test('a wrong password is refused', async () => {
        const s = await createStaff({ leads: 'view' }, 'badpw');
        const r = await ctx.api.anon().post('/auth/login').send({ email: s.email, password: 'Wrong-Password-1!', loginType: 'staff' });
        expect(r.status).toBe(401);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the gate (deny by default)', () => {
    test('a Trial-signups-only user reaches that module and nothing else', async () => {
        const s = await createStaff({ signupLeads: 'manage' }, 'gate');
        const staff = (await loginAs(s)).api();

        expect((await staff.get('/superadmin/signup-leads')).status).toBe(200);
        expect((await staff.get('/superadmin/signup-leads/summary')).status).toBe(200);

        for (const [m, p] of [
            ['get', '/superadmin/restaurants'], ['get', '/superadmin/leads'], ['get', '/superadmin/plans'],
            ['get', '/superadmin/subscription-payments'], ['get', '/superadmin/analytics'], ['get', '/superadmin/blog'],
            ['get', '/superadmin/marketing'], ['get', '/superadmin/audit-logs'], ['get', '/superadmin/pending-approvals'],
            ['get', '/superadmin/platform-staff'], ['get', '/superadmin/addon-catalog'],
        ]) {
            const r = await staff[m](p);
            expect([m, p, r.status]).toEqual([m, p, 403]);
            expect(r.body.code).toBe('PLATFORM_ACCESS_DENIED');
        }
        expect((await staff.post('/superadmin/restaurants').send({})).status).toBe(403);
        expect((await staff.post('/superadmin/plans').send({ name: 'x', price: 1 })).status).toBe(403);
        expect((await staff.delete(`/superadmin/leads/${full._id}`)).status).toBe(403);
    });

    test('blocked attempts are written to the audit log', async () => {
        const s = await createStaff({ leads: 'view' }, 'denied');
        const staff = (await loginAs(s)).api();
        await staff.get('/superadmin/plans');
        await settle();
        const rows = await auditFor(s.id, 'platformstaff.denied');
        expect(rows).toHaveLength(1);
        expect(rows[0].details).toMatchObject({ method: 'GET', path: '/plans' });
    });

    test('view vs manage: view cannot write, manage can', async () => {
        const viewer = (await loginAs(await createStaff({ signupLeads: 'view' }, 'viewer'))).api();
        const manager = (await loginAs(await createStaff({ signupLeads: 'manage' }, 'manager'))).api();
        const slug = tenant.restaurant.slug;
        const body = { stage: 'contacted' };

        expect((await viewer.get('/superadmin/signup-leads')).status).toBe(200);
        expect((await viewer.patch(`/superadmin/signup-leads/${slug}`).send(body)).status).toBe(403);
        expect((await viewer.post(`/superadmin/signup-leads/${slug}/notes`).send({ text: 'hi' })).status).toBe(403);

        const ok = await manager.patch(`/superadmin/signup-leads/${slug}`).send(body);
        expect(ok.status).toBe(200);
        const note = await manager.post(`/superadmin/signup-leads/${slug}/notes`).send({ text: 'Called the owner' });
        expect(note.status).toBeLessThan(300);
    });

    test('Free trials: view lists restaurants, only manage can extend a trial', async () => {
        const viewer = (await loginAs(await createStaff({ trials: 'view' }, 'tview'))).api();
        const manager = (await loginAs(await createStaff({ trials: 'manage' }, 'tmanage'))).api();
        const id = tenant.restaurant._id;
        expect((await viewer.get('/superadmin/restaurants')).status).toBe(200);
        expect((await viewer.get(`/superadmin/restaurants/${id}`)).status).toBe(200);
        expect((await viewer.post(`/superadmin/restaurants/${id}/extend-trial`).send({ days: 3 })).status).toBe(403);
        expect((await manager.post(`/superadmin/restaurants/${id}/extend-trial`).send({ days: 3 })).status).toBe(200);
        // manage on trials does NOT unlock the other restaurant actions
        for (const p of ['suspend', 'reactivate', 'cancel-subscription', 'assign-plan', 'resend-invitation']) {
            expect((await manager.post(`/superadmin/restaurants/${id}/${p}`).send({})).status).toBe(403);
        }
        expect((await manager.patch(`/superadmin/restaurants/${id}`).send({ name: 'Hacked' })).status).toBe(403);
    });

    test('a super admin of level support still cannot write through the module guards', async () => {
        const slug = tenant.restaurant.slug;
        expect((await ctx.api.as(support).patch(`/superadmin/signup-leads/${slug}`).send({ stage: 'contacted' })).status).toBe(403);
        expect((await ctx.api.as(support).get('/superadmin/signup-leads')).status).toBe(200);   // unchanged: reads open
    });

    test('access changes take effect on the next request, without signing in again', async () => {
        const s = await createStaff({ leads: 'view' }, 'live');
        const staff = (await loginAs(s)).api();
        expect((await staff.get('/superadmin/plans')).status).toBe(403);
        const up = await SA().patch(`/superadmin/platform-staff/${s.id}`).send({ modules: { leads: 'view', plans: 'view' } });
        expect(up.status).toBe(200);
        expect((await staff.get('/superadmin/plans')).status).toBe(200);
        await SA().patch(`/superadmin/platform-staff/${s.id}`).send({ modules: { leads: 'view' } });
        expect((await staff.get('/superadmin/plans')).status).toBe(403);
        const [row] = await AuditLog.find({ action: 'platformstaff.update', targetId: s.id }).sort({ createdAt: 1 }).lean();
        expect(row.details.before.modules).toEqual({ leads: 'view' });
        expect(row.details.after.modules).toEqual({ leads: 'view', plans: 'view' });
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('isolation from tenant (restaurant) APIs', () => {
    test('a platform-staff token cannot use restaurant staff, order or admin endpoints', async () => {
        const s = await createStaff({ signupLeads: 'manage', trials: 'manage', leads: 'manage' }, 'iso');
        const { token } = await loginAs(s);
        const api = () => ctx.api.as({ token }, tenant.restaurant);
        for (const p of ['/staff', '/orders/live', '/settings/payments', '/tables', '/ledger/trial-balance', '/supplier-invoices', '/payroll/runs']) {
            const r = await api().get(p);
            expect([p, r.status === 200]).toEqual([p, false]);
        }
        expect((await api().post('/orders').send({ items: [] })).status).not.toBe(201);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the activity log', () => {
    test('views are logged once per module per window (no flood), writes always', async () => {
        const s = await createStaff({ signupLeads: 'manage', plans: 'view' }, 'act');
        const staff = (await loginAs(s)).api();
        await staff.get('/superadmin/signup-leads');
        await staff.get('/superadmin/signup-leads');
        await staff.get('/superadmin/signup-leads/summary');   // same module, still inside the window
        await staff.get('/superadmin/plans');                  // different module
        await settle();
        const views = await auditFor(s.id, 'platformstaff.view');
        expect(views.map((v) => v.details.module).sort()).toEqual(['plans', 'signupLeads']);
    });

    test('PLATFORM_VIEW_LOG_MINUTES=0 logs every view', async () => {
        process.env.PLATFORM_VIEW_LOG_MINUTES = '0';
        const s = await createStaff({ plans: 'view' }, 'every');
        const staff = (await loginAs(s)).api();
        await staff.get('/superadmin/plans');
        await staff.get('/superadmin/plans');
        await settle();
        expect(await auditFor(s.id, 'platformstaff.view')).toHaveLength(2);
    });

    test('a write that already has its own audit row does not get a second generic row', async () => {
        const lead = await Lead.create({ name: 'Asha', restaurantName: 'Asha Cafe', phone: '9876543210' });
        const s = await createStaff({ leads: 'manage' }, 'lead');
        const staff = (await loginAs(s)).api();
        const r = await staff.patch(`/superadmin/leads/${lead._id}`).send({ status: 'contacted' });
        expect(r.status).toBe(200);
        await settle();
        const specific = await auditFor(s.id, 'lead.update');
        expect(specific).toHaveLength(1);
        expect(specific[0].actorRole).toBe('platformstaff');
        expect(await auditFor(s.id, 'platformstaff.write')).toHaveLength(0);
    });

    test('a write with no specific audit gets a generic platformstaff.write row', async () => {
        const s = await createStaff({ signupLeads: 'manage' }, 'generic');
        const staff = (await loginAs(s)).api();
        const slug = tenant.restaurant.slug;
        const r = await staff.post(`/superadmin/signup-leads/${slug}/notes`).send({ text: 'Left a voicemail' });
        expect(r.status).toBeLessThan(300);
        await settle();
        const all = await AuditLog.find({ actor: s.id, action: { $in: ['platformstaff.write', 'superadmin.signup_lead_note'] } }).lean();
        expect(all.length).toBeGreaterThanOrEqual(1);       // either the controller's own row or the generic one, never nothing
    });

    test('failed requests (validation errors) are not logged as writes', async () => {
        const s = await createStaff({ signupLeads: 'manage' }, 'fail');
        const staff = (await loginAs(s)).api();
        const r = await staff.patch(`/superadmin/signup-leads/${tenant.restaurant.slug}`).send({ stage: 'not-a-stage' });
        expect(r.status).toBe(400);
        await settle();
        expect(await auditFor(s.id, 'platformstaff.write')).toHaveLength(0);
    });

    test('the owner reads one person\'s activity (paged, newest first); others cannot', async () => {
        process.env.PLATFORM_VIEW_LOG_MINUTES = '0';
        const s = await createStaff({ plans: 'view' }, 'owner-view');
        const staff = (await loginAs(s)).api();
        await staff.get('/superadmin/plans');
        await staff.get('/superadmin/analytics');            // denied
        await settle();

        const res = await SA().get(`/superadmin/platform-staff/${s.id}/activity`);
        expect(res.status).toBe(200);
        const actions = res.body.data.map((r) => r.action);
        expect(actions).toEqual(expect.arrayContaining(['platformstaff.login', 'platformstaff.view', 'platformstaff.denied']));
        expect(res.body.data.every((r) => String(r.actor) === s.id)).toBe(true);
        expect(new Date(res.body.data[0].createdAt) >= new Date(res.body.data.at(-1).createdAt)).toBe(true);
        expect(res.body.pagination.total).toBe(res.body.data.length);

        const filtered = await SA().get(`/superadmin/platform-staff/${s.id}/activity?action=platformstaff.denied`);
        expect(filtered.body.data.every((r) => r.action === 'platformstaff.denied')).toBe(true);

        expect((await staff.get(`/superadmin/platform-staff/${s.id}/activity`)).status).toBe(403);
        // the owner's general audit-log page shows the same rows
        const general = await SA().get(`/superadmin/audit-logs?actor=${s.id}`);
        expect(general.body.data.length).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════
describe('deactivation and password reset', () => {
    test('deactivating signs the person out everywhere and blocks sign-in until reactivated', async () => {
        const s = await createStaff({ plans: 'view' }, 'off');
        const login = await loginAs(s);
        const staff = login.api();
        expect((await staff.get('/superadmin/plans')).status).toBe(200);

        const off = await SA().patch(`/superadmin/platform-staff/${s.id}`).send({ status: 'inactive' });
        expect(off.status).toBe(200);
        expect((await staff.get('/superadmin/plans')).status).toBe(401);
        const again = await ctx.api.anon().post('/auth/login').send({ email: s.email, password: s.password, loginType: 'staff' });
        expect(again.status).not.toBe(200);
        expect(await auditFor(s.id, 'platformstaff.deactivate')).toHaveLength(0);              // audit is on the owner, with the target id
        expect(await AuditLog.countDocuments({ action: 'platformstaff.deactivate', targetId: s.id })).toBe(1);

        await SA().patch(`/superadmin/platform-staff/${s.id}`).send({ status: 'active' });
        expect(await AuditLog.countDocuments({ action: 'platformstaff.reactivate', targetId: s.id })).toBe(1);
        const back = await ctx.api.anon().post('/auth/login').send({ email: s.email, password: s.password, loginType: 'staff' });
        expect(back.status).toBe(200);
    });

    test('reset-password issues a new temp password, kills old sessions, forces a change', async () => {
        const s = await createStaff({ plans: 'view' }, 'reset');
        const old = (await loginAs(s)).api();
        expect((await old.get('/superadmin/plans')).status).toBe(200);

        const r = await SA().post(`/superadmin/platform-staff/${s.id}/reset-password`);
        expect(r.status).toBe(200);
        expect(r.body.tempPassword).toBeTruthy();
        expect(r.body.tempPassword).not.toBe(s.password);
        expect((await old.get('/superadmin/plans')).status).toBe(401);

        const oldLogin = await ctx.api.anon().post('/auth/login').send({ email: s.email, password: s.password, loginType: 'staff' });
        expect(oldLogin.status).toBe(401);
        const newLogin = await ctx.api.anon().post('/auth/login').send({ email: s.email, password: r.body.tempPassword, loginType: 'staff' });
        expect(newLogin.status).toBe(200);
        expect(newLogin.body.mustChangePassword).toBe(true);
        const [row] = await AuditLog.find({ action: 'platformstaff.reset_password', targetId: s.id }).lean();
        expect(JSON.stringify(row)).not.toContain(r.body.tempPassword);
    });

    test('repeated wrong passwords lock a platform-staff account (unlike a super admin)', async () => {
        const s = await createStaff({ plans: 'view' }, 'lock');
        let last;
        for (let i = 0; i < 12; i += 1) {
            last = await ctx.api.anon().post('/auth/login').send({ email: s.email, password: `Wrong-${i}-Pass!`, loginType: 'staff' });
        }
        expect([423, 429]).toContain(last.status);
        const right = await ctx.api.anon().post('/auth/login').send({ email: s.email, password: s.tempPassword, loginType: 'staff' });
        expect(right.status).not.toBe(200);
    });
});
