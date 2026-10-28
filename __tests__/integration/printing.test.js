/**
 * Thermal printing (Phase 1): Settings → Printers, agent pairing over
 * socket.io, KOT jobs on order create / append, bill on demand, test
 * page, acknowledgement, offline queueing and tenant isolation.
 *
 * The "print agent" here is a plain socket.io-client authenticated with
 * the branch's agent token — exactly what print-agent/agent.js does.
 */
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Settings = require(path.join(BACKEND, 'models/settings'));
const PrintJob = require(path.join(BACKEND, 'models/printJob'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const { toPlainText } = require(path.join(BACKEND, 'utils/receiptRenderer'));

const ctx = useIntegrationApp();
let A;
let B;
let coldCoffee; // bar item on tenant A
const sockets = [];

beforeAll(async () => {
    A = await seedTenant({ label: 'pr-a' });
    B = await seedTenant({ label: 'pr-b' });
    coldCoffee = await MenuItem.create({
        restaurant: A.restaurant._id, category: A.category._id, name: 'Cold Coffee',
        basePrice: 120, prepStation: 'bar', vegType: 'veg', description: 'bar item',
    });
});

afterAll(() => {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
});

const patch = (user, section, body, t) => ctx.api.as(user, t).patch(`/settings/${section}`).send(body);
const tenantDoc = (t) => Settings.findOne({ restaurant: t.restaurant._id, branch: null }).lean();

const PRINTERS = () => ({
    enabled: true,
    autoPrint: { kotOnCreate: true, kotOnAppend: true, billOnPaid: false },
    list: [
        { name: 'Kitchen', station: 'kitchen', interface: 'lan', host: '127.0.0.1', port: 9100, paperWidth: '80' },
        { name: 'Bar', station: 'bar', interface: 'lan', host: '127.0.0.1', port: 9101, paperWidth: '58' },
        { name: 'Counter', station: 'counter', interface: 'lan', host: '127.0.0.1', port: 9102 },
    ],
});

/** Connect a socket; resolves on connect, rejects with the connect_error. */
function connect(auth) {
    return new Promise((resolve, reject) => {
        const socket = connectClient(ctx.baseUrl, {
            auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (err) => reject(err));
    });
}
function recorder(socket) {
    const events = [];
    socket.onAny((event, payload) => events.push({ event, payload }));
    return events;
}
const waitFor = (events, predicate, ms = 4000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
        const hit = events.find(predicate);
        if (hit) return resolve(hit);
        if (Date.now() - started > ms) return reject(new Error('event not received in time'));
        return setTimeout(tick, 25);
    };
    tick();
});
const emitAck = (socket, event, payload) => new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
});
const waitDisconnect = (socket, ms = 4000) => new Promise((resolve, reject) => {
    if (socket.disconnected) return resolve();
    const t = setTimeout(() => reject(new Error('socket did not disconnect')), ms);
    socket.on('disconnect', () => { clearTimeout(t); resolve(); });
});

async function placeDineIn(t, items, total = 2000) {
    const table = await createTable(t, { capacity: 4 });
    const { scanToken } = await scanTable(ctx.api, table);
    const res = await ctx.api.guest(t, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(table._id), items, total,
    });
    expect(res.status).toBe(201);
    await settle(300);
    return { order: res.body.order, table, scanToken };
}
const paneerLine = (t, quantity = 2) => ({ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity });
const coffeeLine = (quantity = 1) => ({ menuItem: String(coldCoffee._id), name: 'Cold Coffee', quantity });

async function pairAgent(t) {
    const res = await ctx.api.as(t.users.admin, t).post('/print/agent-key');
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    const socket = await connect({ agentToken: res.body.token });
    return { socket, token: res.body.token, events: recorder(socket), branch: res.body.branch };
}

// ═══════════════════════ settings ════════════════════════════════════

describe('PATCH /settings/printers', () => {
    test('saves printers with generated ids and the agent block untouched', async () => {
        const res = await patch(A.users.admin, 'printers', PRINTERS());
        expect(res.status).toBe(200);
        const doc = await tenantDoc(A);
        expect(doc.printers.enabled).toBe(true);
        expect(doc.printers.list).toHaveLength(3);
        for (const p of doc.printers.list) expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(doc.printers.list.map((p) => p.station)).toEqual(['kitchen', 'bar', 'counter']);
        expect(doc.printers.agent.keyVersion).toBe(0);
    });

    test('a later save keeps printer ids and never resets the agent key version', async () => {
        await ctx.api.as(A.users.admin, A).post('/print/agent-key').expect(200);
        const before = await tenantDoc(A);
        expect(before.printers.agent.keyVersion).toBe(1);
        const list = before.printers.list.map((p) => ({ ...p, name: `${p.name} 2` }));
        const res = await patch(A.users.admin, 'printers', { ...PRINTERS(), list, agent: { keyVersion: 0, agentId: 'spoof' } });
        expect(res.status).toBe(200);
        const after = await tenantDoc(A);
        expect(after.printers.agent.keyVersion).toBe(1);
        expect(after.printers.agent.agentId).toBe(before.printers.agent.agentId);
        expect(after.printers.list.map((p) => p.id)).toEqual(before.printers.list.map((p) => p.id));
        expect(after.printers.list[0].name).toBe('Kitchen 2');
        // restore names for the rest of the suite
        await patch(A.users.admin, 'printers', { ...PRINTERS(), list: before.printers.list });
    });

    test.each([
        ['unknown station', { list: [{ name: 'X', station: 'oven', host: '1.2.3.4' }] }, 'Station must be kitchen, bar or counter'],
        ['LAN without host', { list: [{ name: 'X', station: 'kitchen', interface: 'lan' }] }, 'LAN printers need a host (IP address or hostname)'],
        ['bad port', { list: [{ name: 'X', station: 'kitchen', host: '1.2.3.4', port: 70000 }] }, 'Port must be between 1 and 65535'],
        ['bad paper width', { list: [{ name: 'X', station: 'kitchen', host: '1.2.3.4', paperWidth: '76' }] }, 'Paper width must be 58 or 80'],
        ['empty name', { list: [{ name: '  ', station: 'kitchen', host: '1.2.3.4' }] }, 'Printer name must be 1-40 characters'],
        ['too many printers', { list: Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, station: 'kitchen', host: '1.2.3.4' })) }, 'At most 10 printers are allowed'],
    ])('%s → 400', async (_l, body, message) => {
        const res = await patch(A.users.admin, 'printers', { enabled: true, ...body });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
    });

    test('waiters cannot edit printers; guests see no printers section', async () => {
        expect((await patch(A.users.waiter, 'printers', PRINTERS(), A)).status).toBe(403);
        const pub = await ctx.api.guest(A).get('/settings');
        expect(pub.status).toBe(200);
        expect(pub.body.printers).toBeUndefined();
    });
});

// ═══════════════════════ agent pairing ═══════════════════════════════

describe('agent pairing', () => {
    test('a fresh key connects, shows online, and a tampered / stale token is refused', async () => {
        const { socket, token, branch } = await pairAgent(A);
        expect(socket.connected).toBe(true);
        expect(branch).toBe(String(A.branch._id));

        const status = await ctx.api.as(A.users.admin, A).get('/print/agent-status');
        expect(status.status).toBe(200);
        expect(status.body.online).toBe(true);
        expect(status.body.count).toBe(1);

        await expect(connect({ agentToken: `${token}x` })).rejects.toMatchObject({ message: 'AGENT_REVOKED' });
        await expect(connect({ agentToken: A.users.waiter.token })).rejects.toMatchObject({ message: 'AGENT_REVOKED' });

        // Issuing a new key invalidates the old one.
        const again = await ctx.api.as(A.users.admin, A).post('/print/agent-key');
        expect(again.body.token).not.toBe(token);
        await expect(connect({ agentToken: token })).rejects.toMatchObject({ message: 'AGENT_REVOKED' });
        socket.close();
    });

    test('revoking drops the connected agent and the status flips offline', async () => {
        const { socket } = await pairAgent(A);
        const res = await ctx.api.as(A.users.admin, A).delete('/print/agent-key');
        expect(res.status).toBe(200);
        await waitDisconnect(socket);
        const status = await ctx.api.as(A.users.admin, A).get('/print/agent-status');
        expect(status.body.online).toBe(false);
    });

    test('an agent token presented as a user token gets a guest socket and no jobs', async () => {
        const { socket, token } = await pairAgent(A);
        socket.close();
        const guest = await connect({ token });
        expect(guest.connected).toBe(true);
        const events = recorder(guest);
        await placeDineIn(A, [paneerLine(A)]);
        await settle(300);
        expect(events.find((e) => e.event === 'print:job')).toBeUndefined();
        guest.close();
        await settle(200);
    });
});

// ═══════════════════════ jobs ════════════════════════════════════════

describe('KOT jobs', () => {
    let agent;
    beforeAll(async () => { agent = await pairAgent(A); });
    afterAll(async () => { agent.socket.close(); await settle(300); });

    test('a dine-in order with kitchen + bar items yields one KOT per station, pushed to the agent and marked sent', async () => {
        const { order } = await placeDineIn(A, [paneerLine(A), coffeeLine()]);
        const kitchen = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId && e.payload.station === 'kitchen');
        const bar = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId && e.payload.station === 'bar');

        expect(kitchen.payload.kind).toBe('kot');
        expect(kitchen.payload.reason).toBe('create');
        expect(kitchen.payload.printer.name).toBe('Kitchen');
        expect(kitchen.payload.printer.host).toBe('127.0.0.1');
        expect(kitchen.payload.document.width).toBe(48);
        const kText = toPlainText(kitchen.payload.document);
        expect(kText).toContain('*** KITCHEN KOT ***');
        expect(kText).toContain('2 x Paneer Tikka');
        expect(kText).not.toContain('Cold Coffee');

        expect(bar.payload.printer.name).toBe('Bar');
        expect(bar.payload.document.width).toBe(32);
        const bText = toPlainText(bar.payload.document);
        expect(bText).toContain('*** BAR KOT ***');
        expect(bText).toContain('1 x Cold Coffee');
        expect(bText).not.toContain('Paneer');

        const jobs = await PrintJob.find({ restaurant: A.restaurant._id, orderId: order.orderId }).lean();
        expect(jobs).toHaveLength(2);
        expect(jobs.every((j) => j.status === 'sent' && String(j.branch) === String(A.branch._id))).toBe(true);
    });

    test('appending items prints an ADDED ITEMS ticket with only the new lines', async () => {
        const { order } = await placeDineIn(A, [paneerLine(A, 1)]);
        await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId);
        const res = await ctx.api.as(A.users.waiter, A).post(`/orders/${order._id}/append`).send({
            items: [{ menuItem: String(A.items.naan._id), name: 'Garlic Naan', quantity: 3 }],
        });
        expect(res.status).toBe(200);
        const added = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId && e.payload.reason === 'append');
        const text = toPlainText(added.payload.document);
        expect(text).toContain('--- ADDED ITEMS ---');
        expect(text).toContain('3 x Garlic Naan');
        expect(text).not.toContain('Paneer Tikka');
    });

    test('reprint-kot also prints a REPRINT ticket regardless of auto-print toggles', async () => {
        await patch(A.users.admin, 'printers', { ...PRINTERS(), autoPrint: { kotOnCreate: false, kotOnAppend: false, billOnPaid: false } });
        const { order } = await placeDineIn(A, [paneerLine(A, 1)]);
        await settle(300);
        expect(await PrintJob.countDocuments({ restaurant: A.restaurant._id, orderId: order.orderId })).toBe(0);

        const res = await ctx.api.as(A.users.admin, A).post(`/orders/${order._id}/reprint-kot`);
        expect(res.status).toBe(200);
        const re = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId && e.payload.reason === 'reprint');
        expect(toPlainText(re.payload.document)).toContain('** REPRINT **');
        await patch(A.users.admin, 'printers', PRINTERS());
    });

    test('the agent acknowledges a job → done / failed with the error kept', async () => {
        const { order } = await placeDineIn(A, [paneerLine(A, 1)]);
        const job = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId);
        let ack = await emitAck(agent.socket, 'print:ack', { jobId: job.payload.jobId, status: 'done' });
        expect(ack).toEqual({ ok: true });
        let stored = await PrintJob.findById(job.payload.jobId).lean();
        expect(stored.status).toBe('done');
        expect(stored.attempts).toBe(1);
        expect(stored.ackedAt).toBeTruthy();

        ack = await emitAck(agent.socket, 'print:ack', { jobId: job.payload.jobId, status: 'failed', error: 'paper out' });
        expect(ack).toEqual({ ok: true });
        stored = await PrintJob.findById(job.payload.jobId).lean();
        expect(stored.status).toBe('failed');
        expect(stored.error).toBe('paper out');

        expect(await emitAck(agent.socket, 'print:ack', { jobId: 'nope', status: 'done' })).toMatchObject({ ok: false, code: 'BAD_JOB_ID' });
        expect(await emitAck(agent.socket, 'print:ack', { jobId: job.payload.jobId, status: 'weird' })).toMatchObject({ ok: false });
    });

    test('no job is created for a tenant without printers, and the order still succeeds', async () => {
        const { order } = await placeDineIn(B, [paneerLine(B)]);
        await settle(300);
        expect(await PrintJob.countDocuments({ restaurant: B.restaurant._id })).toBe(0);
        expect(order.orderId).toBeTruthy();
    });

    test('a missing station printer is skipped while the others still print', async () => {
        await patch(A.users.admin, 'printers', { ...PRINTERS(), list: PRINTERS().list.filter((p) => p.station !== 'bar') });
        const { order } = await placeDineIn(A, [paneerLine(A, 1), coffeeLine()]);
        await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId && e.payload.station === 'kitchen');
        await settle(300);
        const jobs = await PrintJob.find({ restaurant: A.restaurant._id, orderId: order.orderId }).lean();
        expect(jobs.map((j) => j.station)).toEqual(['kitchen']);
        await patch(A.users.admin, 'printers', PRINTERS());
    });
});

describe('offline queue', () => {
    test('jobs raised with no agent stay queued and are handed over on print:pending', async () => {
        // No agent for A right now (previous describe closed its socket).
        for (const s of sockets) { if (s.connected) s.close(); }
        await settle(400);
        const status = await ctx.api.as(A.users.admin, A).get('/print/agent-status');
        expect(status.body.online).toBe(false);

        const { order } = await placeDineIn(A, [paneerLine(A, 1)]);
        await settle(300);
        const queued = await PrintJob.find({ restaurant: A.restaurant._id, orderId: order.orderId }).lean();
        expect(queued).toHaveLength(1);
        expect(queued[0].status).toBe('queued');
        expect(queued[0].sentAt).toBeNull();

        const agent = await pairAgent(A);
        const res = await emitAck(agent.socket, 'print:pending');
        expect(res.ok).toBe(true);
        const mine = res.jobs.find((j) => j.jobId === String(queued[0]._id));
        expect(mine).toBeTruthy();
        expect(mine.document.lines.length).toBeGreaterThan(5);
        expect(res.jobs.every((j) => ['kot', 'bill', 'test'].includes(j.kind))).toBe(true);
        agent.socket.close();
    });
});

// ═══════════════════════ bill + test page ═══════════════════════════

describe('POST /print/orders/:id/bill and /print/test', () => {
    let agent;
    beforeAll(async () => { agent = await pairAgent(A); });
    afterAll(() => agent.socket.close());

    test('prints a GST bill on the counter printer for a captain', async () => {
        const { order } = await placeDineIn(A, [paneerLine(A), coffeeLine()]);
        const res = await ctx.api.as(A.users.captain, A).post(`/print/orders/${order._id}/bill`).send({});
        expect(res.status).toBe(202);
        expect(res.body.agentOnline).toBe(true);
        const bill = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.jobId === res.body.jobId);
        expect(bill.payload.kind).toBe('bill');
        expect(bill.payload.station).toBe('counter');
        expect(bill.payload.printer.name).toBe('Counter');
        const text = toPlainText(bill.payload.document);
        expect(text).toContain(`Bill ${order.orderId}`);
        expect(text).toContain('Paneer Tikka');
        expect(text).toContain('Cold Coffee');
        expect(text).toContain('Subtotal');
        expect(text).toContain('TOTAL');
        expect(bill.payload.document.lines.some((l) => l.drawer)).toBe(false);
    });

    test('openDrawer kicks the drawer; cancelled orders and other tenants are refused', async () => {
        const { order } = await placeDineIn(A, [paneerLine(A, 1)]);
        const res = await ctx.api.as(A.users.admin, A).post(`/print/orders/${order._id}/bill`).send({ openDrawer: true });
        expect(res.status).toBe(202);
        const bill = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.jobId === res.body.jobId);
        expect(bill.payload.document.lines.at(-1)).toEqual({ drawer: true });

        expect((await ctx.api.as(B.users.admin, B).post(`/print/orders/${order._id}/bill`).send({})).status).toBe(404);
        expect((await ctx.api.as(A.users.chef, A).post(`/print/orders/${order._id}/bill`).send({})).status).toBe(403);
        expect((await ctx.api.as(A.users.admin, A).post('/print/orders/not-an-id/bill').send({})).status).toBe(404);
    });

    test('409 when printing is disabled or there is no counter printer', async () => {
        const { order } = await placeDineIn(B, [paneerLine(B, 1)]);
        let res = await ctx.api.as(B.users.admin, B).post(`/print/orders/${order._id}/bill`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PRINTING_DISABLED');

        await patch(B.users.admin, 'printers', { enabled: true, list: [{ name: 'K', station: 'kitchen', host: '127.0.0.1' }] });
        res = await ctx.api.as(B.users.admin, B).post(`/print/orders/${order._id}/bill`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NO_COUNTER_PRINTER');
        await patch(B.users.admin, 'printers', { enabled: false, list: [] });
    });

    test('test page goes to the chosen printer; unknown printer → 404; offline agent → 409', async () => {
        const doc = await tenantDoc(A);
        const bar = doc.printers.list.find((p) => p.station === 'bar');
        const res = await ctx.api.as(A.users.admin, A).post('/print/test').send({ printerId: bar.id });
        expect(res.status).toBe(202);
        const job = await waitFor(agent.events, (e) => e.event === 'print:job' && e.payload.jobId === res.body.jobId);
        expect(job.payload.kind).toBe('test');
        expect(job.payload.printer.name).toBe('Bar');
        expect(toPlainText(job.payload.document)).toContain('PRINTER TEST');

        expect((await ctx.api.as(A.users.admin, A).post('/print/test').send({ printerId: 'nope' })).status).toBe(404);
        expect((await ctx.api.as(A.users.admin, A).post('/print/test').send({})).status).toBe(400);
        expect((await ctx.api.as(A.users.waiter, A).post('/print/test').send({ printerId: bar.id })).status).toBe(403);

        // Tenant B has no agent → 409 even with a printer configured.
        await patch(B.users.admin, 'printers', { enabled: true, list: [{ name: 'K', station: 'kitchen', host: '127.0.0.1' }] });
        const bDoc = await tenantDoc(B);
        const off = await ctx.api.as(B.users.admin, B).post('/print/test').send({ printerId: bDoc.printers.list[0].id });
        expect(off.status).toBe(409);
        expect(off.body.code).toBe('AGENT_OFFLINE');
        await patch(B.users.admin, 'printers', { enabled: false, list: [] });
    });

    test('GET /print/jobs lists recent jobs without the document', async () => {
        const res = await ctx.api.as(A.users.admin, A).get('/print/jobs?limit=5');
        expect(res.status).toBe(200);
        expect(res.body.jobs.length).toBeGreaterThan(0);
        expect(res.body.jobs.length).toBeLessThanOrEqual(5);
        expect(res.body.jobs[0].document).toBeUndefined();
        expect(res.body.jobs[0].printer.name).toBeTruthy();
        expect((await ctx.api.as(A.users.waiter, A).get('/print/jobs')).status).toBe(403);
    });

    // Rate limiting of POST /print/test (10/min) is wired in routes/printRoute.js
    // via makeLimiter, which the integration harness replaces with a
    // pass-through (helpers/mocks.js) — so it is not asserted here.
});

// ═══════════════════════ tenant isolation ════════════════════════════

describe('tenant isolation', () => {
    test("tenant B's agent never receives tenant A's jobs and cannot acknowledge them", async () => {
        await patch(B.users.admin, 'printers', PRINTERS());
        const agentA = await pairAgent(A);
        const agentB = await pairAgent(B);

        const { order } = await placeDineIn(A, [paneerLine(A, 1)]);
        const jobA = await waitFor(agentA.events, (e) => e.event === 'print:job' && e.payload.orderId === order.orderId);
        await settle(300);
        expect(agentB.events.find((e) => e.event === 'print:job' && e.payload.orderId === order.orderId)).toBeUndefined();

        const ack = await emitAck(agentB.socket, 'print:ack', { jobId: jobA.payload.jobId, status: 'done' });
        expect(ack).toMatchObject({ ok: false, code: 'NOT_FOUND' });
        expect((await PrintJob.findById(jobA.payload.jobId).lean()).status).toBe('sent');

        const pendingB = await emitAck(agentB.socket, 'print:pending');
        expect(pendingB.jobs.find((j) => j.jobId === jobA.payload.jobId)).toBeUndefined();

        // Staff cannot sneak into the printer room by name.
        const chef = await connect({ token: A.users.chef.token });
        const chefEvents = recorder(chef);
        chef.emit('join', `t:${A.restaurant._id}:printer:${A.branch._id}`);
        await settle(200);
        const { order: o2 } = await placeDineIn(A, [paneerLine(A, 1)]);
        await waitFor(agentA.events, (e) => e.event === 'print:job' && e.payload.orderId === o2.orderId);
        expect(chefEvents.find((e) => e.event === 'print:job')).toBeUndefined();

        agentA.socket.close(); agentB.socket.close(); chef.close();
        await patch(B.users.admin, 'printers', { enabled: false, list: [] });
    });
});
