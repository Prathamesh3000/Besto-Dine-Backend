/**
 * Realtime tenant isolation (BUGS_REPORT #6): socket.io clients
 * authenticated as tenant A staff receive tenant A's live events and
 * never tenant B's — including when they try to join B's rooms by name.
 */
const path = require('path');
const { io: connectClient } = require('socket.io-client');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable } = require('./helpers/seed');
const { scanTable } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const User = require(path.join(BACKEND, 'models/user'));
const { signAccessToken } = require(path.join(BACKEND, 'middlewares/authMiddleware'));

const ctx = useIntegrationApp();
let A;
let B;
const sockets = [];

beforeAll(async () => {
    A = await seedTenant({ label: 'rt-a' });
    B = await seedTenant({ label: 'rt-b' });
});

afterAll(() => {
    for (const s of sockets) s.close();
});

/** Connect a client and resolve once the server accepted it. */
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

/** Record every event a socket receives. */
function recorder(socket) {
    const events = [];
    socket.onAny((event, payload) => events.push({ event, payload }));
    return events;
}

const waitFor = (events, predicate, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
        const hit = events.find(predicate);
        if (hit) return resolve(hit);
        if (Date.now() - started > ms) return reject(new Error('event not received in time'));
        return setTimeout(tick, 25);
    };
    tick();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guestOrder(t) {
    const table = await createTable(t);
    const { scanToken } = await scanTable(ctx.api, table);
    const res = await ctx.api.guest(t, scanToken).post('/orders').send({
        type: 'dine-in', tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: 250,
    });
    expect(res.status).toBe(201);
    return res.body.order;
}

test('tenant A kitchen/waiter sockets get A order:new; tenant B sockets do not (and vice versa)', async () => {
    const chefA = await connect({ token: A.users.chef.token });
    const waiterA = await connect({ token: A.users.waiter.token });
    const chefB = await connect({ token: B.users.chef.token });
    const waiterB = await connect({ token: B.users.waiter.token });
    const [evChefA, evWaiterA, evChefB, evWaiterB] = [chefA, waiterA, chefB, waiterB].map(recorder);

    const orderA = await guestOrder(A);
    const isA = (e) => e.event === 'order:new' && e.payload?.orderId === orderA.orderId;
    await waitFor(evChefA, isA);
    await waitFor(evWaiterA, isA);

    const orderB = await guestOrder(B);
    const isB = (e) => e.event === 'order:new' && e.payload?.orderId === orderB.orderId;
    await waitFor(evChefB, isB);
    await waitFor(evWaiterB, isB);

    await sleep(400);
    expect(evChefB.some(isA)).toBe(false);
    expect(evWaiterB.some(isA)).toBe(false);
    expect(evChefA.some(isB)).toBe(false);
    expect(evWaiterA.some(isB)).toBe(false);
    // Nothing that mentions the other tenant's order leaks at all.
    expect(JSON.stringify(evChefB)).not.toContain(orderA.orderId);
    expect(JSON.stringify(evWaiterB)).not.toContain(orderA.orderId);
});

test("a B socket asking to join A's tenant rooms (or the legacy global rooms) is ignored", async () => {
    const chefB = await connect({ token: B.users.chef.token });
    const events = recorder(chefB);
    const rid = String(A.restaurant._id);
    const bid = String(A.branch._id);
    for (const room of [
        `t:${rid}:kitchen`, `t:${rid}:kitchen:${bid}`, `t:${rid}:admin`, `t:${rid}:waiter:${bid}`,
        'kitchen', 'admin', 'waiter', `kitchen:${bid}`,
    ]) chefB.emit('join', room);
    await sleep(300);

    const orderA = await guestOrder(A);
    await sleep(800);
    expect(JSON.stringify(events)).not.toContain(orderA.orderId);
});

test('a guest socket with an A scan token gets no staff events', async () => {
    const table = await createTable(A);
    const { scanToken } = await scanTable(ctx.api, table);
    const guest = await connect({ scanToken });
    const events = recorder(guest);
    guest.emit('join', `t:${A.restaurant._id}:kitchen:${A.branch._id}`);
    await sleep(300);
    const orderA = await guestOrder(A);
    await sleep(800);
    expect(events.filter((e) => e.event === 'order:new')).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain(orderA.orderId);
});

test('a revoked staff token (tokenVersion bumped) is refused at connect', async () => {
    const stale = A.users.captain.token;
    await User.updateOne({ _id: A.users.captain._id }, { $inc: { tokenVersion: 1 } });
    await expect(connect({ token: stale })).rejects.toThrow(/AUTH_REVOKED/);
    // A fresh token for the same user works.
    const fresh = signAccessToken(await User.findById(A.users.captain._id));
    const s = await connect({ token: fresh });
    expect(s.connected).toBe(true);
});
