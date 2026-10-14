/**
 * Index-level checks against a FRESH database built purely from the
 * Mongoose schemas (no test workarounds applied): this is what a new
 * deployment / new environment gets.
 */
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const os = require('os');

const BACKEND = path.join(__dirname, '..', '..');
const User = require(path.join(BACKEND, 'models/user'));
const Order = require(path.join(BACKEND, 'models/order'));
const Request = require(path.join(BACKEND, 'models/request'));

let conn;
let FreshUser;
let FreshOrder;
let FreshRequest;

beforeAll(async () => {
    const u = new URL(process.env.MONGO_URL);
    u.pathname = `/${process.env.INTEGRATION_DB_NAME}_fresh`;
    global.assertInMemoryMongo(u.toString());
    // mongodb 7.7 loads its os adapter via dynamic import(), which Jest's CJS runtime cannot do;
    // passing the adapter explicitly skips that (same fix as helpers/db.js).
    conn = await mongoose.createConnection(u.toString(), { runtimeAdapters: { os } }).asPromise();
    FreshUser = conn.model('User', User.schema);
    FreshOrder = conn.model('Order', Order.schema);
    FreshRequest = conn.model('Request', Request.schema);
    await FreshUser.init();
    await FreshOrder.init();
    await FreshRequest.init();
});

afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
});

const user = (n) => ({
    name: `Fresh ${n}`,
    email: `fresh.${n}.${crypto.randomBytes(3).toString('hex')}@customers.test`,
    password: 'Integration#Pass123',
    role: 'customer',
});

// Regression: models/user.js used to declare googleId as
// { default: null, unique: true, sparse: true }. `default: null` stored
// googleId: null on every user and the sparse unique index then admitted
// only ONE password-only user per fresh database (E11000 on googleId_1).
test('two password-only users can exist on a fresh database', async () => {
    await FreshUser.create(user(1));
    await expect(FreshUser.create(user(2))).resolves.toBeTruthy();
    const idx = (await FreshUser.collection.indexes()).find((i) => i.name === 'googleId_1');
    expect(idx.unique).toBe(true);
    expect(idx.partialFilterExpression).toEqual({ googleId: { $type: 'string' } });
});

test('googleId stays unique among users that have one', async () => {
    const a = user(3);
    await FreshUser.create({ ...a, googleId: 'g-sub-1', authProviders: ['google'] });
    await expect(FreshUser.create({ ...user(4), googleId: 'g-sub-1' })).rejects.toMatchObject({ code: 11000 });
});

test('clientIdempotencyKey is unique per tenant but null keys never collide', async () => {
    const indexes = await FreshOrder.collection.indexes();
    const idem = indexes.find((i) => i.name === 'idempotency_per_tenant');
    expect(idem).toBeTruthy();
    expect(idem.unique).toBe(true);
    expect(idem.partialFilterExpression).toEqual({ clientIdempotencyKey: { $type: 'string' } });
});

// Retention (DATABASE_SCALING_PLAN.md A2-now #1): handled service requests
// expire 90 days after they were raised; open ones never do.
describe('Request TTL index (completed_request_ttl)', () => {
    const NINETY_DAYS = 90 * 24 * 60 * 60;
    const base = () => ({
        restaurant: new mongoose.Types.ObjectId(),
        table: new mongoose.Types.ObjectId(),
        type: 'water',
    });
    const daysAgo = (n) => new Date(Date.now() - n * 86400000);

    test('is a 90-day TTL on createdAt restricted to status completed', async () => {
        const idx = (await FreshRequest.collection.indexes()).find((i) => i.name === 'completed_request_ttl');
        expect(idx).toBeTruthy();
        expect(idx.key).toEqual({ createdAt: 1 });
        expect(idx.expireAfterSeconds).toBe(NINETY_DAYS);
        expect(idx.partialFilterExpression).toEqual({ status: 'completed' });
    });

    test('covers a completed request but not a pending or accepted one', async () => {
        // Insert through the driver so createdAt is exactly what we say
        // (the TTL monitor is not awaited here — it runs about once a
        // minute — so the check is index coverage, not deletion).
        await FreshRequest.collection.insertMany([
            { ...base(), status: 'completed', createdAt: daysAgo(100), completedAt: daysAgo(99) },
            { ...base(), status: 'pending', createdAt: daysAgo(100) },
            { ...base(), status: 'accepted', createdAt: daysAgo(100), acceptedAt: daysAgo(99) },
        ]);
        // A hinted scan of a partial index returns only the documents the
        // index holds — exactly the set the TTL monitor is allowed to delete.
        const covered = await FreshRequest.collection
            .find({ createdAt: { $lt: new Date() } })
            .hint('completed_request_ttl')
            .toArray();
        expect(covered.map((d) => d.status)).toEqual(['completed']);
        // and the open ones are still there in full
        expect(await FreshRequest.countDocuments({ status: { $in: ['pending', 'accepted'] } })).toBe(2);
    });
});
