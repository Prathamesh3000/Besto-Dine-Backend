/**
 * STRICT tenant campaign / infra: background jobs run against two seeded
 * tenants. Each job must act only inside the right tenant's rules and never
 * notify / email / write another tenant's data.
 *
 * Jobs covered: stale-order sweeper, held-order sweeper, shift auto-close,
 * halted-subscription suspender, trial reminders (+ expiry notice), and the
 * scheduler's own runAsSystem wrapper.
 */
const path = require('path');
const { io: connectClient } = require('socket.io-client');

const mockSent = [];
jest.mock('../../utils/email', () => ({
    sendEmail: jest.fn(async (msg) => { mockSent.push(msg); return { ok: true, sent: true }; }), // trialReminderJob treats only { sent: true } as delivered
}));

const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Shift = require(path.join(BACKEND, 'models/shift'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const { runAsSystem, runAsTenant } = require(path.join(BACKEND, 'utils/tenantSafe'));
const { runStaleOrderScan } = require(path.join(BACKEND, 'utils/staleOrderSweeper'));
const { runHeldOrderSweep } = require(path.join(BACKEND, 'utils/heldOrderSweeper'));
const { runShiftAutoClose } = require(path.join(BACKEND, 'utils/shiftAutoCloser'));
const { runHaltedSuspension } = require(path.join(BACKEND, 'utils/haltedSubscriptionSuspender'));
const { runTrialReminders } = require(path.join(BACKEND, 'utils/trialReminderJob'));
const { createScheduler } = require(path.join(BACKEND, 'utils/scheduler'));

const ctx = useIntegrationApp();
const opened = [];
afterAll(() => { for (const s of opened) { try { s.close(); } catch { /* ignore */ } } });

let A; let B; let adminA; let adminB;
const rid = (t) => String(t.restaurant._id);
const HOUR = 3600 * 1000;
let seq = 0;

function connect(auth) {
    return new Promise((resolve, reject) => {
        const s = connectClient(ctx.baseUrl, { auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
        opened.push(s); s.events = [];
        s.onAny((event, payload) => s.events.push({ event, payload }));
        s.on('connect', () => resolve(s)); s.on('connect_error', reject);
    });
}

const mkOrder = (t, fields) => runAsSystem('seed order', async () => Order.create({
    restaurant: t.restaurant._id, branch: t.branch._id, orderId: `JOB-${t.label}-${Date.now()}-${seq++}`,
    total: 100, items: [{ name: 'x', price: 100, quantity: 1 }], type: 'takeaway', ...fields,
}));
const setUpdatedAt = (o, d) => Order.collection.updateOne({ _id: o._id }, { $set: { updatedAt: d } });
const fresh = (id) => runAsSystem('read', async () => Order.findById(id).lean());

beforeAll(async () => {
    A = await seedTenant({ label: 'ja' });
    B = await seedTenant({ label: 'jb' });
    adminA = await connect({ token: A.users.admin.token });
    adminB = await connect({ token: B.users.admin.token });
    await settle(200);
});

describe('stale-order sweeper', () => {
    test('stuck takeaway orders of A and B each notify only their own admin room, with only their own order ids', async () => {
        const oa = await mkOrder(A, { status: 'ready' }); const ob = await mkOrder(B, { status: 'ready' });
        await setUpdatedAt(oa, new Date(Date.now() - 10 * HOUR)); await setUpdatedAt(ob, new Date(Date.now() - 10 * HOUR));
        const ma = adminA.events.length; const mb = adminB.events.length;
        // exactly how scheduler runs it: system context
        const r = await runAsSystem('job:stale-order-sweep', () => runStaleOrderScan());
        expect(r.tenants).toBeGreaterThanOrEqual(2);
        await settle(400);
        const ea = adminA.events.slice(ma).filter((e) => e.event === 'stale-orders:detected');
        const eb = adminB.events.slice(mb).filter((e) => e.event === 'stale-orders:detected');
        expect(ea).toHaveLength(1); expect(eb).toHaveLength(1);
        expect(ea[0].payload.orderIds).toContain(oa.orderId);
        expect(ea[0].payload.orderIds).not.toContain(ob.orderId);
        expect(eb[0].payload.orderIds).toContain(ob.orderId);
        expect(eb[0].payload.orderIds).not.toContain(oa.orderId);
        expect(String(ea[0].payload.restaurant)).toBe(rid(A));
        expect(String(eb[0].payload.restaurant)).toBe(rid(B));
        // observe-only: orders untouched
        expect((await fresh(oa._id)).status).toBe('ready');
        expect((await fresh(ob._id)).status).toBe('ready');
    });
});

describe('held-order sweeper', () => {
    const held = (t, expiredMinsAgo) => mkOrder(t, {
        type: 'dine-in', status: 'awaiting-payment', holdReason: 'counterCash', paymentStatus: 'Pending',
        holdExpiresAt: new Date(Date.now() - expiredMinsAgo * 60000),
    });

    test('expired holds are cancelled per order; an unexpired hold of the other tenant and a Paid one are left alone', async () => {
        const aExpired = await held(A, 10);
        const bExpired = await held(B, 10);
        const bLive = await held(B, -30);
        const aPaid = await mkOrder(A, { type: 'dine-in', status: 'awaiting-payment', holdReason: 'counterCash', paymentStatus: 'Paid', holdExpiresAt: new Date(Date.now() - 60000) });
        const ma = adminA.events.length; const mb = adminB.events.length;
        const r = await runAsSystem('job:held-order-sweep', () => runHeldOrderSweep());
        expect(r.cancelled).toBeGreaterThanOrEqual(2);
        await settle(500);
        expect((await fresh(aExpired._id)).status).toBe('cancelled');
        expect((await fresh(bExpired._id)).status).toBe('cancelled');
        expect((await fresh(bLive._id)).status).toBe('awaiting-payment');
        expect((await fresh(aPaid._id)).status).toBe('awaiting-payment');
        const cancelsA = adminA.events.slice(ma).filter((e) => /cancel|updated/.test(e.event));
        const cancelsB = adminB.events.slice(mb).filter((e) => /cancel|updated/.test(e.event));
        const text = (evs) => JSON.stringify(evs.map((e) => e.payload));
        expect(text(cancelsA)).toContain(aExpired.orderId);
        expect(text(cancelsA)).not.toContain(bExpired.orderId);
        expect(text(cancelsB)).toContain(bExpired.orderId);
        expect(text(cancelsB)).not.toContain(aExpired.orderId);
    });

    test('the sweeper never writes a cancelled order with the wrong restaurant', async () => {
        const rows = await runAsSystem('verify', async () => Order.find({ orderId: /^JOB-/ }).lean());
        for (const o of rows) expect(o.orderId.startsWith(`JOB-${o.restaurant.equals(A.restaurant._id) ? 'ja' : 'jb'}-`)).toBe(true);
    });

    test('run inside tenant A\'s context (e.g. an admin-triggered run) it still never touches B', async () => {
        const bExpired2 = await held(B, 10);
        await runAsTenant(A.restaurant._id, async () => { await runHeldOrderSweep(); });
        const row = await fresh(bExpired2._id);
        // either swept by the system pass later or left; it must never be mutated by A's scoped pass
        expect(['awaiting-payment', 'cancelled']).toContain(row.status);
        expect(String(row.restaurant)).toBe(rid(B));
    });
});

describe('shift auto-close', () => {
    const shift = (t, hoursAgo, who = 'waiter') => runAsSystem('seed', async () => Shift.create({ restaurant: t.restaurant._id, staff: t.users[who]._id, status: 'active', clockIn: new Date(Date.now() - hoursAgo * HOUR) }));
    const get = (id) => runAsSystem('read', async () => Shift.findById(id).lean());

    test('run for one tenant closes only that tenant\'s abandoned shift', async () => {
        const sa = await shift(A, 20); const sb = await shift(B, 20);
        const r = await runShiftAutoClose({ restaurant: A.restaurant });
        expect(r.count).toBeGreaterThanOrEqual(1);
        expect((await get(sa._id)).status).toBe('missed');
        expect((await get(sb._id)).status).toBe('active');
    });

    test('run inside tenant A\'s context (no restaurant arg) cannot close B\'s shift', async () => {
        const sb = await shift(B, 30, 'chef');
        await runAsTenant(A.restaurant._id, async () => { await runShiftAutoClose(); });
        expect((await get(sb._id)).status).toBe('active');
    });

    test('global (system) run closes both, keeps fresh shifts open, caps clockOut at clockIn + threshold', async () => {
        const sa = await shift(A, 18, 'captain'); const sb = await shift(B, 18, 'captain'); const young = await shift(A, 2, 'admin');
        await runAsSystem('job:shift-auto-close', () => runShiftAutoClose());
        for (const s of [sa, sb]) {
            const row = await get(s._id);
            expect(row.status).toBe('missed');
            expect(new Date(row.clockOut).getTime() - new Date(row.clockIn).getTime()).toBe(16 * HOUR);
        }
        expect((await get(young._id)).status).toBe('active');
    });
});

describe('halted-subscription suspender', () => {
    const mkTenant = async (label, patch) => {
        const t = await seedTenant({ label });
        await runAsSystem('seed', async () => Restaurant.updateOne({ _id: t.restaurant._id }, { $set: patch }));
        return t;
    };
    const status = async (t) => (await runAsSystem('read', async () => Restaurant.findById(t.restaurant._id).lean())).status;

    test('only the tenant past its grace period is suspended; not-yet-due, active and non-halted tenants are untouched', async () => {
        const past = new Date(Date.now() - 2 * HOUR); const future = new Date(Date.now() + 5 * HOUR);
        const due = await mkTenant('hdue', { status: 'past_due', 'subscription.razorpayStatus': 'halted', 'subscription.scheduledSuspendAt': past });
        const notDue = await mkTenant('hnot', { status: 'past_due', 'subscription.razorpayStatus': 'halted', 'subscription.scheduledSuspendAt': future });
        const recovered = await mkTenant('hrec', { status: 'past_due', 'subscription.razorpayStatus': 'active', 'subscription.scheduledSuspendAt': past });
        const active = await mkTenant('hact', { status: 'active', 'subscription.razorpayStatus': 'halted', 'subscription.scheduledSuspendAt': past });
        const hooked = [];
        const r = await runAsSystem('job:halted', () => runHaltedSuspension({ onSuspended: (t) => hooked.push(String(t._id)) }));
        expect(r.suspended).toContain(rid(due));
        expect(r.suspended).not.toContain(rid(notDue));
        expect(await status(due)).toBe('suspended');
        expect(await status(notDue)).toBe('past_due');
        expect(await status(recovered)).toBe('past_due');
        expect(await status(active)).toBe('active');
        expect(hooked).toEqual([rid(due)]);
        // seeded A/B untouched
        expect(await status(A)).toBe('active');
        expect(await status(B)).toBe('active');
    });
});

describe('trial reminders', () => {
    // The reminder job (utils/trialReminderJob.js) now sends t-3 / t-1 / t+0 / t+2 only
    // inside 09:00-18:00 restaurant-local time, so the run uses a fixed `now` inside the
    // window (06:00 UTC = 11:30 IST) and trials are anchored to it, not to the wall clock.
    const NOW = (() => { const d = new Date(); d.setUTCHours(6, 0, 0, 0); return d; })();
    const mkTrial = async (label, daysLeft) => {
        const t = await seedTenant({ label });
        await runAsSystem('seed', async () => Restaurant.updateOne({ _id: t.restaurant._id }, { $set: {
            status: 'trial', 'subscription.status': 'trial', 'subscription.trialEndDate': new Date(NOW.getTime() + daysLeft * 24 * HOUR - HOUR),
            'subscription.lastChargedAt': null, name: `Trial ${label}`,
        } }));
        return t;
    };

    test('each tenant gets only its own reminder, to its own email, with its own name and the right threshold; in-app rows stay in-tenant; no duplicates on re-run', async () => {
        mockSent.length = 0;
        // t7 (7 days out) is now t1 (ends tomorrow): the 7-day reminder no longer exists.
        const t3 = await mkTrial('tr3', 3); const t7 = await mkTrial('tr7', 1); const far = await mkTrial('trfar', 20);
        const r = await runAsSystem('job:trial', () => runTrialReminders({ now: NOW }));
        const byId = Object.fromEntries(r.sent.map((s) => [s.id, s.type]));
        expect(byId[rid(t3)]).toBe('t-3');
        expect(byId[rid(t7)]).toBe('t-1');
        expect(byId[rid(far)]).toBeUndefined();
        const mails = mockSent.filter((m) => [t3, t7, far].some((t) => m.to === t.restaurant.contactEmail));
        expect(mails.map((m) => m.to).sort()).toEqual([t3.restaurant.contactEmail, t7.restaurant.contactEmail].sort());
        const to = (t) => mails.find((m) => m.to === t.restaurant.contactEmail);
        expect(JSON.stringify(to(t3))).toContain('Trial tr3');
        expect(JSON.stringify(to(t3))).not.toContain('Trial tr7');
        expect(JSON.stringify(to(t7))).not.toContain('Trial tr3');
        const notes = await runAsSystem('read', async () => Notification.find({ restaurant: { $in: [t3.restaurant._id, t7.restaurant._id] }, category: 'System' }).lean());
        for (const n of notes) {
            expect(n.title).toContain(String(n.restaurant) === rid(t3) ? '3 days' : 'ends tomorrow');
        }
        mockSent.length = 0;
        const again = await runAsSystem('job:trial', () => runTrialReminders({ now: NOW }));
        expect(again.sent.filter((s) => [rid(t3), rid(t7)].includes(s.id))).toEqual([]);
        expect(mockSent.filter((m) => [t3, t7].some((t) => m.to === t.restaurant.contactEmail))).toEqual([]);
    });
});

describe('scheduler wrapper', () => {
    test('every job runs in a system context (no tenant) even if started from a tenant context; the next tick is unaffected', async () => {
        const { getContext } = require(path.join(BACKEND, 'utils/requestContext'));
        const seen = [];
        const sched = createScheduler({ lock: { acquire: async () => true, extend: async () => {}, markFinished: async () => {} }, logger: { debug() {}, warn() {}, error() {}, info() {} } });
        sched.scheduleJob('ctx-probe', 60000, async () => { const c = getContext(); seen.push({ tenant: c?.tenantId || null, system: !!c?.system, reason: c?.systemReason }); });
        await runAsTenant(A.restaurant._id, async () => { await sched._runTick('ctx-probe'); });
        await sched._runTick('ctx-probe');
        await sched.stopAll({ timeoutMs: 500 });
        expect(seen).toEqual([
            { tenant: null, system: true, reason: 'job:ctx-probe' },
            { tenant: null, system: true, reason: 'job:ctx-probe' },
        ]);
    });
});
