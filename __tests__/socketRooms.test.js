/**
 * BUG #6 — tenant-namespaced socket rooms + join authorization.
 * Pure-function tests: no DB, lookups are injected.
 */
const {
    tenantRoom, emitRoomsFor, autoRoomsFor, canJoinWith, parseTenantRoom, menuRoom,
} = require('../utils/socketRooms');

const T1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const B1 = '111111111111111111111111'; // branch of T1
const B2 = '222222222222222222222222'; // another branch of T1
const BX = '999999999999999999999999'; // branch of T2
const U1 = 'cccccccccccccccccccccccc';

const branchTenants = { [B1]: T1, [B2]: T1, [BX]: T2 };
const orders = {
    'ORD-1': { restaurant: T1, branch: B1, user: U1, table: 'dddddddddddddddddddddddd', scanSessionId: 's1' },
    'ORD-2': { restaurant: T2, branch: BX, user: null, table: null, scanSessionId: null },
};
const deps = {
    getBranchTenant: async (b) => branchTenants[b] || null,
    findOrder: async (id) => orders[id] || null,
};

describe('room naming', () => {
    test('tenant rooms are namespaced', () => {
        expect(tenantRoom(T1, 'kitchen')).toBe(`t:${T1}:kitchen`);
        expect(tenantRoom(T1, 'kitchen', B1)).toBe(`t:${T1}:kitchen:${B1}`);
        expect(tenantRoom(null, 'kitchen')).toBeNull();
        expect(menuRoom(T1)).toBe(`t:${T1}:menu`);
    });

    test('branch emit → branch room + tenant-level room', () => {
        expect(emitRoomsFor(T1, 'admin', B1)).toEqual([`t:${T1}:admin:${B1}`, `t:${T1}:admin`]);
    });

    test('unbranched emit → tenant-level + unbranched room', () => {
        expect(emitRoomsFor(T1, 'waiter', null)).toEqual([`t:${T1}:waiter`, `t:${T1}:waiter:unbranched`]);
    });

    test('no tenant → no rooms (never global)', () => {
        expect(emitRoomsFor(null, 'admin', B1)).toEqual([]);
    });

    test('parseTenantRoom', () => {
        expect(parseTenantRoom(`t:${T1}:kitchen:${B1}`)).toEqual({ restaurantId: T1, role: 'kitchen', branch: B1 });
        expect(parseTenantRoom('kitchen')).toBeNull();
        expect(parseTenantRoom(`t:${T1}:menu:${B1}`)).toBeNull();
    });
});

describe('autoRoomsFor', () => {
    test('pinned chef joins own branch + unbranched kitchen, never global', () => {
        const r = autoRoomsFor({ userId: U1, role: 'chef', restaurant: T1, branchId: B1 });
        expect(r).toEqual(expect.arrayContaining([U1, `t:${T1}:kitchen:${B1}`, `t:${T1}:kitchen:unbranched`, `t:${T1}:menu`]));
        expect(r).not.toContain('kitchen');
        expect(r).not.toContain(`t:${T1}:kitchen`);
    });

    test('unpinned admin joins tenant-level admin room', () => {
        expect(autoRoomsFor({ userId: U1, role: 'admin', restaurant: T1 })).toContain(`t:${T1}:admin`);
    });

    test('captain listens on captain + waiter', () => {
        const r = autoRoomsFor({ userId: U1, role: 'captain', restaurant: T1 });
        expect(r).toEqual(expect.arrayContaining([`t:${T1}:captain`, `t:${T1}:waiter`]));
    });

    test('superadmin gets only its own room', () => {
        expect(autoRoomsFor({ userId: U1, role: 'superadmin', restaurant: null }).sort()).toEqual([U1, 'superadmin'].sort());
    });

    test('staff with no tenant gets no staff rooms', () => {
        expect(autoRoomsFor({ userId: U1, role: 'waiter', restaurant: null })).toEqual([U1]);
    });

    test('scan guest gets table + menu room', () => {
        const r = autoRoomsFor({ scan: { tableId: 'dddddddddddddddddddddddd', restaurantId: T1 } });
        expect(r).toEqual(expect.arrayContaining(['table:dddddddddddddddddddddddd', `t:${T1}:menu`]));
    });
});

describe('canJoinWith', () => {
    const chefT1 = { userId: U1, role: 'chef', restaurant: T1, branchId: B1 };
    const adminT1 = { userId: U1, role: 'admin', restaurant: T1 };
    const waiterT2 = { userId: U1, role: 'waiter', restaurant: T2 };

    test('legacy global rooms are denied', async () => {
        for (const room of ['admin', 'kitchen', 'waiter', `kitchen:${B1}`]) {
            expect(await canJoinWith(adminT1, room, deps)).toBe(false);
        }
    });

    test('cross-tenant room denied', async () => {
        expect(await canJoinWith(waiterT2, `t:${T1}:waiter`, deps)).toBe(false);
        expect(await canJoinWith(adminT1, `t:${T2}:admin`, deps)).toBe(false);
    });

    test('pinned staff: own branch + unbranched only', async () => {
        expect(await canJoinWith(chefT1, `t:${T1}:kitchen:${B1}`, deps)).toBe(true);
        expect(await canJoinWith(chefT1, `t:${T1}:kitchen:unbranched`, deps)).toBe(true);
        expect(await canJoinWith(chefT1, `t:${T1}:kitchen:${B2}`, deps)).toBe(false);
        expect(await canJoinWith(chefT1, `t:${T1}:kitchen`, deps)).toBe(false);
        expect(await canJoinWith(chefT1, `t:${T1}:admin:${B1}`, deps)).toBe(false);
    });

    test('unpinned admin: any role room of own tenant, own-tenant branches only', async () => {
        expect(await canJoinWith(adminT1, `t:${T1}:kitchen`, deps)).toBe(true);
        expect(await canJoinWith(adminT1, `t:${T1}:admin:${B2}`, deps)).toBe(true);
        expect(await canJoinWith(adminT1, `t:${T1}:admin:${BX}`, deps)).toBe(false);
    });

    test('menu room is public', async () => {
        expect(await canJoinWith({}, `t:${T1}:menu`, deps)).toBe(true);
    });

    test('superadmin room', async () => {
        expect(await canJoinWith({ role: 'superadmin' }, 'superadmin', deps)).toBe(true);
        expect(await canJoinWith(adminT1, 'superadmin', deps)).toBe(false);
    });

    test('user room only for self', async () => {
        expect(await canJoinWith({ userId: U1 }, U1, deps)).toBe(true);
        expect(await canJoinWith({ userId: T1 }, U1, deps)).toBe(false);
    });

    test('order rooms: owner, scan session, same-tenant staff', async () => {
        expect(await canJoinWith({ userId: U1, role: 'customer' }, 'order:ORD-1', deps)).toBe(true);
        expect(await canJoinWith({ scan: { tableId: 'dddddddddddddddddddddddd', sessionId: 's1', restaurantId: T1 } }, 'order:ORD-1', deps)).toBe(true);
        expect(await canJoinWith({ scan: { tableId: 'dddddddddddddddddddddddd', sessionId: 'old', restaurantId: T1 } }, 'order:ORD-1', deps)).toBe(false);
        expect(await canJoinWith(adminT1, 'order:ORD-1', deps)).toBe(true);
        expect(await canJoinWith({ ...chefT1, branchId: B2 }, 'order:ORD-1', deps)).toBe(false);
        expect(await canJoinWith(adminT1, 'order:ORD-2', deps)).toBe(false);
        expect(await canJoinWith(waiterT2, 'order:ORD-1', deps)).toBe(false);
        expect(await canJoinWith(adminT1, 'order:NOPE', deps)).toBe(false);
    });

    test('unknown shapes denied', async () => {
        expect(await canJoinWith(adminT1, 'customer', deps)).toBe(false);
        expect(await canJoinWith(adminT1, null, deps)).toBe(false);
    });
});
