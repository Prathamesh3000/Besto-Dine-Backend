/**
 * Per-restaurant landing page:
 *   - GET /public/restaurants/:slug/landing — public-safe fields only,
 *     featured-item fallback chain, branch variant, availability codes
 *   - PATCH /settings/landingPage — validation + tenant-owned featuredItems
 *   - reserved restaurant slugs on self-signup and Super Admin create
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createUser } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Restaurant = require(path.join(BACKEND, 'models/restaurant'));
const Branch = require(path.join(BACKEND, 'models/branch'));
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Settings = require(path.join(BACKEND, 'models/settings'));
const SubscriptionPlan = require(path.join(BACKEND, 'models/subscriptionPlan'));

const ctx = useIntegrationApp();
let A;
let B;

const GSTIN = '27ABCDE1234F1Z5';
const landing = (slug, q = '') => ctx.api.anon().get(`/public/restaurants/${slug}/landing${q}`);
const patchLanding = (t, body) => ctx.api.as(t.users.admin).patch('/settings/landingPage').send(body);

beforeAll(async () => {
    A = await seedTenant({ label: 'lp-a' });
    B = await seedTenant({ label: 'lp-b' });
    // Sensitive tenant data that must never reach the public page.
    await Restaurant.updateOne({ _id: A.restaurant._id }, {
        $set: {
            owner: A.users.admin._id,
            legal: { legalBusinessName: 'Secret Legal Pvt Ltd', gstin: GSTIN, fssaiLicense: '12345678901234', pan: 'ABCDE1234F' },
            city: 'Pune',
        },
    });
    await Settings.updateOne({ _id: A.settings._id }, {
        $set: {
            'general.contactNumber': '+91 90000 11111',
            'general.email': 'hello@lp-a.test',
            'general.addressDetails': { line1: '12 FC Road', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411004', country: 'India' },
            'general.legal': { legalBusinessName: 'Secret Legal Pvt Ltd', gstin: GSTIN, fssaiLicense: '12345678901234', pan: 'ABCDE1234F' },
            'general.timezone': 'Asia/Kolkata',
        },
    });
});

describe('GET /public/restaurants/:slug/landing', () => {
    test('returns the public contract and no legal / owner / billing fields', async () => {
        const res = await landing(A.slug);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toMatch(/public/);
        expect(res.headers['cache-control']).toMatch(/max-age=60/);
        const d = res.body.data;

        expect(Object.keys(d.restaurant).sort()).toEqual(['_id', 'city', 'logo', 'name', 'slug']);
        expect(d.restaurant.slug).toBe(A.slug);
        expect(d.branch).toBeNull();
        expect(d.landing).toMatchObject({
            enabled: true, tagline: '', about: '', coverImages: [],
            social: { instagram: '', facebook: '', website: '', whatsapp: '', googleMapsUrl: '' },
            sections: { featured: true, about: true, hours: true, location: true, branches: true, gallery: true },
        });
        expect(d.landing).not.toHaveProperty('featuredItems');
        expect(d.contact).toEqual({ phone: '+91 90000 11111', email: 'hello@lp-a.test' });
        expect(d.address).toMatchObject({ line1: '12 FC Road', city: 'Pune', state: 'Maharashtra', pincode: '411004', country: 'India' });
        expect(d.address.full).toBe('12 FC Road, Pune, Maharashtra, 411004');
        expect(d.address.mapUrl).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
        expect(Array.isArray(d.operatingHours)).toBe(true);
        expect(typeof d.openNow.isOpen).toBe('boolean');
        expect(typeof d.openNow.label).toBe('string');
        expect(d.branches).toEqual([{ name: 'Main', slug: 'main', city: '', addressLine1: '' }]);
        expect(d.actions).toMatchObject({ menu: true, takeaway: true, booking: true });
        expect(d.features).toMatchObject({ dineIn: true, takeaway: true });

        const text = JSON.stringify(res.body);
        for (const secret of [GSTIN, 'Secret Legal', '12345678901234', 'ABCDE1234F', A.restaurant.contactEmail,
            String(A.users.admin._id), '"legal"', '"owner"', '"gstin"', '"subscription"', '"featureOverrides"', '"status"']) {
            expect(text).not.toContain(secret);
        }
    });

    test('featured items: chosen → isFeatured → best sellers, active + in stock only', async () => {
        // No choice, nothing flagged → best sellers by orderCount.
        await MenuItem.updateOne({ _id: A.items.naan._id }, { $set: { orderCount: 50 } });
        let d = (await landing(A.slug)).body.data;
        expect(d.featuredSource).toBe('popular');
        expect(d.featuredItems[0]).toMatchObject({ name: 'Garlic Naan', basePrice: 40, finalPrice: 40, vegType: 'veg' });
        expect(Object.keys(d.featuredItems[0]).sort()).toEqual(
            ['_id', 'basePrice', 'description', 'finalPrice', 'image', 'name', 'offerPercentage', 'vegType'],
        );

        // Flagged items win over best sellers.
        await MenuItem.updateOne({ _id: A.items.paneer._id }, { $set: { isFeatured: true } });
        d = (await landing(A.slug)).body.data;
        expect(d.featuredSource).toBe('featured');
        expect(d.featuredItems.map((i) => i.name)).toEqual(['Paneer Tikka']);

        // The admin's choice wins, in the admin's order.
        const r = await patchLanding(A, { featuredItems: [String(A.items.thali._id), String(A.items.naan._id)] });
        expect(r.status).toBe(200);
        d = (await landing(A.slug)).body.data;
        expect(d.featuredSource).toBe('chosen');
        expect(d.featuredItems.map((i) => i.name)).toEqual(['Veg Thali', 'Garlic Naan']);
        expect(d.featuredItems[0]).toMatchObject({ basePrice: 150, finalPrice: 135, offerPercentage: 10 });

        // Out-of-stock / inactive chosen items drop out; none left → fallback.
        await MenuItem.updateMany({ _id: { $in: [A.items.thali._id, A.items.naan._id] } }, { $set: { inStock: false } });
        d = (await landing(A.slug)).body.data;
        expect(d.featuredSource).toBe('featured');
        await MenuItem.updateMany({ _id: { $in: [A.items.thali._id, A.items.naan._id] } }, { $set: { inStock: true } });
        await MenuItem.updateOne({ _id: A.items.thali._id }, { $set: { status: 'archived' } });
        d = (await landing(A.slug)).body.data;
        expect(d.featuredItems.map((i) => i.name)).toEqual(['Garlic Naan']);
        await MenuItem.updateOne({ _id: A.items.thali._id }, { $set: { status: 'active' } });
    });

    test('branch variant: branch address / phone / coordinates and branch prices', async () => {
        const downtown = await Branch.create({
            restaurant: A.restaurant._id, name: 'Downtown', slug: 'downtown', isActive: true, sortOrder: 1,
            addressLine1: '5 MG Road', city: 'Mumbai', state: 'Maharashtra', postalCode: '400001',
            contactPhone: '+91 90000 22222', latitude: 18.93, longitude: 72.83,
        });
        await Branch.create({ restaurant: A.restaurant._id, name: 'Closed One', slug: 'closed-one', isActive: false });
        await MenuItem.updateOne({ _id: A.items.naan._id }, {
            $set: { branchPrices: [{ branch: downtown._id, basePrice: 60, offerPercentage: 0 }] },
        });

        const res = await landing(A.slug, '?branch=downtown');
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d.branch).toEqual({
            _id: String(downtown._id), name: 'Downtown', slug: 'downtown', city: 'Mumbai',
            addressLine1: '5 MG Road', addressLine2: '', state: 'Maharashtra', postalCode: '400001',
            contactPhone: '+91 90000 22222', latitude: 18.93, longitude: 72.83,
        });
        expect(d.contact.phone).toBe('+91 90000 22222');
        expect(d.address).toMatchObject({ line1: '5 MG Road', city: 'Mumbai', pincode: '400001' });
        expect(d.address.mapUrl).toContain(encodeURIComponent('18.93,72.83'));
        const naan = d.featuredItems.find((i) => i.name === 'Garlic Naan');
        expect(naan).toMatchObject({ basePrice: 60, finalPrice: 60 });
        expect(d.branches.map((b) => b.slug)).toEqual(['main', 'downtown']);

        // Tenant-level page keeps default prices.
        const base = (await landing(A.slug)).body.data.featuredItems.find((i) => i.name === 'Garlic Naan');
        expect(base.basePrice).toBe(40);

        for (const q of ['?branch=nope', '?branch=closed-one']) {
            const miss = await landing(A.slug, q);
            expect(miss.status).toBe(404);
            expect(miss.body.code).toBe('BRANCH_NOT_FOUND');
        }
        // A branch of ANOTHER tenant is never resolved.
        await Branch.create({ restaurant: B.restaurant._id, name: 'B Only', slug: 'b-only', isActive: true });
        expect((await landing(A.slug, '?branch=b-only')).body.code).toBe('BRANCH_NOT_FOUND');
    });

    test('operations: the public blob is in the payload — tenant default on /<slug>, the branch override on ?branch= (design §12)', async () => {
        const { normaliseProfile } = require(path.join(BACKEND, 'utils/operationsProfile'));
        // No profile yet → the defaults (tables on), same as the app assumes.
        let d = (await landing(B.slug)).body.data;
        expect(d.operations).toMatchObject({ tables: { useTables: true }, orderFlow: { customerTracking: true } });
        expect(Object.keys(d.operations).sort()).toEqual(['customerApp', 'orderFlow', 'payment', 'serviceModel', 'tables']);

        // Token mode on the tenant; a branch that keeps its tables.
        const kiosk = await Branch.create({ restaurant: B.restaurant._id, name: 'Tables Annex', slug: 'tables-annex', isActive: true, sortOrder: 2 });
        await Restaurant.updateOne({ _id: B.restaurant._id }, {
            $set: {
                operations: normaliseProfile({ answers: { useTables: false } }),
                operationsByBranch: [{ branch: kiosk._id, overrides: { answers: { useTables: true } }, updatedAt: new Date() }],
            },
        });
        d = (await landing(B.slug)).body.data;                           // plain link → Main → tenant profile
        expect(d.operations.tables.useTables).toBe(false);
        d = (await landing(B.slug, '?branch=main')).body.data;
        expect(d.operations.tables.useTables).toBe(false);
        d = (await landing(B.slug, '?branch=tables-annex')).body.data;  // branch link → its override
        expect(d.operations.tables.useTables).toBe(true);
        expect(d.branch.slug).toBe('tables-annex');

        // The disabled-landing payload carries it too.
        await Settings.updateOne({ restaurant: B.restaurant._id, branch: null }, { $set: { 'landingPage.enabled': false } });
        d = (await landing(B.slug)).body.data;
        expect(d.landing.enabled).toBe(false);
        expect(d.operations.tables.useTables).toBe(false);
        // Nothing internal rides along with the blob.
        expect(JSON.stringify(d)).not.toContain('operationsByBranch');
        await Settings.updateOne({ restaurant: B.restaurant._id, branch: null }, { $set: { 'landingPage.enabled': true } });
        await Restaurant.updateOne({ _id: B.restaurant._id }, { $unset: { operations: 1, operationsByBranch: 1 } });
    });

    test('a stale tenant header does not change which restaurant is served', async () => {
        const res = await ctx.api.guest(B).get(`/public/restaurants/${A.slug}/landing`);
        expect(res.status).toBe(200);
        expect(res.body.data.restaurant.slug).toBe(A.slug);
        expect(res.body.data.featuredItems.every((i) =>
            [A.items.paneer, A.items.thali, A.items.naan].some((x) => String(x._id) === String(i._id)))).toBe(true);
    });

    test('unknown → RESTAURANT_NOT_FOUND, suspended / cancelled → RESTAURANT_UNAVAILABLE', async () => {
        const unknown = await landing('no-such-restaurant-xyz');
        expect(unknown.status).toBe(404);
        expect(unknown.body.code).toBe('RESTAURANT_NOT_FOUND');

        const C = await seedTenant({ label: 'lp-c' });
        for (const status of ['suspended', 'cancelled']) {
            await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { status } });
            const res = await landing(C.slug);
            expect(res.status).toBe(404);
            expect(res.body.code).toBe('RESTAURANT_UNAVAILABLE');
            expect(JSON.stringify(res.body)).not.toContain(C.restaurant.name);
        }
        await Restaurant.updateOne({ _id: C.restaurant._id }, { $set: { status: 'trial' } });
        expect((await landing(C.slug)).status).toBe(200);
    });

    test('disabled landing page still answers 200 with minimal data', async () => {
        expect((await patchLanding(A, { enabled: false })).status).toBe(200);
        const res = await landing(A.slug);
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d.landing.enabled).toBe(false);
        expect(d.restaurant.slug).toBe(A.slug);
        expect(d.contact.phone).toBe('+91 90000 11111');
        expect(d.address.line1).toBe('12 FC Road');
        expect(d.featuredItems).toEqual([]);
        expect((await patchLanding(A, { enabled: true })).status).toBe(200);
    });
});

describe('PATCH /settings/landingPage', () => {
    test('saves a valid landing page (partial merge) and GET /settings returns it', async () => {
        const body = {
            tagline: '  Best dosa in town  ',
            about: 'Family run since 1990.',
            coverImages: ['https://res.cloudinary.com/demo/image/upload/a.jpg'],
            social: { instagram: 'https://instagram.com/lp_a', whatsapp: '+91 90000 11111', googleMapsUrl: 'https://maps.app.goo.gl/abc' },
            sections: { gallery: false },
            accentColor: '#FE8301',
        };
        const res = await patchLanding(A, body);
        expect(res.status).toBe(200);
        expect(res.body.landingPage).toMatchObject({
            tagline: 'Best dosa in town',
            coverImages: body.coverImages,
            social: { instagram: 'https://instagram.com/lp_a', facebook: '', whatsapp: '+91 90000 11111' },
            sections: { gallery: false, featured: true },
            accentColor: '#FE8301',
        });
        // Earlier featured choice survives a partial PATCH.
        expect(res.body.landingPage.featuredItems.length).toBeGreaterThan(0);

        const get = await ctx.api.as(A.users.admin).get('/settings');
        expect(get.status).toBe(200);
        expect(get.body.landingPage.tagline).toBe('Best dosa in town');

        // Stored on the tenant-level doc and served publicly.
        const pub = (await landing(A.slug)).body.data;
        expect(pub.landing).toMatchObject({ tagline: 'Best dosa in town', accentColor: '#FE8301', sections: { gallery: false } });
        expect(pub.address.mapUrl).toBe('https://maps.app.goo.gl/abc');
    });

    test.each([
        ['tagline too long', { tagline: 'x'.repeat(121) }],
        ['about too long', { about: 'x'.repeat(2001) }],
        ['too many cover images', { coverImages: Array.from({ length: 7 }, (_, i) => `https://img.test/${i}.jpg`) }],
        ['cover image not a URL', { coverImages: ['javascript:alert(1)'] }],
        ['social link not a URL', { social: { instagram: 'not a url' } }],
        ['social link too long', { social: { website: `https://x.test/${'a'.repeat(300)}` } }],
        ['bad whatsapp', { social: { whatsapp: 'call me maybe' } }],
        ['bad accent colour', { accentColor: 'red' }],
        ['non-boolean section', { sections: { about: 'yes' } }],
        ['non-boolean enabled', { enabled: 'true' }],
        ['featured item not an id', { featuredItems: ['abc'] }],
        ['too many featured items', { featuredItems: Array.from({ length: 9 }, (_, i) => `507f1f77bcf86cd79943901${i}`) }],
        ['body not an object', ['x']],
    ])('rejects %s with 400', async (_label, body) => {
        const res = await patchLanding(A, body);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test("tenant A admin cannot feature tenant B's menu items", async () => {
        const before = await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean();
        const res = await patchLanding(A, { featuredItems: [String(B.items.paneer._id)] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_FEATURED_ITEMS');

        const mixed = await patchLanding(A, { featuredItems: [String(A.items.naan._id), String(B.items.naan._id)] });
        expect(mixed.status).toBe(400);
        expect(mixed.body.code).toBe('INVALID_FEATURED_ITEMS');

        const after = await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean();
        expect(after.landingPage.featuredItems.map(String)).toEqual(before.landingPage.featuredItems.map(String));
        expect(JSON.stringify((await landing(A.slug)).body)).not.toContain(String(B.items.paneer._id));
    });

    test('full PUT /settings cannot smuggle landingPage past the ownership check', async () => {
        const res = await ctx.api.as(A.users.admin).put('/settings')
            .send({ landingPage: { featuredItems: [String(B.items.paneer._id)], tagline: 'hacked' } });
        expect(res.status).toBe(200);
        const doc = await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean();
        expect(doc.landingPage.tagline).toBe('Best dosa in town');
        expect(doc.landingPage.featuredItems.map(String)).not.toContain(String(B.items.paneer._id));
    });

    test('non-admin staff and anonymous callers cannot edit', async () => {
        expect((await ctx.api.as(A.users.waiter).patch('/settings/landingPage').send({ tagline: 'x' })).status).toBe(403);
        expect([400, 401, 403]).toContain((await ctx.api.anon().patch('/settings/landingPage').send({ tagline: 'x' })).status);
        const doc = await Settings.findOne({ restaurant: A.restaurant._id, branch: null }).lean();
        expect(doc.landingPage.tagline).toBe('Best dosa in town');
    });

    test('sub-branch admin is refused (landing page is tenant-level)', async () => {
        const sub = await Branch.create({ restaurant: A.restaurant._id, name: 'Sub', slug: 'sub', isActive: true });
        const subAdmin = await createUser({
            name: 'Sub admin', email: `sub.${A.slug}@staff.test`, role: 'admin',
            restaurant: A.restaurant._id, branch: sub._id, permissions: {},
        });
        const res = await ctx.api.as(subAdmin).patch('/settings/landingPage').send({ tagline: 'from sub' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('INHERITED_FROM_MAIN');
        // …but reads the tenant's landing page on GET.
        const get = await ctx.api.as(subAdmin).get('/settings');
        expect(get.status).toBe(200);
        expect(get.body.landingPage.tagline).toBe('Best dosa in town');
    });
});

describe('reserved restaurant slugs', () => {
    let superadmin;
    let plan;

    beforeAll(async () => {
        plan = await SubscriptionPlan.create({ name: 'Free', slug: 'free', price: 0, isActive: true });
        superadmin = await createUser({
            name: 'Root', email: 'root@platform.test', role: 'superadmin', superadminLevel: 'full',
        });
    });

    const signup = (body) => ctx.api.anon().post('/public/register-restaurant').send({
        contactEmail: `signup.${Math.random().toString(16).slice(2)}@owners.test`,
        ownerName: 'Owner',
        password: 'Signup#Pass1234',
        contactPhone: '9876543210',
        city: 'Pune',
        acceptTerms: true,
        ...body,
    });

    const superCreate = (body) => ctx.api.as(superadmin).post('/superadmin/restaurants').send({
        contactEmail: `sa.${Math.random().toString(16).slice(2)}@owners.test`,
        ownerName: 'Owner',
        planId: String(plan._id),
        addressLine1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
        legalBusinessName: 'Test Pvt Ltd', fssaiLicense: '12345678901234',
        ...body,
    });

    test('self-signup: generated reserved slug is auto-suffixed', async () => {
        const res = await signup({ restaurantName: 'Admin' });
        expect(res.status).toBe(202);
        const slug = res.body.data.restaurant.slug;
        expect(slug).not.toBe('admin');
        expect(slug).toMatch(/^admin-[a-z0-9]+$/);
    });

    test('self-signup: explicit reserved slug → 400 SLUG_RESERVED', async () => {
        const res = await signup({ restaurantName: 'Login Cafe', slug: 'login' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SLUG_RESERVED');
        expect(await Restaurant.exists({ slug: 'login' })).toBeNull();
    });

    test('self-signup: explicit free slug is used as-is', async () => {
        const res = await signup({ restaurantName: 'Anything', slug: 'my-own-cafe' });
        expect(res.status).toBe(202);
        expect(res.body.data.restaurant.slug).toBe('my-own-cafe');
    });

    test('super admin create: generated reserved slug is auto-suffixed', async () => {
        const res = await superCreate({ name: 'Kiosk' });
        expect(res.status).toBe(201);
        expect(res.body.data.restaurant.slug).toMatch(/^kiosk-[a-z0-9]+$/);
    });

    test('super admin create: explicit reserved slug → 400 SLUG_RESERVED', async () => {
        const res = await superCreate({ name: 'Some Place', slug: 'superadmin' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SLUG_RESERVED');
        expect(await Restaurant.exists({ slug: 'superadmin' })).toBeNull();
    });

    test('super admin create: explicit slug already taken → 400 SLUG_TAKEN', async () => {
        const res = await superCreate({ name: 'Dup', slug: A.slug });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SLUG_TAKEN');
    });
});
