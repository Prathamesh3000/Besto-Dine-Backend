/**
 * Tenant isolation sweep, part 2 (checklist 3.4) — catalogue, booking and
 * staff-operations surfaces not covered by tenantIsolation.test.js:
 * branches, areas, categories, combos, halls, decoration packages,
 * booking info (event types / packages / add-ons), advance bookings,
 * tips + settlements, the staff wallet + withdrawals, shifts,
 * notifications, customer requests and refund requests.
 *
 * Same pattern as part 1: the record is written straight into tenant B
 * through its model, tenant A's owner (holding B's ids) tries read /
 * list / update / delete, and every attempt is checked on the HTTP
 * answer AND on the B document re-read from the database. Positive
 * controls prove the route paths.
 *
 * The last block checks cross-BRANCH isolation inside tenant A: a Branch
 * Admin (role admin pinned to a second branch) must not see or act on
 * the Main branch's refunds, payments, analytics, tips or withdrawals.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser } = require('./helpers/seed');
const { settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const model = (name) => require(path.join(BACKEND, 'models', name));
const Branch = model('branch');
const Area = model('area');
const Category = model('category');
const MenuItem = model('menuItem');
const Combo = model('combo');
const Hall = model('hall');
const DecorationPackage = model('decorationPackage');
const EventType = model('eventType');
const Package = model('package');
const Addon = model('addon');
const AdvanceBooking = model('advanceBooking');
const Order = model('order');
const Tip = model('tip');
const TipSettlement = model('tipSettlement');
const StaffWallet = model('staffWallet');
const StaffWithdrawal = model('staffWithdrawal');
const Shift = model('shift');
const Notification = model('notification');
const Request = model('request');
const RefundRequest = model('refundRequest');
const User = model('user');
const { defaultPermissionsForRole } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;
let B;
let customerB;
const rec = {};                       // tenant-B records under attack

const DENIED = [403, 404];
const DAY = 24 * 3600 * 1000;

const adminA = () => ctx.api.as(A.users.admin);
const adminB = () => ctx.api.as(B.users.admin);
const bodyText = (res) => JSON.stringify(res.body || {});
const lean = (Model, id) => Model.findById(id).lean();

/** A paid order written straight to the DB (no pricing / side effects). */
const paidOrder = (t, { orderId, total, branch = t.branch._id, user = null }) => Order.create({
    restaurant: t.restaurant._id,
    branch,
    orderId,
    type: 'dine-in',
    user,
    items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', price: total, quantity: 1 }],
    total,
    status: 'served',
    paymentStatus: 'Paid',
    paymentMethod: 'cash',
});

/** Pending withdrawal + the staff wallet it was debited from. */
async function pendingWithdrawal(t, staffUser, amount) {
    // Upsert: GET /staff-wallet/me lazily creates the wallet (unique per user + tenant).
    const wallet = await StaffWallet.findOneAndUpdate(
        { restaurant: t.restaurant._id, user: staffUser._id },
        { $set: { balance: 0 } },
        { upsert: true, returnDocument: 'after' },
    );
    const withdrawal = await StaffWithdrawal.create({
        restaurant: t.restaurant._id, user: staffUser._id, wallet: wallet._id, amount, method: 'Cash',
    });
    return { wallet, withdrawal };
}

beforeAll(async () => {
    A = await seedTenant({ label: 'sweep2-a' });
    B = await seedTenant({ label: 'sweep2-b' });
    const ownB = { restaurant: B.restaurant._id, branch: B.branch._id };
    customerB = await createCustomer('sweep2-b-only');

    rec.branch = await Branch.create({ restaurant: B.restaurant._id, name: 'B-Secret-Branch', slug: 'b-secret', isActive: true });
    rec.combo = await Combo.create({ ...ownB, name: 'B-Secret-Combo', description: 'b only', price: 321 });
    rec.hall = await Hall.create({ ...ownB, name: 'B-Secret-Hall', type: 'Banquet Hall', maxCapacity: 100, basePrice: 5000 });
    rec.decor = await DecorationPackage.create({ ...ownB, name: 'B-Secret-Decor', category: 'Birthday', basePrice: 900 });
    rec.eventType = await EventType.create({ ...ownB, title: 'B-Secret-Event' });
    rec.package = await Package.create({ ...ownB, name: 'B-Secret-Package', price: 700 });
    rec.addon = await Addon.create({ ...ownB, title: 'B-Secret-Addon', slug: 'b-secret-addon', price: 70 });
    rec.booking = await AdvanceBooking.create({
        ...ownB,
        bookingId: 'ADV-BSWEEP-001',
        user: customerB._id,
        bookingDate: new Date(Date.now() + 10 * DAY),
        bookingTime: '20:00',
        timeSlot: 'Dinner',
        guestCount: 4,
        payment: { totalAmount: 2000 },
    });

    rec.order = await paidOrder(B, { orderId: 'ORD-B2SWEEP-001', total: 500, user: customerB._id });
    rec.tip = await Tip.create({ restaurant: B.restaurant._id, waiter: B.users.waiter._id, order: rec.order._id, amount: 41 });
    rec.settlement = await TipSettlement.create({
        restaurant: B.restaurant._id, waiter: B.users.waiter._id, amount: 31, tipsSettledCount: 1,
        paymentMethod: 'Cash', settledBy: B.users.admin._id, notes: 'B-secret-settlement',
    });
    Object.assign(rec, await pendingWithdrawal(B, B.users.waiter, 61));
    rec.shift = await Shift.create({ restaurant: B.restaurant._id, staff: B.users.waiter._id, clockIn: new Date(Date.now() - 3600 * 1000), status: 'active' });
    rec.notification = await Notification.create({
        ...ownB, title: 'B-Secret-Notice', description: 'b only', recipientRole: 'admin', recipient: null,
    });
    rec.request = await Request.create({ ...ownB, table: B.tables.main._id, type: 'water' });
    rec.refund = await RefundRequest.create({
        ...ownB, order: rec.order._id, orderIdRef: 'ORD-B2SWEEP-001', amount: 500, customerName: 'B-Refund-Guest',
    });
    await settle();
});

describe('branches', () => {
    test("B's branches are not listed for A", async () => {
        const res = await adminA().get('/branches');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain('B-Secret-Branch');
        expect(bodyText(res)).not.toContain(String(B.branch._id));
    });

    test.each([
        ['read', (id) => adminA().get(`/branches/${id}`)],
        ['update', (id) => adminA().put(`/branches/${id}`).send({ name: 'pwned' })],
        ['disable', (id) => adminA().delete(`/branches/${id}`)],
        ['hard-delete', (id) => adminA().delete(`/branches/${id}/permanent`)],
        ['reactivate', (id) => adminA().patch(`/branches/${id}/reactivate`).send({})],
        ['sync menu into', (id) => adminA().post(`/branches/${id}/sync-menu`).send({})],
        ['sync areas into', (id) => adminA().post(`/branches/${id}/sync-areas`).send({})],
        ['create a sub-admin on', (id) => adminA().post(`/branches/${id}/subadmin`).send({
            name: 'Intruder', email: `intruder.${Date.now()}@staff.test`, password: 'Intruder#Pass123',
        })],
        ['reset the sub-admin password of', (id) => adminA().post(`/branches/${id}/subadmin/reset-password`).send({})],
    ])('A owner cannot %s a B branch', async (_label, call) => {
        const res = await call(rec.branch._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(Branch, rec.branch._id);
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('B-Secret-Branch');
        expect(saved.isActive).toBe(true);
        expect(await User.countDocuments({ branch: rec.branch._id })).toBe(0);
    });

    test("A's disable-check on a B branch counts nothing of B's", async () => {
        const res = await adminA().get(`/branches/${B.branch._id}/disable-check`);
        // Read-only probe answers 200, but every count is tenant-scoped to A.
        expect(res.status).toBe(200);
        expect(res.body.blockers).toEqual({});
        expect(res.body.warnings).toEqual({});
    });

    test('positive control: B owner reads the branch', async () => {
        const res = await adminB().get(`/branches/${rec.branch._id}`);
        expect(res.status).toBe(200);
        expect(bodyText(res)).toContain('B-Secret-Branch');
    });
});

describe('areas + categories + combos', () => {
    test("B's areas, categories and combos are not listed on tenant A", async () => {
        for (const url of ['/areas', '/categories', '/combos']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await ctx.api.guest(A).get(url);
            expect(res.status).toBe(200);
            const text = bodyText(res);
            expect(text).not.toContain(String(B.area._id));
            expect(text).not.toContain(String(B.category._id));
            expect(text).not.toContain('B-Secret-Combo');
        }
    });

    test('A admin cannot delete a B area', async () => {
        const res = await adminA().delete(`/areas/${B.area._id}`);
        expect(DENIED).toContain(res.status);
        expect(await lean(Area, B.area._id)).not.toBeNull();
        expect(await lean(model('table'), B.tables.main._id)).not.toBeNull();
    });

    test.each([
        ['read (guest)', (id) => ctx.api.guest(A).get(`/categories/${id}`)],
        ['update', (id) => adminA().put(`/categories/${id}`).send({ name: 'pwned' })],
        ['delete', (id) => adminA().delete(`/categories/${id}`)],
    ])('A cannot %s a B category', async (_label, call) => {
        const res = await call(B.category._id);
        expect(DENIED).toContain(res.status);
        expect((await lean(Category, B.category._id)).name).toBe(B.category.name);
        expect(await MenuItem.countDocuments({ category: B.category._id })).toBe(3);
    });

    test.each([
        ['read (guest)', (id) => ctx.api.guest(A).get(`/combos/${id}`)],
        ['update', (id) => adminA().put(`/combos/${id}`).send({ name: 'pwned', price: 1 })],
        ['delete', (id) => adminA().delete(`/combos/${id}`)],
    ])('A cannot %s a B combo', async (_label, call) => {
        const res = await call(rec.combo._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(Combo, rec.combo._id);
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('B-Secret-Combo');
        expect(saved.price).toBe(321);
    });

    test('positive control: B guests see the B category and combo', async () => {
        expect((await ctx.api.guest(B).get(`/categories/${B.category._id}`)).status).toBe(200);
        const combo = await ctx.api.guest(B).get(`/combos/${rec.combo._id}`);
        expect(combo.status).toBe(200);
        expect(bodyText(combo)).toContain('B-Secret-Combo');
    });
});

describe('halls + decoration packages + booking info', () => {
    test("B's hall-booking catalogue is not listed on tenant A", async () => {
        const markers = ['B-Secret-Hall', 'B-Secret-Decor', 'B-Secret-Event', 'B-Secret-Package', 'B-Secret-Addon'];
        for (const caller of [ctx.api.guest(A), adminA()]) {
            for (const url of ['/halls', '/decoration-packages', '/booking-info/resources', '/booking-info/event-types',
                '/booking-info/packages', '/booking-info/addons', '/booking-info/decorations']) {
                // eslint-disable-next-line no-await-in-loop
                const res = await caller.get(url);
                expect(res.status).toBe(200);
                for (const m of markers) expect(bodyText(res)).not.toContain(m);
            }
        }
        const admin = await adminA().get('/booking-info/addons/admin');
        expect(admin.status).toBe(200);
        expect(bodyText(admin)).not.toContain('B-Secret-Addon');
    });

    test.each([
        ['update', (id) => adminA().put(`/halls/${id}`).send({ name: 'pwned', basePrice: 1 })],
        ['delete', (id) => adminA().delete(`/halls/${id}`)],
    ])('A admin cannot %s a B hall', async (_label, call) => {
        const res = await call(rec.hall._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(Hall, rec.hall._id);
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('B-Secret-Hall');
        expect(saved.basePrice).toBe(5000);
    });

    test.each([
        ['read (guest)', (id) => ctx.api.guest(A).get(`/decoration-packages/${id}`)],
        ['update', (id) => adminA().put(`/decoration-packages/${id}`).send({ name: 'pwned', basePrice: 1 })],
        ['toggle status', (id) => adminA().patch(`/decoration-packages/${id}/status`).send({})],
        ['delete', (id) => adminA().delete(`/decoration-packages/${id}`)],
    ])('A cannot %s a B decoration package', async (_label, call) => {
        const before = await lean(DecorationPackage, rec.decor._id);
        const res = await call(rec.decor._id);
        expect(DENIED).toContain(res.status);
        const saved = await lean(DecorationPackage, rec.decor._id);
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('B-Secret-Decor');
        expect(saved.basePrice).toBe(900);
        expect(saved.isActive).toBe(before.isActive);
    });

    test.each([
        ['update event type', () => adminA().put(`/booking-info/event-types/${rec.eventType._id}`).send({ title: 'pwned' }), EventType, 'eventType', 'title', 'B-Secret-Event'],
        ['delete event type', () => adminA().delete(`/booking-info/event-types/${rec.eventType._id}`), EventType, 'eventType', 'title', 'B-Secret-Event'],
        ['update package', () => adminA().put(`/booking-info/packages/${rec.package._id}`).send({ name: 'pwned', price: 1 }), Package, 'package', 'name', 'B-Secret-Package'],
        ['delete package', () => adminA().delete(`/booking-info/packages/${rec.package._id}`), Package, 'package', 'name', 'B-Secret-Package'],
        ['update add-on', () => adminA().put(`/booking-info/addons/${rec.addon._id}`).send({ title: 'pwned', price: 1 }), Addon, 'addon', 'title', 'B-Secret-Addon'],
        ['delete add-on', () => adminA().delete(`/booking-info/addons/${rec.addon._id}`), Addon, 'addon', 'title', 'B-Secret-Addon'],
    ])('A admin cannot %s of tenant B', async (_label, call, Model, key, field, value) => {
        const res = await call();
        expect(DENIED).toContain(res.status);
        const saved = await lean(Model, rec[key]._id);
        expect(saved).not.toBeNull();
        expect(saved[field]).toBe(value);
    });

    test('positive control: B sees its own catalogue', async () => {
        expect(bodyText(await ctx.api.guest(B).get('/halls'))).toContain('B-Secret-Hall');
        expect((await ctx.api.guest(B).get(`/decoration-packages/${rec.decor._id}`)).status).toBe(200);
        expect(bodyText(await adminB().get('/booking-info/addons/admin'))).toContain('B-Secret-Addon');
    });
});

describe('advance bookings', () => {
    const bookingUnchanged = async () => {
        const saved = await lean(AdvanceBooking, rec.booking._id);
        expect(saved).not.toBeNull();
        expect(saved.status).toBe('Pending');
        expect(saved.payment.totalAmount).toBe(2000);
        expect(saved.guestCount).toBe(4);
    };

    test("B's bookings are not listed for A", async () => {
        const res = await adminA().get('/advance-booking/all');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain('ADV-BSWEEP-001');
        const mine = await ctx.api.as(customerB, A).get('/advance-booking/my-bookings');
        expect(mine.status).toBe(200);
        expect(bodyText(mine)).not.toContain('ADV-BSWEEP-001');
    });

    test.each([
        ['read', (id) => adminA().get(`/advance-booking/${id}`)],
        ['confirm', (id) => adminA().patch(`/advance-booking/${id}/status`).send({ status: 'Confirmed' })],
        ['edit details', (id) => adminA().patch(`/advance-booking/${id}/details`).send({ discount: 1500 })],
        ['delete', (id) => adminA().delete(`/advance-booking/${id}`)],
    ])('A admin cannot %s a B booking', async (_label, call) => {
        const res = await call(rec.booking._id);
        expect(DENIED).toContain(res.status);
        expect(bodyText(res)).not.toContain('ADV-BSWEEP-001');
        await bookingUnchanged();
    });

    test.each([
        ['preview cancellation', (id) => ctx.api.as(customerB, A).get(`/advance-booking/${id}/cancel-preview`)],
        ['cancel', (id) => ctx.api.as(customerB, A).post(`/advance-booking/${id}/cancel`).send({})],
    ])('the owning customer cannot %s a B booking through tenant A', async (_label, call) => {
        const res = await call(rec.booking._id);
        expect(DENIED).toContain(res.status);
        await bookingUnchanged();
    });

    test('positive control: B admin reads the booking', async () => {
        const res = await adminB().get(`/advance-booking/${rec.booking._id}`);
        expect(res.status).toBe(200);
        expect(bodyText(res)).toContain('ADV-BSWEEP-001');
    });
});

describe('tips + settlements', () => {
    test("B's pending tips and settlement history are not listed for A", async () => {
        const pending = await adminA().get('/tips/pending');
        expect(pending.status).toBe(200);
        expect(bodyText(pending)).not.toContain(String(B.users.waiter._id));
        const history = await adminA().get('/tips/history');
        expect(history.status).toBe(200);
        expect(bodyText(history)).not.toContain(String(rec.settlement._id));
    });

    test("A admin cannot settle a B waiter's tips", async () => {
        const res = await adminA().post('/tips/settle').send({ waiterId: String(B.users.waiter._id), paymentMethod: 'Cash' });
        // Tips are looked up tenant-scoped, so A finds nothing to settle.
        expect([400, 403, 404]).toContain(res.status);
        expect((await lean(Tip, rec.tip._id)).status).toBe('pending');
        expect(await TipSettlement.countDocuments({ waiter: B.users.waiter._id })).toBe(1);
    });

    test('positive control: B admin sees the pending tip and the settlement', async () => {
        expect(bodyText(await adminB().get('/tips/pending'))).toContain(String(B.users.waiter._id));
        expect(bodyText(await adminB().get('/tips/history'))).toContain(String(rec.settlement._id));
    });
});

describe('staff wallet + withdrawals', () => {
    test("B's withdrawals are not listed for A", async () => {
        const res = await adminA().get('/staff-wallet/withdrawals');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(rec.withdrawal._id));
        expect(res.body.pendingCount).toBe(0);
    });

    test.each([
        ['approve', (id) => adminA().post(`/staff-wallet/withdrawals/${id}/approve`).send({ txnRef: 'x' })],
        ['reject', (id) => adminA().post(`/staff-wallet/withdrawals/${id}/reject`).send({ reason: 'x' })],
    ])('A admin cannot %s a B withdrawal', async (_label, call) => {
        const res = await call(rec.withdrawal._id);
        expect(DENIED).toContain(res.status);
        expect((await lean(StaffWithdrawal, rec.withdrawal._id)).status).toBe('pending');
        expect((await lean(StaffWallet, rec.wallet._id)).balance).toBe(0);
    });

    test("an A waiter's own wallet never shows B's ledger", async () => {
        const res = await ctx.api.as(A.users.waiter).get('/staff-wallet/me');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(rec.withdrawal._id));
    });

    test('positive control: B admin lists the withdrawal', async () => {
        expect(bodyText(await adminB().get('/staff-wallet/withdrawals'))).toContain(String(rec.withdrawal._id));
    });
});

describe('shifts', () => {
    test("A admin cannot read a B waiter's shifts or force-clock them out", async () => {
        const list = await adminA().get(`/shifts/staff/${B.users.waiter._id}`);
        expect(list.status).toBe(200);
        expect(list.body.shifts).toHaveLength(0);
        expect(list.body.activeShift).toBeNull();

        const res = await adminA().post(`/shifts/${rec.shift._id}/force-clockout`).send({ note: 'pwned' });
        expect(DENIED).toContain(res.status);
        const saved = await lean(Shift, rec.shift._id);
        expect(saved.status).toBe('active');
        expect(saved.clockOut || null).toBeNull();
    });

    test('positive control: B admin sees the shift', async () => {
        const res = await adminB().get(`/shifts/staff/${B.users.waiter._id}`);
        expect(res.status).toBe(200);
        expect(res.body.shifts).toHaveLength(1);
    });
});

describe('notifications', () => {
    test("B's admin broadcast is not delivered to A's admin", async () => {
        const res = await adminA().get('/notifications');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain('B-Secret-Notice');
    });

    test.each([
        ['mark read', (id) => adminA().put(`/notifications/${id}/read`).send({})],
        ['delete', (id) => adminA().delete(`/notifications/${id}`)],
        ['mark all read', () => adminA().put('/notifications/all/read').send({})],
        ['clear all', () => adminA().delete('/notifications/clear')],
    ])("A admin %s does not touch B's notification", async (_label, call) => {
        const res = await call(rec.notification._id);
        // These endpoints are idempotent no-ops on a scope miss (200), so
        // the proof is the B document, not the status.
        expect([200, 403, 404]).toContain(res.status);
        const saved = await lean(Notification, rec.notification._id);
        expect(saved).not.toBeNull();
        expect(saved.status).toBe('unread');
    });

    test('positive control: B admin receives the broadcast', async () => {
        expect(bodyText(await adminB().get('/notifications'))).toContain('B-Secret-Notice');
    });
});

describe('customer requests', () => {
    test("B's table requests are invisible through tenant A", async () => {
        const staff = await ctx.api.as(A.users.waiter).get('/requests');
        expect(staff.status).toBe(200);
        expect(bodyText(staff)).not.toContain(String(rec.request._id));

        const guest = await ctx.api.guest(A).get(`/requests/active/table/${B.tables.main._id}`);
        expect(guest.status).toBe(200);
        expect(guest.body.count).toBe(0);
    });

    test('A waiter cannot accept a B request', async () => {
        const res = await ctx.api.as(A.users.waiter).put(`/requests/${rec.request._id}/status`).send({ status: 'accepted' });
        expect(DENIED).toContain(res.status);
        expect((await lean(Request, rec.request._id)).status).toBe('pending');
    });

    test('positive control: B waiter sees the request', async () => {
        expect(bodyText(await ctx.api.as(B.users.waiter).get('/requests'))).toContain(String(rec.request._id));
    });
});

describe('refund requests', () => {
    test("B's refund requests are not listed for A", async () => {
        const res = await adminA().get('/refund-requests');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain('B-Refund-Guest');
        expect(res.body.totalItems).toBe(0);
    });

    test.each([
        ['approve', (id) => adminA().post(`/refund-requests/${id}/approve`).send({ note: 'x' })],
        ['reject', (id) => adminA().post(`/refund-requests/${id}/reject`).send({ note: 'x' })],
    ])('A admin cannot %s a B refund request', async (_label, call) => {
        const res = await call(rec.refund._id);
        expect(DENIED).toContain(res.status);
        expect((await lean(RefundRequest, rec.refund._id)).status).toBe('pending');
        expect((await lean(Order, rec.order._id)).paymentStatus).toBe('Paid');
    });

    test('positive control: B admin lists the refund request', async () => {
        expect(bodyText(await adminB().get('/refund-requests'))).toContain('B-Refund-Guest');
    });
});

// ─── Cross-BRANCH isolation inside tenant A ────────────────────────────
describe('branch-pinned admin (cross-branch inside one tenant)', () => {
    const main = {};
    let branchAdmin;
    const pinnedA = () => ctx.api.as(branchAdmin);

    beforeAll(async () => {
        const second = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: 'second', isActive: true });
        branchAdmin = await createUser({
            name: 'Branch Admin sweep2',
            email: `branch-admin.${A.slug}@staff.test`,
            role: 'admin',
            restaurant: A.restaurant._id,
            branch: second._id,
            isTenantOwner: false,
            permissions: defaultPermissionsForRole('admin'),
        });
        // Everything below lives on A's MAIN branch (A.users.waiter is pinned there).
        main.order = await paidOrder(A, { orderId: 'ORD-AMAIN-001', total: 43210 });
        main.refund = await RefundRequest.create({
            restaurant: A.restaurant._id, branch: A.branch._id, order: main.order._id,
            orderIdRef: 'ORD-AMAIN-001', amount: 100, customerName: 'Main-Refund-Guest',
        });
        main.tip = await Tip.create({ restaurant: A.restaurant._id, waiter: A.users.waiter._id, order: main.order._id, amount: 77 });
        main.settlement = await TipSettlement.create({
            restaurant: A.restaurant._id, waiter: A.users.waiter._id, amount: 55, tipsSettledCount: 1,
            paymentMethod: 'Cash', settledBy: A.users.admin._id,
        });
        Object.assign(main, await pendingWithdrawal(A, A.users.waiter, 66));
        main.request = await Request.create({ restaurant: A.restaurant._id, branch: A.branch._id, table: A.tables.main._id, type: 'bill' });
    });

    test('refund requests: Main-branch requests are hidden and cannot be decided', async () => {
        const list = await pinnedA().get('/refund-requests');
        expect(list.status).toBe(200);
        expect(bodyText(list)).not.toContain('Main-Refund-Guest');
        const res = await pinnedA().post(`/refund-requests/${main.refund._id}/approve`).send({ note: 'x' });
        expect(res.status).toBe(404);
        expect((await lean(RefundRequest, main.refund._id)).status).toBe('pending');
    });

    test.each([
        ['default scope', ''],
        ['?branch=all widening attempt', '?branch=all'],
    ])('payments + analytics exclude Main-branch revenue (%s)', async (_label, qs) => {
        const payments = await pinnedA().get(`/payments/admin/all${qs}`);
        expect(payments.status).toBe(200);
        expect(bodyText(payments)).not.toContain('ORD-AMAIN-001');
        const summary = await pinnedA().get(`/analytics/summary${qs}`);
        expect(summary.status).toBe(200);
        expect(summary.body.summary.revenue).toBe(0);
        expect(bodyText(await pinnedA().get(`/analytics/sales-history${qs}`))).not.toContain('43210');
    });

    test('customer requests: Main-branch table calls are hidden', async () => {
        const res = await pinnedA().get('/requests');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(main.request._id));
    });

    test("tips: Main-branch waiters' pending tips are hidden and cannot be settled", async () => {
        const pending = await pinnedA().get('/tips/pending');
        expect(pending.status).toBe(200);
        expect(bodyText(pending)).not.toContain(String(A.users.waiter._id));
        const settleRes = await pinnedA().post('/tips/settle').send({ waiterId: String(A.users.waiter._id), paymentMethod: 'Cash' });
        expect(settleRes.status).toBe(403);
        expect((await lean(Tip, main.tip._id)).status).toBe('pending');
    });

    // Regression (fixed 2026-10): getSettlementHistory narrows a pinned admin to settlements of their branch's waiters.
    test("tips: a branch admin does not see the Main branch's tip-settlement history", async () => {
        const res = await pinnedA().get('/tips/history');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(main.settlement._id));
    });

    // Regression (fixed 2026-10): list/approve/reject withdrawals scope a pinned admin to staff of their branch.
    test("staff wallet: a branch admin does not list the Main branch's withdrawals", async () => {
        const res = await pinnedA().get('/staff-wallet/withdrawals');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(main.withdrawal._id));
    });

    test("staff wallet: a branch admin cannot reject a Main-branch waiter's withdrawal", async () => {
        // Regression (fixed 2026-10): rejectWithdrawal applies the same branch scope (404 for other-branch rows).
        const res = await pinnedA().post(`/staff-wallet/withdrawals/${main.withdrawal._id}/reject`).send({ reason: 'cross-branch' });
        const saved = await lean(StaffWithdrawal, main.withdrawal._id);
        expect(saved.status).toBe('pending');
        expect(DENIED).toContain(res.status);
    });

    test('positive control: the tenant owner sees every Main-branch record', async () => {
        expect(bodyText(await adminA().get('/refund-requests'))).toContain('Main-Refund-Guest');
        expect(bodyText(await adminA().get('/payments/admin/all'))).toContain('ORD-AMAIN-001');
        expect((await adminA().get('/analytics/summary')).body.summary.revenue).toBe(43210);
        expect(bodyText(await adminA().get('/tips/pending'))).toContain(String(A.users.waiter._id));
        expect(bodyText(await adminA().get('/requests'))).toContain(String(main.request._id));
    });
});
