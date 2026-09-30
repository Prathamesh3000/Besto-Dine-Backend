/**
 * Unit tests for utils/bodyAllowlist — the explicit field allowlists that
 * replaced "spread req.body onto the document" in the table / menu /
 * category / branch / coupon / promotion / staff write endpoints.
 */
const {
    TABLE_UPDATE_FIELDS,
    MENU_ITEM_FIELDS,
    CATEGORY_FIELDS,
    BRANCH_UPDATE_FIELDS,
    COUPON_FIELDS,
    PROMOTION_FIELDS,
    pickAllowed,
    disallowedKeys,
    toPositiveAmount,
    permissionsChanged,
    cleanStaffUpdate,
    canManageStaffRole,
    FLOOR_STAFF_ROLES,
} = require('../utils/bodyAllowlist');

describe('pickAllowed', () => {
    test('keeps only allowlisted keys and drops undefined values', () => {
        const out = pickAllowed({ a: 1, b: undefined, c: 3, d: null }, ['a', 'b', 'd']);
        expect(out).toEqual({ a: 1, d: null });
    });

    test('never copies Mongo operators or prototype keys', () => {
        const body = JSON.parse('{"name":"x","$inc":{"orderCount":5},"__proto__":{"polluted":true}}');
        const out = pickAllowed(body, MENU_ITEM_FIELDS);
        expect(out).toEqual({ name: 'x' });
        expect({}.polluted).toBeUndefined();
    });

    test('non-object bodies yield an empty object', () => {
        expect(pickAllowed(null, TABLE_UPDATE_FIELDS)).toEqual({});
        expect(pickAllowed('x', TABLE_UPDATE_FIELDS)).toEqual({});
        expect(pickAllowed([1, 2], TABLE_UPDATE_FIELDS)).toEqual({});
    });

    test('returns a new object (input untouched)', () => {
        const body = { name: 'T1', qrToken: 'tb-x' };
        pickAllowed(body, TABLE_UPDATE_FIELDS);
        expect(body).toEqual({ name: 'T1', qrToken: 'tb-x' });
    });
});

describe('endpoint allowlists', () => {
    test('table update: server-owned fields are excluded', () => {
        for (const f of ['qrToken', 'isDeleted', 'deletedAt', 'currentDiner', 'mergedWith', 'alerts',
            'restaurant', 'assignedWaiter', 'activeOrder']) {
            expect(TABLE_UPDATE_FIELDS).not.toContain(f);
        }
        const out = pickAllowed(
            { name: 'T1', capacity: 4, area: 'a', branch: '', status: 'free', isActive: true, qrToken: 'x', assignedWaiter: 'w' },
            TABLE_UPDATE_FIELDS,
        );
        expect(out).toEqual({ name: 'T1', capacity: 4, area: 'a', branch: '', status: 'free', isActive: true });
    });

    test('menu item: counters / computed / flow-owned fields are excluded', () => {
        for (const f of ['orderCount', 'finalPrice', 'inactivationUntil', 'restaurant', 'branchPrices', '_id', 'createdAt']) {
            expect(MENU_ITEM_FIELDS).not.toContain(f);
        }
        // Every field the AddMenuItemModal sends is kept.
        for (const f of ['name', 'category', 'branch', 'description', 'images', 'basePrice', 'offerPercentage',
            'prepTimeMinutes', 'availableDays', 'sizes', 'toppings', 'nutritionalInfo', 'status', 'prepStation']) {
            expect(MENU_ITEM_FIELDS).toContain(f);
        }
    });

    test('category: only UI-edited fields', () => {
        expect(pickAllowed({ name: 'Soups', displayOrder: 2, image: 'u', showOnKiosk: false, status: 'active', restaurant: 'r', itemCount: 9 }, CATEGORY_FIELDS))
            .toEqual({ name: 'Soups', displayOrder: 2, image: 'u', showOnKiosk: false, status: 'active' });
    });

    test('branch update: isActive / restaurant / manager fields excluded', () => {
        for (const f of ['isActive', 'restaurant', 'createdBy', 'managerName', 'managerEmail', 'syncFromMain']) {
            expect(BRANCH_UPDATE_FIELDS).not.toContain(f);
        }
    });

    test('coupon / promotion: counters, targetUsers, restaurant excluded', () => {
        for (const f of ['usageCount', 'targetUsers', 'restaurant']) {
            expect(COUPON_FIELDS).not.toContain(f);
            expect(PROMOTION_FIELDS).not.toContain(f);
        }
        expect(COUPON_FIELDS).toEqual(expect.arrayContaining(['code', 'title', 'discountType', 'discountValue', 'scope', 'isActive']));
    });
});

describe('disallowedKeys', () => {
    test('lists keys outside the allowlist', () => {
        expect(disallowedKeys({ status: 'free', qrToken: 'x', alerts: [] }, TABLE_UPDATE_FIELDS)).toEqual(['qrToken', 'alerts']);
        expect(disallowedKeys({ status: 'free' }, TABLE_UPDATE_FIELDS)).toEqual([]);
        expect(disallowedKeys(undefined, TABLE_UPDATE_FIELDS)).toEqual([]);
    });
});

describe('toPositiveAmount', () => {
    test.each([
        [499, 499], ['499', 499], ['12.5', 12.5], [0.01, 0.01],
    ])('%p → %p', (input, expected) => {
        expect(toPositiveAmount(input)).toBe(expected);
    });

    test.each([
        [0], [-5], ['abc'], [''], [null], [undefined], [NaN], [Infinity], ['Infinity'], [true], [{}], [[100]],
    ])('%p → null', (input) => {
        expect(toPositiveAmount(input)).toBeNull();
    });
});

describe('permissionsChanged', () => {
    test('unchanged (missing keys count as false)', () => {
        expect(permissionsChanged({ tables: true, refund: false }, { tables: true })).toBe(false);
        expect(permissionsChanged({}, { refund: false })).toBe(false);
        expect(permissionsChanged(null, undefined)).toBe(false);
    });

    test('grant or revoke is a change', () => {
        expect(permissionsChanged({ tables: true }, { tables: true, refund: true })).toBe(true);
        expect(permissionsChanged({ tables: true, refund: true }, { tables: true })).toBe(true);
    });
});

describe('cleanStaffUpdate', () => {
    test('null / blank required fields are ignored, not written', () => {
        const out = cleanStaffUpdate({ name: null, email: '  ', role: null, staffId: null, permissions: null, avatar: 'a' });
        expect(out).toEqual({ avatar: 'a' });
    });

    test('mobile / kitchenResponsibility null means clear', () => {
        expect(cleanStaffUpdate({ mobile: null, kitchenResponsibility: null })).toEqual({ mobile: '', kitchenResponsibility: '' });
    });

    test('undefined fields dropped, real values kept, input untouched', () => {
        const input = { name: 'Asha', email: 'a@b.co', mobile: '9876543210', avatar: undefined };
        expect(cleanStaffUpdate(input)).toEqual({ name: 'Asha', email: 'a@b.co', mobile: '9876543210' });
        expect(input).toHaveProperty('avatar');
    });
});

describe('canManageStaffRole', () => {
    test('floor roles are exactly waiter / chef / captain', () => {
        expect([...FLOOR_STAFF_ROLES].sort()).toEqual(['captain', 'chef', 'waiter']);
    });

    test('admin callers may manage every staff role', () => {
        for (const r of ['waiter', 'chef', 'captain', 'manager', 'admin']) {
            expect(canManageStaffRole('admin', r)).toBe(true);
        }
    });

    test('managers may only manage floor roles', () => {
        for (const r of ['waiter', 'chef', 'captain']) expect(canManageStaffRole('manager', r)).toBe(true);
        expect(canManageStaffRole('manager', 'manager')).toBe(false);
        expect(canManageStaffRole('manager', 'admin')).toBe(false);
    });

    test('any other caller role is treated like a non-admin', () => {
        expect(canManageStaffRole('captain', 'manager')).toBe(false);
        expect(canManageStaffRole(undefined, 'manager')).toBe(false);
        expect(canManageStaffRole(undefined, 'waiter')).toBe(true);
    });

    test('an absent role (not being set) is allowed', () => {
        expect(canManageStaffRole('manager', undefined)).toBe(true);
        expect(canManageStaffRole('manager', null)).toBe(true);
        expect(canManageStaffRole('manager', '')).toBe(true);
    });
});

describe('staffRoleGate (create / edit / status / delete / reset-password)', () => {
    const { staffRoleGate } = require('../utils/bodyAllowlist');

    test('manager acting on a Manager or Admin row → 403 ROLE_ADMIN_ONLY', () => {
        for (const target of ['manager', 'admin']) {
            const gate = staffRoleGate('manager', target);
            expect(gate).not.toBeNull();
            expect(gate.status).toBe(403);
            expect(gate.body).toMatchObject({ success: false, code: 'ROLE_ADMIN_ONLY' });
        }
    });

    test('manager keeps these actions for waiter / chef / captain', () => {
        for (const target of ['waiter', 'chef', 'captain']) {
            expect(staffRoleGate('manager', target)).toBeNull();
        }
    });

    test('admin callers pass the role gate for every role', () => {
        for (const target of ['waiter', 'chef', 'captain', 'manager', 'admin']) {
            expect(staffRoleGate('admin', target)).toBeNull();
        }
    });

    test('returned body is a fresh copy (callers cannot mutate the shared constant)', () => {
        const a = staffRoleGate('manager', 'manager');
        a.body.message = 'x';
        expect(staffRoleGate('manager', 'manager').body.message).not.toBe('x');
    });
});
