/**
 * utils/orderToken — token numbers for token-number mode
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.2, tables.useTables:false).
 *
 *   - 'T-001', 'T-002', … from one atomic $inc per { restaurant, branch,
 *     day } on order_token_counters (model mocked here; the real-Mongo
 *     path is covered by __tests__/integration/opsTokenMode.test.js)
 *   - the day key is the server-local calendar day; a new day starts at T-001
 *   - isTokenMode / tokenModeFor read the RESOLVED profile; tenants without
 *     a profile, or with tables on, are never in token mode
 */
const mockFindOneAndUpdate = jest.fn();
jest.mock('../models/orderTokenCounter', () => ({
    findOneAndUpdate: (...args) => ({ lean: () => mockFindOneAndUpdate(...args) }),
}));

const {
    localDayKey,
    formatTokenNumber,
    nextTokenNumber,
    isTokenMode,
    tokenModeFor,
    tablesDisabledError,
    requestBranchId,
} = require('../utils/orderToken');
const { normaliseProfile, resolveOperations } = require('../utils/operationsProfile');

const R = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BR = '111111111111111111111111';

// An in-memory stand-in for the counter collection: seq per key.
function fakeCounters() {
    const seqs = new Map();
    mockFindOneAndUpdate.mockImplementation(async (filter, update) => {
        const key = `${filter.restaurant}|${filter.branch}|${filter.day}`;
        const next = (seqs.get(key) || 0) + update.$inc.seq;
        seqs.set(key, next);
        return { ...filter, seq: next };
    });
    return seqs;
}

beforeEach(() => {
    mockFindOneAndUpdate.mockReset();
});

describe('formatting', () => {
    test('T- prefix, zero-padded to three digits, never truncated', () => {
        expect(formatTokenNumber(1)).toBe('T-001');
        expect(formatTokenNumber(42)).toBe('T-042');
        expect(formatTokenNumber(999)).toBe('T-999');
        expect(formatTokenNumber(1000)).toBe('T-1000');
    });

    test('day key is the server-local calendar day', () => {
        const d = new Date(2026, 9, 19, 23, 59, 59);     // local 19 Oct 2026
        expect(localDayKey(d)).toBe('2026-10-19');
        expect(localDayKey(new Date(2026, 0, 5, 0, 0, 1))).toBe('2026-01-05');
    });
});

describe('nextTokenNumber', () => {
    test('counts up per branch per day from one atomic upsert + $inc', async () => {
        fakeCounters();
        expect(await nextTokenNumber(R, BR, '2026-10-19')).toBe('T-001');
        expect(await nextTokenNumber(R, BR, '2026-10-19')).toBe('T-002');
        expect(await nextTokenNumber(R, BR, '2026-10-19')).toBe('T-003');

        const [filter, update, options] = mockFindOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ restaurant: R, branch: BR, day: '2026-10-19' });
        expect(update.$inc).toEqual({ seq: 1 });
        expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date);
        expect(options).toMatchObject({ upsert: true, returnDocument: 'after' });
    });

    test('a new day starts again at T-001; other branches and tenants have their own sequence', async () => {
        fakeCounters();
        await nextTokenNumber(R, BR, '2026-10-19');
        await nextTokenNumber(R, BR, '2026-10-19');
        expect(await nextTokenNumber(R, BR, '2026-10-20')).toBe('T-001');
        expect(await nextTokenNumber(R, '222222222222222222222222', '2026-10-19')).toBe('T-001');
        expect(await nextTokenNumber('bbbbbbbbbbbbbbbbbbbbbbbb', BR, '2026-10-19')).toBe('T-001');
        // tenant-level orders (no branch) are keyed on branch null
        expect(await nextTokenNumber(R, null, '2026-10-19')).toBe('T-001');
        expect(mockFindOneAndUpdate.mock.calls.at(-1)[0].branch).toBeNull();
    });

    test('a Date is reduced to its local day key', async () => {
        fakeCounters();
        await nextTokenNumber(R, BR, new Date(2026, 9, 19, 13, 0, 0));
        expect(mockFindOneAndUpdate.mock.calls[0][0].day).toBe('2026-10-19');
    });

    test('refuses to allocate without a restaurant', async () => {
        await expect(nextTokenNumber(null, BR)).rejects.toThrow(/restaurantId/);
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
});

describe('token mode detection', () => {
    const restaurantWith = (profile) => ({
        operations: profile == null ? undefined : normaliseProfile(profile),
        subscription: { features: {} },
    });

    test('isTokenMode reads the resolved profile', () => {
        expect(isTokenMode(null)).toBe(false);
        expect(isTokenMode({ tables: { useTables: true } })).toBe(false);
        expect(isTokenMode({ tables: { useTables: false } })).toBe(true);
        expect(isTokenMode({})).toBe(false);
    });

    test('a saved useTables:false resolves to token mode; no profile / tables on do not', () => {
        const off = resolveOperations(restaurantWith({ answers: { useTables: false } }));
        expect(off.tables.useTables).toBe(false);
        expect(isTokenMode(off)).toBe(true);
        expect(isTokenMode(resolveOperations(restaurantWith({ answers: { useTables: true } })))).toBe(false);
        expect(isTokenMode(resolveOperations(restaurantWith(null)))).toBe(false);
    });

    test('tokenModeFor(req): false without a tenant or a profile, true for a token-mode tenant', () => {
        expect(tokenModeFor({})).toBe(false);
        expect(tokenModeFor({ restaurant: null })).toBe(false);
        expect(tokenModeFor({ restaurant: restaurantWith(null) })).toBe(false);
        expect(tokenModeFor({ restaurant: restaurantWith({ answers: { useTables: true } }) })).toBe(false);
        expect(tokenModeFor({ restaurant: restaurantWith({ answers: { useTables: false } }) })).toBe(true);
    });

    test('the branch the resolver reads: staff pin, then the active branch, then main', () => {
        expect(requestBranchId({ user: { branch: BR }, branch: { _id: 'x' }, mainBranchId: 'm' })).toBe(BR);
        expect(requestBranchId({ user: { branch: { _id: BR } } })).toBe(BR);
        expect(requestBranchId({ user: {}, branch: { _id: 'x' }, mainBranchId: 'm' })).toBe('x');
        expect(requestBranchId({ mainBranchId: 'm' })).toBe('m');
        expect(requestBranchId({})).toBeNull();
    });

    test('TABLES_DISABLED body', () => {
        expect(tablesDisabledError()).toMatchObject({ success: false, code: 'TABLES_DISABLED', message: expect.any(String) });
    });
});
