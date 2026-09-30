/**
 * Tenant isolation (BUGS_REPORT #30): tenant A's staff, holding B's real
 * document ids, can neither read nor change tenant B's orders, tables,
 * menu, staff, customers or reservations. Every write attempt is checked
 * twice: the HTTP answer (403/404, no B data in the body) AND the B
 * document in the database (unchanged).
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createTable, createCustomer, setWallet } = require('./helpers/seed');
const { scanTable, settle } = require('./helpers/http');

const BACKEND = path.join(__dirname, '..', '..');
const Order = require(path.join(BACKEND, 'models/order'));
const Table = require(path.join(BACKEND, 'models/table'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const User = require(path.join(BACKEND, 'models/user'));
const Area = require(path.join(BACKEND, 'models/area'));
const Reservation = require(path.join(BACKEND, 'models/reservation'));

const ctx = useIntegrationApp();
let A;
let B;
let orderB;
let tableB;
let customerB;
let reservationB;

const DENIED = [403, 404];
const TOTAL = 250; // 200 + 5% + 10% + ₹20

async function placeGuestOrder(t, table) {
    const { scanToken } = await scanTable(ctx.api, table);
    const res = await ctx.api.guest(t, scanToken).post('/orders').send({
        type: 'dine-in',
        tableId: String(table._id),
        items: [{ menuItem: String(t.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }],
        total: TOTAL,
    });
    expect(res.status).toBe(201);
    return res.body.order;
}

beforeAll(async () => {
    A = await seedTenant({ label: 'iso-a' });
    B = await seedTenant({ label: 'iso-b' });
    tableB = await createTable(B, { name: 'B-Secret' });
    orderB = await placeGuestOrder(B, tableB);
    await placeGuestOrder(A, await createTable(A, { name: 'A-1' }));

    // A customer who only ever dealt with tenant B.
    customerB = await createCustomer('iso-b-only');
    await setWallet(B, customerB, { balance: 300 });
    reservationB = await Reservation.create({
        restaurant: B.restaurant._id,
        branch: B.branch._id,
        guestName: 'B Guest',
        contactNo: '9000000009',
        date: new Date(Date.now() + 2 * 24 * 3600 * 1000),
        time: '20:00',
        guestCount: 2,
        area: B.area._id,
        table: B.tables.main._id,
        user: customerB._id,
    });
    await settle();
});

const adminA = () => ctx.api.as(A.users.admin);
const bodyText = (res) => JSON.stringify(res.body || {});

describe('orders', () => {
    test('A admin cannot read B order detail', async () => {
        const res = await adminA().get(`/orders/${orderB._id}/detail`);
        expect(DENIED).toContain(res.status);
        expect(bodyText(res)).not.toContain(orderB.orderId);
    });

    test("B's orders never appear in A's live / past / kitchen lists", async () => {
        for (const url of ['/orders/live', '/orders/past', '/orders/kitchen']) {
            // eslint-disable-next-line no-await-in-loop
            const res = await adminA().get(url);
            expect(res.status).toBe(200);
            expect(bodyText(res)).not.toContain(orderB.orderId);
        }
        const chef = await ctx.api.as(A.users.chef).get('/orders/kitchen');
        expect(bodyText(chef)).not.toContain(orderB.orderId);
    });

    test.each([
        ['status → preparing', (id) => adminA().patch(`/orders/${id}/status`).send({ status: 'preparing' })],
        ['mark Paid', (id) => adminA().patch(`/orders/${id}/status`).send({ paymentStatus: 'Paid', paymentMethod: 'cash', amountPaid: 1 })],
        ['cancel', (id) => adminA().patch(`/orders/${id}/cancel`).send({})],
        ['append items', (id) => adminA().post(`/orders/${id}/append`).send({ items: [{ menuItem: String(A.items.naan._id), quantity: 1 }] })],
        ['pickup', (id) => adminA().patch(`/orders/${id}/pickup`).send({})],
        ['apply coupon', (id) => adminA().patch(`/orders/${id}/coupon`).send({ couponCode: '' })],
        ['generate invoice', (id) => adminA().post(`/invoices/generate/${id}`).send({})],
    ])('A admin cannot %s on a B order', async (_label, call) => {
        const res = await call(orderB._id);
        expect(DENIED).toContain(res.status);
        const saved = await Order.findById(orderB._id).lean();
        expect(saved.status).toBe('new');
        expect(saved.paymentStatus).toBe('Pending');
        expect(saved.items).toHaveLength(1);
        expect(saved.total).toBe(TOTAL);
    });

    test('A waiter cannot place an order on a B table', async () => {
        const res = await ctx.api.as(A.users.waiter).post('/orders').send({
            type: 'dine-in', tableId: String(tableB._id),
            items: [{ menuItem: String(A.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL,
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await Order.countDocuments({ table: tableB._id })).toBe(1);
    });

    test("a guest cannot use B's scan token on tenant A", async () => {
        const { scanToken } = await scanTable(ctx.api, B.tables.small);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(B.tables.small._id),
            items: [{ menuItem: String(A.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL,
        });
        expect(DENIED).toContain(res.status);
    });

    test('a spoofed X-Restaurant-Slug does not move A staff into tenant B', async () => {
        const res = await ctx.api.raw.get('/api/v1/orders/live')
            .set('Authorization', `Bearer ${A.users.admin.token}`)
            .set('X-Restaurant-Slug', B.slug);
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(orderB.orderId);
    });
});

describe('tables', () => {
    test("B's tables are not listed for A", async () => {
        const res = await adminA().get('/tables');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(tableB._id));
        expect(bodyText(res)).not.toContain('B-Secret');
    });

    test.each([
        ['rename', (id) => adminA().put(`/tables/${id}`).send({ name: 'pwned' })],
        ['free', (id) => adminA().post(`/tables/${id}/free`).send({ force: true })],
        ['assign waiter', (id) => adminA().put(`/tables/${id}/assign`).send({ waiterId: String(A.users.waiter._id) })],
        ['rotate QR token', (id) => adminA().post(`/tables/${id}/qr-token`).send({})],
        ['delete', (id) => adminA().delete(`/tables/${id}`)],
    ])('A admin cannot %s a B table', async (_label, call) => {
        const before = await Table.findById(tableB._id).select('+qrToken').lean();
        const res = await call(tableB._id);
        expect(DENIED).toContain(res.status);
        const after = await Table.findById(tableB._id).select('+qrToken').lean();
        expect(after.name).toBe('B-Secret');
        expect(after.isDeleted).toBe(false);
        expect(after.qrToken).toBe(before.qrToken);
        expect(after.status).toBe(before.status);
        expect(String(after.assignedWaiter || '')).toBe(String(before.assignedWaiter || ''));
    });

    test('A admin cannot edit a B area', async () => {
        const res = await adminA().put(`/areas/${B.area._id}`).send({ name: 'pwned' });
        expect(DENIED).toContain(res.status);
        expect((await Area.findById(B.area._id).lean()).name).toBe(B.area.name);
    });
});

describe('menu', () => {
    test('B menu item is invisible through tenant A (admin and guest)', async () => {
        const id = B.items.paneer._id;
        const guest = await ctx.api.guest(A).get(`/menu/${id}`);
        expect(DENIED).toContain(guest.status);
        const list = await ctx.api.guest(A).get('/menu');
        expect(list.status).toBe(200);
        expect(bodyText(list)).not.toContain(String(id));
    });

    test.each([
        ['update', (id) => adminA().put(`/menu/${id}`).send({ name: 'pwned', basePrice: 1 })],
        ['delete', (id) => adminA().delete(`/menu/${id}`)],
    ])('A admin cannot %s a B menu item', async (_label, call) => {
        const id = B.items.paneer._id;
        const res = await call(id);
        expect(DENIED).toContain(res.status);
        const saved = await MenuItem.findById(id).lean();
        expect(saved).not.toBeNull();
        expect(saved.name).toBe('Paneer Tikka');
        expect(saved.basePrice).toBe(200);
    });

    test("A guest cannot order B's menu item through tenant A", async () => {
        const table = await createTable(A, { name: 'A-menu' });
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await ctx.api.guest(A, scanToken).post('/orders').send({
            type: 'dine-in', tableId: String(table._id),
            items: [{ menuItem: String(B.items.paneer._id), name: 'Paneer Tikka', quantity: 1 }], total: TOTAL,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ITEM_NOT_FOUND');
    });
});

describe('staff', () => {
    test("B's staff are not listed for A", async () => {
        const res = await adminA().get('/staff');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(B.users.waiter._id));
        expect(bodyText(res)).not.toContain(B.users.waiter.email);
    });

    test.each([
        ['update', (id) => adminA().put(`/staff/${id}`).send({ name: 'pwned' })],
        ['deactivate', (id) => adminA().patch(`/staff/${id}/status`).send({ status: 'inactive' })],
        ['reset password', (id) => adminA().post(`/staff/${id}/reset-password`).send({})],
        ['view performance', (id) => adminA().get(`/staff/${id}/performance`)],
        ['delete', (id) => adminA().delete(`/staff/${id}`)],
    ])('A admin cannot %s a B staff member', async (_label, call) => {
        const id = B.users.waiter._id;
        const before = await User.findById(id).select('+password').lean();
        const res = await call(id);
        expect(DENIED).toContain(res.status);
        const after = await User.findById(id).select('+password').lean();
        expect(after).not.toBeNull();
        expect(after.name).toBe(before.name);
        expect(after.status).toBe('active');
        expect(after.password).toBe(before.password);
        expect(after.tokenVersion).toBe(before.tokenVersion);
    });
});

describe('customers (CRM)', () => {
    test("A cannot open the CRM profile of a customer who only used B", async () => {
        const res = await adminA().get(`/crm/customers/${customerB._id}`);
        expect(res.status).toBe(404);
        expect(bodyText(res)).not.toContain(customerB.email);

        const list = await adminA().get('/crm/customers');
        expect(list.status).toBe(200);
        expect(bodyText(list)).not.toContain(customerB.email);

        const own = await ctx.api.as(B.users.admin).get(`/crm/customers/${customerB._id}`);
        expect(own.status).toBe(200);
    });
});

describe('reservations', () => {
    test("B's reservations are not listed for A", async () => {
        const res = await adminA().get('/reservations');
        expect(res.status).toBe(200);
        expect(bodyText(res)).not.toContain(String(reservationB._id));
        expect(bodyText(res)).not.toContain('B Guest');
    });

    test.each([
        ['approve', (id) => adminA().put(`/reservations/${id}/status`).send({ status: 'Approved' })],
        ['cancel', (id) => adminA().put(`/reservations/${id}/cancel`).send({})],
    ])('A admin cannot %s a B reservation', async (_label, call) => {
        const res = await call(reservationB._id);
        expect(DENIED).toContain(res.status);
        expect((await Reservation.findById(reservationB._id).lean()).status).toBe('Pending');
    });

    test("a customer browsing tenant A does not see their tenant-B booking", async () => {
        const res = await ctx.api.as(customerB, A).get('/reservations');
        expect(res.status).toBe(200);
        expect(res.body.reservations).toHaveLength(0);
    });
});

describe('positive controls (the same calls work for tenant B itself)', () => {
    test("B's own staff / guests can see B's data through the same endpoints", async () => {
        const adminB = ctx.api.as(B.users.admin);
        const detail = await adminB.get(`/orders/${orderB._id}/detail`);
        expect(detail.status).toBe(200);
        expect(bodyText(detail)).toContain(orderB.orderId);
        expect(bodyText(await adminB.get('/orders/live'))).toContain(orderB.orderId);
        expect(bodyText(await adminB.get('/tables'))).toContain('B-Secret');
        expect(bodyText(await adminB.get('/staff'))).toContain(String(B.users.waiter._id));
        expect(bodyText(await adminB.get('/reservations'))).toContain('B Guest');
        expect((await ctx.api.guest(B).get(`/menu/${B.items.paneer._id}`)).status).toBe(200);
        const rename = await adminB.put(`/tables/${B.tables.small._id}`).send({ name: 'Small-b-renamed' });
        expect(rename.status).toBe(200);
    });
});
