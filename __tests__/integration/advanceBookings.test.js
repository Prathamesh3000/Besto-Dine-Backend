/**
 * Advance bookings end to end — controllers/advanceBookingController.js
 * plus the catalog controllers that feed it (hallController,
 * decorationPackageController, bookingInfoController).
 *
 * Coverage:
 *   - create: table + hall, price recomputed from the catalog (client
 *     total ignored), shape / date / guest / capacity / duration rules,
 *     hall slot overlap, branch derived from the table
 *   - wallet points: negative, more than balance, other tenant's wallet,
 *     exact rupee value, concurrent double use
 *   - Razorpay advance / full payment: signature, gateway fail-closed,
 *     capture state, purpose / tenant / payer / food-order binding,
 *     50 % advance boundary (₹1 tolerance), single-use claim
 *   - remaining-balance checkout + verify (binding, amount, replay)
 *   - customer cancellation: refund tiers (preview == cancel), ownership,
 *     already cancelled / completed
 *   - admin: list / get scoped by tenant + branch pin, status changes
 *     with customer notification, details edit (applyBookingDetailsEdit
 *     over HTTP), delete
 *   - customer sees only their own bookings; guests cannot book
 *   - halls / decoration packages / booking-info catalog CRUD + public
 *     listing scope
 *
 * Tests whose name starts with "BUG:" pin behaviour the handlers get
 * wrong today; they are expected to fail until the source is fixed.
 */
const crypto = require('crypto');
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, setWallet } = require('./helpers/seed');
const { settle } = require('./helpers/http');
const rzp = require('./helpers/razorpayMock');

const BACKEND = path.join(__dirname, '..', '..');
const AdvanceBooking = require(path.join(BACKEND, 'models/advanceBooking'));
const Hall = require(path.join(BACKEND, 'models/hall'));
const DecorationPackage = require(path.join(BACKEND, 'models/decorationPackage'));
const Package = require(path.join(BACKEND, 'models/package'));
const Addon = require(path.join(BACKEND, 'models/addon'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const Transaction = require(path.join(BACKEND, 'models/transaction'));
const PaymentClaim = require(path.join(BACKEND, 'models/paymentClaim'));
const Notification = require(path.join(BACKEND, 'models/notification'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Category = require(path.join(BACKEND, 'models/category'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const EventType = require(path.join(BACKEND, 'models/eventType'));
const logger = require(path.join(BACKEND, 'utils/logger'));

const ctx = useIntegrationApp();
let A;
let B;
let decor600;     // A: decoration ₹600 (prices a table booking)
let hall;         // A: ₹5000, 10–100 guests
let pkg250;       // A: ₹250 / guest
let dj;           // A: add-on ₹1000 (duration scaled)
let hallB;        // B: a hall of another tenant

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const rid = () => crypto.randomBytes(5).toString('hex');
const sig = (orderId, paymentId, secret = KEY_SECRET) =>
    crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

/** YYYY-MM-DD `days` from now (UTC). */
const dayStr = (days) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

beforeAll(async () => {
    A = await seedTenant({ label: 'bk-a' });
    B = await seedTenant({ label: 'bk-b' });
    decor600 = await DecorationPackage.create({ restaurant: A.restaurant._id, name: 'Balloon Theme', category: 'Birthday', basePrice: 600 });
    hall = await Hall.create({
        restaurant: A.restaurant._id, name: 'Grand Hall', type: 'Banquet Hall',
        minCapacity: 10, maxCapacity: 100, basePrice: 5000,
    });
    pkg250 = await Package.create({ restaurant: A.restaurant._id, name: 'Classic Veg', price: 250 });
    dj = await Addon.create({ restaurant: A.restaurant._id, title: 'DJ', slug: 'dj', price: 1000 });
    hallB = await Hall.create({
        restaurant: B.restaurant._id, name: 'Other Hall', type: 'Banquet Hall', maxCapacity: 100, basePrice: 9000,
    });
});

// ── Helpers ──────────────────────────────────────────────────────────

// Each table booking defaults to its own date: one table cannot be
// advance-booked twice for the same slot (see 'hall double booking'), so
// tests that are not about availability must not collide on A's table.
// (Previously every call used dayStr(7) and relied on double booking.)
let tableDay = 200;
const tableBody = (t, extra = {}) => ({
    bookingType: 'table',
    selectedDate: dayStr(tableDay++),
    selectedTime: '7-8 PM',
    selectedStartTime: '19:00',
    selectedTimeType: 'Dinner',
    guests: 2,
    selectedTypes: [String(t.area._id)],
    selectedTableIds: [String(t.tables.main._id)],
    selectedDecor: { id: String(decor600._id) },
    paymentMethod: 'cash',
    ...extra,
});

const hallBody = (extra = {}) => ({
    bookingType: 'hall',
    selectedDate: dayStr(20),
    selectedTime: '6:00 PM',
    selectedStartTime: '18:00',
    guests: 40,
    selectedHallId: String(hall._id),
    paymentMethod: 'cash',
    ...extra,
});

const create = (user, t, body) => ctx.api.as(user, t).post('/advance-booking/create').send(body);
const reload = (id) => AdvanceBooking.findById(id).lean();
const countA = () => AdvanceBooking.countDocuments({ restaurant: A.restaurant._id });

/**
 * Stub the gateway for one checkout and return the browser-side proof.
 * Notes default to a booking checkout opened by /razorpay/create-order
 * for tenant `t` and `payer`.
 */
function checkout({ t = A, payer, rupees, status = 'captured', notes = {}, paymentId = `pay_${rid()}` }) {
    const orderId = `order_${rid()}`;
    const n = {
        restaurantId: String(t.restaurant._id),
        purpose: 'cafe_order',
        cafeOrderId: 'none',
        ...(payer ? { userId: String(payer._id) } : {}),
        ...notes,
    };
    const amount = Math.round(rupees * 100);
    rzp.instance.payments.fetch.mockResolvedValue({
        id: paymentId, entity: 'payment', order_id: orderId, status, amount, currency: 'INR', notes: n,
    });
    rzp.instance.orders.fetch.mockResolvedValue({ id: orderId, entity: 'order', amount, notes: n });
    return {
        paymentId,
        orderId,
        body: {
            paymentMethod: 'online',
            razorpayPaymentId: paymentId,
            razorpay_order_id: orderId,
            razorpay_signature: sig(orderId, paymentId),
        },
    };
}

/** Insert a booking directly (for cancellation / admin tests). */
async function seedBooking(user, fields = {}, payment = {}) {
    const doc = await AdvanceBooking.create({
        bookingId: `BKT-${rid()}`,
        user: user._id,
        restaurant: A.restaurant._id,
        branch: A.branch._id,
        bookingType: 'table',
        tables: [A.tables.main._id],
        bookingDate: new Date(Date.now() + 10 * 24 * 3600 * 1000),
        bookingTime: '7-8 PM',
        timeSlot: 'Dinner',
        guestCount: 2,
        ...fields,
        payment: { totalAmount: 1000, advancePaid: 0, status: 'Pending', method: 'cash', ...payment },
    });
    return doc.toObject();
}

// ── create: pricing + shape ──────────────────────────────────────────

describe('POST /advance-booking/create — price from the catalog', () => {
    test('table booking with a decoration is priced at ₹600, Pending with nothing paid, branch from the table', async () => {
        const cust = await createCustomer('bk-price');
        const res = await create(cust, A, tableBody(A));

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.booking.bookingId).toMatch(/^BKT-/);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment).toMatchObject({
            totalAmount: 600, advancePaid: 0, status: 'Pending', method: 'cash', walletPointsUsed: 0, razorpayPaymentId: null,
        });
        expect(doc.payment.priceBreakdown).toMatchObject({ decoration: 600, parking: 0, addon: 0, discount: 0, points: 0 });
        expect(doc.addons.decoration).toMatchObject({ id: String(decor600._id), title: 'Balloon Theme', price: 600 });
        expect(String(doc.branch)).toBe(String(A.branch._id));
        expect(String(doc.restaurant)).toBe(String(A.restaurant._id));
        expect(doc.timeSlot).toBe('Dinner');
        expect(doc.startTime).toBe('19:00');
        expect(String(doc.user)).toBe(String(cust._id));
    });

    test('a client total that differs by more than ₹1 is ignored — the server price is stored and the mismatch logged', async () => {
        const cust = await createCustomer('bk-mismatch');
        const before = logger.__records.length;
        const res = await create(cust, A, tableBody(A, { total: 1 }));

        expect(res.status).toBe(201);
        expect((await reload(res.body.booking._id)).payment.totalAmount).toBe(600);
        const warned = logger.__records.slice(before).filter((r) => r.level === 'warn'
            && String(r.args[0]).includes('client total differs'));
        expect(warned).toHaveLength(1);
        expect(warned[0].args[1]).toMatchObject({ clientTotal: 1, serverTotal: 600 });
    });

    test('hall + per-guest package + 4h DJ: 5000 + 250×40 + 800 = ₹15,800 exactly', async () => {
        const cust = await createCustomer('bk-hall-price');
        const res = await create(cust, A, hallBody({
            selectedDate: dayStr(40),
            selectedPackage: { _id: String(pkg250._id) },
            selectedAddons: [String(dj._id)],
            addonSelections: { [String(dj._id)]: { duration: '4' } },
            durationHours: 6,
            total: 99999,
        }));

        expect(res.status).toBe(201);
        expect(res.body.booking.bookingId).toMatch(/^BKH-/);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment.totalAmount).toBe(15800);
        expect(doc.payment.priceBreakdown).toMatchObject({ hall: 5000, package: 10000, addon: 800 });
        expect(doc.addons.otherAddons).toEqual([expect.objectContaining({ title: 'DJ', price: 800 })]);
        expect(doc.durationHours).toBe(6);
        expect(doc.branch).toBeNull();
    });

    test.each([
        ['an unknown booking type', { bookingType: 'room' }],
        ['a table booking without tables', { selectedTableIds: [] }],
        ['a date in the past', { selectedDate: dayStr(-2) }],
        ['an unparsable date', { selectedDate: 'next friday' }],
        ['no date', { selectedDate: '' }],
        ['zero guests', { guests: 0 }],
        ['more than 2000 guests', { guests: 2001 }],
        ['negative wallet points', { walletPointsUsed: -5 }],
        ['a malformed table id', { selectedTableIds: ['not-an-id'] }],
    ])('table: rejects %s with 400 and creates nothing', async (_label, extra) => {
        const cust = await createCustomer('bk-bad');
        const before = await countA();
        const res = await create(cust, A, tableBody(A, extra));
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(await countA()).toBe(before);
    });

    test('table + hall in one request is refused', async () => {
        const cust = await createCustomer('bk-mix');
        const res = await create(cust, A, tableBody(A, { selectedHallId: String(hall._id) }));
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Pick either a hall OR tables, not both');
    });

    test.each([
        ['more guests than the hall holds', { guests: 101 }, 'HALL_CAPACITY_EXCEEDED'],
        ['fewer guests than the hall minimum', { guests: 9 }, 'HALL_CAPACITY_BELOW_MIN'],
        ['a 3-hour block', { durationHours: 3 }, undefined],
        ['no hall', { selectedHallId: undefined }, undefined],
        ['individual tables', {}, undefined],
    ])('hall: rejects %s with 400', async (_label, extra, code) => {
        const cust = await createCustomer('bk-hall-bad');
        const body = hallBody(extra);
        if (_label === 'individual tables') body.selectedTableIds = [String(A.tables.main._id)];
        const before = await countA();
        const res = await create(cust, A, body);
        expect(res.status).toBe(400);
        if (code) expect(res.body.code).toBe(code);
        expect(await countA()).toBe(before);
    });

    test('capacity boundaries are inclusive: exactly 10 and exactly 100 guests are accepted', async () => {
        const cust = await createCustomer('bk-cap');
        const lo = await create(cust, A, hallBody({ guests: 10, selectedDate: dayStr(41) }));
        const hi = await create(cust, A, hallBody({ guests: 100, selectedDate: dayStr(42) }));
        expect(lo.status).toBe(201);
        expect(hi.status).toBe(201);
        expect((await reload(hi.body.booking._id)).payment.totalAmount).toBe(5000);
    });

    test('a guest (no login) cannot book', async () => {
        const res = await ctx.api.guest(A).post('/advance-booking/create').send(tableBody(A));
        expect(res.status).toBe(401);
    });

    test('a hall that belongs to another tenant (or does not exist) is refused instead of booked at ₹0', async () => {
        // Regression (fixed 2026-10): createAdvanceBooking 404s a hall not found in this tenant instead of pricing it at ₹0.
        const cust = await createCustomer('bk-foreign-hall');
        const before = await countA();
        const res = await create(cust, A, hallBody({ selectedHallId: String(hallB._id), selectedDate: dayStr(43), guests: 1500 }));

        expect(res.status).toBe(404);
        expect(await countA()).toBe(before);
    });

    test('a deactivated hall cannot be booked', async () => {
        // Regression (fixed 2026-10): createAdvanceBooking refuses (400 HALL_UNAVAILABLE) a hall with isActive:false.
        const off = await Hall.create({
            restaurant: A.restaurant._id, name: 'Closed Hall', type: 'Auditorium', maxCapacity: 50, basePrice: 3000, isActive: false,
        });
        const cust = await createCustomer('bk-off-hall');
        const res = await create(cust, A, hallBody({ selectedHallId: String(off._id), guests: 20 }));

        expect(res.status).toBe(400);
        expect(await AdvanceBooking.countDocuments({ hall: off._id })).toBe(0);
    });
});

// ── coupon + cake pricing ────────────────────────────────────────────

describe('fully covered bookings', () => {
    // Regression (fixed 2026-10): a booking whose total is ₹0 after points
    // had no payment to verify and was saved 'Pending' at ₹0 forever.
    test('a booking fully covered by points is saved as Paid without a payment', async () => {
        const cust = await createCustomer('ab-zero');
        await setWallet(A, cust, { loyaltyPoints: 100000 });

        const res = await create(cust, A, tableBody(A, { walletPointsUsed: 100000 }));

        expect(res.status).toBe(201);
        const saved = await AdvanceBooking.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean();
        expect(saved.payment.totalAmount).toBe(0);
        expect(saved.payment.status).toBe('Paid');
        expect(saved.payment.advancePaid).toBe(0);
    });
});

describe('coupon and cake lines', () => {
    const coupon = (fields) => Coupon.create({
        restaurant: A.restaurant._id, title: 'Test coupon', discountType: 'percentage', discountValue: 10,
        endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000), isActive: true, ...fields,
    });

    test('10 % coupon capped at ₹50 (code matched case-insensitively): ₹600 → ₹550', async () => {
        await coupon({ code: 'BOOK10', maxDiscountAmount: 50 });
        const cust = await createCustomer('bk-cpn');
        const res = await create(cust, A, tableBody(A, { couponCode: 'book10' }));
        expect(res.status).toBe(201);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment).toMatchObject({ totalAmount: 550, couponCode: 'book10' });
        expect(doc.payment.priceBreakdown.discount).toBe(50);
    });

    test('coupon + points stack in order: 600 − 15 % (90) − 200 pts (₹20) = ₹490', async () => {
        await coupon({ code: 'STACK15', discountValue: 15 });
        const cust = await createCustomer('bk-cpn-pts');
        await setWallet(A, cust, { loyaltyPoints: 200 });
        const res = await create(cust, A, tableBody(A, { couponCode: 'STACK15', walletPointsUsed: 200 }));
        expect(res.status).toBe(201);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment.totalAmount).toBe(490);
        expect(doc.payment.priceBreakdown).toMatchObject({ discount: 90, points: 20 });
    });

    test.each([
        ['an expired coupon', { code: 'OLD10', endDate: new Date(Date.now() - 3600 * 1000) }, 'A'],
        ['an inactive coupon', { code: 'OFF10', isActive: false }, 'A'],
        ['a coupon with an unmet minimum', { code: 'MIN10', minOrderValue: 601 }, 'A'],
        ['an exhausted coupon', { code: 'USED10', usageLimit: 5, usageCount: 5 }, 'A'],
        ['a beverages-only coupon', { code: 'BEV10', scope: 'beverages' }, 'A'],
        ['another tenant’s coupon', { code: 'BEE10' }, 'B'],
    ])('%s gives no discount (booking still priced at ₹600)', async (_label, fields, owner) => {
        await coupon({ ...fields, restaurant: (owner === 'B' ? B : A).restaurant._id });
        const cust = await createCustomer('bk-cpn-bad');
        const res = await create(cust, A, tableBody(A, { couponCode: fields.code }));
        expect(res.status).toBe(201);
        expect((await reload(res.body.booking._id)).payment.totalAmount).toBe(600);
    });

    test('a once-per-customer coupon used on a booking cannot be used again', async () => {
        // Regression (fixed 2026-10): createAdvanceBooking atomically bumps Coupon.usageCount (within usageLimit) and writes a CouponRedemption row.
        const c = await coupon({ code: 'ONCE20', discountValue: 20, usageLimit: 1, usagePerUser: 1 });
        const cust = await createCustomer('bk-cpn-once');
        const r1 = await create(cust, A, tableBody(A, { couponCode: 'ONCE20' }));
        const r2 = await create(cust, A, tableBody(A, { couponCode: 'ONCE20', selectedDate: dayStr(9) }));
        expect((await reload(r1.body.booking._id)).payment.totalAmount).toBe(480);

        expect({
            usageCount: (await Coupon.findById(c._id).lean()).usageCount,
            secondTotal: (await reload(r2.body.booking._id)).payment.totalAmount,
        }).toEqual({ usageCount: 1, secondTotal: 600 });
    });

    test('cake: size price × quantity from the catalog (₹450 × 2) + decoration = ₹1500', async () => {
        const cakes = await Category.create({ restaurant: A.restaurant._id, name: `Cakes ${rid()}` });
        const cake = await MenuItem.create({
            restaurant: A.restaurant._id, category: cakes._id, name: 'Truffle', description: 'cake', basePrice: 400,
            sizes: [{ name: '500 g', price: 450 }, { name: '1 kg', price: 850 }],
        });
        const half = cake.sizes[0];
        const cust = await createCustomer('bk-cake');
        const res = await create(cust, A, tableBody(A, {
            selectedFlavor: String(cake._id), selectedFlavorName: 'Truffle', selectedSize: String(half._id), selectedSizeName: '500 g', quantity: 2,
        }));
        expect(res.status).toBe(201);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment.totalAmount).toBe(1500);
        expect(doc.payment.priceBreakdown).toMatchObject({ cake: 900, decoration: 600 });
        expect(doc.cakeDetails).toMatchObject({ quantity: 2, flavor: 'Truffle', size: '500 g', isSkipped: false });

        const list = await ctx.api.guest(A).get('/booking-info/cakes');
        expect(list.status).toBe(200);
        expect(list.body.cakes.map((x) => x.name)).toContain('Truffle');
    });

    test('a size id belonging to a different item is not priced', async () => {
        const other = await MenuItem.create({
            restaurant: A.restaurant._id, category: A.category._id, name: 'Plain', description: 'x', basePrice: 1,
            sizes: [{ name: 'S', price: 9999 }],
        });
        const cust = await createCustomer('bk-cake-x');
        const res = await create(cust, A, tableBody(A, {
            selectedFlavor: String(A.items.thali._id), selectedSize: String(other.sizes[0]._id), quantity: 1,
        }));
        expect(res.status).toBe(201);
        expect((await reload(res.body.booking._id)).payment.totalAmount).toBe(600);
    });
});

// ── hall slot availability ───────────────────────────────────────────

describe('hall double booking', () => {
    const D = dayStr(30);
    let first;

    beforeAll(async () => {
        const cust = await createCustomer('bk-slot-1');
        first = await create(cust, A, hallBody({ selectedDate: D, selectedStartTime: '18:00', durationHours: 5 }));
        expect(first.status).toBe(201);
    });

    test.each([
        ['the same start time', '18:00', 5, 409],
        ['a start inside the block', '20:00', 5, 409],
        ['a block ending inside it', '13:00', 6, 409],
        ['a block ending exactly at its start (12–18)', '12:00', 6, 201],
    ])('a second booking at %s → %i', async (_label, start, hours, status) => {
        const cust = await createCustomer('bk-slot-n');
        const res = await create(cust, A, hallBody({ selectedDate: D, selectedStartTime: start, durationHours: hours }));
        expect(res.status).toBe(status);
        if (status === 409) expect(res.body.code).toBe('HALL_SLOT_TAKEN');
        else await AdvanceBooking.deleteOne({ _id: res.body.booking._id });
    });

    test('a cancelled booking frees the slot', async () => {
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${first.body.booking._id}/status`).send({ status: 'Cancelled' });
        expect(res.status).toBe(200);
        const cust = await createCustomer('bk-slot-free');
        const again = await create(cust, A, hallBody({ selectedDate: D, selectedStartTime: '18:00', durationHours: 5 }));
        expect(again.status).toBe(201);
    });

    test('the same table cannot be advance-booked twice for the same date and time', async () => {
        // Regression (fixed 2026-10): createAdvanceBooking runs a slot-overlap check for tables like halls (409 TABLE_SLOT_TAKEN).
        const c1 = await createCustomer('bk-tbl-1');
        const c2 = await createCustomer('bk-tbl-2');
        const body = tableBody(A, { selectedDate: dayStr(33), selectedDecor: undefined });
        const r1 = await create(c1, A, body);
        const r2 = await create(c2, A, body);

        expect(r1.status).toBe(201);
        expect(r2.status).toBe(409);
    });
});

// ── wallet points ────────────────────────────────────────────────────

describe('wallet points on a booking', () => {
    test('1000 points at ₹0.1 take exactly ₹100 off the ₹600 booking and are debited with a ledger row', async () => {
        const cust = await createCustomer('bk-pts');
        await setWallet(A, cust, { loyaltyPoints: 1500 });

        const res = await create(cust, A, tableBody(A, { walletPointsUsed: 1000 }));

        expect(res.status).toBe(201);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment.totalAmount).toBe(500);
        expect(doc.payment.priceBreakdown.points).toBe(100);
        expect(doc.payment.walletPointsUsed).toBe(1000);
        const w = await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean();
        expect(w.loyaltyPoints).toBe(500);
        const tx = await Transaction.find({ user: cust._id, type: 'points_redeemed' }).lean();
        expect(tx).toHaveLength(1);
        expect(tx[0]).toMatchObject({ amount: -1000, balanceBefore: 1500, balanceAfter: 500, paymentMethod: 'points', status: 'completed' });
        expect(String(tx[0].restaurant)).toBe(String(A.restaurant._id));
    });

    test('more points than the balance is refused and nothing moves', async () => {
        const cust = await createCustomer('bk-pts-over');
        await setWallet(A, cust, { loyaltyPoints: 50 });
        const before = await countA();

        const res = await create(cust, A, tableBody(A, { walletPointsUsed: 51 }));

        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Insufficient wallet points. Available: 50');
        expect(await countA()).toBe(before);
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).loyaltyPoints).toBe(50);
    });

    test('points held in another tenant’s wallet cannot be spent here', async () => {
        const cust = await createCustomer('bk-pts-xt');
        await setWallet(B, cust, { loyaltyPoints: 5000 });
        const res = await create(cust, A, tableBody(A, { walletPointsUsed: 100 }));
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Insufficient wallet points. Available: 0');
        expect((await Wallet.findOne({ user: cust._id, restaurant: B.restaurant._id }).lean()).loyaltyPoints).toBe(5000);
    });

    test('two concurrent bookings spending the same 1000 points: exactly one succeeds', async () => {
        const cust = await createCustomer('bk-pts-race');
        await setWallet(A, cust, { loyaltyPoints: 1000 });
        const before = await countA();

        const results = await Promise.all([
            create(cust, A, tableBody(A, { walletPointsUsed: 1000 })),
            create(cust, A, tableBody(A, { walletPointsUsed: 1000 })),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
        expect(await countA()).toBe(before + 1);
        expect((await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean()).loyaltyPoints).toBe(0);
        expect(await Transaction.countDocuments({ user: cust._id, type: 'points_redeemed' })).toBe(1);
    });

    test('redeeming more points than the booking needs only deducts the points actually used', async () => {
        // Regression (fixed 2026-10): only the points the capped rupee value needs (loadBookingPrice.pointsUsed) are debited and stored.
        const cust = await createCustomer('bk-pts-cap');
        await setWallet(A, cust, { loyaltyPoints: 10000 });

        const res = await create(cust, A, tableBody(A, { walletPointsUsed: 10000 }));

        expect(res.status).toBe(201);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment.totalAmount).toBe(0);
        expect(doc.payment.priceBreakdown.points).toBe(600);
        const w = await Wallet.findOne({ user: cust._id, restaurant: A.restaurant._id }).lean();
        expect(w.loyaltyPoints).toBe(4000);
        expect(doc.payment.walletPointsUsed).toBe(6000);
    });
});

// ── Razorpay advance / full payment ──────────────────────────────────

describe('online payment at booking time', () => {
    test('a captured ₹600 payment marks the booking Paid and claims the payment id for it', async () => {
        const cust = await createCustomer('bk-pay-full');
        const co = checkout({ payer: cust, rupees: 600 });

        const res = await create(cust, A, tableBody(A, co.body));

        expect(res.status).toBe(201);
        const doc = await reload(res.body.booking._id);
        expect(doc.payment).toMatchObject({
            totalAmount: 600, advancePaid: 600, status: 'Paid', method: 'online',
            razorpayPaymentId: co.paymentId, razorpayOrderId: co.orderId,
        });
        const claim = await PaymentClaim.findOne({ paymentId: co.paymentId }).lean();
        expect(claim).toMatchObject({ purpose: 'advance_booking', ref: doc.bookingId, amount: 600 });
        expect(rzp.instance.payments.fetch).toHaveBeenCalledWith(co.paymentId);
        expect(rzp.instance.orders.fetch).toHaveBeenCalledWith(co.orderId);
    });

    test.each([
        [300, 'Partial', 300],     // exactly the 50 % advance
        [299, 'Partial', 299],     // ₹1 tolerance below the advance
        [599, 'Paid', 599],        // ₹1 tolerance below the total
        [750, 'Paid', 600],        // overpayment is capped at the total
    ])('₹%d against a ₹600 booking → %s with ₹%d recorded', async (paid, status, recorded) => {
        const cust = await createCustomer('bk-pay-tier');
        const co = checkout({ payer: cust, rupees: paid });
        const res = await create(cust, A, tableBody(A, co.body));
        expect(res.status).toBe(201);
        expect((await reload(res.body.booking._id)).payment).toMatchObject({ status, advancePaid: recorded });
    });

    test('₹298.99 does not cover the ₹300 advance: 400 AMOUNT_INSUFFICIENT, no booking, no claim', async () => {
        const cust = await createCustomer('bk-pay-short');
        const co = checkout({ payer: cust, rupees: 298.99 });
        const before = await countA();
        const res = await create(cust, A, tableBody(A, co.body));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AMOUNT_INSUFFICIENT');
        expect(await countA()).toBe(before);
        expect(await PaymentClaim.countDocuments({ paymentId: co.paymentId })).toBe(0);
    });

    test('one payment cannot pay for two bookings', async () => {
        const cust = await createCustomer('bk-pay-reuse');
        const co = checkout({ payer: cust, rupees: 600 });
        const first = await create(cust, A, tableBody(A, co.body));
        expect(first.status).toBe(201);
        const before = await countA();

        const second = await create(cust, A, tableBody(A, { ...co.body, selectedDate: dayStr(8) }));

        expect(second.status).toBe(409);
        expect(second.body.code).toBe('PAYMENT_ALREADY_USED');
        expect(await countA()).toBe(before);
        expect(await PaymentClaim.countDocuments({ paymentId: co.paymentId })).toBe(1);
    });

    test.each([
        ['another tenant’s payment', (c) => ({ notes: { restaurantId: String(B.restaurant._id) } }), 403, 'TENANT_MISMATCH'],
        ['a payment with no tenant stamp', () => ({ notes: { restaurantId: undefined } }), 403, 'TENANT_MISMATCH'],
        ['a different customer’s payment', () => ({ notes: { userId: '0123456789abcdef01234567' } }), 403, 'PAYER_MISMATCH'],
        ['a food-order payment', () => ({ notes: { cafeOrderId: '0123456789abcdef01234567' } }), 400, 'PAYMENT_ORDER_MISMATCH'],
        ['a wallet top-up payment', () => ({ notes: { purpose: 'wallet_recharge' } }), 400, 'PAYMENT_PURPOSE_MISMATCH'],
        ['an authorised-but-failed payment', () => ({ status: 'failed' }), 400, 'PAYMENT_NOT_CAPTURED'],
    ])('refuses %s', async (_label, opts, status, code) => {
        const cust = await createCustomer('bk-pay-bad');
        const co = checkout({ payer: cust, rupees: 600, ...opts(cust) });
        const before = await countA();
        const res = await create(cust, A, tableBody(A, co.body));
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(await countA()).toBe(before);
        expect(await PaymentClaim.countDocuments({ paymentId: co.paymentId })).toBe(0);
    });

    test('a forged checkout signature is refused before the gateway is asked', async () => {
        const cust = await createCustomer('bk-pay-sig');
        const co = checkout({ payer: cust, rupees: 600 });
        const res = await create(cust, A, tableBody(A, { ...co.body, razorpay_signature: sig(co.orderId, co.paymentId, 'wrong') }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PAYMENT_SIGNATURE_INVALID');
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });

    test('gateway unreachable → 502, fail closed', async () => {
        const cust = await createCustomer('bk-pay-down');
        const co = checkout({ payer: cust, rupees: 600 });
        rzp.instance.payments.fetch.mockRejectedValue(new Error('ETIMEDOUT'));
        const before = await countA();
        const res = await create(cust, A, tableBody(A, co.body));
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('GATEWAY_UNAVAILABLE');
        expect(await countA()).toBe(before);
    });

    test('paymentMethod "cash" ignores any Razorpay ids: Pending, ₹0 paid, gateway never called', async () => {
        const cust = await createCustomer('bk-pay-cash');
        const co = checkout({ payer: cust, rupees: 600 });
        const res = await create(cust, A, tableBody(A, { ...co.body, paymentMethod: 'cash' }));
        expect(res.status).toBe(201);
        expect((await reload(res.body.booking._id)).payment).toMatchObject({ status: 'Pending', advancePaid: 0, razorpayPaymentId: null });
        expect(rzp.instance.payments.fetch).not.toHaveBeenCalled();
    });
});

// ── remaining balance ────────────────────────────────────────────────

describe('remaining-balance payment', () => {
    let cust;
    let booking;

    beforeAll(async () => {
        cust = await createCustomer('bk-rem');
        booking = await seedBooking(cust, {}, { totalAmount: 600, advancePaid: 300, status: 'Partial', method: 'online' });
    });

    const remCheckout = (rupees, notes = {}) => {
        const doc = { kind: 'advance-booking-remaining', bookingId: String(booking._id), restaurantId: String(A.restaurant._id), ...notes };
        return { doc };
    };

    test('create opens a ₹300 (30000 paise) checkout bound to the booking and stamps its id', async () => {
        rzp.instance.orders.create.mockImplementation(async (o) => ({ id: `order_${rid()}`, amount: o.amount, currency: o.currency, receipt: o.receipt, notes: o.notes }));

        const res = await ctx.api.as(cust, A).post(`/advance-booking/${booking._id}/create-remaining-payment`).send({});

        expect(res.status).toBe(200);
        expect(res.body.booking.remainingAmount).toBe(300);
        const opts = rzp.instance.orders.create.mock.calls[0][0];
        expect(opts.amount).toBe(30000);
        expect(opts.receipt.length).toBeLessThanOrEqual(40);
        expect(opts.notes).toEqual({
            bookingId: String(booking._id), bookingCode: booking.bookingId,
            restaurantId: String(A.restaurant._id), kind: 'advance-booking-remaining',
        });
        expect((await reload(booking._id)).payment.remainingRazorpayOrderId).toBe(res.body.razorpayOrder.id);
    });

    test('another customer cannot open or verify this booking’s balance', async () => {
        const other = await createCustomer('bk-rem-other');
        const a = await ctx.api.as(other, A).post(`/advance-booking/${booking._id}/create-remaining-payment`).send({});
        const b = await ctx.api.as(other, A).post(`/advance-booking/${booking._id}/verify-remaining-payment`)
            .send({ razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 's' });
        expect(a.status).toBe(404);
        expect(b.status).toBe(404);
    });

    test('verify: a different Razorpay order, an underpayment and a bad signature are all refused', async () => {
        const stamped = (await reload(booking._id)).payment.remainingRazorpayOrderId;
        const pay = `pay_${rid()}`;
        const verify = (body) => ctx.api.as(cust, A).post(`/advance-booking/${booking._id}/verify-remaining-payment`).send(body);

        const wrongOrder = await verify({ razorpay_order_id: 'order_other', razorpay_payment_id: pay, razorpay_signature: sig('order_other', pay) });
        expect(wrongOrder.status).toBe(400);

        const badSig = await verify({ razorpay_order_id: stamped, razorpay_payment_id: pay, razorpay_signature: sig(stamped, pay, 'nope') });
        expect(badSig.status).toBe(400);
        expect(badSig.body.message).toBe('Invalid payment signature');

        const { doc } = remCheckout();
        rzp.instance.payments.fetch.mockResolvedValue({ id: pay, order_id: stamped, status: 'captured', amount: 29900, currency: 'INR', notes: doc });
        rzp.instance.orders.fetch.mockResolvedValue({ id: stamped, notes: doc });
        const short = await verify({ razorpay_order_id: stamped, razorpay_payment_id: pay, razorpay_signature: sig(stamped, pay) });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('PAYMENT_AMOUNT_MISMATCH');

        rzp.instance.payments.fetch.mockResolvedValue({ id: pay, order_id: stamped, status: 'captured', amount: 30000, currency: 'INR', notes: { ...doc, restaurantId: String(B.restaurant._id) } });
        rzp.instance.orders.fetch.mockResolvedValue({ id: stamped, notes: { ...doc, restaurantId: String(B.restaurant._id) } });
        const xt = await verify({ razorpay_order_id: stamped, razorpay_payment_id: pay, razorpay_signature: sig(stamped, pay) });
        expect(xt.status).toBe(403);

        const after = await reload(booking._id);
        expect(after.payment).toMatchObject({ status: 'Partial', advancePaid: 300 });
        expect(await PaymentClaim.countDocuments({ paymentId: pay })).toBe(0);
    });

    test('a payment already spent elsewhere cannot settle the balance', async () => {
        const stamped = (await reload(booking._id)).payment.remainingRazorpayOrderId;
        const pay = `pay_${rid()}`;
        await PaymentClaim.create({ paymentId: pay, purpose: 'wallet_recharge', ref: 'x', amount: 300 });
        const { doc } = remCheckout();
        rzp.instance.payments.fetch.mockResolvedValue({ id: pay, order_id: stamped, status: 'captured', amount: 30000, currency: 'INR', notes: doc });
        rzp.instance.orders.fetch.mockResolvedValue({ id: stamped, notes: doc });

        const res = await ctx.api.as(cust, A).post(`/advance-booking/${booking._id}/verify-remaining-payment`)
            .send({ razorpay_order_id: stamped, razorpay_payment_id: pay, razorpay_signature: sig(stamped, pay) });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_ALREADY_USED');
        expect((await reload(booking._id)).payment.status).toBe('Partial');
    });

    test('a captured ₹300 settles the booking (Paid, ₹600, online); a replay is idempotent', async () => {
        const stamped = (await reload(booking._id)).payment.remainingRazorpayOrderId;
        const pay = `pay_${rid()}`;
        const { doc } = remCheckout();
        rzp.instance.payments.fetch.mockResolvedValue({ id: pay, order_id: stamped, status: 'captured', amount: 30000, currency: 'INR', notes: doc });
        rzp.instance.orders.fetch.mockResolvedValue({ id: stamped, notes: doc });
        const body = { razorpay_order_id: stamped, razorpay_payment_id: pay, razorpay_signature: sig(stamped, pay) };

        const res = await ctx.api.as(cust, A).post(`/advance-booking/${booking._id}/verify-remaining-payment`).send(body);

        expect(res.status).toBe(200);
        const after = await reload(booking._id);
        expect(after.payment).toMatchObject({ status: 'Paid', advancePaid: 600, method: 'online' });
        expect(after.payment.fullyPaidAt).toBeTruthy();
        expect(await PaymentClaim.findOne({ paymentId: pay }).lean()).toMatchObject({ purpose: 'advance_booking', ref: `${booking.bookingId}:remaining`, amount: 300 });
        await settle();
        expect(await Notification.countDocuments({ recipient: cust._id, title: 'Payment Received' })).toBe(1);

        const replay = await ctx.api.as(cust, A).post(`/advance-booking/${booking._id}/verify-remaining-payment`).send(body);
        expect(replay.status).toBe(200);
        expect(replay.body.alreadyPaid).toBe(true);

        const again = await ctx.api.as(cust, A).post(`/advance-booking/${booking._id}/create-remaining-payment`).send({});
        expect(again.status).toBe(400);
        expect(again.body.message).toBe('This booking is already fully paid.');
    });

    test('a cancelled booking cannot open a balance checkout', async () => {
        const b = await seedBooking(cust, { status: 'Cancelled' }, { totalAmount: 600, advancePaid: 300, status: 'Partial' });
        const res = await ctx.api.as(cust, A).post(`/advance-booking/${b._id}/create-remaining-payment`).send({});
        expect(res.status).toBe(400);
        expect(rzp.instance.orders.create).not.toHaveBeenCalled();
    });
});

// ── customer cancellation ────────────────────────────────────────────

describe('customer cancellation + refund policy', () => {
    const H = 3600 * 1000;

    test.each([
        ['≥ 48h ahead', 72 * H, 1000, 100, 1000, 'Full refund (≥ 48h notice)'],
        ['exactly 49h ahead', 49 * H, 1000, 100, 1000, 'Full refund (≥ 48h notice)'],
        ['24–48h ahead', 30 * H, 1000, 50, 500, '50% refund (24–48h notice)'],
        ['24–48h with a paise advance (rounded to the rupee)', 30 * H, 301, 50, 151, '50% refund (24–48h notice)'],
        ['< 24h ahead', 10 * H, 1000, 0, 0, 'Non-refundable (< 24h)'],
        ['after the event', -5 * H, 1000, 0, 0, 'Non-refundable (< 24h)'],
    ])('%s: preview and cancel agree on the refund', async (_label, offset, paid, pct, amount, tier) => {
        const cust = await createCustomer('bk-cxl');
        const b = await seedBooking(cust, { bookingDate: new Date(Date.now() + offset) }, { totalAmount: 2000, advancePaid: paid, status: 'Partial' });

        const prev = await ctx.api.as(cust, A).get(`/advance-booking/${b._id}/cancel-preview`);
        expect(prev.status).toBe(200);
        expect(prev.body.preview).toMatchObject({ advancePaid: paid, refundPct: pct, refundAmount: amount, refundTier: tier, cancellable: true });

        const res = await ctx.api.as(cust, A).post(`/advance-booking/${b._id}/cancel`).send({ reason: 'plans changed' });
        expect(res.status).toBe(200);
        expect(res.body.booking.cancellation).toMatchObject({ refundPct: pct, refundAmount: amount, refundTier: tier, cancelledBy: 'customer', reason: 'plans changed' });
        const doc = await reload(b._id);
        expect(doc.status).toBe('Cancelled');
        expect(doc.cancellation).toMatchObject({ refundPct: pct, refundAmount: amount, policy: 'standard-v1' });
    });

    test('the admin is told about the refund due (category coerced to a valid one)', async () => {
        const cust = await createCustomer('bk-cxl-n');
        const b = await seedBooking(cust, { bookingDate: new Date(Date.now() + 72 * H) }, { advancePaid: 400, status: 'Partial' });
        await ctx.api.as(cust, A).post(`/advance-booking/${b._id}/cancel`).send({});
        await settle();
        const n = await Notification.findOne({
            restaurant: A.restaurant._id, title: 'Booking Cancelled by Customer', description: new RegExp(b.bookingId),
        }).lean();
        expect(n).toBeTruthy();
        expect(n).toMatchObject({ recipientRole: 'admin', priority: 'high', category: 'System' });
        expect(n.description).toBe(`${b.bookingId} — Full refund (≥ 48h notice). Refund due: ₹400`);
    });

    test('booking notifications keep the booking reference in meta', async () => {
        // Regression (fixed 2026-10): models/notification.js meta allows bookingId / bookingDocId / refundAmount / refundPct.
        const cust = await createCustomer('bk-cxl-meta');
        const b = await seedBooking(cust, { bookingDate: new Date(Date.now() + 72 * H) }, { advancePaid: 400, status: 'Partial' });
        await ctx.api.as(cust, A).post(`/advance-booking/${b._id}/cancel`).send({});
        await settle();
        const n = await Notification.findOne({
            restaurant: A.restaurant._id, title: 'Booking Cancelled by Customer', description: new RegExp(b.bookingId),
        }).lean();
        expect(n.meta).toMatchObject({ bookingId: b.bookingId, bookingDocId: String(b._id), refundAmount: 400 });
    });

    test('already cancelled / completed bookings cannot be cancelled; preview says not cancellable', async () => {
        const cust = await createCustomer('bk-cxl-state');
        const c = await seedBooking(cust, { status: 'Cancelled' });
        const d = await seedBooking(cust, { status: 'Completed' });
        const r1 = await ctx.api.as(cust, A).post(`/advance-booking/${c._id}/cancel`).send({});
        const r2 = await ctx.api.as(cust, A).post(`/advance-booking/${d._id}/cancel`).send({});
        expect(r1.status).toBe(400);
        expect(r1.body.code).toBe('ALREADY_CANCELLED');
        expect(r2.status).toBe(400);
        expect(r2.body.code).toBe('BOOKING_COMPLETED');
        const p = await ctx.api.as(cust, A).get(`/advance-booking/${d._id}/cancel-preview`);
        expect(p.body.preview.cancellable).toBe(false);
    });

    test('another customer (or the same customer on another tenant) cannot cancel or preview it', async () => {
        const owner = await createCustomer('bk-cxl-own');
        const other = await createCustomer('bk-cxl-oth');
        const b = await seedBooking(owner);
        expect((await ctx.api.as(other, A).post(`/advance-booking/${b._id}/cancel`).send({})).status).toBe(404);
        expect((await ctx.api.as(other, A).get(`/advance-booking/${b._id}/cancel-preview`)).status).toBe(404);
        expect((await ctx.api.as(owner, B).post(`/advance-booking/${b._id}/cancel`).send({})).status).toBe(404);
        expect((await reload(b._id)).status).toBe('Pending');
    });

    test('the refund window is measured to the event start time, not to midnight of the booking date', async () => {
        // Regression (fixed 2026-10): cancel + preview measure to bookingDate + startTime in the tenant timezone (bookingEventStart).
        const cust = await createCustomer('bk-cxl-time');
        const midnight = new Date(`${new Date(Date.now() + 24 * H).toISOString().slice(0, 10)}T00:00:00.000Z`);
        const b = await seedBooking(cust, { bookingDate: midnight, startTime: '23:00', bookingTime: '11:00 PM' }, { advancePaid: 1000, status: 'Partial' });

        const realNow = Date.now;
        const spy = jest.spyOn(Date, 'now').mockImplementation(() => midnight.getTime() - 44 * H);
        let res;
        try {
            res = await ctx.api.as(cust, A).get(`/advance-booking/${b._id}/cancel-preview`);
        } finally {
            spy.mockRestore();
            Date.now = realNow;
        }

        expect(res.status).toBe(200);
        expect(res.body.preview.refundPct).toBe(100);
        expect(res.body.preview.refundAmount).toBe(1000);
    });
});

// ── admin side ───────────────────────────────────────────────────────

describe('admin management', () => {
    let cust;
    let booking;
    let branch2;
    let subAdmin2;

    beforeAll(async () => {
        cust = await createCustomer('bk-adm');
        const co = checkout({ payer: cust, rupees: 800 });
        const res = await create(cust, A, tableBody(A, {
            ...co.body, selectedAddons: [String(dj._id)], selectedDate: dayStr(12),
        }));
        expect(res.status).toBe(201);
        booking = await reload(res.body.booking._id);
        expect(booking.payment).toMatchObject({ totalAmount: 1600, advancePaid: 800, status: 'Partial' });

        branch2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Second', slug: `second-${rid()}`, isActive: true });
        subAdmin2 = await createUser({
            name: 'Sub admin 2', email: `sub2.${rid()}@staff.test`, role: 'admin',
            restaurant: A.restaurant._id, branch: branch2._id, permissions: {},
        });
    });

    test('customers cannot reach admin endpoints', async () => {
        expect((await ctx.api.as(cust, A).get('/advance-booking/all')).status).toBe(403);
        expect((await ctx.api.as(cust, A).patch(`/advance-booking/${booking._id}/status`).send({ status: 'Confirmed' })).status).toBe(403);
        expect((await ctx.api.as(cust, A).delete(`/advance-booking/${booking._id}`)).status).toBe(403);
    });

    test('tenant owner sees it; another tenant’s admin and another branch’s sub-admin do not', async () => {
        const all = await ctx.api.as(A.users.admin).get('/advance-booking/all');
        expect(all.status).toBe(200);
        expect(all.body.bookings.map((b) => String(b._id))).toContain(String(booking._id));
        expect(all.body.bookings.every((b) => String(b.restaurant) === String(A.restaurant._id))).toBe(true);

        const allB = await ctx.api.as(B.users.admin).get('/advance-booking/all');
        expect(allB.body.bookings.map((b) => String(b._id))).not.toContain(String(booking._id));
        expect((await ctx.api.as(B.users.admin).get(`/advance-booking/${booking._id}`)).status).toBe(404);
        expect((await ctx.api.as(B.users.admin).patch(`/advance-booking/${booking._id}/status`).send({ status: 'Cancelled' })).status).toBe(404);

        const sub = await ctx.api.as(subAdmin2).get('/advance-booking/all');
        expect(sub.status).toBe(200);
        expect(sub.body.bookings.map((b) => String(b._id))).not.toContain(String(booking._id));
        expect((await ctx.api.as(subAdmin2).get(`/advance-booking/${booking._id}`)).status).toBe(404);
        expect((await ctx.api.as(subAdmin2).patch(`/advance-booking/${booking._id}/details`).send({ discount: 100 })).status).toBe(404);
        expect((await reload(booking._id)).status).toBe('Pending');
    });

    test('Confirmed notifies the customer of the exact ₹800 balance due', async () => {
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${booking._id}/status`).send({ status: 'Confirmed' });
        expect(res.status).toBe(200);
        expect((await reload(booking._id)).status).toBe('Confirmed');
        await settle();
        const n = await Notification.findOne({ recipient: cust._id, title: 'Booking Confirmed' }).lean();
        expect(n).toMatchObject({ category: 'Payment', priority: 'high', recipientRole: 'customer' });
        expect(n.description).toBe(`Your booking ${booking.bookingId} is confirmed for ${new Date(booking.bookingDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. ₹800 balance is due before the event.`);

        // Saving the same status again does not re-notify.
        await ctx.api.as(A.users.admin).patch(`/advance-booking/${booking._id}/status`).send({ status: 'Confirmed' });
        await settle();
        expect(await Notification.countDocuments({ recipient: cust._id, title: 'Booking Confirmed' })).toBe(1);
    });

    test('an unknown status is refused', async () => {
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${booking._id}/status`).send({ status: 'Paid' });
        expect(res.status).toBe(400);
    });

    test('details edit: +₹150 add-on and ₹50 discount → ₹1700, audit row with the exact numbers', async () => {
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${booking._id}/details`).send({
            addons: [{ title: 'DJ', price: 1000 }, { title: 'Balloons', price: 150 }],
            discount: 50,
        });
        expect(res.status).toBe(200);
        const doc = await reload(booking._id);
        expect(doc.payment).toMatchObject({ totalAmount: 1700, advancePaid: 800, status: 'Partial' });
        expect(doc.addons.otherAddons.map((a) => [a.title, a.price])).toEqual([['DJ', 1000], ['Balloons', 150]]);
        expect(doc.addons.otherAddons[0].id).toBe(String(dj._id)); // catalog line kept
        const edits = doc.payment.priceBreakdown.adminEdits;
        expect(edits[edits.length - 1]).toMatchObject({ previousTotal: 1600, delta: 150, discount: 50, newTotal: 1700 });
    });

    test('details edit: a discount larger than the balance is capped so the total never drops below what was paid', async () => {
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${booking._id}/details`).send({ discount: 100000 });
        expect(res.status).toBe(200);
        const doc = await reload(booking._id);
        expect(doc.payment).toMatchObject({ totalAmount: 800, status: 'Paid' });
        const edits = doc.payment.priceBreakdown.adminEdits;
        expect(edits[edits.length - 1]).toMatchObject({ previousTotal: 1700, discount: 900, newTotal: 800 });
    });

    test.each([
        ['a non-editable field', { status: 'Completed' }],
        ['an empty body', {}],
        ['a negative discount', { discount: -1 }],
        ['a negative add-on price', { addons: [{ title: 'X', price: -5 }] }],
    ])('details edit refuses %s', async (_l, body) => {
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${booking._id}/details`).send(body);
        expect(res.status).toBe(400);
    });

    test('a completed booking can no longer be edited', async () => {
        const b = await seedBooking(cust, { status: 'Completed' });
        const res = await ctx.api.as(A.users.admin).patch(`/advance-booking/${b._id}/details`).send({ discount: 10 });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('A completed booking can no longer be edited');
    });

    test('delete: owner deletes; another tenant cannot', async () => {
        const b = await seedBooking(cust);
        expect((await ctx.api.as(B.users.admin).delete(`/advance-booking/${b._id}`)).status).toBe(404);
        expect(await reload(b._id)).toBeTruthy();
        expect((await ctx.api.as(A.users.admin).delete(`/advance-booking/${b._id}`)).status).toBe(200);
        expect(await reload(b._id)).toBeNull();
    });
});

// ── customer listing ─────────────────────────────────────────────────

describe('GET /advance-booking/my-bookings', () => {
    test('a customer sees only their own bookings, only on this tenant', async () => {
        const me = await createCustomer('bk-mine');
        const other = await createCustomer('bk-theirs');
        const mine = await seedBooking(me);
        await seedBooking(other);

        const res = await ctx.api.as(me, A).get('/advance-booking/my-bookings');
        expect(res.status).toBe(200);
        expect(res.body.bookings.map((b) => String(b._id))).toEqual([String(mine._id)]);

        const onB = await ctx.api.as(me, B).get('/advance-booking/my-bookings');
        expect(onB.body.bookings).toEqual([]);
    });
});

// ── catalog: halls / decorations / booking-info ──────────────────────

describe('hall + decoration + booking-info catalog', () => {
    test('admin creates a hall in their own tenant even if the body names another', async () => {
        const res = await ctx.api.as(A.users.admin).post('/halls').send({
            name: 'Garden', type: 'Outdoor Space', maxCapacity: 80, basePrice: 4000, restaurant: String(B.restaurant._id),
        });
        expect(res.status).toBe(201);
        const doc = await Hall.findById(res.body.hall._id).lean();
        expect(String(doc.restaurant)).toBe(String(A.restaurant._id));
        expect(doc.branch).toBeNull();
    });

    test('public hall list shows only this tenant’s halls', async () => {
        const res = await ctx.api.guest(A).get('/halls');
        expect(res.status).toBe(200);
        const ids = res.body.halls.map((h) => String(h._id));
        expect(ids).toContain(String(hall._id));
        expect(ids).not.toContain(String(hallB._id));
    });

    test('hall update / delete by another tenant’s admin is a 404 and changes nothing', async () => {
        expect((await ctx.api.as(B.users.admin).put(`/halls/${hall._id}`).send({ basePrice: 1 })).status).toBe(404);
        expect((await ctx.api.as(B.users.admin).delete(`/halls/${hall._id}`)).status).toBe(404);
        expect((await Hall.findById(hall._id).lean()).basePrice).toBe(5000);
    });

    test('hall create refuses a branch of another tenant', async () => {
        const res = await ctx.api.as(A.users.admin).post('/halls').send({
            name: 'X', type: 'Auditorium', maxCapacity: 10, basePrice: 1, branch: String(B.branch._id),
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Branch not found in this tenant');
    });

    test.each([
        ['hall', '/halls', { name: 'Neg', type: 'Auditorium', maxCapacity: 10, basePrice: -500 }],
        ['hall capacity', '/halls', { name: 'NegCap', type: 'Auditorium', maxCapacity: -10, minCapacity: 50, basePrice: 100 }],
        ['decoration package', '/decoration-packages', { name: 'Neg', category: 'X', basePrice: -500 }],
        ['menu package', '/booking-info/packages', { name: 'Neg', price: -500 }],
    ])('%s create rejects a negative price / impossible capacity', async (_label, url, body) => {
        // Regression (fixed 2026-10): hall / decoration / package schemas have min:0 (hall maxCapacity min:1, min ≤ max checked in hallController).
        const res = await ctx.api.as(A.users.admin).post(url).send(body);
        expect(res.status).toBe(400);
    });

    test('public decoration list: only active packages of this tenant; toggling status hides one', async () => {
        const on = await ctx.api.as(A.users.admin).post('/decoration-packages').send({ name: 'Floral', category: 'Wedding', basePrice: 1200 });
        expect(on.status).toBe(201);
        const bDecor = await DecorationPackage.create({ restaurant: B.restaurant._id, name: 'B only', category: 'X', basePrice: 10 });

        const list1 = await ctx.api.guest(A).get('/decoration-packages');
        const ids1 = list1.body.decorPackages.map((d) => String(d._id));
        expect(ids1).toContain(on.body.decorPackage._id);
        expect(ids1).not.toContain(String(bDecor._id));

        const tog = await ctx.api.as(A.users.admin).patch(`/decoration-packages/${on.body.decorPackage._id}/status`).send({});
        expect(tog.status).toBe(200);
        expect(tog.body.decorPackage.isActive).toBe(false);

        const list2 = await ctx.api.guest(A).get('/decoration-packages');
        expect(list2.body.decorPackages.map((d) => String(d._id))).not.toContain(on.body.decorPackage._id);
        const viaInfo = await ctx.api.guest(A).get('/booking-info/decorations');
        expect(viaInfo.status).toBe(200);
        expect(JSON.stringify(viaInfo.body)).not.toContain(on.body.decorPackage._id);

        // Another tenant's admin cannot touch it.
        expect((await ctx.api.as(B.users.admin).put(`/decoration-packages/${on.body.decorPackage._id}`).send({ basePrice: 1 })).status).toBe(404);
        expect((await ctx.api.as(B.users.admin).patch(`/decoration-packages/${on.body.decorPackage._id}/status`).send({})).status).toBe(404);
    });

    test('add-ons: validation (title, slug format, negative price, duplicate slug) and active-only public list', async () => {
        const post = (body) => ctx.api.as(A.users.admin).post('/booking-info/addons').send(body);
        expect((await post({ slug: 'x', price: 1 })).status).toBe(400);
        expect((await post({ title: 'X', slug: 'Bad Slug', price: 1 })).body.code).toBe('INVALID_SLUG');
        expect((await post({ title: 'X', slug: 'neg', price: -1 })).status).toBe(400);
        expect((await post({ title: 'DJ again', slug: 'dj', price: 1 })).status).toBe(409);

        const ok = await post({ title: 'Magician', slug: 'magician', price: 0 });
        expect(ok.status).toBe(201);
        const hidden = await post({ title: 'Hidden', slug: 'hidden', price: 5, isActive: false });
        expect(hidden.status).toBe(201);

        const list = await ctx.api.guest(A).get('/booking-info/addons');
        expect(list.status).toBe(200);
        const titles = JSON.stringify(list.body);
        expect(titles).toContain('Magician');
        expect(titles).not.toContain('"Hidden"');

        const upd = await ctx.api.as(A.users.admin).put(`/booking-info/addons/${ok.body.addon._id}`).send({ price: -3 });
        expect(upd.status).toBe(400);
        expect((await Addon.findById(ok.body.addon._id).lean()).price).toBe(0);
    });

    test('event types + packages: admin CRUD, active-only public reads, tenant isolation', async () => {
        const admin = ctx.api.as(A.users.admin);
        const et = await admin.post('/booking-info/event-types').send({ title: 'Birthday' });
        expect(et.status).toBe(201);
        const pk = await admin.post('/booking-info/packages').send({ name: 'Royal', price: 900 });
        expect(pk.status).toBe(201);
        const hiddenPk = await admin.post('/booking-info/packages').send({ name: 'Retired', price: 1, isActive: false });
        expect(hiddenPk.status).toBe(201);

        const pubPk = await ctx.api.guest(A).get('/booking-info/packages');
        expect(pubPk.status).toBe(200);
        expect(JSON.stringify(pubPk.body)).toContain('Royal');
        expect(JSON.stringify(pubPk.body)).not.toContain('Retired');
        const pubEt = await ctx.api.guest(A).get('/booking-info/event-types');
        expect(JSON.stringify(pubEt.body)).toContain('Birthday');
        expect(JSON.stringify((await ctx.api.guest(B).get('/booking-info/packages')).body)).not.toContain('Royal');

        const res = await ctx.api.guest(A).get('/booking-info/resources');
        expect(res.status).toBe(200);
        expect(res.body.eventTypes.map((e) => e.title)).toContain('Birthday');
        expect(res.body.decorations.every((d) => d.isActive && String(d.restaurant) === String(A.restaurant._id))).toBe(true);

        const pkId = pk.body.package._id;
        const etId = et.body.eventType._id;
        expect((await ctx.api.as(B.users.admin).put(`/booking-info/packages/${pkId}`).send({ price: 1 })).status).toBe(404);
        expect((await ctx.api.as(B.users.admin).delete(`/booking-info/event-types/${etId}`)).status).toBe(404);
        expect((await admin.put(`/booking-info/packages/${pkId}`).send({ price: 950, restaurant: String(B.restaurant._id) })).status).toBe(200);
        const pkDoc = await Package.findById(pkId).lean();
        expect(pkDoc.price).toBe(950);
        expect(String(pkDoc.restaurant)).toBe(String(A.restaurant._id));
        expect((await admin.put(`/booking-info/event-types/${etId}`).send({ title: 'Bday' })).status).toBe(200);
        expect((await EventType.findById(etId).lean()).title).toBe('Bday');
        expect((await admin.delete(`/booking-info/event-types/${etId}`)).status).toBe(200);
        expect((await admin.delete(`/booking-info/packages/${pkId}`)).status).toBe(200);
        expect(await Package.findById(pkId)).toBeNull();
    });

    test('a branch-pinned sub-admin creates catalog rows at their branch and sees / edits only those', async () => {
        const b2 = await Branch.create({ restaurant: A.restaurant._id, name: 'Cat2', slug: `cat2-${rid()}`, isActive: true });
        const sub = await createUser({
            name: 'Sub cat', email: `subcat.${rid()}@staff.test`, role: 'admin', restaurant: A.restaurant._id, branch: b2._id, permissions: {},
        });
        const made = await ctx.api.as(sub).post('/decoration-packages').send({ name: 'Branch decor', category: 'X', basePrice: 10, branch: String(A.branch._id) });
        expect(made.status).toBe(201);
        expect(String(made.body.decorPackage.branch)).toBe(String(b2._id));
        const h = await ctx.api.as(sub).post('/halls').send({ name: 'Branch hall', type: 'Auditorium', maxCapacity: 10, basePrice: 1 });
        expect(h.status).toBe(201);
        expect(String(h.body.hall.branch)).toBe(String(b2._id));

        const subList = await ctx.api.as(sub).get('/halls');
        expect(subList.body.halls.map((x) => x.name)).toEqual(['Branch hall']);

        const own = await DecorationPackage.create({ restaurant: A.restaurant._id, branch: A.branch._id, name: 'Main only', category: 'X', basePrice: 5 });
        expect((await ctx.api.as(sub).put(`/decoration-packages/${own._id}`).send({ basePrice: 1 })).status).toBe(404);
        expect((await ctx.api.as(sub).delete(`/decoration-packages/${own._id}`)).status).toBe(404);
        expect((await ctx.api.as(sub).get(`/decoration-packages/${own._id}`)).status).toBe(404);
        expect((await ctx.api.as(A.users.admin).get(`/decoration-packages/${own._id}`)).status).toBe(200);
        const upd = await ctx.api.as(A.users.admin).put(`/decoration-packages/${own._id}`).send({ basePrice: 7, restaurant: String(B.restaurant._id) });
        expect(upd.status).toBe(200);
        expect(upd.body.decorPackage).toMatchObject({ basePrice: 7, restaurant: String(A.restaurant._id) });
        expect((await ctx.api.as(A.users.admin).delete(`/decoration-packages/${own._id}`)).status).toBe(200);
        expect(await DecorationPackage.findById(own._id)).toBeNull();

        const hu = await ctx.api.as(A.users.admin).put(`/halls/${h.body.hall._id}`).send({ status: false, basePrice: 2 });
        expect(hu.status).toBe(200);
        expect(hu.body.hall).toMatchObject({ isActive: false, basePrice: 2 });
        expect((await ctx.api.as(A.users.admin).delete(`/halls/${h.body.hall._id}`)).status).toBe(200);
    });

    test('customers cannot use the admin catalog endpoints', async () => {
        const cust = await createCustomer('bk-cat');
        expect((await ctx.api.as(cust, A).post('/halls').send({ name: 'x' })).status).toBe(403);
        expect((await ctx.api.as(cust, A).post('/decoration-packages').send({ name: 'x' })).status).toBe(403);
        expect((await ctx.api.as(cust, A).post('/booking-info/addons').send({ title: 'x' })).status).toBe(403);
    });
});
