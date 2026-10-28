/**
 * Scan my menu: POST /menu/scan returns a DRAFT, saves nothing, and the
 * confirmed rows then go through the existing CSV importer.
 */
const path = require('path');
const sharp = require('sharp');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const extractor = require(path.join(BACKEND, 'utils/menuScan/extractor'));

const ctx = useIntegrationApp();
let A;

beforeAll(async () => { A = await seedTenant({ label: 'scan-a' }); });
afterEach(() => extractor.setReaderForTests(null));

const admin = () => ctx.api.as(A.users.admin, A);
// A flat grey page has no edges, so it scores as blurry; noise-free white scores blurry too.
const flat = (bg) => sharp({ create: { width: 1600, height: 1200, channels: 3, background: bg } }).jpeg().toBuffer();
const scan = async () => admin().post('/menu/scan').attach('files', await flat('#fff'), { filename: 'm.jpg', contentType: 'image/jpeg' });

test('without an API key the endpoint answers 503 SCAN_NOT_CONFIGURED', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
        const res = await scan();
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('SCAN_NOT_CONFIGURED');
    } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
});

test('returns draft rows and saves nothing', async () => {
    const before = await MenuItem.countDocuments({ restaurant: A.restaurant._id });
    extractor.setReaderForTests(async (pages) => {
        expect(pages[0].mediaType).toBe('image/jpeg');
        return [
            { name: 'Paneer Tikka', category: 'Starters', price: 240, veg_type: 'veg', certainty: 0.95, page: 1 },
            { name: 'Chicken Curry', category: 'Mains', price: null, veg_type: 'unknown', certainty: 0.8, page: 1 },
        ];
    });
    const res = await scan();
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(2);
    expect(res.body.data.rows[1]).toMatchObject({ basePrice: null, vegType: 'non-veg', needsCheck: true });
    expect(res.body.data.needsCheckCount).toBeGreaterThanOrEqual(1);
    expect([...res.body.data.categories].sort()).toEqual(['Mains', 'Starters']);
    expect(res.body.data.pages[0].quality).toHaveProperty('level');
    expect(await MenuItem.countDocuments({ restaurant: A.restaurant._id })).toBe(before);
});

test('a blurry page is read twice', async () => {
    let calls = 0;
    extractor.setReaderForTests(async () => {
        calls += 1;
        return [{ name: 'Naan', category: 'Breads', price: 40, veg_type: 'veg', certainty: 0.8, page: 1 }];
    });
    const res = await scan();
    expect(res.status).toBe(200);
    expect(res.body.data.pages[0].quality.level).toBe('blurry');
    expect(calls).toBe(2);
});

test('nothing found, no files, bad type and non-admin are refused cleanly', async () => {
    extractor.setReaderForTests(async () => []);
    expect((await scan()).body.code).toBe('NOTHING_FOUND');
    expect((await admin().post('/menu/scan')).body.code).toBe('NO_FILES');
    const bad = await admin().post('/menu/scan').attach('files', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(bad.status).toBe(400);
    const w = await ctx.api.as(A.users.waiter, A).post('/menu/scan')
        .attach('files', await flat('#fff'), { filename: 'm.jpg', contentType: 'image/jpeg' });
    expect([401, 403]).toContain(w.status);
});

test('confirmed rows import through the existing CSV importer', async () => {
    const csv = 'name,description,category,baseprice,vegtype,sizes\n"Scan Tikka","Scan Tikka","Scan Starters","240","veg","Half:120:1|Full:220:1"\n';
    const res = await admin().post('/menu/import').attach('file', Buffer.from(csv), { filename: 'menu-scan.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const item = await MenuItem.findOne({ restaurant: A.restaurant._id, name: 'Scan Tikka' }).lean();
    expect(item.basePrice).toBe(240);
    expect(item.sizes.map((s) => s.name)).toEqual(['Half', 'Full']);
});
