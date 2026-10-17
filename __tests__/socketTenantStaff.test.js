/**
 * utils/socket.js — emitToTenantStaff / tenantStaffRooms (ops panel A11):
 * a tenant-wide staff broadcast must reach EVERY staff role (admin,
 * manager, waiter, captain, kitchen) in the tenant-level room, the
 * "unbranched" room and every active branch room. No DB: Branch.find is
 * mocked; emits go to a fake io.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockBranchFind = jest.fn();
jest.mock('../models/branch', () => ({
    find: (...a) => ({ select: () => ({ lean: async () => mockBranchFind(...a) }) }),
    findById: () => ({ select: () => ({ lean: async () => null }) }),
}));

const socket = require('../utils/socket');
const { ROOM_ROLES } = require('../utils/socketRooms');

const RID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B1 = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const B2 = 'bbbbbbbbbbbbbbbbbbbbbbb2';

function fakeIo() {
    const emits = [];
    const io = { to: (rooms) => ({ emit: (event, payload) => emits.push({ rooms, event, payload }) }) };
    return { io, emits };
}

beforeEach(() => mockBranchFind.mockReset());

describe('tenantStaffRooms (pure)', () => {
    test('every role × tenant-level + unbranched + each branch', () => {
        const rooms = socket.tenantStaffRooms(RID, [B1, B2]);
        expect(ROOM_ROLES).toEqual(expect.arrayContaining(['admin', 'waiter', 'kitchen', 'captain', 'manager']));
        for (const role of ROOM_ROLES) {
            expect(rooms).toContain(`t:${RID}:${role}`);
            expect(rooms).toContain(`t:${RID}:${role}:unbranched`);
            expect(rooms).toContain(`t:${RID}:${role}:${B1}`);
            expect(rooms).toContain(`t:${RID}:${role}:${B2}`);
        }
        expect(rooms).toHaveLength(ROOM_ROLES.length * 4);
        expect(new Set(rooms).size).toBe(rooms.length);
    });

    test('no branches → tenant-level + unbranched only; junk branch ids ignored; bad tenant → []', () => {
        expect(socket.tenantStaffRooms(RID, [])).toHaveLength(ROOM_ROLES.length * 2);
        expect(socket.tenantStaffRooms(RID, ['nope', null])).toHaveLength(ROOM_ROLES.length * 2);
        expect(socket.tenantStaffRooms('not-an-id', [B1])).toEqual([]);
        expect(socket.tenantStaffRooms(null)).toEqual([]);
    });

    test('accepts an ObjectId-like / populated doc for the tenant', () => {
        expect(socket.tenantStaffRooms({ _id: RID }, [{ _id: B1 }])).toContain(`t:${RID}:captain:${B1}`);
    });
});

describe('emitToTenantStaff', () => {
    test('looks up the tenant\'s ACTIVE branches and emits once to every staff room, captain and kitchen included', async () => {
        mockBranchFind.mockResolvedValue([{ _id: B1 }, { _id: B2 }]);
        const { io, emits } = fakeIo();
        const targets = await socket.emitToTenantStaff(io, RID, 'tenant:operations-updated', { restaurant: RID });
        expect(mockBranchFind).toHaveBeenCalledWith({ restaurant: RID, isActive: true });
        expect(emits).toHaveLength(1);
        expect(emits[0].event).toBe('tenant:operations-updated');
        expect(emits[0].payload).toEqual({ restaurant: RID });
        expect(emits[0].rooms).toEqual(targets);
        expect(targets).toEqual(expect.arrayContaining([
            `t:${RID}:admin`, `t:${RID}:captain`, `t:${RID}:kitchen`, `t:${RID}:manager`, `t:${RID}:waiter`,
            `t:${RID}:captain:${B1}`, `t:${RID}:kitchen:${B2}`, `t:${RID}:waiter:unbranched`,
        ]));
        // never a global / foreign room
        for (const r of targets) expect(r.startsWith(`t:${RID}:`)).toBe(true);
    });

    test('branch lookup failure still reaches the tenant-level and unbranched rooms', async () => {
        mockBranchFind.mockRejectedValue(new Error('db down'));
        const { io, emits } = fakeIo();
        const targets = await socket.emitToTenantStaff(io, RID, 'tenant:operations-updated', {});
        expect(emits).toHaveLength(1);
        expect(targets).toHaveLength(ROOM_ROLES.length * 2);
    });

    test('unresolvable tenant or null io → nothing emitted', async () => {
        const { io, emits } = fakeIo();
        expect(await socket.emitToTenantStaff(io, 'garbage', 'x', {})).toEqual([]);
        expect(await socket.emitToTenantStaff(null, RID, 'x', {})).toEqual([]);
        expect(emits).toHaveLength(0);
        expect(mockBranchFind).not.toHaveBeenCalled();
    });
});
