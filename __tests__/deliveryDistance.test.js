/**
 * utils/deliveryDistance + controllers/deliveryController — home-delivery
 * distance and fee.
 *
 *   haversineKm          exact great-circle values for known coordinates
 *   toCoord              coordinate validation (range, 0,0, blanks)
 *   findSlabForDistance  slab boundaries (3.0 km inclusive), gaps, out of range
 *   geocodeAddress       Nominatim (mocked fetch — never the network):
 *                        success, miss, HTTP error, network failure, cache
 *   resolveDeliveryOrigin branch coordinates (tenant scoped) → tenant origin
 *   quoteDelivery        disabled / no slabs / origin unset / address not
 *                        found fallbacks, exact fee + distance, out of range
 *   getDeliveryQuote     HTTP mapping (400 / 200 fallback / 500)
 */
jest.mock('../utils/logger', () => ({
    warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/branch', () => ({ findOne: jest.fn() }));
jest.mock('../utils/settingsCache', () => ({ getSettings: jest.fn() }));

const Branch = require('../models/branch');
const { getSettings } = require('../utils/settingsCache');
const {
    haversineKm, toCoord, findSlabForDistance, geocodeAddress, resolveDeliveryOrigin, quoteDelivery,
} = require('../utils/deliveryDistance');
const { getDeliveryQuote } = require('../controllers/deliveryController');

const R = 6371;
const KM_PER_DEG = (2 * Math.PI * R) / 360; // 111.19492664455873
const TENANT = '0123456789abcdef01234567';
const BRANCH_ID = '89abcdef0123456789abcdef';
const PUNE = { lat: 18.5204, lng: 73.8567 };
/** A point `km` due north of PUNE along the meridian (exact great-circle distance). */
const north = (km) => ({ lat: PUNE.lat + km / KM_PER_DEG, lng: PUNE.lng });

const SLABS = [
    { fromKm: 0, toKm: 3, charge: 30 },
    { fromKm: 3, toKm: 6, charge: 50 },
    { fromKm: 8, toKm: 10, charge: 99.999 },
];
const settingsWith = (delivery) => ({ delivery: { enabled: true, slabs: SLABS, origin: { ...PUNE }, ...delivery } });
const req = (extra = {}) => ({ restaurant: { _id: TENANT }, ...extra });

const branchReturns = (doc) => Branch.findOne.mockReturnValue({ select: () => ({ lean: async () => doc }) });

let uniq = 0;
const freshAddress = (s = 'MG Road, Pune') => `${s} #${uniq += 1}`;

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(() => Promise.reject(new Error('fetch not stubbed in this test')));
    branchReturns(null);
});

// ── haversine ────────────────────────────────────────────────────────

describe('haversineKm', () => {
    test.each([
        ['1° of longitude on the equator', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, KM_PER_DEG],
        ['1° of latitude', { lat: 0, lng: 0 }, { lat: 1, lng: 0 }, KM_PER_DEG],
        ['half the equator', { lat: 0, lng: 0 }, { lat: 0, lng: 180 }, Math.PI * R],
        ['pole to pole', { lat: 90, lng: 0 }, { lat: -90, lng: 0 }, Math.PI * R],
        ['the same point', PUNE, PUNE, 0],
        ['3 km due north', PUNE, north(3), 3],
    ])('%s', (_label, a, b, km) => {
        expect(haversineKm(a, b)).toBeCloseTo(km, 9);
    });

    test('same-latitude points match the closed form 2R·asin(cos φ · sin(Δλ/2)) (60° N, 1° apart)', () => {
        const rad = (d) => (d * Math.PI) / 180;
        const expected = 2 * R * Math.asin(Math.cos(rad(60)) * Math.sin(rad(0.5)));
        expect(haversineKm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })).toBeCloseTo(expected, 9);
        // shorter than the 55.5975 km arc along the parallel (great circle)
        expect(haversineKm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })).toBeLessThan(KM_PER_DEG / 2);
    });

    test('is symmetric and crosses the antimeridian the short way', () => {
        const a = { lat: 10, lng: 179.5 };
        const b = { lat: 10, lng: -179.5 };
        expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 12);
        const rad = (d) => (d * Math.PI) / 180;
        expect(haversineKm(a, b)).toBeCloseTo(2 * R * Math.asin(Math.cos(rad(10)) * Math.sin(rad(0.5))), 9);
    });
});

// ── toCoord ──────────────────────────────────────────────────────────

describe('toCoord', () => {
    test.each([
        ['numbers', 18.5, 73.8, { lat: 18.5, lng: 73.8 }],
        ['numeric strings', '18.5', '73.8', { lat: 18.5, lng: 73.8 }],
        ['the range edges', -90, 180, { lat: -90, lng: 180 }],
        ['0,0 (the unset default)', 0, 0, null],
        ['latitude above 90', 90.0001, 10, null],
        ['longitude below -180', 10, -180.1, null],
        ['blank strings', '', '', null],
        ['null', null, 73, null],
        ['text', 'north', 'east', null],
        ['Infinity', Infinity, 1, null],
    ])('%s', (_label, lat, lng, out) => {
        expect(toCoord(lat, lng)).toEqual(out);
    });
});

// ── slabs ────────────────────────────────────────────────────────────

describe('findSlabForDistance', () => {
    test.each([
        [0, 30],
        [2.99, 30],
        [3.0, 30],     // boundary is inclusive on the lower slab
        [3.01, 50],
        [6, 50],
        [6.01, 99.999],  // gap 6–8 → next slab up
        [7.5, 99.999],
        [10, 99.999],
    ])('%d km → ₹%d', (km, charge) => {
        expect(findSlabForDistance(SLABS, km).charge).toBe(charge);
    });

    test('beyond the last slab is out of range (null)', () => {
        expect(findSlabForDistance(SLABS, 10.01)).toBeNull();
    });

    test('unsorted slabs, string numbers and junk rows are handled', () => {
        const slabs = [{ fromKm: '3', toKm: '6', charge: '45' }, { fromKm: 'x', toKm: 2, charge: 1 }, { fromKm: 0, toKm: 3, charge: null }];
        expect(findSlabForDistance(slabs, 2)).toEqual({ fromKm: 0, toKm: 3, charge: 0 });
        expect(findSlabForDistance(slabs, 4)).toEqual({ fromKm: 3, toKm: 6, charge: 45 });
        expect(findSlabForDistance(null, 1)).toBeNull();
    });
});

// ── geocoding (fetch mocked) ─────────────────────────────────────────

describe('geocodeAddress', () => {
    const ok = (rows) => Promise.resolve({ ok: true, json: async () => rows });

    test('returns the first hit and caches it (one request per address)', async () => {
        global.fetch.mockImplementation(() => ok([{ lat: '18.53', lon: '73.85' }]));
        const addr = freshAddress();
        expect(await geocodeAddress(addr)).toEqual({ lat: 18.53, lng: 73.85 });
        expect(await geocodeAddress(`  ${addr.toUpperCase()} `)).toEqual({ lat: 18.53, lng: 73.85 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addr)}`);
        expect(opts.headers['User-Agent']).toMatch(/BestoDine/);
        expect(opts.signal).toBeDefined();
    });

    test('a miss is cached as null', async () => {
        global.fetch.mockImplementation(() => ok([]));
        const addr = freshAddress('Nowhere');
        expect(await geocodeAddress(addr)).toBeNull();
        expect(await geocodeAddress(addr)).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('a network failure returns null and is NOT cached (next call retries)', async () => {
        const addr = freshAddress('Flaky');
        global.fetch.mockImplementationOnce(() => Promise.reject(new Error('ECONNRESET')));
        expect(await geocodeAddress(addr)).toBeNull();
        global.fetch.mockImplementationOnce(() => ok([{ lat: '18.6', lon: '73.9' }]));
        expect(await geocodeAddress(addr)).toEqual({ lat: 18.6, lng: 73.9 });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('an HTTP error and an out-of-range hit both resolve to null; blank input never calls out', async () => {
        global.fetch.mockImplementationOnce(() => Promise.resolve({ ok: false, json: async () => [] }));
        expect(await geocodeAddress(freshAddress('Err'))).toBeNull();
        global.fetch.mockImplementationOnce(() => ok([{ lat: '95', lon: '10' }]));
        expect(await geocodeAddress(freshAddress('Bad'))).toBeNull();
        global.fetch.mockClear();
        expect(await geocodeAddress('   ')).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

// ── origin ───────────────────────────────────────────────────────────

describe('resolveDeliveryOrigin', () => {
    test('branch coordinates win, looked up inside the caller’s tenant', async () => {
        branchReturns({ latitude: 18.6, longitude: 73.7 });
        const o = await resolveDeliveryOrigin(req(), settingsWith({}), BRANCH_ID);
        expect(o).toEqual({ lat: 18.6, lng: 73.7, source: 'branch' });
        expect(Branch.findOne).toHaveBeenCalledWith({ _id: BRANCH_ID, restaurant: TENANT });
    });

    test('a branch without coordinates (or an invalid id) falls back to the tenant origin', async () => {
        branchReturns({ latitude: 0, longitude: 0 });
        expect(await resolveDeliveryOrigin(req(), settingsWith({}), BRANCH_ID)).toEqual({ ...PUNE, source: 'restaurant' });
        Branch.findOne.mockClear();
        expect(await resolveDeliveryOrigin(req(), settingsWith({}), 'not-an-id')).toEqual({ ...PUNE, source: 'restaurant' });
        expect(Branch.findOne).not.toHaveBeenCalled();
    });

    test('a branch lookup error falls back; nothing configured → null', async () => {
        Branch.findOne.mockImplementation(() => { throw new Error('db down'); });
        expect(await resolveDeliveryOrigin(req(), settingsWith({}), BRANCH_ID)).toEqual({ ...PUNE, source: 'restaurant' });
        expect(await resolveDeliveryOrigin(req(), settingsWith({ origin: { lat: 0, lng: 0 } }), null)).toBeNull();
    });
});

// ── quote ────────────────────────────────────────────────────────────

describe('quoteDelivery', () => {
    test.each([
        ['delivery switched off', { enabled: false }, 'DELIVERY_DISABLED', false],
        ['no slabs', { slabs: [] }, 'DELIVERY_NO_SLABS', false],
        ['no origin anywhere', { origin: null }, 'DELIVERY_ORIGIN_UNSET', true],
    ])('%s → %s (fallback %s)', async (_label, cfg, code, fallback) => {
        const q = await quoteDelivery({ req: req(), settings: settingsWith(cfg), lat: north(1).lat, lng: north(1).lng });
        expect(q).toMatchObject({ ok: false, code, fallback });
    });

    test('exactly 3.00 km → the ₹30 slab; 3.01 km → the ₹50 slab', async () => {
        const at3 = north(3);
        const q3 = await quoteDelivery({ req: req(), settings: settingsWith({}), lat: at3.lat, lng: at3.lng });
        expect(q3).toMatchObject({ ok: true, distanceKm: 3, charge: 30, slab: { fromKm: 0, toKm: 3, charge: 30 }, method: 'coordinates', originSource: 'restaurant' });

        const past = north(3.01);
        const q301 = await quoteDelivery({ req: req(), settings: settingsWith({}), lat: past.lat, lng: past.lng });
        expect(q301).toMatchObject({ ok: true, distanceKm: 3.01, charge: 50 });
    });

    test('distance is rounded to 2 dp BEFORE slab matching: 3.004 km is billed as 3.00 (₹30)', async () => {
        const p = north(3.004);
        const q = await quoteDelivery({ req: req(), settings: settingsWith({}), lat: p.lat, lng: p.lng });
        expect(q).toMatchObject({ distanceKm: 3, charge: 30 });
    });

    test('the fee is rounded to the paisa (₹99.999 → ₹100)', async () => {
        const p = north(9);
        const q = await quoteDelivery({ req: req(), settings: settingsWith({}), lat: p.lat, lng: p.lng });
        expect(q).toMatchObject({ ok: true, distanceKm: 9, charge: 100, slab: { charge: 100 } });
    });

    test('beyond the last slab: out of range with the measured distance', async () => {
        const p = north(12.36);
        const q = await quoteDelivery({ req: req(), settings: settingsWith({}), lat: p.lat, lng: p.lng });
        expect(q).toEqual({
            ok: false, fallback: false, code: 'DELIVERY_OUT_OF_RANGE', distanceKm: 12.36, maxKm: 10,
            message: 'Your address is about 12.4 km away — we deliver up to 10 km.',
        });
    });

    test('an address is geocoded when no coordinates are sent', async () => {
        const dest = north(4);
        global.fetch.mockResolvedValue({ ok: true, json: async () => [{ lat: String(dest.lat), lon: String(dest.lng) }] });
        const q = await quoteDelivery({ req: req(), settings: settingsWith({}), address: freshAddress('Koregaon Park') });
        expect(q).toMatchObject({ ok: true, distanceKm: 4, charge: 50, method: 'geocoded' });
    });

    test('geocoder down → fallback so the customer can pick a slab manually', async () => {
        global.fetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
        const q = await quoteDelivery({ req: req(), settings: settingsWith({}), address: freshAddress('Down') });
        expect(q).toMatchObject({ ok: false, fallback: true, code: 'DELIVERY_ADDRESS_NOT_FOUND' });
    });

    test('valid coordinates win over the address (no geocoder call); invalid ones fall through to it', async () => {
        const p = north(1);
        const q = await quoteDelivery({ req: req(), settings: settingsWith({}), lat: p.lat, lng: p.lng, address: freshAddress() });
        expect(q.method).toBe('coordinates');
        expect(global.fetch).not.toHaveBeenCalled();

        global.fetch.mockResolvedValue({ ok: true, json: async () => [{ lat: String(p.lat), lon: String(p.lng) }] });
        const q2 = await quoteDelivery({ req: req(), settings: settingsWith({}), lat: 0, lng: 0, address: freshAddress() });
        expect(q2).toMatchObject({ method: 'geocoded', distanceKm: 1, charge: 30 });
    });
});

// ── controller ───────────────────────────────────────────────────────

describe('deliveryController.getDeliveryQuote', () => {
    const mkRes = () => {
        const res = { statusCode: 200, body: null };
        res.status = jest.fn((c) => { res.statusCode = c; return res; });
        res.json = jest.fn((b) => { res.body = b; return res; });
        return res;
    };
    const call = async (body, extraReq = {}) => {
        const res = mkRes();
        await getDeliveryQuote({ body, ...req(extraReq) }, res);
        return res;
    };

    test('no location and no address → 400 DELIVERY_LOCATION_REQUIRED', async () => {
        const res = await call({ address: '  \u0007 ' });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('DELIVERY_LOCATION_REQUIRED');
        expect(getSettings).not.toHaveBeenCalled();
    });

    test('measured quote: 200 with distance, slab, fee and origin source', async () => {
        getSettings.mockResolvedValue(settingsWith({}));
        const p = north(5);
        const res = await call({ lat: p.lat, lng: p.lng });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true, distanceKm: 5, slab: { fromKm: 3, toKm: 6, charge: 50 }, charge: 50,
            location: { lat: p.lat, lng: p.lng }, method: 'coordinates', originSource: 'restaurant',
        });
    });

    test('a fallback is 200 success:false (checkout shows the manual picker); a hard refusal is 400', async () => {
        getSettings.mockResolvedValue(settingsWith({ origin: null }));
        const fb = await call({ lat: 18.6, lng: 73.9 });
        expect(fb.statusCode).toBe(200);
        expect(fb.body).toMatchObject({ success: false, fallback: true, code: 'DELIVERY_ORIGIN_UNSET' });

        getSettings.mockResolvedValue(settingsWith({ enabled: false }));
        const off = await call({ lat: 18.6, lng: 73.9 });
        expect(off.statusCode).toBe(400);
        expect(off.body).toMatchObject({ success: false, code: 'DELIVERY_DISABLED' });
    });

    test('control characters are stripped and the address is capped at 500 chars before geocoding', async () => {
        getSettings.mockResolvedValue(settingsWith({}));
        global.fetch.mockResolvedValue({ ok: true, json: async () => [] });
        const res = await call({ address: `\u0000Baner\u001F ${'x'.repeat(800)}` });
        expect(res.statusCode).toBe(200);
        expect(res.body.code).toBe('DELIVERY_ADDRESS_NOT_FOUND');
        const q = decodeURIComponent(global.fetch.mock.calls[0][0].split('&q=')[1]);
        expect(q.startsWith('Baner ')).toBe(true);
        expect(q).not.toMatch(/[\x00-\x1F]/);
        expect(q.length).toBe(300); // geocoder clamps the 500-char address to 300
    });

    test('an unexpected error is a 500 without internals', async () => {
        getSettings.mockRejectedValue(new Error('redis exploded'));
        const res = await call({ lat: 18.6, lng: 73.9 });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ success: false, message: 'Could not calculate delivery charge.' });
    });
});
