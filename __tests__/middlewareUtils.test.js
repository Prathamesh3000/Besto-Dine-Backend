/**
 * Unit tests for the request-pipeline helpers (checklist 10.1, 10.2, 10.5, 10.6):
 *
 *   middlewares/idempotency.js     key format, scoping, replay, 4xx/5xx caching,
 *                                  write race (E11000), fail-open lookup, required mode
 *   middlewares/validate.js        error shape, ObjectId helpers, no implicit sanitisation
 *   middlewares/uploadMiddleware.js image type / size limits, ext-vs-mime spoofing
 *   middlewares/csvUpload.js       CSV type / size limits (ext OR mime)
 *   utils/csvParser.js             RFC-4180-ish parsing edge cases, formula cells
 *   utils/cloudinaryUploader.js    compression branch per format, Cloudinary errors
 *
 * The idempotency HTTP-level behaviour against the real Mongo model (unique
 * index, verify-payment stale-400 replay, concurrent same-key money calls)
 * lives in __tests__/integration/idempotencySettings.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-unit-test-secret!!';
process.env.CLOUDINARY_CLOUD_NAME = 'cloud-x';
process.env.CLOUDINARY_API_KEY = 'key-x';
process.env.CLOUDINARY_API_SECRET = 'secret-x';

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockFindOne = jest.fn();
const mockCreate = jest.fn();
jest.mock('../models/idempotencyRecord', () => ({
    findOne: (...a) => mockFindOne(...a),
    create: (...a) => mockCreate(...a),
}));

// authMiddleware drags in models + DB; idempotency only needs the typed
// scan-token verifier, so re-implement it on the real jsonwebtoken.
jest.mock('../middlewares/authMiddleware', () => {
    const jwt = require('jsonwebtoken');
    const TOKEN_TYPES = { USER: 'user', SCAN: 'scan', KIOSK: 'kiosk' };
    return {
        TOKEN_TYPES,
        verifyTypedToken: (token, typ) => {
            const d = jwt.verify(token, process.env.JWT_SECRET);
            if (d.typ !== typ) throw new Error('wrong type');
            return d;
        },
    };
});

const mockUploadStream = jest.fn();
const mockCloudConfig = jest.fn();
jest.mock('cloudinary', () => ({
    v2: {
        config: (...a) => mockCloudConfig(...a),
        uploader: { upload_stream: (...a) => mockUploadStream(...a) },
    },
}));

const mockSharpCalls = [];
// Set to true to make sharp fail to decode (e.g. iPhone HEIC).
let mockSharpCannotDecode = false;
jest.mock('sharp', () => (buf) => {
    const chain = {
        rotate: () => { mockSharpCalls.push(['rotate']); return chain; },
        resize: (o) => { mockSharpCalls.push(['resize', o]); return chain; },
        png: (o) => { mockSharpCalls.push(['png', o]); return chain; },
        webp: (o) => { mockSharpCalls.push(['webp', o]); return chain; },
        jpeg: (o) => { mockSharpCalls.push(['jpeg', o]); return chain; },
        toBuffer: async () => {
            if (mockSharpCannotDecode) throw new Error('Input buffer contains unsupported image format');
            return Buffer.concat([Buffer.from('OUT:'), buf]);
        },
    };
    return chain;
});

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const logger = require('../utils/logger');
const { idempotency, scopedIdempotencyKey, callerIdentity } = require('../middlewares/idempotency');
const {
    validate, handleValidation, isObjectIdLike, objectIdParam, requiredObjectId,
    optionalObjectId, optionalObjectIdArray, body, query,
} = require('../middlewares/validate');
const upload = require('../middlewares/uploadMiddleware');
const { csvUpload } = require('../middlewares/csvUpload');
const { parseCsv } = require('../utils/csvParser');
const { compressAndUpload } = require('../utils/cloudinaryUploader');

const TENANT = '507f1f77bcf86cd799439011';
const OTHER_TENANT = '507f1f77bcf86cd799439099';
const USER = '507f1f77bcf86cd799439022';
const KEY = 'abcDEF_123-xyz';

// ── helpers ─────────────────────────────────────────────────────────

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

function mockReq({ key, user, restaurant = { _id: TENANT }, method = 'POST', url = '/api/v1/razorpay/verify-payment', ip = '10.0.0.1', headers = {} } = {}) {
    const h = { ...headers };
    if (key !== undefined) h['idempotency-key'] = key;
    return {
        method,
        originalUrl: url,
        ip,
        user,
        restaurant,
        headers: h,
        get: (name) => h[String(name).toLowerCase()],
    };
}

const leanResult = (v) => ({ lean: () => Promise.resolve(v) });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    mockFindOne.mockReset();
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({});
    logger.warn.mockClear();
});

// ════════════════════════ idempotency ════════════════════════════════

describe('idempotency() — key handling', () => {
    test('no header, optional mode → passes through without touching the DB', async () => {
        const next = jest.fn();
        await idempotency()(mockReq(), mockRes(), next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(mockFindOne).not.toHaveBeenCalled();
    });

    test('no header, required mode → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
        const res = mockRes();
        const next = jest.fn();
        await idempotency({ required: true })(mockReq(), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(expect.objectContaining({ success: false, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    });

    test.each([
        ['too short (7)', 'abcdefg'],
        ['too long (129)', 'a'.repeat(129)],
        ['space', 'abc def ghi'],
        ['dot', 'abc.defghi'],
        ['unicode', 'ключключключ'],
        ['mongo operator chars', '{$gt:""}xx'],
        ['slash', 'abcd/efgh'],
    ])('malformed key (%s) → 400 IDEMPOTENCY_KEY_INVALID', async (_l, key) => {
        const res = mockRes();
        const next = jest.fn();
        await idempotency()(mockReq({ key }), res, next);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
        expect(next).not.toHaveBeenCalled();
        expect(mockFindOne).not.toHaveBeenCalled();
    });

    test.each([
        ['min length 8', 'a'.repeat(8)],
        ['max length 128', 'Z'.repeat(128)],
        ['uuid v4', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
        ['underscore/hex', 'verify_0a1b2c3d'],
    ])('well-formed key (%s) is accepted', async (_l, key) => {
        mockFindOne.mockReturnValue(leanResult(null));
        const next = jest.fn();
        await idempotency()(mockReq({ key }), mockRes(), next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('idempotency() — scoping', () => {
    const base = () => mockReq({ key: KEY, user: { _id: USER } });
    const k = (req) => scopedIdempotencyKey(req, KEY);

    test('stored key is a sha256 hex digest, never the raw client key', () => {
        const key = k(base());
        expect(key).toMatch(/^[a-f0-9]{64}$/);
        expect(key).not.toContain(KEY);
    });

    test('same caller/tenant/method/path/key → same scoped key; query string ignored', () => {
        const a = base();
        const b = { ...base(), originalUrl: '/api/v1/razorpay/verify-payment?x=1' };
        expect(k(a)).toBe(k(b));
    });

    test.each([
        ['different user', (r) => { r.user = { _id: '507f1f77bcf86cd799439033' }; }],
        ['different tenant', (r) => { r.restaurant = { _id: OTHER_TENANT }; }],
        ['different method', (r) => { r.method = 'PATCH'; }],
        ['different path', (r) => { r.originalUrl = '/api/v1/razorpay/refund'; }],
        ['anonymous (IP) caller', (r) => { r.user = undefined; }],
    ])('%s → different scoped key', (_l, mutate) => {
        const a = base();
        const b = base();
        mutate(b);
        expect(k(b)).not.toBe(k(a));
    });

    test('method is case-normalised', () => {
        const a = base();
        const b = { ...base(), method: 'post' };
        expect(k(a)).toBe(k(b));
    });

    test('tenant falls back to req.user.restaurant when attachTenant did not run', () => {
        const a = mockReq({ key: KEY, user: { _id: USER, restaurant: TENANT }, restaurant: null });
        const b = mockReq({ key: KEY, user: { _id: USER }, restaurant: { _id: TENANT } });
        expect(k(a)).toBe(k(b));
    });

    test('callerIdentity: user id beats scan token beats IP', () => {
        const scan = jwt.sign({ typ: 'scan', sessionId: 'sess-1', tableId: 't1' }, process.env.JWT_SECRET);
        expect(callerIdentity(mockReq({ user: { id: USER }, headers: { 'x-scan-token': scan } }))).toBe(`user:${USER}`);
        expect(callerIdentity(mockReq({ headers: { 'x-scan-token': scan } }))).toBe('scan:sess-1');
        expect(callerIdentity(mockReq({ ip: '1.2.3.4' }))).toBe('ip:1.2.3.4');
        expect(callerIdentity({ headers: {} })).toBe('ip:unknown');
    });

    test.each([
        ['forged signature', () => jwt.sign({ typ: 'scan', sessionId: 'victim' }, 'not-the-secret')],
        ['user token presented as scan token', () => jwt.sign({ typ: 'user', id: USER, sessionId: 'victim' }, process.env.JWT_SECRET)],
        ['garbage', () => 'not.a.jwt'],
    ])('scan token that fails verification (%s) falls back to IP identity', (_l, make) => {
        const req = mockReq({ ip: '9.9.9.9', headers: { 'x-scan-token': make() } });
        expect(callerIdentity(req)).toBe('ip:9.9.9.9');
    });

    test('scan identity is ignored when JWT_SECRET is unset', () => {
        const scan = jwt.sign({ typ: 'scan', sessionId: 'sess-1' }, process.env.JWT_SECRET);
        const prev = process.env.JWT_SECRET;
        delete process.env.JWT_SECRET;
        try {
            expect(callerIdentity(mockReq({ ip: '5.5.5.5', headers: { 'x-scan-token': scan } }))).toBe('ip:5.5.5.5');
        } finally {
            process.env.JWT_SECRET = prev;
        }
    });

    test('scan token read from raw headers when req.get is absent', () => {
        const scan = jwt.sign({ typ: 'scan', sessionId: 'raw-1' }, process.env.JWT_SECRET);
        expect(callerIdentity({ headers: { 'x-scan-token': scan } })).toBe('scan:raw-1');
    });

    test('degenerate request (no url/method/tenant/user) still yields a stable key', () => {
        const bare = { headers: {} };
        const viaUrl = { headers: {}, url: '/x?y=1' };
        expect(scopedIdempotencyKey(bare, KEY)).toMatch(/^[a-f0-9]{64}$/);
        expect(scopedIdempotencyKey(viaUrl, KEY)).toBe(scopedIdempotencyKey({ headers: {}, url: '/x' }, KEY));
        expect(scopedIdempotencyKey(viaUrl, KEY)).not.toBe(scopedIdempotencyKey(bare, KEY));
    });

    test('lookup uses the scoped key', async () => {
        mockFindOne.mockReturnValue(leanResult(null));
        const req = base();
        await idempotency()(req, mockRes(), jest.fn());
        expect(mockFindOne).toHaveBeenCalledWith({ key: k(req) });
    });
});

describe('idempotency() — replay and recording', () => {
    test('existing record → replays cached status + body with Idempotent-Replayed, handler skipped', async () => {
        mockFindOne.mockReturnValue(leanResult({ statusCode: 201, response: { success: true, id: 7 } }));
        const res = mockRes();
        const next = jest.fn();
        await idempotency()(mockReq({ key: KEY }), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({ success: true, id: 7 });
        expect(res.headers['Idempotent-Replayed']).toBe('true');
    });

    test('record with no statusCode replays as 200', async () => {
        mockFindOne.mockReturnValue(leanResult({ response: { ok: 1 } }));
        const res = mockRes();
        await idempotency()(mockReq({ key: KEY }), res, jest.fn());
        expect(res.statusCode).toBe(200);
    });

    test.each([
        [200, true],
        [201, true],
        // Only 2xx + 409 are cached (fixed 2026-10): a transient 4xx such as
        // 400 PAYMENT_NOT_CAPTURED must not be replayed to a later retry.
        [400, false],
        [404, false],
        [409, true],
        [499, false],
        [500, false],
        [502, false],
        [503, false],
    ])('first response with status %i → recorded: %s', async (status, recorded) => {
        mockFindOne.mockReturnValue(leanResult(null));
        const req = mockReq({ key: KEY, user: { _id: USER } });
        const res = mockRes();
        await idempotency()(req, res, () => res.status(status).json({ s: status }));
        expect(res.body).toEqual({ s: status });
        expect(mockCreate).toHaveBeenCalledTimes(recorded ? 1 : 0);
        if (recorded) {
            expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
                key: scopedIdempotencyKey(req, KEY),
                endpoint: 'POST /api/v1/razorpay/verify-payment',
                user: USER,
                restaurant: TENANT,
                statusCode: status,
                response: { s: status },
            }));
        }
    });

    test('guest request records user:null', async () => {
        mockFindOne.mockReturnValue(leanResult(null));
        const res = mockRes();
        await idempotency()(mockReq({ key: KEY, restaurant: null }), res, () => res.json({ ok: 1 }));
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ user: null, restaurant: null, statusCode: 200 }));
    });

    test('duplicate-key write (concurrent twin) is swallowed silently', async () => {
        mockFindOne.mockReturnValue(leanResult(null));
        mockCreate.mockRejectedValue(Object.assign(new Error('E11000 dup'), { code: 11000 }));
        const res = mockRes();
        await idempotency()(mockReq({ key: KEY }), res, () => res.json({ ok: 1 }));
        await flush();
        expect(res.body).toEqual({ ok: 1 });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('any other write failure is logged but the response still goes out', async () => {
        mockFindOne.mockReturnValue(leanResult(null));
        mockCreate.mockRejectedValue(new Error('disk full'));
        const res = mockRes();
        await idempotency()(mockReq({ key: KEY }), res, () => res.json({ ok: 1 }));
        await flush();
        expect(res.body).toEqual({ ok: 1 });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    });

    test('lookup failure fails OPEN: handler runs, nothing is recorded, warning logged', async () => {
        mockFindOne.mockReturnValue({ lean: () => Promise.reject(new Error('mongo down')) });
        const res = mockRes();
        const next = jest.fn(() => res.json({ ran: true }));
        await idempotency()(mockReq({ key: KEY }), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.body).toEqual({ ran: true });
        expect(mockCreate).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
    });

    test('lookup failure fails open even in required mode (key present)', async () => {
        mockFindOne.mockReturnValue({ lean: () => Promise.reject(new Error('mongo down')) });
        const next = jest.fn();
        await idempotency({ required: true })(mockReq({ key: KEY }), mockRes(), next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('two concurrent requests with the same key BOTH run the handler (no in-flight lock)', async () => {
        // Characterisation: the middleware only dedupes AFTER the first
        // response is stored. Money endpoints rely on their own claims
        // (PaymentClaim) for concurrent safety — see integration suite.
        mockFindOne.mockReturnValue(leanResult(null));
        const handler = jest.fn();
        const mw = idempotency();
        const r1 = mockRes();
        const r2 = mockRes();
        await Promise.all([
            mw(mockReq({ key: KEY }), r1, () => { handler(); r1.json({ n: 1 }); }),
            mw(mockReq({ key: KEY }), r2, () => { handler(); r2.json({ n: 2 }); }),
        ]);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    test('responses sent with res.send (not res.json) are never recorded', async () => {
        mockFindOne.mockReturnValue(leanResult(null));
        const res = mockRes();
        res.send = jest.fn();
        await idempotency()(mockReq({ key: KEY }), res, () => res.send('ok'));
        expect(mockCreate).not.toHaveBeenCalled();
    });
});

// ════════════════════════ validate ═══════════════════════════════════

async function runChain(chain, req) {
    const res = mockRes();
    for (const mw of chain) {
        let called = false;
        await mw(req, res, () => { called = true; });
        if (!called) return { res, passed: false };
    }
    return { res, passed: true };
}

describe('validate.js', () => {
    const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

    test.each([
        [ID, true],
        [ID.toUpperCase(), true],
        ['aaaaaaaaaaaaaaaaaaaaaaa', false],
        ['zzzzzzzzzzzzzzzzzzzzzzzz', false],
        [null, false],
        [undefined, false],
        [123, false],
        [{ _id: ID }, true],
        [{ _id: 'bad' }, false],
        [{ toHexString: () => ID }, true],
        [{ toHexString: () => 'nope' }, false],
        [{}, false],
        [{ $gt: '' }, false],
    ])('isObjectIdLike(%p) → %p', (v, expected) => {
        expect(isObjectIdLike(v)).toBe(expected);
    });

    test('self-referencing _id does not recurse forever', () => {
        const o = {};
        o._id = o;
        expect(isObjectIdLike(o)).toBe(false);
    });

    test('objectIdParam: default name + custom message', async () => {
        const bad = await runChain(validate([objectIdParam()]), { params: { id: 'x' }, body: {}, query: {} });
        expect(bad.res.body).toEqual({ success: false, message: 'Invalid id', errors: [{ field: 'id', message: 'Invalid id' }] });
        const custom = await runChain(validate(objectIdParam('postId', 'Bad post')), { params: { postId: 'x' }, body: {}, query: {} });
        expect(custom.res.body.message).toBe('Bad post');
        const ok = await runChain(validate([objectIdParam()]), { params: { id: ID }, body: {}, query: {} });
        expect(ok.passed).toBe(true);
    });

    test('requiredObjectId: missing → "is required", malformed → "Invalid"', async () => {
        const chain = validate([requiredObjectId('body', 'table')]);
        const missing = await runChain(chain, { params: {}, body: {}, query: {} });
        expect(missing.res.body.errors).toEqual([{ field: 'table', message: 'table is required' }]);
        const bad = await runChain(chain, { params: {}, body: { table: 'nope' }, query: {} });
        expect(bad.res.body.errors).toEqual([{ field: 'table', message: 'Invalid table' }]);
        const ok = await runChain(chain, { params: {}, body: { table: ID }, query: {} });
        expect(ok.passed).toBe(true);
    });

    test.each([
        ['query', 'all', true],
        ['body', 'all', false],
        ['query', '', true],
        ['query', null, true],
        ['query', 'bad', false],
        ['param', ID, true],
        ['check', 'bad', false],
    ])('optionalObjectId(%s) with %p → passes: %p', async (loc, v, ok) => {
        const container = loc === 'param' ? 'params' : (loc === 'check' ? 'body' : loc);
        const req = { params: {}, body: {}, query: {} };
        req[container].branch = v;
        const { passed } = await runChain(validate([optionalObjectId(loc, 'branch')]), req);
        expect(passed).toBe(ok);
    });

    test.each([
        [[ID, ID], true],
        [[], true],
        [null, true],
        [undefined, true],
        [[ID, 'x'], false],
        ['not-array', false],
    ])('optionalObjectIdArray(%p) → passes: %p', async (v, ok) => {
        const { passed, res } = await runChain(validate([optionalObjectIdArray('body', 'items')]), { params: {}, body: { items: v }, query: {} });
        expect(passed).toBe(ok);
        if (!ok) expect(res.body.message).toBe('items must be a list of valid ids');
    });

    test('one error per field (first failing rule) and message = first error', async () => {
        const chain = validate([
            body('qty').isInt().withMessage('qty int'),
            body('qty').isInt({ min: 5 }).withMessage('qty min'),
            body('name').isString().withMessage('name str'),
        ]);
        const { res } = await runChain(chain, { params: {}, body: { qty: 'x', name: 3 }, query: {} });
        expect(res.statusCode).toBe(400);
        expect(res.body.errors).toEqual([
            { field: 'qty', message: 'qty int' },
            { field: 'name', message: 'name str' },
        ]);
        expect(res.body.message).toBe('qty int');
    });

    test('no sanitisation: valid input is left exactly as sent (incl. HTML / operators)', async () => {
        const req = { params: {}, body: { name: '  <b>x</b>  ', filter: { $ne: 1 } }, query: { q: ' a ' } };
        const { passed } = await runChain(validate([body('name').isString(), query('q').optional().isString()]), req);
        expect(passed).toBe(true);
        expect(req.body).toEqual({ name: '  <b>x</b>  ', filter: { $ne: 1 } });
        expect(req.query.q).toBe(' a ');
    });

    test('root-body and oneOf() errors get synthetic field labels', async () => {
        const { check, oneOf } = require('express-validator');
        const root = await runChain(validate([body().custom(() => false).withMessage('must be object')]), { params: {}, body: [], query: {} });
        expect(root.res.body.errors).toEqual([{ field: 'field', message: 'must be object' }]);
        const alt = await runChain(validate([oneOf([check('a').exists(), check('b').exists()], { message: 'need a or b', errorType: 'least_errored' })]), { params: {}, body: {}, query: {} });
        expect(alt.res.body.errors).toEqual([{ field: 'request', message: 'need a or b' }]);
    });

    test('handleValidation with no errors calls next; alternative/unknown errors get a field label', async () => {
        const next = jest.fn();
        handleValidation({ params: {}, body: {}, query: {} }, mockRes(), next);
        expect(next).toHaveBeenCalled();
        // A message-less error falls back to "Invalid value".
        const { res } = await runChain(validate([body('x').custom(() => false)]), { params: {}, body: { x: 1 }, query: {} });
        expect(res.body.errors[0]).toEqual({ field: 'x', message: 'Invalid value' });
    });
});

// ════════════════════════ upload middlewares ═════════════════════════

function uploadApp(mw) {
    const app = express();
    app.post('/up', mw, (req, res) => res.json({ ok: true, name: req.file?.originalname, size: req.file?.size, mimetype: req.file?.mimetype }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => res.status(400).json({ ok: false, message: err.message, code: err.code }));
    return app;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('uploadMiddleware (images)', () => {
    const app = uploadApp(upload.single('image'));
    const send = (filename, contentType, buf = PNG_MAGIC) =>
        request(app).post('/up').attach('image', buf, { filename, contentType });

    test.each([
        ['a.jpg', 'image/jpeg'],
        ['a.JPEG', 'image/jpeg'],
        ['a.png', 'image/png'],
        ['a.webp', 'image/webp'],
        ['a.gif', 'image/gif'],
        ['logo.svg', 'image/svg+xml'],          // rasterised to PNG by cloudinaryUploader
        ['a.bmp', 'image/bmp'],
        ['a.avif', 'image/avif'],
        ['a.tiff', 'image/tiff'],
        ['IMG_0001.HEIC', 'image/heic'],
        ['IMG_0002.heic', 'application/octet-stream'],   // Windows browsers
        ['fav.ico', 'image/x-icon'],
    ])('accepts %s (%s)', async (name, mime) => {
        const res = await send(name, mime);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    test.each([
        ['html renamed', 'a.html', 'text/html'],
        ['pdf', 'menu.pdf', 'application/pdf'],
        ['svg ext + html mime', 'logo.svg', 'text/html'],
        ['png ext + html mime', 'a.png', 'text/html'],
        ['exe ext + png mime', 'evil.exe', 'image/png'],
        ['no extension', 'image', 'image/png'],
    ])('rejects %s', async (_l, name, mime) => {
        const res = await send(name, mime);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Only image files/);
    });

    test('filter only checks ext + client-declared mime, never the bytes: HTML body named .png/image/png passes', async () => {
        // Characterisation: content is not sniffed. Downstream sharp() re-encodes
        // the buffer (cloudinaryUploader), which is what actually defuses this.
        const res = await send('x.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>'));
        expect(res.status).toBe(200);
    });

    test('extension must be an exact image extension: ".pngx" with a non-image mime is rejected', async () => {
        const res = await send('x.pngx', 'application/x-png-but-not');
        expect(res.status).toBe(400);
    });

    test('5 MB limit: 5 MB - 1 byte passes; exactly 5 MB is already LIMIT_FILE_SIZE (busboy emits limit on reaching it)', async () => {
        const five = 5 * 1024 * 1024;
        const ok = await send('big.png', 'image/png', Buffer.alloc(five - 1));
        expect(ok.status).toBe(200);
        const tooBig = await send('big.png', 'image/png', Buffer.alloc(five));
        expect(tooBig.status).toBe(400);
        expect(tooBig.body.code).toBe('LIMIT_FILE_SIZE');
    });

    test('memory storage — buffer kept, no path on disk', async () => {
        const app2 = express();
        app2.post('/up', upload.single('image'), (req, res) => res.json({ hasBuffer: Buffer.isBuffer(req.file.buffer), path: req.file.path || null }));
        const res = await request(app2).post('/up').attach('image', PNG_MAGIC, { filename: 'a.png', contentType: 'image/png' });
        expect(res.body).toEqual({ hasBuffer: true, path: null });
    });
});

describe('csvUpload', () => {
    const app = uploadApp(csvUpload.single('file'));
    const send = (filename, contentType, buf = Buffer.from('a,b\n1,2\n')) =>
        request(app).post('/up').attach('file', buf, { filename, contentType });

    test.each([
        ['a.csv', 'text/csv'],
        ['A.CSV', 'application/octet-stream'],   // ext alone is enough
        ['export', 'application/vnd.ms-excel'],  // mime alone is enough
        ['notes.txt', 'text/plain'],
        ['x', 'application/csv'],
    ])('accepts %s (%s)', async (name, mime) => {
        expect((await send(name, mime)).status).toBe(200);
    });

    test.each([
        ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['a.json', 'application/json'],
        ['a.html', 'text/html'],
    ])('rejects %s', async (name, mime) => {
        const res = await send(name, mime);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Only .csv files are allowed');
    });

    test('OR-rule: any binary renamed *.csv is accepted (ext spoof)', async () => {
        const res = await send('payload.csv', 'application/x-msdownload', Buffer.from('MZ\x90\x00'));
        expect(res.status).toBe(200);
    });

    test('1 MB cap (effective max is 1 MB - 1 byte)', async () => {
        expect((await send('a.csv', 'text/csv', Buffer.alloc(1024 * 1024 - 1, 0x61))).status).toBe(200);
        const big = await send('a.csv', 'text/csv', Buffer.alloc(1024 * 1024, 0x61));
        expect(big.status).toBe(400);
        expect(big.body.code).toBe('LIMIT_FILE_SIZE');
    });
});

// ════════════════════════ csvParser ══════════════════════════════════

describe('parseCsv', () => {
    test.each([
        ['simple', 'a,b\n1,2', [['a', 'b'], ['1', '2']]],
        ['quoted comma', 'name,price\n"Paneer, Spicy",200', [['name', 'price'], ['Paneer, Spicy', '200']]],
        ['escaped quotes', '"He said ""hi""",x', [['He said "hi"', 'x']]],
        ['newline inside quotes', '"line1\nline2",x', [['line1\nline2', 'x']]],
        ['CRLF', 'a,b\r\n1,2\r\n', [['a', 'b'], ['1', '2']]],
        ['BOM stripped', '﻿name,price\nx,1', [['name', 'price'], ['x', '1']]],
        ['blank lines skipped', 'a\n\n\nb\n', [['a'], ['b']]],
        ['trailing newline', 'a,b\n', [['a', 'b']]],
        ['empty trailing field kept', 'a,b,\n', [['a', 'b', '']]],
        ['row of only commas kept', ',,\n', [['', '', '']]],
        ['whitespace preserved', ' a , b ', [[' a ', ' b ']]],
        ['empty input', '', []],
        ['lone CR line endings (old Mac) are NOT row breaks', 'a\rb', [['ab']]],
        ['unterminated quote swallows rest', '"abc,def\nghi', [['abc,def\nghi']]],
        ['quote mid-field toggles quoting', 'ab"c,d"e', [['abc,de']]],
    ])('%s', (_l, input, expected) => {
        expect(parseCsv(input)).toEqual(expected);
    });

    test.each([null, undefined, 0])('non-string input %p → []', (v) => {
        expect(parseCsv(v)).toEqual([]);
    });

    test('Buffer input is stringified', () => {
        expect(parseCsv(Buffer.from('x,y'))).toEqual([['x', 'y']]);
    });

    test.each([
        '=HYPERLINK("http://evil.test","click")',
        '+cmd|\' /C calc\'!A0',
        '-2+3+cmd|\' /C calc\'!A0',
        '@SUM(1+1)*cmd|\' /C calc\'!A0',
        '\t=1+1',
    ])('formula-injection cell is returned verbatim (no neutralisation): %s', (cell) => {
        const csv = `name,price\n"${cell.replace(/"/g, '""')}",10`;
        expect(parseCsv(csv)[1][0]).toBe(cell);
    });

    test('no row cap: 20k rows parse (only the 1 MB upload limit bounds it)', () => {
        const csv = 'a\n' + Array.from({ length: 20000 }, (_, i) => `r${i}`).join('\n');
        expect(parseCsv(csv)).toHaveLength(20001);
    });
});

// ════════════════════════ cloudinaryUploader ═════════════════════════

describe('cloudinaryUploader.compressAndUpload', () => {
    beforeEach(() => {
        mockSharpCalls.length = 0;
        mockSharpCannotDecode = false;
        mockUploadStream.mockReset();
        mockUploadStream.mockImplementation((opts, cb) => ({
            end: (buf) => cb(null, { secure_url: `https://res.cloudinary.test/${opts.folder}/x.${opts.format}`, bytes: buf.length, opts }),
        }));
    });

    test('configures cloudinary from env with secure:true at load', () => {
        // config() ran at require-time (before this beforeEach reset anything).
        expect(mockCloudConfig).toHaveBeenCalledWith({
            cloud_name: 'cloud-x', api_key: 'key-x', api_secret: 'secret-x', secure: true,
        });
    });

    test.each([
        [undefined],
        [Buffer.alloc(0)],
        [null],
    ])('empty buffer (%p) → throws before touching sharp/cloudinary', async (buffer) => {
        await expect(compressAndUpload({ buffer, originalname: 'a.png' })).rejects.toThrow('Empty buffer');
        expect(mockUploadStream).not.toHaveBeenCalled();
    });

    test.each([
        ['a.png', 'image/png', 'png'],
        ['a.PNG', 'application/octet-stream', 'png'],
        ['a.bin', 'image/png', 'png'],
        ['a.webp', 'image/webp', 'webp'],
        ['a.jpg', 'image/jpeg', 'jpeg'],
        ['noext', 'image/gif', 'png'],          // GIF keeps transparency → PNG
        ['logo.svg', 'image/svg+xml', 'png'],
        ['photo.heic', 'image/heic', 'jpeg'],
        ['scan.bmp', 'image/bmp', 'jpeg'],
        [undefined, undefined, 'jpeg'],
    ])('%s / %s → %s pipeline', async (originalname, mimetype, encoder) => {
        const result = await compressAndUpload({ buffer: Buffer.from('img'), originalname, mimetype });
        expect(mockSharpCalls[0]).toEqual(['rotate']);      // EXIF orientation applied
        expect(mockSharpCalls[1]).toEqual(['resize', { width: 1200, withoutEnlargement: true }]);
        expect(mockSharpCalls[2][0]).toBe(encoder);
        const fmt = encoder === 'jpeg' ? 'jpg' : encoder;
        expect(mockUploadStream).toHaveBeenCalledWith(
            { folder: 'bestodine/uploads', format: fmt, resource_type: 'image' },
            expect.any(Function),
        );
        expect(result.secure_url).toBe(`https://res.cloudinary.test/bestodine/uploads/x.${fmt}`);
    });

    test('custom folder + maxWidth are honoured and the RE-ENCODED buffer is uploaded', async () => {
        const result = await compressAndUpload({ buffer: Buffer.from('raw'), originalname: 'c.jpg', folder: 'bestodine/blog', maxWidth: 1280 });
        expect(mockSharpCalls[1]).toEqual(['resize', { width: 1280, withoutEnlargement: true }]);
        expect(result.opts.folder).toBe('bestodine/blog');
        expect(result.bytes).toBe(Buffer.from('OUT:raw').length);
    });

    test('format sharp cannot decode (HEIC) → original sent to Cloudinary, converted to JPG with the width cap', async () => {
        mockSharpCannotDecode = true;
        const original = Buffer.from('heic-bytes');
        const result = await compressAndUpload({ buffer: original, originalname: 'IMG_1.HEIC', mimetype: 'image/heic', maxWidth: 1200 });
        expect(mockUploadStream).toHaveBeenCalledWith(
            { folder: 'bestodine/uploads', format: 'jpg', resource_type: 'image', transformation: [{ width: 1200, crop: 'limit', quality: 80 }] },
            expect.any(Function),
        );
        expect(result.bytes).toBe(original.length);   // the untouched original went up
    });

    test('an SVG sharp cannot rasterise is rejected, never uploaded as markup', async () => {
        mockSharpCannotDecode = true;
        await expect(compressAndUpload({ buffer: Buffer.from('<svg'), originalname: 'x.svg', mimetype: 'image/svg+xml' })).rejects.toThrow();
        expect(mockUploadStream).not.toHaveBeenCalled();
    });

    test('cloudinary error rejects', async () => {
        mockUploadStream.mockImplementation((opts, cb) => ({ end: () => cb(new Error('cloudinary 401')) }));
        await expect(compressAndUpload({ buffer: Buffer.from('x'), originalname: 'a.jpg' })).rejects.toThrow('cloudinary 401');
    });
});
