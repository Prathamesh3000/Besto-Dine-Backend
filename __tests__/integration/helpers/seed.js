/**
 * Seed helpers: a complete tenant (restaurant + main branch + tenant
 * settings with taxes + area + category + menu + tables + staff) plus
 * customers, with access tokens minted by the app's real signer
 * (middlewares/authMiddleware.signAccessToken).
 *
 * Require AFTER helpers/createTestApp (models must be registered by the
 * app's own requires, so the tenant-scope plugin and hooks are in place).
 */
const crypto = require('crypto');
const path = require('path');

const BACKEND = path.join(__dirname, '..', '..', '..');
const req_ = (rel) => require(path.join(BACKEND, rel));

const Restaurant = req_('models/restaurant');
const Branch = req_('models/branch');
const Settings = req_('models/settings');
const Area = req_('models/area');
const Category = req_('models/category');
const MenuItem = req_('models/menuItem');
const Table = req_('models/table');
const User = req_('models/user');
const Wallet = req_('models/wallet');
const { signAccessToken } = req_('middlewares/authMiddleware');
const { FEATURE_LABELS } = req_('middlewares/featureGate');
const { defaultPermissionsForRole } = req_('utils/staffDefaults');

const DEFAULT_PASSWORD = 'Integration#Pass123';

const rand = (n = 6) => crypto.randomBytes(n).toString('hex');
const qrToken = () => `tb-${crypto.randomBytes(6).toString('hex')}`;

/** Every plan feature switched on (featureGate reads subscription.features). */
function allFeatures() {
    return Object.fromEntries(Object.keys(FEATURE_LABELS).map((k) => [k, true]));
}

/** Default tax setup: GST 5%, service charge 10%, flat ₹20 packaging. */
const DEFAULT_TAXES = {
    gst: { enabled: true, value: 5 },
    serviceCharge: { enabled: true, value: 10 },
    additionalCharges: [{ name: 'Packaging', value: 20, type: 'Flat', enabled: true }],
};

// bcrypt (cost 12, as in the model) is hashed ONCE per test file and the
// users are written with insertMany, which validates + applies defaults
// but skips the pre('save') re-hash. Logging in with DEFAULT_PASSWORD
// still goes through the real bcrypt compare.
let defaultHashPromise = null;
const defaultHash = () => {
    defaultHashPromise = defaultHashPromise || require('bcryptjs').hash(DEFAULT_PASSWORD, 12);
    return defaultHashPromise;
};

async function createUser(fields) {
    const [user] = await User.insertMany([{
        password: await defaultHash(),
        status: 'active',
        ...fields,
    }]);
    user.token = signAccessToken(user);
    return user;
}

async function createCustomer(label = 'cust', extra = {}) {
    return createUser({
        name: `Customer ${label}`,
        email: `${label}.${rand(4)}@customers.test`,
        role: 'customer',
        ...extra,
    });
}

async function createTable(tenant, { name, capacity = 4, branch = tenant.branch._id, area = tenant.area._id } = {}) {
    const doc = await Table.create({
        restaurant: tenant.restaurant._id,
        branch,
        area,
        name: name || `T-${rand(3)}`,
        capacity,
        qrToken: qrToken(),
        status: 'free',
    });
    // qrToken is select:false — keep it on the returned object.
    const t = doc.toObject();
    t.qrToken = doc.qrToken;
    return t;
}

/**
 * Seed a full tenant. Returns plain handles for the tests:
 *   restaurant, branch, settings, area, category,
 *   items: { paneer, thali (sizes + offer), naan },
 *   tables: { main (cap 4), small (cap 1) },
 *   users: { admin, waiter, chef, captain } — staff pinned to the branch,
 *          admin is the unpinned tenant owner; each has `.token`.
 */
async function seedTenant({ label = 'a', taxes = DEFAULT_TAXES } = {}) {
    const slug = `it-${label}-${rand(3)}`;
    const restaurant = await Restaurant.create({
        name: `Integration ${label.toUpperCase()}`,
        slug,
        contactEmail: `owner.${slug}@tenants.test`,
        status: 'active',
        subscription: {
            planName: 'Integration', planSlug: 'integration', status: 'active',
            features: allFeatures(), limits: {},
        },
    });
    const branch = await Branch.create({ restaurant: restaurant._id, name: 'Main', slug: 'main', isActive: true });
    const settings = await Settings.create({ restaurant: restaurant._id, branch: null, taxes });
    const area = await Area.create({ restaurant: restaurant._id, branch: branch._id, name: `Hall ${rand(2)}` });
    const category = await Category.create({ restaurant: restaurant._id, branch: null, name: `Mains ${rand(2)}` });

    const mkItem = (fields) => MenuItem.create({
        restaurant: restaurant._id,
        category: category._id,
        description: 'integration test item',
        prepStation: 'kitchen',
        vegType: 'veg',
        ...fields,
    });
    const paneer = await mkItem({ name: 'Paneer Tikka', basePrice: 200 });
    // Size variants carry the base price; the 10% offer applies on top
    // (orderPricingService.priceCartItems): Full = 250 → 225.
    const thali = await mkItem({
        name: 'Veg Thali',
        basePrice: 150,
        offerPercentage: 10,
        sizes: [{ name: 'Half', price: 150 }, { name: 'Full', price: 250 }],
    });
    const naan = await mkItem({ name: 'Garlic Naan', basePrice: 40 });

    const tenant = {
        label, slug, restaurant, branch, settings, area, category,
        items: { paneer, thali, naan },
    };
    tenant.tables = {
        main: await createTable(tenant, { name: `Main-${label}`, capacity: 4 }),
        small: await createTable(tenant, { name: `Small-${label}`, capacity: 1 }),
    };

    const staff = (role, extra = {}) => createUser({
        name: `${role} ${label}`,
        email: `${role}.${slug}@staff.test`,
        role,
        restaurant: restaurant._id,
        branch: branch._id,
        permissions: defaultPermissionsForRole(role),
        ...extra,
    });
    tenant.users = {
        admin: await staff('admin', { branch: null, isTenantOwner: true, permissions: {} }),
        waiter: await staff('waiter'),
        chef: await staff('chef'),
        captain: await staff('captain'),
    };
    return tenant;
}

async function setWallet(tenant, user, { balance = 0, loyaltyPoints = 0 } = {}) {
    return Wallet.findOneAndUpdate(
        { user: user._id, restaurant: tenant.restaurant._id },
        { $set: { balance, loyaltyPoints, status: 'active' } },
        { upsert: true, returnDocument: 'after' },
    );
}

module.exports = {
    DEFAULT_PASSWORD,
    DEFAULT_TAXES,
    seedTenant,
    createTable,
    createCustomer,
    createUser,
    setWallet,
    qrToken,
};
