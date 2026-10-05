/**
 * Model hooks, schema shapes and indexes (checklist 10.13 — models),
 * exercised against the real in-memory MongoDB:
 *   - User      — bcrypt on save (only when modified), comparePassword,
 *                 password select:false, default avatar, serialisation
 *   - Order     — globally unique orderId
 *   - Wallet    — 2-dp rounding in pre('save') and post('findOneAndUpdate')
 *   - MenuItem  — finalPrice computed in pre('save'), branch overrides
 *   - Table     — alerts sub-document array
 *   - Coupon    — code uppercased + trimmed, unique per tenant+branch
 */
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, DEFAULT_PASSWORD } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const User = require(path.join(BACKEND, 'models/user'));
const Order = require(path.join(BACKEND, 'models/order'));
const Wallet = require(path.join(BACKEND, 'models/wallet'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Table = require(path.join(BACKEND, 'models/table'));
const Coupon = require(path.join(BACKEND, 'models/coupon'));
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));

const ctx = useIntegrationApp();
let A;

const rid = () => new mongoose.Types.ObjectId().toString().slice(-6);

beforeAll(async () => {
    A = await seedTenant({ label: 'mh' });
    await Restaurant.updateOne({ _id: A.restaurant._id }, { $set: { 'subscription.limits.maxStaff': 100 } });
});

// ─── User ───────────────────────────────────────────────────────────
describe('User model', () => {
    test('password is bcrypt-hashed on create, not re-hashed on unrelated saves', async () => {
        const u = await User.create({ name: 'Hash Me', email: `HASH.${rid()}@Users.Test `, password: 'Plain#Pass123', role: 'customer' });
        expect(u.email).toMatch(/^hash\.[0-9a-f]{6}@users\.test$/); // lowercased + trimmed
        const stored = await User.findById(u._id).select('+password');
        expect(stored.password).toMatch(/^\$2[aby]\$12\$/);
        expect(await stored.comparePassword('Plain#Pass123')).toBe(true);
        expect(await stored.comparePassword('plain#pass123')).toBe(false);
        expect(await stored.comparePassword('')).toBe(false);

        const before = stored.password;
        stored.name = 'Renamed';
        await stored.save();
        const again = await User.findById(u._id).select('+password').lean();
        expect(again.password).toBe(before);

        stored.password = 'Another#Pass456';
        await stored.save();
        const changed = await User.findById(u._id).select('+password');
        expect(changed.password).not.toBe(before);
        expect(await changed.comparePassword('Another#Pass456')).toBe(true);
    });

    test('password is select:false and the avatar defaults from the name', async () => {
        const u = await User.create({ name: 'Asha K', email: `asha.${rid()}@users.test`, password: 'Plain#Pass123', role: 'customer' });
        const plain = await User.findById(u._id).lean();
        expect(plain).not.toHaveProperty('password');
        expect(plain.avatar).toBe('https://ui-avatars.com/api/?name=Asha%20K&background=FE8301&color=fff');
        expect(plain.tokenVersion).toBe(0);
    });

    test.each([
        ['too short', { password: 'short' }, 'password'],
        ['missing password (no googleId)', { password: undefined }, 'password'],
        ['missing email', { email: undefined }, 'email'],
    ])('validation: %s', async (_l, override, field) => {
        const doc = new User({ name: 'V', email: `v.${rid()}@users.test`, password: 'Plain#Pass123', role: 'customer', ...override });
        const err = doc.validateSync();
        expect(err.errors[field]).toBeDefined();
    });

    test('a Google account may have no password', () => {
        const doc = new User({ name: 'G', email: `g.${rid()}@users.test`, googleId: `g-${rid()}`, role: 'customer' });
        expect(doc.validateSync()?.errors?.password).toBeUndefined();
    });

    // Regression (fixed 2026-10): the User schema's toJSON transform strips the password hash from serialised documents.
    test('POST /staff does not return the new staff member\'s password hash', async () => {
        const res = await ctx.api.as(A.users.admin).post('/staff').send({
            name: 'Hash Leak', email: `leak.${rid()}@staff.test`, role: 'waiter', branch: String(A.branch._id),
        });
        expect(res.status).toBe(201);
        expect(res.body.tempPassword).toBeTruthy();
        expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$\d\d\$/);
        expect(res.body.staffMember.password).toBeUndefined();
    });
});

// ─── Order ──────────────────────────────────────────────────────────
describe('Order model', () => {
    const base = (orderId, restaurant = A.restaurant._id) => ({
        restaurant, orderId, type: 'takeaway', total: 100,
        items: [{ name: 'X', price: 100, quantity: 1 }],
    });

    test('orderId is unique across ALL tenants (E11000 on reuse)', async () => {
        const B = await seedTenant({ label: 'mh-b' });
        const id = `ORD-TEST-${rid()}`;
        await Order.create(base(id));
        await expect(Order.create(base(id))).rejects.toMatchObject({ code: 11000 });
        // Different tenant, same human id — still rejected (global index).
        await expect(Order.create(base(id, B.restaurant._id))).rejects.toMatchObject({ code: 11000 });
    });

    test.each([
        ['negative total', { total: -1 }, 'total'],
        ['missing orderId', { orderId: undefined }, 'orderId'],
        ['missing restaurant', { restaurant: undefined }, 'restaurant'],
        ['bad type', { type: 'delivery-drone' }, 'type'],
    ])('validation: %s', (_l, override, field) => {
        const err = new Order({ ...base(`ORD-V-${rid()}`), ...override }).validateSync();
        expect(err.errors[field]).toBeDefined();
    });
});

// ─── Wallet ─────────────────────────────────────────────────────────
describe('Wallet rounding hooks', () => {
    const mkWallet = async (balance) => {
        const cust = await createCustomer(`w${rid()}`);
        return Wallet.create({ user: cust._id, restaurant: A.restaurant._id, balance });
    };

    test('pre(save) rounds balance and loyaltyPoints to 2 dp', async () => {
        const w = await mkWallet(10.005);
        w.loyaltyPoints = 3.14159;
        await w.save();
        const got = await Wallet.findById(w._id).lean();
        expect(got.balance).toBe(10.01);
        expect(got.loyaltyPoints).toBe(3.14);
    });

    test('post(findOneAndUpdate) fixes $inc float drift when the updated doc is returned', async () => {
        const w = await mkWallet(0.1);
        const after = await Wallet.findOneAndUpdate(
            { _id: w._id, restaurant: A.restaurant._id }, { $inc: { balance: 0.2 } }, { returnDocument: 'after' },
        );
        expect(after.balance).toBe(0.3);
        expect((await Wallet.findById(w._id).lean()).balance).toBe(0.3);
    });

    test('unique (user, restaurant)', async () => {
        const w = await mkWallet(0);
        await expect(Wallet.create({ user: w.user, restaurant: A.restaurant._id })).rejects.toMatchObject({ code: 11000 });
    });

    // Regression (fixed 2026-10): the post('findOneAndUpdate') hook used to
    // round the returned doc and save() it; with the default returnDocument
    // ('before') that wrote the PRE-update balance back over the $inc and the
    // debit was lost. It now rounds atomically in the database (conditional
    // update), so the stored balance is the exact paise value after every $inc.
    test('a $inc via findOneAndUpdate (default returnDocument) is not lost to the rounding hook', async () => {
        const w = await mkWallet(10.1);
        const q = { _id: w._id, restaurant: A.restaurant._id };
        // Refund credit ₹20.20 (default returnDocument 'before').
        await Wallet.findOneAndUpdate(q, { $inc: { balance: 20.2 } });
        // Updated 2026-10: previously pinned the drifted 30.299999999999997;
        // the hook now rounds the stored value itself.
        expect((await Wallet.findById(w._id).lean()).balance).toBe(30.3);
        // Debit ₹30.30 the same way — must not be overwritten.
        await Wallet.findOneAndUpdate(q, { $inc: { balance: -30.3 } });
        const final = (await Wallet.findById(w._id).lean()).balance;
        expect(Math.round(final * 100) / 100).toBe(0);
    });
});

// ─── MenuItem ───────────────────────────────────────────────────────
describe('MenuItem finalPrice pre(save)', () => {
    const mk = (fields) => MenuItem.create({
        restaurant: A.restaurant._id, category: A.category._id, name: `Item ${rid()}`, description: 'hook test', prepStation: 'kitchen', vegType: 'veg', ...fields,
    });

    test.each([
        [200, 0, 200],
        [200, 10, 180],
        [250, 100, 0],
        [99, 50, 49.5],
    ])('basePrice %p, offer %p%% → finalPrice %p', async (basePrice, offerPercentage, finalPrice) => {
        const item = await mk({ basePrice, offerPercentage });
        expect((await MenuItem.findById(item._id).lean()).finalPrice).toBe(finalPrice);
    });

    test('branch overrides get their own finalPrice', async () => {
        const item = await mk({ basePrice: 100, branchPrices: [{ branch: A.branch._id, basePrice: 120, offerPercentage: 25 }] });
        const got = await MenuItem.findById(item._id).lean();
        expect(got.branchPrices[0].finalPrice).toBe(90);
    });

    test('edit via save() recomputes; updateOne bypasses the hook (callers must recompute)', async () => {
        const item = await mk({ basePrice: 100, offerPercentage: 0 });
        item.offerPercentage = 20;
        await item.save();
        expect((await MenuItem.findById(item._id).lean()).finalPrice).toBe(80);
        await MenuItem.updateOne({ _id: item._id }, { $set: { basePrice: 200 } });
        expect((await MenuItem.findById(item._id).lean()).finalPrice).toBe(80);
    });

    // Regression (fixed 2026-10): the pre-save hook recomputes on any numeric
    // basePrice, so a ₹0 (free) item stores finalPrice 0 (branch entries too).
    test('changing basePrice to 0 resets finalPrice to 0', async () => {
        const item = await mk({ basePrice: 100, offerPercentage: 0 });
        item.basePrice = 0;
        await item.save();
        expect((await MenuItem.findById(item._id).lean()).finalPrice).toBe(0);
    });
});

// ─── Table alerts ───────────────────────────────────────────────────
describe('Table alerts sub-schema', () => {
    // Regression (fixed 2026-10): models/table.js declares the alert field as `type: { type: String }`, so alerts is a sub-document array.
    test('alerts compile as a sub-document array, not [String]', () => {
        const p = Table.schema.path('alerts');
        expect(p.constructor.name).toBe('SchemaDocumentArray');
    });

    test('pushing an alert object (as requestController does) persists it', async () => {
        const t = await Table.create({
            restaurant: A.restaurant._id, branch: A.branch._id, area: A.area._id,
            name: `Alert-${rid()}`, capacity: 2, qrToken: `tb-${rid()}${rid()}`, status: 'free',
        });
        const requestId = new mongoose.Types.ObjectId();
        const push = Table.updateOne({ _id: t._id }, {
            $push: { alerts: { reason: 'T1 waiting for water', type: 'water', requestId, timestamp: new Date() } },
        });
        await expect(push).resolves.toBeTruthy();
        const got = await Table.findById(t._id).lean();
        expect(got.alerts).toHaveLength(1);
        expect(got.alerts[0]).toMatchObject({ reason: 'T1 waiting for water', type: 'water' });
    });

    test('a customer water request (POST /requests → 201) shows up in table.alerts', async () => {
        const { scanTable } = require('./helpers/http');
        const table = A.tables.small;
        const { scanToken } = await scanTable(ctx.api, table);
        const res = await ctx.api.guest(A, scanToken).post('/requests').send({ type: 'water', tableId: String(table._id) });
        expect(res.status).toBe(201);
        const got = await Table.findById(table._id).lean();
        expect(got.alerts.map((a) => a.type)).toEqual(['water']);
    });
});

// ─── Coupon ─────────────────────────────────────────────────────────
describe('Coupon model', () => {
    const mk = (code, branch = null) => Coupon.create({
        restaurant: A.restaurant._id, branch, code, title: 'T', discountValue: 10,
        endDate: new Date(Date.now() + 7 * 86400000),
    });

    test('code is uppercased and trimmed', async () => {
        const c = await mk('  welcome10 ');
        expect(c.code).toBe('WELCOME10');
    });

    test('code unique per tenant+branch, case-insensitively via uppercase', async () => {
        await mk('dupe5');
        await expect(mk('DUPE5')).rejects.toMatchObject({ code: 11000 });
        // Another branch may reuse it.
        await expect(mk('dupe5', A.branch._id)).resolves.toBeTruthy();
    });

    test.each([
        ['zero discount', { discountValue: 0 }, 'discountValue'],
        ['bad discountType', { discountType: 'free-money' }, 'discountType'],
        ['negative minOrderValue', { minOrderValue: -5 }, 'minOrderValue'],
    ])('validation: %s', (_l, override, field) => {
        const err = new Coupon({ restaurant: A.restaurant._id, code: 'X', title: 'T', discountValue: 10, ...override }).validateSync();
        expect(err.errors[field]).toBeDefined();
    });
});

test('seed login still works through the real comparePassword', async () => {
    const res = await ctx.api.anon().post('/auth/login').send({ email: A.users.waiter.email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
});
