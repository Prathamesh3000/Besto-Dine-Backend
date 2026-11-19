/**
 * STRICT tenant campaign / infra: Socket.io + print-agent socket.
 * Real socket.io-client sockets against the real test server.
 *
 * Tenant A (staff of every role, a table guest, a customer, an anonymous
 * guest, a print agent) must never:
 *   - end up in any of tenant B's rooms (joins by room name / order id / table id)
 *   - receive an event emitted for B (new order, status, request, table, tenant-wide)
 *   - pull or acknowledge B's print jobs
 *
 * "BUG:" tests are expected to FAIL until the source is fixed.
 */
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const PrintJob = require(path.join(BACKEND, 'models/printJob'));
const Order = require(path.join(BACKEND, 'models/order'));
const socketUtil = require(path.join(BACKEND, 'utils/socket'));
const { runAsSystem } = require(path.join(BACKEND, 'utils/tenantSafe'));

const ctx = useIntegrationApp();
const opened = [];
afterAll(async () => { for (const s of opened) { try { s.close(); } catch { /* ignore */ } } await settle(200); });

let A; let B; let tableA; let tableB; let orderB; let orderA; let scanA; let scanB;
let cast; // connected clients

function connect(auth) {
    return new Promise((resolve, reject) => {
        const s = connectClient(ctx.baseUrl, { auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
        opened.push(s);
        s.events = [];
        s.onAny((event, payload) => s.events.push({ event, payload }));
        s.on('connect', () => resolve(s));
        s.on('connect_error', reject);
    });
}
const serverRooms = (client) => [...(ctx.io.sockets.sockets.get(client.id)?.rooms || [])];
const emitAck = (s, ev, payload) => new Promise((resolve) => (payload === undefined ? s.emit(ev, resolve) : s.emit(ev, payload, resolve)));

async function placeOrder(t, table, scanToken) {
    const res = await ctx.api.guest(t, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: 250,
    });
    expect(res.status).toBe(201);
    return res.body.order;
}

beforeAll(async () => {
    A = await seedTenant({ label: 'sa' });
    B = await seedTenant({ label: 'sb' });
    tableA = await createTable(A, { name: 'SA-1' });
    tableB = await createTable(B, { name: 'SB-1' });
    scanA = (await scanTable(ctx.api, tableA)).scanToken;
    scanB = (await scanTable(ctx.api, tableB)).scanToken;
    orderA = await placeOrder(A, tableA, scanA);
    orderB = await placeOrder(B, tableB, scanB);
    await settle(300);

    const customerA = await createCustomer('sock-a');
    cast = {
        adminA: await connect({ token: A.users.admin.token }),
        waiterA: await connect({ token: A.users.waiter.token }),
        chefA: await connect({ token: A.users.chef.token }),
        captainA: await connect({ token: A.users.captain.token }),
        guestA: await connect({ scanToken: scanA }),
        customerA: await connect({ token: customerA.token }),
        anon: await connect({}),
        adminB: await connect({ token: B.users.admin.token }),
        chefB: await connect({ token: B.users.chef.token }),
        guestB: await connect({ scanToken: scanB }),
    };
    await settle(300);
});

const aClients = () => ['adminA', 'waiterA', 'chefA', 'captainA', 'guestA', 'customerA', 'anon'].map((k) => [k, cast[k]]);
const bTenantId = () => String(B.restaurant._id);
const bBranchId = () => String(B.branch._id);

function foreignRooms() {
    const t = bTenantId(); const br = bBranchId();
    return [
        `t:${t}:admin`, `t:${t}:waiter`, `t:${t}:kitchen`, `t:${t}:captain`, `t:${t}:manager`,
        `t:${t}:admin:${br}`, `t:${t}:kitchen:${br}`, `t:${t}:waiter:${br}`, `t:${t}:captain:${br}`,
        `t:${t}:admin:unbranched`, `t:${t}:kitchen:unbranched`,
        `order:${orderB.orderId}`, `table:${tableB._id}`,
        String(B.users.admin._id), String(B.users.chef._id),
        'admin', 'kitchen', 'waiter', 'captain', `admin:${br}`, `kitchen:${br}`, 'superadmin',
        `t:${t}:printer:${br}`,
    ];
}

describe('joins: nobody from A can enter a B room', () => {
    test('every A client is refused every B room name', async () => {
        for (const [, c] of aClients()) for (const r of foreignRooms()) c.emit('join', r);
        await settle(700);
        for (const [name, c] of aClients()) {
            const rooms = serverRooms(c);
            for (const r of foreignRooms()) expect([name, rooms.includes(r) ? r : null]).toEqual([name, null]);
            expect(rooms.some((r) => r.includes(bTenantId()) && !r.endsWith(':menu'))).toBe(false);
        }
    });

    test('join with a payload object and a guestAccess token for B order is refused', async () => {
        for (const [, c] of aClients()) {
            c.emit('join', { room: `order:${orderB.orderId}`, guestAccess: 'x'.repeat(40) });
            c.emit('join', { room: `order:${orderB.orderId}`, guestAccess: orderB.guestAccessToken || 'nope' });
        }
        await settle(400);
        for (const [, c] of aClients()) expect(serverRooms(c)).not.toContain(`order:${orderB.orderId}`);
    });

    test('A staff and A guest can still join their OWN order rooms (sanity)', async () => {
        cast.adminA.emit('join', `order:${orderA.orderId}`);
        cast.guestA.emit('join', `order:${orderA.orderId}`);
        await settle(400);
        expect(serverRooms(cast.adminA)).toContain(`order:${orderA.orderId}`);
        expect(serverRooms(cast.guestA)).toContain(`order:${orderA.orderId}`);
    });

    test('A guest holding A scan token cannot join table:<B> nor B order, even by a case-mangled id', async () => {
        cast.guestA.emit('join', `table:${String(tableB._id).toUpperCase()}`);
        cast.guestA.emit('join', `order:${orderB.orderId.toLowerCase()}`);
        cast.guestA.emit('join', `t:${bTenantId().toUpperCase()}:admin`);
        await settle(400);
        const rooms = serverRooms(cast.guestA);
        expect(rooms.some((r) => r.toLowerCase().includes(String(tableB._id)))).toBe(false);
        expect(rooms.some((r) => r.toLowerCase().includes(bTenantId()))).toBe(false);
    });

    test('A admin cannot use leave/join tricks: join array / non-string payloads are ignored', async () => {
        cast.adminA.emit('join', [`t:${bTenantId()}:admin`]);
        cast.adminA.emit('join', { room: [`t:${bTenantId()}:admin`] });
        cast.adminA.emit('join', { room: { toString: () => `t:${bTenantId()}:admin` } });
        await settle(300);
        expect(serverRooms(cast.adminA).some((r) => r.includes(bTenantId()))).toBe(false);
    });

    test('the tenant menu room is public by design: joinable, and its payload carries no private fields', async () => {
        cast.anon.emit('join', `t:${bTenantId()}:menu`);
        await settle(300);
        expect(serverRooms(cast.anon)).toContain(`t:${bTenantId()}:menu`);
        cast.anon.events.length = 0;
        socketUtil.emitMenuUpdated(B.restaurant._id, { itemIds: ['1'], reason: 'test' });
        await settle(300);
        const ev = cast.anon.events.find((e) => e.event === 'menu:updated');
        expect(ev).toBeDefined();
        expect(Object.keys(ev.payload).sort()).toEqual(['at', 'itemIds', 'reason', 'restaurant']);
        cast.anon.emit('leave', `t:${bTenantId()}:menu`);
    });

    test('A staff auto-rooms contain only A tenant ids', async () => {
        for (const k of ['adminA', 'waiterA', 'chefA', 'captainA']) {
            const rooms = serverRooms(cast[k]);
            expect(rooms.some((r) => r.includes(bTenantId()))).toBe(false);
            expect(rooms.some((r) => r.includes(String(A.restaurant._id)))).toBe(true);
        }
    });

    test('a token for A combined with a scan token for B: staff cannot use it to join B staff rooms', async () => {
        const mixed = await connect({ token: A.users.admin.token, scanToken: scanB });
        await settle(300);
        mixed.emit('join', `t:${bTenantId()}:admin`);
        mixed.emit('join', `order:${orderB.orderId}`);
        await settle(400);
        const rooms = serverRooms(mixed);
        expect(rooms).not.toContain(`t:${bTenantId()}:admin`);
        // order:<B> is refused because the staff tenant differs from the order tenant.
        expect(rooms).not.toContain(`order:${orderB.orderId}`);
        mixed.close();
    });

    test('a deactivated/other-tenant token never yields B rooms: B chef token has only B kitchen rooms', async () => {
        const rooms = serverRooms(cast.chefB);
        expect(rooms.some((r) => r.includes(String(A.restaurant._id)))).toBe(false);
    });
});

describe('emits: events for B never reach A', () => {
    const sinceMark = () => Object.fromEntries(Object.entries(cast).map(([k, c]) => [k, c.events.length]));
    const received = (mark, key) => cast[key].events.slice(mark[key]);
    const fromB = (evs) => evs.filter((e) => JSON.stringify(e.payload || {}).includes(bTenantId())
        || JSON.stringify(e.payload || {}).includes(orderB.orderId) || JSON.stringify(e.payload || {}).includes('FOR-B'));

    test('every emit helper aimed at B reaches B and no A client', async () => {
        const mark = sinceMark();
        const io = ctx.io;
        const p = (n) => ({ tag: `FOR-B-${n}`, restaurant: bTenantId() });
        socketUtil.emitToStaff(io, B.branch._id, 'x:staff', p(1));
        socketUtil.emitToAdmin(io, B.branch._id, 'x:admin', p(2));
        socketUtil.emitToKitchen(io, B.branch._id, 'x:kitchen', p(3));
        socketUtil.emitToWaiter(io, B.branch._id, 'x:waiter', p(4));
        socketUtil.emitToCaptain(io, B.branch._id, 'x:captain', p(5));
        socketUtil.emitToStaff(io, null, 'x:staff-nobranch', { tag: 'FOR-B-6', restaurant: bTenantId() });
        socketUtil.emitToAdmin(io, null, 'x:by-order', { tag: 'FOR-B-7', orderId: orderB.orderId });
        socketUtil.emitToKitchen(io, null, 'x:by-table', { tag: 'FOR-B-8', tableId: String(tableB._id) });
        await socketUtil.emitToTenantStaff(io, B.restaurant._id, 'x:tenant', p(9));
        socketUtil.staffRoom(io, 'admin', B.branch._id, B.restaurant._id).emit('x:staffroom', p(10));
        io.to(`order:${orderB.orderId}`).emit('x:order-room', p(11));
        io.to(`table:${tableB._id}`).emit('x:table-room', p(12));
        // legacy raw room names with no request context must be dropped
        io.to('admin').emit('x:legacy', p(13));
        io.to(`kitchen:${B.branch._id}`).emit('x:legacy-branch', p(14));
        await settle(600);
        for (const [name] of aClients()) expect([name, fromB(received(mark, name)).map((e) => e.event)]).toEqual([name, []]);
        const adminB = received(mark, 'adminB').map((e) => e.event);
        expect(adminB).toEqual(expect.arrayContaining(['x:staff', 'x:admin', 'x:staff-nobranch', 'x:by-order', 'x:tenant', 'x:staffroom']));
        expect(received(mark, 'chefB').map((e) => e.event)).toEqual(expect.arrayContaining(['x:kitchen', 'x:tenant', 'x:legacy-branch']));
        expect(received(mark, 'guestB').map((e) => e.event)).toContain('x:table-room');
    });

    test('emit with a payload naming B but a branch id of A is routed by the BRANCH (authoritative), never to B', async () => {
        const mark = sinceMark();
        socketUtil.emitToAdmin(ctx.io, A.branch._id, 'x:mix', { tag: 'FOR-A-ONLY', restaurant: bTenantId() });
        await settle(400);
        expect(received(mark, 'adminB').map((e) => e.event)).not.toContain('x:mix');
        expect(received(mark, 'adminA').map((e) => e.event)).toContain('x:mix');
    });

    test('real flows on B (order create, status change, waiter request, counter payment) leak nothing to A', async () => {
        const mark = sinceMark();
        const tb2 = await createTable(B, { name: 'SB-flow' });
        const sc = (await scanTable(ctx.api, tb2)).scanToken;
        const o = await placeOrder(B, tb2, sc);
        await settle(300);
        const st = await ctx.api.as(B.users.admin, B).patch(`/orders/${o._id}/status`).send({ status: 'preparing' });
        const rq = await ctx.api.guest(B, sc).post('/requests').send({ tableId: String(tb2._id), type: 'waiter' });
        const cp = await ctx.api.guest(B, sc).post(`/orders/${o._id}/request-counter-payment`).send({});
        await settle(700);
        // sanity: B actually saw activity
        expect(received(mark, 'adminB').length).toBeGreaterThan(0);
        expect([st.status, rq.status, cp.status].some((s) => s < 300)).toBe(true);
        for (const [name] of aClients()) {
            const leaked = received(mark, name).filter((e) => e.event !== 'menu:updated');
            expect([name, leaked.map((e) => e.event)]).toEqual([name, []]);
        }
    });

    test('real flows on A do not reach B clients', async () => {
        const mark = sinceMark();
        const ta = await createTable(A, { name: 'SA-flow' });
        const sc = (await scanTable(ctx.api, ta)).scanToken;
        await placeOrder(A, ta, sc);
        await ctx.api.guest(A, sc).post('/requests').send({ tableId: String(ta._id), type: 'waiter' });
        await settle(700);
        expect(received(mark, 'adminA').length).toBeGreaterThan(0);
        for (const k of ['adminB', 'chefB', 'guestB']) {
            expect([k, received(mark, k).filter((e) => e.event !== 'menu:updated').map((e) => e.event)]).toEqual([k, []]);
        }
    });

    test('superadmin-only emits never reach tenant clients', async () => {
        const mark = sinceMark();
        socketUtil.emitToSuperadmin('x:platform', { secret: 'platform-data' });
        await settle(300);
        for (const [name] of aClients()) expect(received(mark, name).map((e) => e.event)).not.toContain('x:platform');
        for (const k of ['adminB', 'chefB', 'guestB']) expect(received(mark, k).map((e) => e.event)).not.toContain('x:platform');
    });

    test('notifyAuthReload targets only that user', async () => {
        const mark = sinceMark();
        socketUtil.notifyAuthReload(B.users.admin._id);
        await settle(300);
        expect(received(mark, 'adminB').map((e) => e.event)).toContain('auth:reload');
        for (const [name] of aClients()) expect(received(mark, name).map((e) => e.event)).not.toContain('auth:reload');
    });

    test('an emit whose tenant cannot be resolved is dropped, not broadcast', async () => {
        const mark = sinceMark();
        socketUtil.emitToAdmin(ctx.io, null, 'x:nowhere', { tag: 'FOR-B-nowhere' });
        socketUtil.emitToStaff(ctx.io, '000000000000000000000000', 'x:ghost-branch', { tag: 'FOR-B-ghost' });
        await settle(400);
        for (const k of Object.keys(cast)) expect(received(mark, k).map((e) => e.event)).not.toEqual(expect.arrayContaining(['x:nowhere']));
        for (const k of Object.keys(cast)) expect(received(mark, k).map((e) => e.event)).not.toContain('x:ghost-branch');
    });
});

describe('socket tenant cache keyed by id (order/table/branch -> tenant)', () => {
    test('resolve by orderId / tableId / branchId returns each own tenant, never swapped', async () => {
        const { resolveTenantAsync } = socketUtil._internals;
        expect(await resolveTenantAsync(null, { orderId: orderA.orderId })).toBe(String(A.restaurant._id));
        expect(await resolveTenantAsync(null, { orderId: orderB.orderId })).toBe(bTenantId());
        expect(await resolveTenantAsync(null, { tableId: String(tableB._id) })).toBe(bTenantId());
        expect(await resolveTenantAsync(B.branch._id)).toBe(bTenantId());
        expect(await resolveTenantAsync(A.branch._id)).toBe(String(A.restaurant._id));
        // a repeat (cached) hit stays correct
        expect(await resolveTenantAsync(null, { orderId: orderB.orderId })).toBe(bTenantId());
    });

    test('Regression (fixed 2026-11): payloadTenantHint trusts payload.restaurant over the HTTP request tenant (a request-derived payload can steer an emit to another tenant)', () => {
        // resolveTenantSync(null, { restaurant: B }) returns B even when called inside A's request
        // context: any controller that spreads user input into an emit payload can route a staff
        // event to tenant B's rooms. Priority should be: request context tenant first.
        const { requestStore, enterRequest } = socketUtil._internals;
        const req = { restaurant: { _id: A.restaurant._id }, method: 'POST' };
        const out = requestStore.run(enterRequest(req, null), () => socketUtil._internals.resolveTenantSync(null, { restaurant: bTenantId() }));
        expect(out).toBe(String(A.restaurant._id));
    });
});

// ═══════════════════════ print agent ═════════════════════════════════

describe('print agent sockets', () => {
    let jobA; let jobB; let agentA; let agentB; let tokA; let tokB;

    beforeAll(async () => {
        const mk = async (t) => runAsSystem('seed print job', () => PrintJob.create({
            restaurant: t.restaurant._id, branch: t.branch._id, kind: 'test', station: 'kitchen', reason: 'test',
            printer: { id: 'p1', name: `printer-${t.label}`, host: '127.0.0.1' }, document: { lines: [`SECRET-${t.label}`] }, status: 'queued',
        }));
        jobA = await mk(A); jobB = await mk(B);
        const ra = await ctx.api.as(A.users.admin, A).post('/print/agent-key');
        const rb = await ctx.api.as(B.users.admin, B).post('/print/agent-key');
        tokA = ra.body.token; tokB = rb.body.token;
        agentA = await connect({ agentToken: tokA });
        agentB = await connect({ agentToken: tokB });
        await settle(200);
    });

    test('agent A pulls only A jobs; B document text never appears', async () => {
        const r = await emitAck(agentA, 'print:pending');
        expect(r.ok).toBe(true);
        const ids = r.jobs.map((j) => j.jobId);
        expect(ids).toContain(String(jobA._id));
        expect(ids).not.toContain(String(jobB._id));
        expect(JSON.stringify(r.jobs)).not.toContain('SECRET-sb');
        const rb = await emitAck(agentB, 'print:pending');
        expect(rb.jobs.map((j) => j.jobId)).toEqual([String(jobB._id)]);
    });

    test('agent A cannot ack / fail B job; B job untouched; same-tenant ack works', async () => {
        for (const st of ['done', 'failed']) {
            const r = await emitAck(agentA, 'print:ack', { jobId: String(jobB._id), status: st, error: 'x' });
            expect(r.ok).toBe(false);
            expect(r.code).toBe('NOT_FOUND');
        }
        const after = await runAsSystem('verify', async () => PrintJob.findById(jobB._id).lean());
        expect(after.status).toBe('queued');
        expect(after.attempts).toBe(0);
        // malformed / injection-ish ids
        for (const bad of [{ $ne: null }, '', 'zz', [String(jobB._id)], null]) {
            const r = await emitAck(agentA, 'print:ack', { jobId: bad, status: 'done' });
            expect(r.ok).toBe(false);
        }
        const own = await emitAck(agentA, 'print:ack', { jobId: String(jobA._id), status: 'done' });
        expect(own.ok).toBe(true);
        expect((await runAsSystem('verify', async () => PrintJob.findById(jobB._id).lean())).status).toBe('queued');
    });

    test('agent A cannot join B printer room or staff rooms, and receives no B print:job', async () => {
        const room = `t:${bTenantId()}:printer:${bBranchId()}`;
        agentA.emit('join', room);
        agentA.emit('join', `t:${bTenantId()}:admin`);
        agentA.emit('join', `order:${orderB.orderId}`);
        await settle(300);
        expect(serverRooms(agentA).filter((r) => r.includes(bTenantId()))).toEqual([]);
        const mark = agentA.events.length;
        const wire = { jobId: 'x', document: 'SECRET-B-live' };
        ctx.io.to(room).emit('print:job', wire);
        socketUtil.emitToAdmin(ctx.io, B.branch._id, 'print:job-updated', { jobId: 'x', tag: 'FOR-B' });
        await settle(300);
        expect(agentA.events.slice(mark)).toEqual([]);
        expect(agentB.events.some((e) => e.event === 'print:job')).toBe(true);
    });

    // verifyAgentClaims never checks that the branch belongs to the restaurant (printService.js:404);
    // needs a validly signed token, so this is defense-in-depth.
    test('BUG: an agent token naming A with B\'s branch id must be refused at the handshake', async () => {
        const auth = require(path.join(BACKEND, 'middlewares/authMiddleware'));
        const forged = auth.signTypedToken(auth.TOKEN_TYPES.AGENT, { restaurant: String(A.restaurant._id), branch: bBranchId(), agentId: 'x', kv: 1 }, { expiresIn: '1h' });
        await expect(connect({ agentToken: forged })).rejects.toMatchObject({ message: 'AGENT_REVOKED' });
        // and A's restaurant with B's key version / agent: refused
        const forged2 = auth.signTypedToken(auth.TOKEN_TYPES.AGENT, { restaurant: bTenantId(), branch: String(A.branch._id), agentId: 'x', kv: 1 }, { expiresIn: '1h' });
        await expect(connect({ agentToken: forged2 })).rejects.toMatchObject({ message: 'AGENT_REVOKED' });
    });

    test('revoking B\'s agent does not disconnect or invalidate A\'s', async () => {
        const r = await ctx.api.as(B.users.admin, B).delete('/print/agent-key');
        expect(r.status).toBe(200);
        await settle(400);
        expect(agentA.connected).toBe(true);
        const again = await connect({ agentToken: tokA });
        expect(again.connected).toBe(true);
        again.close();
        await expect(connect({ agentToken: tokB })).rejects.toMatchObject({ message: 'AGENT_REVOKED' });
    });

    test('agent presence events for B go only to B admins (A admin gets none)', async () => {
        const mark = cast.adminA.events.length;
        const markB = cast.adminB.events.length;
        const again = await connect({ agentToken: (await ctx.api.as(B.users.admin, B).post('/print/agent-key')).body.token });
        await settle(400);
        again.close();
        await settle(300);
        expect(cast.adminA.events.slice(mark).filter((e) => e.event.startsWith('print:'))).toEqual([]);
        expect(cast.adminB.events.slice(markB).some((e) => e.event === 'print:agent-status')).toBe(true);
    });

    test('A admin cannot mint an agent key bound to B\'s branch via a branch override', async () => {
        const res = await ctx.api.as(A.users.admin, A).post('/print/agent-key').send({ branchId: bBranchId(), branch: bBranchId() })
            .set('X-Branch-Id', bBranchId());
        if (res.status === 200) expect(res.body.branch).toBe(String(A.branch._id));
        else expect([400, 403, 404]).toContain(res.status);
    });
});

// The shared harness may already have disconnected by now; this is only a courtesy touch.
afterAll(async () => { try { await runAsSystem('cleanup', async () => { await Order.countDocuments({}); }); } catch (_) { /* disconnected */ } });
