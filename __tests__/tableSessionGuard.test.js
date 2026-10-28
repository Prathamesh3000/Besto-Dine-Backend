/**
 * middlewares/tableSessionGuard.js — revoked table scan tokens.
 * Table lookups and token verification are mocked.
 */
const mockFindById = jest.fn();
const mockWarn = jest.fn();
let mockVerify;

jest.mock('../models/table', () => ({ findById: (...a) => mockFindById(...a) }));
jest.mock('../utils/logger', () => ({ warn: (...a) => mockWarn(...a), error: jest.fn(), info: jest.fn() }));
jest.mock('../middlewares/authMiddleware', () => ({
    TOKEN_TYPES: { SCAN: 'scan' },
    verifyTypedToken: (...a) => mockVerify(...a),
}));

const guard = require('../middlewares/tableSessionGuard');

const TABLE = 'd'.repeat(24);
const SEC = 1_700_000_000; // arbitrary whole second
const epochDoc = (ms) => ({ select: () => ({ lean: async () => (ms == null ? { sessionEpoch: null } : { sessionEpoch: new Date(ms) }) }) });

function run(req) {
    const res = {
        statusCode: null, body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
    const next = jest.fn();
    return guard({ method: 'GET', path: '/orders/x', headers: {}, ...req }, res, next).then(() => ({ res, next }));
}
const withToken = (extra = {}) => ({ headers: { 'x-scan-token': 'tok' }, ...extra });

beforeEach(() => {
    jest.clearAllMocks();
    guard._epochCache.clear();
    mockVerify = jest.fn(() => ({ tableId: TABLE, iat: SEC }));
    mockFindById.mockReturnValue(epochDoc(null));
});

describe('tableSessionGuard', () => {
    test('passes without an X-Scan-Token header (no DB lookup)', async () => {
        const { next } = await run({});
        expect(next).toHaveBeenCalledTimes(1);
        expect(mockFindById).not.toHaveBeenCalled();
    });

    test.each(['/tables/token/tb-abc', '/tables/scan/tb-abc'])('GET %s is exempt even with a stale token', async (p) => {
        mockFindById.mockReturnValue(epochDoc((SEC + 100) * 1000));
        const { res, next } = await run(withToken({ path: p }));
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBeNull();
        expect(mockVerify).not.toHaveBeenCalled();
    });

    test('the exemption is GET-only', async () => {
        mockFindById.mockReturnValue(epochDoc((SEC + 100) * 1000));
        const { res } = await run(withToken({ method: 'POST', path: '/tables/token/x' }));
        expect(res.statusCode).toBe(401);
    });

    test('rejects a token issued in an earlier second than the epoch with 401 TABLE_SESSION_ENDED', async () => {
        mockFindById.mockReturnValue(epochDoc(SEC * 1000 + 1500)); // epoch 1.5 s after iat second start
        const { res, next } = await run(withToken());
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ success: false, code: 'TABLE_SESSION_ENDED' });
    });

    test('passes a token issued in the same second as the epoch', async () => {
        mockFindById.mockReturnValue(epochDoc(SEC * 1000 + 900));
        const { res, next } = await run(withToken());
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBeNull();
    });

    test('passes a token issued after the epoch, and a table never reset', async () => {
        mockFindById.mockReturnValue(epochDoc((SEC - 50) * 1000));
        expect((await run(withToken())).next).toHaveBeenCalled();
        guard._epochCache.clear();
        mockFindById.mockReturnValue(epochDoc(null));
        expect((await run(withToken())).next).toHaveBeenCalled();
    });

    test('expired / garbage tokens pass through for the route to reject', async () => {
        mockVerify = jest.fn(() => { throw new Error('jwt expired'); });
        const { res, next } = await run(withToken());
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBeNull();
        expect(mockFindById).not.toHaveBeenCalled();
    });

    test('tokens without tableId or iat pass through', async () => {
        mockVerify = jest.fn(() => ({ iat: SEC }));
        expect((await run(withToken())).next).toHaveBeenCalled();
        mockVerify = jest.fn(() => ({ tableId: TABLE }));
        expect((await run(withToken())).next).toHaveBeenCalled();
        expect(mockFindById).not.toHaveBeenCalled();
    });

    test('fails open on a DB error and logs a warning', async () => {
        mockFindById.mockImplementation(() => { throw new Error('mongo gone'); });
        const { res, next } = await run(withToken());
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBeNull();
        expect(mockWarn).toHaveBeenCalled();
    });

    test('epoch lookups are cached; forgetTableEpoch makes a new epoch take effect at once', async () => {
        await run(withToken());
        await run(withToken());
        expect(mockFindById).toHaveBeenCalledTimes(1); // second hit served from cache

        // Staff reset the table: the stale cache would still say "no epoch".
        mockFindById.mockReturnValue(epochDoc((SEC + 10) * 1000));
        expect((await run(withToken())).res.statusCode).toBeNull();
        guard.forgetTableEpoch(TABLE);
        expect((await run(withToken())).res.statusCode).toBe(401);
        expect(mockFindById).toHaveBeenCalledTimes(2);
    });
});
