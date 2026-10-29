/**
 * middlewares/idempotency.js — fail-closed, enforcement flag, atomic claim.
 * Pure unit tests: the IdempotencyRecord model is mocked, no database.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-unit-test-secret!!';

const mockCreate = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
const mockDeleteOne = jest.fn();
jest.mock('../models/idempotencyRecord', () => ({
    create: (...a) => mockCreate(...a),
    findOne: (...a) => mockFindOne(...a),
    findOneAndUpdate: (...a) => mockFindOneAndUpdate(...a),
    updateOne: (...a) => mockUpdateOne(...a),
    deleteOne: (...a) => mockDeleteOne(...a),
}));

jest.mock('../middlewares/authMiddleware', () => ({
    verifyTypedToken: jest.fn(() => { throw new Error('no'); }),
    TOKEN_TYPES: { SCAN: 'scan' },
}));

jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../utils/logger');
const { idempotency, scopedIdempotencyKey } = require('../middlewares/idempotency');

const KEY = 'abcDEF_123-xyz';
const dup = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
const lean = (v) => ({ lean: () => Promise.resolve(v) });
const leanFail = (m) => ({ lean: () => Promise.reject(new Error(m)) });
const tick = () => new Promise((r) => setImmediate(r));

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined, sent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.json = (b) => { res.body = b; res.sent = true; return res; };
    return res;
}

function mockReq({ key, url = '/api/v1/razorpay/verify-payment' } = {}) {
    const h = {};
    if (key !== undefined) h['idempotency-key'] = key;
    return {
        method: 'POST', originalUrl: url, ip: '10.0.0.1',
        user: { _id: '507f1f77bcf86cd799439022' },
        restaurant: { _id: '507f1f77bcf86cd799439011' },
        headers: h, get: (n) => h[String(n).toLowerCase()],
    };
}

// Run the middleware, call the handler like a controller, wait for the
// (awaited) record write + deferred send to settle.
async function run(mw, req, res, handler) {
    const next = jest.fn(() => { if (handler) handler(res); });
    await mw(req, res, next);
    await tick();
    return next;
}

beforeEach(() => {
    [mockCreate, mockFindOne, mockFindOneAndUpdate, mockUpdateOne, mockDeleteOne].forEach((m) => m.mockReset());
    mockCreate.mockResolvedValue({});
    mockUpdateOne.mockResolvedValue({});
    mockDeleteOne.mockResolvedValue({});
    Object.values(logger).forEach((f) => f.mockClear());
    delete process.env.IDEMPOTENCY_ENFORCE;
});
afterAll(() => { delete process.env.IDEMPOTENCY_ENFORCE; });

describe('IDEMPOTENCY_ENFORCE flag', () => {
    test('required route, no key, flag OFF (default) → falls through, no DB', async () => {
        const next = await run(idempotency({ required: true }), mockReq(), mockRes());
        expect(next).toHaveBeenCalledTimes(1);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    test.each(['1', 'true', 'TRUE', 'yes', 'on'])('flag=%s → 400 IDEMPOTENCY_KEY_REQUIRED', async (v) => {
        process.env.IDEMPOTENCY_ENFORCE = v;
        const res = mockRes();
        const next = await run(idempotency({ required: true }), mockReq(), res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    test.each(['0', 'false', '', 'off', 'no'])('flag=%j → not enforced', async (v) => {
        process.env.IDEMPOTENCY_ENFORCE = v;
        const next = await run(idempotency({ required: true }), mockReq(), mockRes());
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('flag ON does not affect non-required routes', async () => {
        process.env.IDEMPOTENCY_ENFORCE = '1';
        const next = await run(idempotency(), mockReq(), mockRes());
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('fail closed (required route, key present, regardless of flag)', () => {
    test.each([undefined, '1'])('claim failure (flag=%s) → 503 retryable, handler NOT run', async (flag) => {
        if (flag) process.env.IDEMPOTENCY_ENFORCE = flag;
        mockCreate.mockRejectedValue(new Error('mongo down'));
        const res = mockRes();
        const next = await run(idempotency({ required: true }), mockReq({ key: KEY }), res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_UNAVAILABLE', retryable: true }));
        expect(res.headers['Retry-After']).toBeDefined();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
    });

    test('lookup failure after duplicate-key → 503, handler NOT run', async () => {
        mockCreate.mockRejectedValue(dup());
        mockFindOne.mockReturnValue(leanFail('read timeout'));
        const res = mockRes();
        const next = await run(idempotency({ required: true }), mockReq({ key: KEY }), res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('IDEMPOTENCY_UNAVAILABLE');
    });

    test('stale-takeover failure → 503', async () => {
        mockCreate.mockRejectedValue(dup());
        mockFindOne.mockReturnValue(lean({ state: 'in_progress' }));
        mockFindOneAndUpdate.mockReturnValue(leanFail('boom'));
        const res = mockRes();
        const next = await run(idempotency({ required: true }), mockReq({ key: KEY }), res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
    });

    test('NON-required route keeps fail-open on claim failure (warn, handler runs)', async () => {
        mockCreate.mockRejectedValue(new Error('mongo down'));
        const res = mockRes();
        const next = await run(idempotency(), mockReq({ key: KEY }), res, (r) => r.json({ ran: true }));
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.body).toEqual({ ran: true });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
        expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    test('NON-required route keeps fail-open on lookup failure', async () => {
        mockCreate.mockRejectedValue(dup());
        mockFindOne.mockReturnValue(leanFail('read timeout'));
        const next = await run(idempotency(), mockReq({ key: KEY }), mockRes());
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('atomic claim and concurrency', () => {
    test('first request claims in_progress BEFORE the handler runs, with scoped key', async () => {
        const req = mockReq({ key: KEY });
        let createdBeforeHandler = false;
        const res = mockRes();
        await run(idempotency({ required: true }), req, res, () => { createdBeforeHandler = mockCreate.mock.calls.length === 1; });
        expect(createdBeforeHandler).toBe(true);
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
            key: scopedIdempotencyKey(req, KEY),
            endpoint: 'POST /api/v1/razorpay/verify-payment',
            state: 'in_progress',
        }));
    });

    test('two simultaneous identical requests: only ONE handler runs, twin gets 409 IN_PROGRESS', async () => {
        let claimed = false;
        mockCreate.mockImplementation(async () => {
            if (claimed) throw dup();
            claimed = true;
            return {};
        });
        mockFindOne.mockReturnValue(lean({ state: 'in_progress', lockedAt: new Date() }));
        mockFindOneAndUpdate.mockReturnValue(lean(null)); // claim is fresh, not stale
        const handler = jest.fn();
        const mw = idempotency({ required: true });
        const r1 = mockRes();
        const r2 = mockRes();
        await Promise.all([
            mw(mockReq({ key: KEY }), r1, () => { handler(); r1.json({ n: 1 }); }),
            mw(mockReq({ key: KEY }), r2, () => { handler(); r2.json({ n: 2 }); }),
        ]);
        await tick();
        expect(handler).toHaveBeenCalledTimes(1);
        expect(r1.body).toEqual({ n: 1 });
        expect(r2.statusCode).toBe(409);
        expect(r2.body).toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS', retryable: true }));
        expect(r2.headers['Retry-After']).toBeDefined();
    });

    test('stale in-progress claim (crashed twin) is taken over: handler runs', async () => {
        mockCreate.mockRejectedValue(dup());
        mockFindOne.mockReturnValue(lean({ state: 'in_progress', lockedAt: new Date(0) }));
        mockFindOneAndUpdate.mockReturnValue(lean({ state: 'in_progress' }));
        const res = mockRes();
        const next = await run(idempotency({ required: true }), mockReq({ key: KEY }), res, (r) => r.json({ ok: 1 }));
        expect(next).toHaveBeenCalledTimes(1);
        const [filter] = mockFindOneAndUpdate.mock.calls[0];
        expect(filter).toEqual(expect.objectContaining({ state: 'in_progress', lockedAt: { $lt: expect.any(Date) } }));
        expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    });

    test('record that vanished between insert and read → 409 retryable, handler not run', async () => {
        mockCreate.mockRejectedValue(dup());
        mockFindOne.mockReturnValue(lean(null));
        const res = mockRes();
        const next = await run(idempotency({ required: true }), mockReq({ key: KEY }), res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(409);
    });
});

describe('replay of finished records', () => {
    test('done record → replays status + body, Idempotent-Replayed, handler skipped', async () => {
        mockCreate.mockRejectedValue(dup());
        mockFindOne.mockReturnValue(lean({ state: 'done', statusCode: 201, response: { id: 7 } }));
        const res = mockRes();
        const next = await run(idempotency({ required: true }), mockReq({ key: KEY }), res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({ id: 7 });
        expect(res.headers['Idempotent-Replayed']).toBe('true');
    });

    test('legacy record without state is treated as done', async () => {
        mockCreate.mockRejectedValue(dup());
        mockFindOne.mockReturnValue(lean({ statusCode: 200, response: { legacy: true } }));
        const res = mockRes();
        await run(idempotency(), mockReq({ key: KEY }), res);
        expect(res.body).toEqual({ legacy: true });
    });
});

describe('storing the response (awaited)', () => {
    test.each([[200, true], [201, true], [409, true], [400, false], [404, false], [500, false], [503, false]])(
        'status %i → stored as done: %s, otherwise claim released', async (status, stored) => {
            const res = mockRes();
            await run(idempotency({ required: true }), mockReq({ key: KEY }), res, (r) => r.status(status).json({ s: status }));
            expect(res.body).toEqual({ s: status });
            if (stored) {
                expect(mockUpdateOne).toHaveBeenCalledWith(
                    expect.objectContaining({ state: 'in_progress' }),
                    { $set: { state: 'done', statusCode: status, response: { s: status } } },
                );
                expect(mockDeleteOne).not.toHaveBeenCalled();
            } else {
                expect(mockUpdateOne).not.toHaveBeenCalled();
                expect(mockDeleteOne).toHaveBeenCalledTimes(1);
            }
        });

    test('response is sent only AFTER the record write completes', async () => {
        let resolveWrite;
        mockUpdateOne.mockReturnValue(new Promise((r) => { resolveWrite = r; }));
        const res = mockRes();
        await run(idempotency({ required: true }), mockReq({ key: KEY }), res, (r) => r.json({ ok: 1 }));
        expect(res.sent).toBe(false);
        resolveWrite({});
        await tick();
        expect(res.sent).toBe(true);
        expect(res.body).toEqual({ ok: 1 });
    });

    test('failed write: retried once, logged at error, response still sent but flagged, claim released', async () => {
        mockUpdateOne.mockRejectedValue(new Error('disk full'));
        const res = mockRes();
        await run(idempotency({ required: true }), mockReq({ key: KEY }), res, (r) => r.json({ paid: true }));
        expect(mockUpdateOne).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
        expect(res.headers['X-Idempotency-Recorded']).toBe('false');
        expect(mockDeleteOne).toHaveBeenCalledTimes(1);
        expect(res.body).toEqual({ paid: true });
        expect(res.statusCode).toBe(200);
    });

    test('first write fails, retry succeeds → recorded normally, no flag', async () => {
        mockUpdateOne.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({});
        const res = mockRes();
        await run(idempotency({ required: true }), mockReq({ key: KEY }), res, (r) => r.json({ ok: 1 }));
        expect(res.headers['X-Idempotency-Recorded']).toBeUndefined();
        expect(mockDeleteOne).not.toHaveBeenCalled();
    });

    test('release failure never blocks the response', async () => {
        mockDeleteOne.mockRejectedValue(new Error('nope'));
        const res = mockRes();
        await run(idempotency({ required: true }), mockReq({ key: KEY }), res, (r) => r.status(400).json({ bad: 1 }));
        expect(res.body).toEqual({ bad: 1 });
        expect(logger.warn).toHaveBeenCalled();
    });

    test('res.send-style response (finish without res.json) releases the claim', async () => {
        const res = mockRes();
        let finish;
        res.once = (ev, cb) => { if (ev === 'finish') finish = cb; };
        await run(idempotency({ required: true }), mockReq({ key: KEY }), res);
        finish();
        await tick();
        expect(mockDeleteOne).toHaveBeenCalledTimes(1);
        expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    test('malformed key still 400 IDEMPOTENCY_KEY_INVALID on required route', async () => {
        const res = mockRes();
        await run(idempotency({ required: true }), mockReq({ key: 'short' }), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    });
});

describe('requiredWhen (per-request required)', () => {
    const paidBody = (req) => req.body?.paymentStatus !== undefined || req.body?.amountPaid !== undefined;
    const withBody = (body) => Object.assign(mockReq(), { body });

    test('predicate true, no key, flag ON → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
        process.env.IDEMPOTENCY_ENFORCE = '1';
        const res = mockRes();
        const next = await run(idempotency({ requiredWhen: paidBody }), withBody({ paymentStatus: 'Paid' }), res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    test('amountPaid alone also triggers', async () => {
        process.env.IDEMPOTENCY_ENFORCE = '1';
        const res = mockRes();
        await run(idempotency({ requiredWhen: paidBody }), withBody({ amountPaid: 0 }), res);
        expect(res.statusCode).toBe(400);
    });

    test('predicate false (plain status change), no key, flag ON → passes untouched', async () => {
        process.env.IDEMPOTENCY_ENFORCE = '1';
        const next = await run(idempotency({ requiredWhen: paidBody }), withBody({ status: 'preparing' }), mockRes());
        expect(next).toHaveBeenCalledTimes(1);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    test('predicate true, flag OFF → passes', async () => {
        const next = await run(idempotency({ requiredWhen: paidBody }), withBody({ paymentStatus: 'Paid' }), mockRes());
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('predicate true + key present → fail closed on claim failure', async () => {
        mockCreate.mockRejectedValue(new Error('mongo down'));
        const res = mockRes();
        const req = Object.assign(mockReq({ key: KEY }), { body: { paymentStatus: 'Paid' } });
        const next = await run(idempotency({ requiredWhen: paidBody }), req, res);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
    });

    test('predicate false + key present → stays fail-open', async () => {
        mockCreate.mockRejectedValue(new Error('mongo down'));
        const req = Object.assign(mockReq({ key: KEY }), { body: { status: 'ready' } });
        const next = await run(idempotency({ requiredWhen: paidBody }), req, mockRes());
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('throwing predicate is treated as required', async () => {
        process.env.IDEMPOTENCY_ENFORCE = '1';
        const res = mockRes();
        await run(idempotency({ requiredWhen: () => { throw new Error('x'); } }), mockReq(), res);
        expect(res.statusCode).toBe(400);
    });
});
