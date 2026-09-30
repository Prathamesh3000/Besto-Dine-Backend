/**
 * BUG #33 — asyncHandler / AppError / validate middleware.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { devError } = require('../utils/AppError');
const { validate, body, param, objectIdParam, optionalObjectId } = require('../middlewares/validate');

function mockRes() {
    const res = { headersSent: false, statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

describe('asyncHandler', () => {
    test('AppError → status + { success:false, code, message }', async () => {
        const res = mockRes();
        const next = jest.fn();
        await asyncHandler(async () => { throw new AppError(404, 'NOT_FOUND', 'Thing not found'); })({}, res, next);
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ success: false, code: 'NOT_FOUND', message: 'Thing not found' });
        expect(next).not.toHaveBeenCalled();
    });

    test('unexpected error with fallback → 500 { success:false, message }', async () => {
        const res = mockRes();
        await asyncHandler(async () => { throw new Error('db down'); }, 'Failed to fetch X')({ method: 'GET', originalUrl: '/x' }, res, jest.fn());
        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Failed to fetch X');
    });

    test('unexpected error without fallback → next(err) (global handler)', async () => {
        const err = new Error('boom');
        const next = jest.fn();
        await asyncHandler(async () => { throw err; })({}, mockRes(), next);
        expect(next).toHaveBeenCalledWith(err);
    });

    test('sync throw is caught too; success path untouched', async () => {
        const next = jest.fn();
        asyncHandler(() => { throw new Error('sync'); })({}, mockRes(), next);
        expect(next).toHaveBeenCalled();
        const res = mockRes();
        await asyncHandler(async (req, r) => r.status(201).json({ success: true }))({}, res, jest.fn());
        expect(res.statusCode).toBe(201);
    });

    test('AppError exposes 4xx messages only; devError hidden in production', () => {
        expect(new AppError(400, 'X', 'bad').expose).toBe(true);
        expect(new AppError(500, 'X', 'bad').expose).toBe(false);
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        expect(devError(new Error('secret'))).toEqual({});
        process.env.NODE_ENV = 'test';
        expect(devError(new Error('secret'))).toEqual({ error: 'secret' });
        process.env.NODE_ENV = prev;
    });
});

async function run(chain, req) {
    const res = mockRes();
    let passed = false;
    for (const mw of chain) {
        let called = false;
        await mw(req, res, () => { called = true; });
        if (!called) return { res, passed: false };
    }
    passed = true;
    return { res, passed };
}

describe('validate()', () => {
    const chain = validate([
        objectIdParam('id'),
        body('name').optional().isString().withMessage('Name must be text'),
        body('capacity').optional().isInt({ min: 1 }).withMessage('Capacity must be a positive number'),
        optionalObjectId('body', 'branch'),
    ]);

    test('valid request passes', async () => {
        const { passed } = await run(chain, {
            params: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { name: 'T1', capacity: '4', branch: null }, query: {},
        });
        expect(passed).toBe(true);
    });

    test('invalid request → 400 { success:false, message, errors:[{field,message}] }', async () => {
        const { res, passed } = await run(chain, {
            params: { id: 'nope' }, body: { capacity: 0, branch: 'x' }, query: {},
        });
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(typeof res.body.message).toBe('string');
        expect(res.body.errors.map((e) => e.field).sort()).toEqual(['branch', 'capacity', 'id']);
        expect(res.body.errors[0]).toEqual({ field: expect.any(String), message: expect.any(String) });
    });

    test('param() helper is re-exported', () => {
        expect(typeof param).toBe('function');
    });
});
