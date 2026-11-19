/**
 * STRICT tenant campaign / infra: pure functions (no DB). "BUG:" tests are
 * expected to FAIL until the source is fixed.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mongoose = require('mongoose');
const { scopeFilter, scopePipeline, hasTenantCondition } = require('../utils/tenantScopePlugin');
const { canJoinWith, autoRoomsFor } = require('../utils/socketRooms');

const A = new mongoose.Types.ObjectId();
const B = new mongoose.Types.ObjectId();
const ha = String(A); const hb = String(B);

describe('scopeFilter', () => {
    test('empty / plain filters get the tenant injected and the input is not mutated', () => {
        const f = { name: 'x' };
        const r = scopeFilter(f, A);
        expect(r.action).toBe('inject');
        expect(String(r.filter.restaurant)).toBe(ha);
        expect(f).toEqual({ name: 'x' });
        expect(scopeFilter(null, A).action).toBe('inject');
        expect(scopeFilter({}, 'not-an-id').action).toBe('noop');
    });
    test('$nor / $or-with-gap / nested $and without restaurant are still injected', () => {
        expect(scopeFilter({ $nor: [{ restaurant: A }] }, A).action).toBe('inject');
        expect(scopeFilter({ $or: [{ restaurant: B }, { x: 1 }] }, A).action).toBe('inject');
        expect(scopeFilter({ $and: [{ x: 1 }] }, A).action).toBe('inject');
        expect(scopeFilter({ restaurant: undefined }, A).action).toBe('inject');
    });
    test('Regression (fixed 2026-11): a restaurant condition naming another tenant counts as already scoped (not rewritten, not rejected)', () => {
        expect(scopeFilter({ restaurant: B }, A).action).not.toBe('explicit');
    });
    test('Regression (fixed 2026-11): an operator restaurant condition ($ne / $in / $exists) counts as already scoped', () => {
        expect(hasTenantCondition({ restaurant: { $ne: A } })).toBe(false);
        expect(hasTenantCondition({ restaurant: { $in: [A, B] } })).toBe(false);
        expect(hasTenantCondition({ $and: [{ restaurant: { $exists: true } }] })).toBe(false);
    });
    test('Regression (fixed 2026-11): $or where every branch names ANY restaurant counts as scoped even when it is another tenant', () => {
        expect(hasTenantCondition({ $or: [{ restaurant: B }, { restaurant: B }] })).toBe(false);
    });
});

describe('scopePipeline', () => {
    test('prepends / merges a tenant $match and never mutates the input', () => {
        const p = [{ $group: { _id: null } }];
        const r = scopePipeline(p, A);
        expect(r.action).toBe('inject');
        expect(String(r.pipeline[0].$match.restaurant)).toBe(ha);
        expect(p).toHaveLength(1);
        expect(scopePipeline([{ $match: { x: 1 } }], A).pipeline[0].$match.restaurant).toBeDefined();
    });
    test('$geoNear stays first; the tenant $match follows it', () => {
        const r = scopePipeline([{ $geoNear: {} }, { $limit: 1 }], A);
        expect(Object.keys(r.pipeline[0])[0]).toBe('$geoNear');
        expect(r.pipeline[1].$match.restaurant).toBeDefined();
    });
    test('Regression (fixed 2026-11): a pipeline whose $match names another tenant is left untouched ("explicit")', () => {
        expect(scopePipeline([{ $match: { restaurant: B } }], A).action).not.toBe('explicit');
    });
    test('Regression (fixed 2026-11): a $match for the tenant placed AFTER a $lookup / $unionWith does not stop the earlier stage reading all tenants', () => {
        const r = scopePipeline([{ $unionWith: { coll: 'tables' } }, { $match: { restaurant: A } }], A);
        // desired: the tenant $match must run before any stage that reads other collections
        expect(Object.keys(r.pipeline[0])[0]).toBe('$match');
    });
});

describe('canJoinWith (room authorization)', () => {
    const staffA = { userId: 'u1', role: 'admin', restaurant: ha, branchId: null };
    const lookups = { getBranchTenant: async (b) => (b === 'bbbbbbbbbbbbbbbbbbbbbbbb' ? hb : ha), findOrder: async () => ({ restaurant: hb, user: null }) };
    test('A staff refused every B tenant room, order, branch room; accepted for A', async () => {
        for (const room of [`t:${hb}:admin`, `t:${hb}:kitchen:unbranched`, `t:${hb}:admin:bbbbbbbbbbbbbbbbbbbbbbbb`, `t:${hb.toUpperCase()}:admin`, 'order:B-1']) {
            expect([room, await canJoinWith(staffA, room, lookups)]).toEqual([room, false]);
        }
        expect(await canJoinWith(staffA, `t:${ha}:admin`, lookups)).toBe(true);
    });
    test('branch lookup that returns B for a branch id used under A\'s room is refused', async () => {
        expect(await canJoinWith(staffA, `t:${ha}:admin:bbbbbbbbbbbbbbbbbbbbbbbb`, lookups)).toBe(false);
    });
    test('a socket with no verified tenant joins no staff room; garbage rooms are refused', async () => {
        const anon = { userId: null, role: null, restaurant: null };
        for (const room of [`t:${ha}:admin`, 'admin', 'superadmin', '', null, 'order:', `t:${ha}:admin:`, `t:${ha}:menu:${hb}`]) {
            expect(await canJoinWith(anon, room, lookups)).toBe(false);
        }
    });
    test('autoRoomsFor never mentions a tenant other than the socket\'s own', () => {
        const rooms = autoRoomsFor({ userId: 'u', role: 'manager', restaurant: ha, branchId: 'cccccccccccccccccccccccc' });
        expect(rooms.every((r) => !r.includes(hb))).toBe(true);
        expect(rooms.some((r) => r.includes(ha))).toBe(true);
    });
    test('customer cannot join another customer\'s user room', async () => {
        expect(await canJoinWith({ userId: 'cccccccccccccccccccccccc', role: 'customer' }, 'dddddddddddddddddddddddd', lookups)).toBe(false);
    });
});
