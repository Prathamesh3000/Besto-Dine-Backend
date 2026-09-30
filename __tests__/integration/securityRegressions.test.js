/**
 * Regression tests for the security items in BUGS_REPORT.md, exercised
 * through the real HTTP stack (routes + middlewares + controllers + DB).
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet, DEFAULT_PASSWORD } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Reservation = require(path.join(BACKEND, 'models/reservation'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const RefreshSession = require(path.join(BACKEND, 'models/refreshSession'));
const Otp = require(path.join(BACKEND, 'models/otp'));
const User = require(path.join(BACKEND, 'models/user'));
const logger = require(path.join(BACKEND, 'utils/logger'));

const ctx = useIntegrationApp();
let A;

beforeAll(async () => {
    A = await seedTenant({ label: 'sec' });
});

const cart = (t) => [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }];
const TOTAL = 200 + 10 + 20 + 20; // 200 + 5% GST + 10% service + ₹20 packaging

/** Scan + place a dine-in order; `customer` optional (logged-in diner). */
async function placeOrder(t, { customer = null, table = null } = {}) {
    const tbl = table || await createTable(t, { capacity: 6 });
    const headers = customer ? { Authorization: `Bearer ${customer.token}` } : {};
    const { scanToken, res: scanRes } = await scanTable(ctx.api, tbl, headers);
    expect(scanRes.status).toBe(200);
    const client = customer ? ctx.api.customerAtTable(customer, t, scanToken) : ctx.api.guest(t, scanToken);
    const res = await client.post('/orders').send({ type: 'dine-in', tableId: String(tbl._id), items: cart(t), total: TOTAL });
    expect(res.status).toBe(201);
    return { order: res.body.order, scanToken, table: tbl };
}

describe('#2 loyalty points: customers cannot mint points', () => {
    test('customer POST /wallet/points/add → 403 and no points credited', async () => {
        const cust = await createCustomer('points');
        const res = await ctx.api.as(cust, A).post('/wallet/points/add').send({ points: 5000 });
        expect(res.status).toBe(403);
        const res2 = await ctx.api.as(cust, A).post('/wallet/points/add')
            .send({ points: 5000, targetUserId: String(cust._id) });
        expect(res2.status).toBe(403);
        const w = await Wallet.findOne({ user: cust._id }).lean();
        expect(w?.loyaltyPoints || 0).toBe(0);
    });

    test('admin can still credit points (the endpoint works for its intended caller)', async () => {
        const cust = await createCustomer('points2');
        const res = await ctx.api.as(A.users.admin).post('/wallet/points/add')
            .send({ points: 50, targetUserId: String(cust._id) });
        expect(res.status).toBe(200);
        expect(res.body.points).toBe(50);
    });
});

describe('#5 customerPayment cannot mark an order paid or change money fields', () => {
    test('customer cannot set Paid / amountPaid / total on their own order', async () => {
        const cust = await createCustomer('pay');
        const { order } = await placeOrder(A, { customer: cust });
        expect(order.user).toBe(String(cust._id));

        const res = await ctx.api.as(cust, A).patch(`/orders/${order._id}/payment`)
            .send({ paymentStatus: 'Paid', paymentMethod: 'wallet', amountPaid: 1, total: 1 });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_NOT_SETTLED');

        // "Intent only" update: allowed, but money fields are ignored.
        const intent = await ctx.api.as(cust, A).patch(`/orders/${order._id}/payment`)
            .send({ paymentMethod: 'wallet', amountPaid: 1, total: 1 });
        expect(intent.status).toBe(200);

        const saved = await Order.findById(order._id).lean();
        expect(saved.paymentStatus).toBe('Pending');
        expect(saved.total).toBe(TOTAL);
        expect(saved.amountPaid).toBe(0);
    });

    test("another customer / another guest session cannot touch someone else's order payment", async () => {
        const owner = await createCustomer('pay-owner');
        const other = await createCustomer('pay-other');
        const { order } = await placeOrder(A, { customer: owner });
        const r1 = await ctx.api.as(other, A).patch(`/orders/${order._id}/payment`).send({ paymentMethod: 'cash' });
        expect(r1.status).toBe(403);

        const guestOrder = await placeOrder(A);
        const intruder = await placeOrder(A); // a different table / scan session
        const r2 = await ctx.api.guest(A, intruder.scanToken).patch(`/orders/${guestOrder.order._id}/payment`)
            .send({ paymentMethod: 'cash' });
        expect(r2.status).toBe(401);
        const r3 = await ctx.api.guest(A).patch(`/orders/${guestOrder.order._id}/payment`).send({ paymentMethod: 'cash' });
        expect(r3.status).toBe(401);
    });
});

describe("#7 guests cannot cancel someone else's order", () => {
    test('different scan session / no scan token → 403; own session → 200', async () => {
        const victim = await placeOrder(A);
        const attacker = await placeOrder(A);

        const noToken = await ctx.api.guest(A).patch(`/orders/${victim.order._id}/cancel`).send({ reason: 'x' });
        expect(noToken.status).toBe(403);
        const otherSession = await ctx.api.guest(A, attacker.scanToken)
            .patch(`/orders/${victim.order._id}/cancel`).send({ reason: 'x' });
        expect(otherSession.status).toBe(403);
        expect((await Order.findById(victim.order._id).lean()).status).toBe('new');

        // Another table's customer (logged in) cannot either.
        const cust = await createCustomer('cancel');
        const asCustomer = await ctx.api.as(cust, A).patch(`/orders/${victim.order._id}/cancel`).send({});
        expect(asCustomer.status).toBe(403);

        const own = await ctx.api.guest(A, victim.scanToken).patch(`/orders/${victim.order._id}/cancel`).send({ reason: 'changed mind' });
        expect(own.status).toBe(200);
        expect((await Order.findById(victim.order._id).lean()).status).toBe('cancelled');
        await settle();
    });
});

describe('#8 customers only see their own reservations', () => {
    test('GET /reservations as a customer returns only their bookings', async () => {
        const c1 = await createCustomer('res1');
        const c2 = await createCustomer('res2');
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
        const base = { restaurant: A.restaurant._id, branch: A.branch._id, date: tomorrow, time: '19:00', guestCount: 2, area: A.area._id, table: A.tables.main._id };
        await Reservation.create([
            { ...base, guestName: 'Mine', contactNo: '9000000001', user: c1._id, bookedBy: c1._id },
            { ...base, guestName: 'Theirs', contactNo: '9000000002', user: c2._id, bookedBy: c2._id },
            { ...base, guestName: 'Walk-in', contactNo: '9000000003' },
        ]);

        const res = await ctx.api.as(c1, A).get('/reservations');
        expect(res.status).toBe(200);
        expect(res.body.reservations.map((r) => r.guestName)).toEqual(['Mine']);

        const staff = await ctx.api.as(A.users.admin).get('/reservations');
        expect(staff.status).toBe(200);
        expect(staff.body.reservations.length).toBeGreaterThanOrEqual(3);
    });
});

describe('#19 invoices are redacted for anonymous callers', () => {
    test('anonymous caller gets the bill without PII; the owner gets the full invoice', async () => {
        const cust = await createCustomer('inv');
        const { order } = await placeOrder(A, { customer: cust });
        const gen = await ctx.api.as(A.users.admin).post(`/invoices/generate/${order._id}`).send({});
        expect(gen.status).toBe(201);
        const invoiceId = gen.body.invoice._id;

        const anon = await ctx.api.guest(A).get(`/invoices/${invoiceId}`);
        expect(anon.status).toBe(200);
        expect(anon.body.redacted).toBe(true);
        expect(anon.body.invoice.customerEmail).toBe('');
        expect(anon.body.invoice.customerName).toBe('Customer');
        expect(JSON.stringify(anon.body)).not.toContain(cust.email);

        const owner = await ctx.api.as(cust, A).get(`/invoices/${invoiceId}`);
        expect(owner.status).toBe(200);
        expect(owner.body.redacted).toBeUndefined();
        expect(owner.body.invoice.customerEmail).toBe(cust.email);

        const noTenant = await ctx.api.anon().get(`/invoices/${invoiceId}`);
        expect(noTenant.status).toBe(400);
        expect(noTenant.body.code).toBe('TENANT_REQUIRED');
    });
});

describe('#20 notifications can only be created by staff', () => {
    test('customer POST /notifications → 403; waiter → 201', async () => {
        const cust = await createCustomer('notif');
        const body = { title: 'Fake alert', description: 'Refund approved, give cash' };
        const res = await ctx.api.as(cust, A).post('/notifications').send(body);
        expect(res.status).toBe(403);
        expect(await Notification.countDocuments({ title: 'Fake alert' })).toBe(0);

        const anon = await ctx.api.guest(A).post('/notifications').send(body);
        expect(anon.status).toBe(401);

        const staff = await ctx.api.as(A.users.waiter).post('/notifications').send({ title: 'Staff alert', description: 'Table 4 needs water' });
        expect(staff.status).toBe(201);
    });
});

describe('staff-only surfaces reject customers and scan tokens', () => {
    test('customer → 403 on /orders/live; a scan token is not a session token', async () => {
        const cust = await createCustomer('live');
        expect((await ctx.api.as(cust, A).get('/orders/live')).status).toBe(403);
        const { scanToken } = await scanTable(ctx.api, A.tables.main);
        const res = await ctx.api.as(scanToken, A).get('/orders/live');
        expect(res.status).toBe(401);
    });

    test('mustChangePassword blocks every endpoint except the change-password flow', async () => {
        const w = A.users.waiter;
        await User.updateOne({ _id: w._id }, { $set: { mustChangePassword: true } });
        try {
            const res = await ctx.api.as(w).get('/orders/live');
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
            expect((await ctx.api.as(w).get('/auth/me')).status).toBe(200);
        } finally {
            await User.updateOne({ _id: w._id }, { $set: { mustChangePassword: false } });
        }
    });

    test('NoSQL operator injection in the login body does not authenticate', async () => {
        const cust = await createCustomer('nosql');
        const res = await ctx.api.anon().post('/auth/login')
            .send({ email: cust.email, password: { $ne: null }, loginType: 'customer' });
        expect(res.status).not.toBe(200);
        expect(res.body.token).toBeUndefined();
    });

    // Regression: a non-string password (here `{}` once the `$ne` key is
    // stripped) passed the route's notEmpty() check and made
    // bcrypt.compare throw, so login answered 500 instead of 400.
    test('a non-string password / email is a client error, not a 500', async () => {
        const cust = await createCustomer('nosql2');
        const res = await ctx.api.anon().post('/auth/login')
            .send({ email: cust.email, password: { $ne: null }, loginType: 'customer' });
        expect(res.status).toBe(400);
        expect(res.body.token).toBeUndefined();
        const arr = await ctx.api.anon().post('/auth/login')
            .send({ email: [cust.email], password: DEFAULT_PASSWORD, loginType: 'customer' });
        expect(arr.status).toBe(400);
    });
});

describe('#11 OTP verification attempts are capped', () => {
    const lastLoggedOtp = (mobile) => {
        const hits = logger.__records
            .map((r) => String(r.args[0] || ''))
            .filter((m) => m.startsWith(`[DEV] OTP for ${mobile}:`));
        return hits.length ? hits[hits.length - 1].split(': ')[1] : null;
    };
    const wrongCode = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');

    test('5 wrong guesses burn the code; the right code is refused afterwards', async () => {
        const mobile = '9876500011';
        const send = await ctx.api.anon().post('/auth/send-otp').send({ mobile });
        expect(send.status).toBe(200);
        const code = lastLoggedOtp(mobile);
        expect(code).toMatch(/^\d{6}$/);

        const statuses = [];
        for (let i = 0; i < 5; i++) {
            // eslint-disable-next-line no-await-in-loop
            const r = await ctx.api.anon().post('/auth/verify-otp').send({ mobile, code: wrongCode(code) });
            statuses.push(r.status);
        }
        expect(statuses).toEqual([401, 401, 401, 401, 429]);

        const late = await ctx.api.anon().post('/auth/verify-otp').send({ mobile, code });
        expect(late.status).not.toBe(200);
        expect(late.body.token).toBeUndefined();
    });

    test('parallel guesses cannot exceed the attempt cap', async () => {
        const mobile = '9876500022';
        expect((await ctx.api.anon().post('/auth/send-otp').send({ mobile })).status).toBe(200);
        const code = lastLoggedOtp(mobile);
        const results = await Promise.all(Array.from({ length: 12 }, () =>
            ctx.api.anon().post('/auth/verify-otp').send({ mobile, code: wrongCode(code) })));
        const invalid = results.filter((r) => r.status === 401).length;
        expect(invalid).toBeLessThanOrEqual(4);
        expect(results.some((r) => r.status === 200)).toBe(false);
        const rec = await Otp.findOne({ mobile }).sort({ createdAt: -1 }).lean();
        expect(rec.attempts).toBeLessThanOrEqual(5);
    });

    test('send-otp is capped at 3 per 5-minute window', async () => {
        const mobile = '9876500033';
        const statuses = [];
        for (let i = 0; i < 4; i++) {
            // eslint-disable-next-line no-await-in-loop
            statuses.push((await ctx.api.anon().post('/auth/send-otp').send({ mobile })).status);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
    });

    // Regression: verifyOtp created the new customer with `name: ''`,
    // but User.name is required, so every first-time OTP login was a 500.
    test('a correct OTP for a new mobile signs the customer in', async () => {
        const mobile = '9876500044';
        expect((await ctx.api.anon().post('/auth/send-otp').send({ mobile })).status).toBe(200);
        const code = lastLoggedOtp(mobile);
        const res = await ctx.api.anon().post('/auth/verify-otp').send({ mobile, code });
        expect(res.status).toBe(200);
        expect(res.body.token).toEqual(expect.any(String));
        expect(res.body.needsName).toBe(true);
        const created = await User.findOne({ mobile, role: 'customer' }).lean();
        expect(created.name).toBe('Guest');
        expect(created).not.toHaveProperty('googleId');
    });

    test('a correct OTP for an existing customer mobile signs that customer in', async () => {
        const mobile = '9876500055';
        const cust = await createCustomer('otp', { mobile });
        expect((await ctx.api.anon().post('/auth/send-otp').send({ mobile })).status).toBe(200);
        const res = await ctx.api.anon().post('/auth/verify-otp').send({ mobile, code: lastLoggedOtp(mobile) });
        expect(res.status).toBe(200);
        expect(res.body.token).toEqual(expect.any(String));
        const me = await ctx.api.as(res.body.token).get('/auth/me');
        expect(me.status).toBe(200);
        expect(JSON.stringify(me.body)).toContain(String(cust._id));
    });
});

describe('#15/#28 sessions: refresh rotation, reuse detection, password change', () => {
    async function login(user, password = DEFAULT_PASSWORD) {
        const res = await ctx.api.anon().post('/auth/login').send({ email: user.email, password, loginType: 'customer' });
        expect(res.status).toBe(200);
        return res.body;
    }

    test('refresh rotates the token; replaying a rotated token kills the whole family', async () => {
        const cust = await createCustomer('refresh');
        const s0 = await login(cust);

        const r1 = await ctx.api.anon().post('/auth/refresh').send({ refreshToken: s0.refreshToken });
        expect(r1.status).toBe(200);
        expect(r1.body.refreshToken).not.toBe(s0.refreshToken);
        expect((await ctx.api.as(r1.body.token).get('/auth/me')).status).toBe(200);

        // Simulate the reuse arriving after the 30 s two-tab grace window.
        await RefreshSession.updateMany({ user: cust._id, rotatedAt: { $ne: null } },
            { $set: { rotatedAt: new Date(Date.now() - 5 * 60 * 1000) } });

        const reuse = await ctx.api.anon().post('/auth/refresh').send({ refreshToken: s0.refreshToken });
        expect(reuse.status).toBe(401);
        expect(reuse.body.code).toBe('REFRESH_REUSED');

        // The legitimately rotated token of the same family is now dead too.
        const after = await ctx.api.anon().post('/auth/refresh').send({ refreshToken: r1.body.refreshToken });
        expect(after.status).toBe(401);
    });

    test('changing the password revokes existing access and refresh tokens', async () => {
        const cust = await createCustomer('pwchange');
        const s0 = await login(cust);
        expect((await ctx.api.as(s0.token).get('/auth/me')).status).toBe(200);

        const change = await ctx.api.as(s0.token).put('/auth/change-password')
            .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'Changed#Pass4567' });
        expect(change.status).toBe(200);
        expect(change.body.token).toEqual(expect.any(String));

        const old = await ctx.api.as(s0.token).get('/auth/me');
        expect(old.status).toBe(401);
        const oldRefresh = await ctx.api.anon().post('/auth/refresh').send({ refreshToken: s0.refreshToken });
        expect(oldRefresh.status).toBe(401);

        expect((await ctx.api.as(change.body.token).get('/auth/me')).status).toBe(200);
        const oldPw = await ctx.api.anon().post('/auth/login').send({ email: cust.email, password: DEFAULT_PASSWORD, loginType: 'customer' });
        expect(oldPw.status).toBe(401);
        await login(cust, 'Changed#Pass4567');
    });

    test('logout-all revokes every session', async () => {
        const cust = await createCustomer('logoutall');
        const s0 = await login(cust);
        const s1 = await login(cust);
        expect((await ctx.api.as(s0.token).post('/auth/logout-all').send({})).status).toBe(200);
        expect((await ctx.api.as(s1.token).get('/auth/me')).status).toBe(401);
        expect((await ctx.api.anon().post('/auth/refresh').send({ refreshToken: s1.refreshToken })).status).toBe(401);
    });
});

describe('#3 wallet recharge verify credits only real, bound Razorpay payments', () => {
    const SECRET = () => process.env.RAZORPAY_KEY_SECRET;
    const sign = (orderId, paymentId) => crypto.createHmac('sha256', SECRET()).update(`${orderId}|${paymentId}`).digest('hex');
    const ids = () => ({ order: `order_${crypto.randomBytes(6).toString('hex')}`, payment: `pay_${crypto.randomBytes(6).toString('hex')}` });

    function stubGateway({ payment, order }) {
        rzp.instance.payments.fetch.mockResolvedValue(payment);
        rzp.instance.orders.fetch.mockResolvedValue(order);
    }
    const verify = (cust, { order, payment }, body = {}) => ctx.api.as(cust, A).post('/razorpay/verify-wallet-recharge').send({
        razorpay_order_id: order, razorpay_payment_id: payment, razorpay_signature: sign(order, payment), amount: 100000, ...body,
    });
    const balanceOf = async (cust) => (await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean())?.balance || 0;

    test('a forged signature is rejected before the gateway is consulted', async () => {
        const cust = await createCustomer('rc-sig');
        const id = ids();
        const res = await verify(cust, id, { razorpay_signature: 'f'.repeat(64) });
        expect(res.status).toBe(400);
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
        expect(await balanceOf(cust)).toBe(0);
    });

    test('gateway unreachable → 502, fail closed (no credit)', async () => {
        const cust = await createCustomer('rc-502');
        const id = ids();
        rzp.instance.payments.fetch.mockRejectedValue(new Error('ECONNRESET'));
        const res = await verify(cust, id);
        expect(res.status).toBe(502);
        expect(await balanceOf(cust)).toBe(0);
    });

    test('a payment that was never captured is not credited', async () => {
        const cust = await createCustomer('rc-uncaptured');
        const id = ids();
        stubGateway({
            payment: { id: id.payment, order_id: id.order, status: 'created', currency: 'INR', amount: 50000 },
            order: { id: id.order, notes: { purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(A.restaurant._id) } },
        });
        const res = await verify(cust, id);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_NOT_CAPTURED');
        expect(await balanceOf(cust)).toBe(0);
    });

    test("another user's recharge payment cannot be claimed", async () => {
        const payer = await createCustomer('rc-payer');
        const thief = await createCustomer('rc-thief');
        const id = ids();
        stubGateway({
            payment: { id: id.payment, order_id: id.order, status: 'captured', currency: 'INR', amount: 50000 },
            order: { id: id.order, notes: { purpose: 'wallet_recharge', userId: String(payer._id), restaurantId: String(A.restaurant._id) } },
        });
        const res = await verify(thief, id);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('RECHARGE_USER_MISMATCH');
        expect(await balanceOf(thief)).toBe(0);
    });

    test('a real payment credits what Razorpay settled (not the body amount), exactly once', async () => {
        const cust = await createCustomer('rc-ok');
        const id = ids();
        stubGateway({
            payment: { id: id.payment, order_id: id.order, status: 'captured', currency: 'INR', amount: 50000 },
            order: { id: id.order, notes: { purpose: 'wallet_recharge', userId: String(cust._id), restaurantId: String(A.restaurant._id) } },
        });
        const res = await verify(cust, id);
        expect(res.status).toBe(200);
        expect(res.body.newBalance).toBe(500);
        expect(await balanceOf(cust)).toBe(500);

        const replay = await verify(cust, id);
        expect(replay.status).toBe(200);
        expect(replay.body.alreadyCredited).toBe(true);
        expect(await balanceOf(cust)).toBe(500);
    });
});
