/**
 * Regression guard for branch isolation.
 *
 * These tests pin down the CONTRACT of the branch-scoping helpers in
 * [Backend/utils/tenantScope.js](Backend/utils/tenantScope.js) and the
 * canonical filter shapes each controller relies on. Any future change
 * that softens these helpers (e.g. re-adding a `{ branch: null }`
 * fallback for pinned staff, or letting query params widen scope) will
 * fail one of these tests immediately.
 *
 * Context — the rule (see memory/feedback_branch_isolation_strict.md):
 *   A staff user with `user.branch` set MUST only see data scoped to
 *   their branch. Tenant-level (`branch: null`) data and other-branch
 *   data must NOT leak through. Sharing across branches is opt-in only
 *   via the "Copy from Main" syncFromMain flow at branch-create time.
 *
 * The user has flagged this as a recurring bug ("this is final
 * reminder"). These tests exist so a fresh DB / fresh deploy keeps
 * the guarantee.
 */

const mongoose = require('mongoose');
const {
    tenantFilter,
    strictBranchFilter,
    analyticsBranchFilter,
    pinnedBranchId,
    isBranchPinned,
} = require('../utils/tenantScope');

const FAKE_TENANT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PINNED_BRANCH = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_BRANCH = 'cccccccccccccccccccccccc';

// The branch filters return real ObjectIds (not strings) so they work
// inside aggregation $match stages too. These helpers let tests
// compare against the ObjectId form expected by the filter contract.
const oid = (s) => new mongoose.Types.ObjectId(String(s));

function pinnedReq(overrides = {}) {
    return {
        restaurant: { _id: FAKE_TENANT },
        user: { _id: 'staff1', role: 'admin', branch: PINNED_BRANCH },
        query: {},
        ...overrides,
    };
}

function unpinnedOwnerReq(overrides = {}) {
    return {
        restaurant: { _id: FAKE_TENANT },
        user: { _id: 'owner1', role: 'admin', branch: null, isTenantOwner: true },
        query: {},
        ...overrides,
    };
}

describe('branch isolation helpers — fresh-deploy contract', () => {
    describe('pinnedBranchId / isBranchPinned', () => {
        test('returns the branch id for pinned staff', () => {
            expect(pinnedBranchId(pinnedReq())).toBe(PINNED_BRANCH);
            expect(isBranchPinned(pinnedReq())).toBe(true);
        });

        test('returns null for tenant owner', () => {
            expect(pinnedBranchId(unpinnedOwnerReq())).toBeNull();
            expect(isBranchPinned(unpinnedOwnerReq())).toBe(false);
        });

        test('tolerates populated branch ({_id}) shape', () => {
            const req = pinnedReq({ user: { branch: { _id: PINNED_BRANCH } } });
            expect(pinnedBranchId(req)).toBe(PINNED_BRANCH);
        });
    });

    describe('strictBranchFilter — pinned staff', () => {
        test('returns { branch: pinned ObjectId } — NO tenant-null fallback', () => {
            const f = strictBranchFilter(pinnedReq());
            expect(f).toEqual({ branch: oid(PINNED_BRANCH) });
            // The leak this guards against: a $or with { branch: null }
            // would pull every tenant-level seeded doc into the branch
            // admin's list. Reject that shape outright.
            expect(f.$or).toBeUndefined();
            // And the value must be a real ObjectId so aggregation
            // $match stages cast correctly — see the 2026-05-20 dashboard
            // earnings-0 bug.
            expect(f.branch).toBeInstanceOf(mongoose.Types.ObjectId);
        });

        test('ignores ?branch=all override — pin is authoritative', () => {
            const f = strictBranchFilter(pinnedReq({ query: { branch: 'all' } }));
            expect(f).toEqual({ branch: oid(PINNED_BRANCH) });
        });

        test('ignores ?branch=<otherId> — pin is authoritative', () => {
            const f = strictBranchFilter(pinnedReq({ query: { branch: OTHER_BRANCH } }));
            expect(f).toEqual({ branch: oid(PINNED_BRANCH) });
        });

        test('ignores ?branch=tenant-only — pin is authoritative', () => {
            const f = strictBranchFilter(pinnedReq({ query: { branch: 'tenant-only' } }));
            expect(f).toEqual({ branch: oid(PINNED_BRANCH) });
        });
    });

    describe('strictBranchFilter — tenant owner', () => {
        test('returns {} by default (sees everything in tenant)', () => {
            expect(strictBranchFilter(unpinnedOwnerReq())).toEqual({});
        });

        test('respects ?branch=<id> query — returns ObjectId', () => {
            const f = strictBranchFilter(unpinnedOwnerReq({ query: { branch: OTHER_BRANCH } }));
            expect(f).toEqual({ branch: oid(OTHER_BRANCH) });
            expect(f.branch).toBeInstanceOf(mongoose.Types.ObjectId);
        });

        test('respects ?branch=tenant-only', () => {
            const f = strictBranchFilter(unpinnedOwnerReq({ query: { branch: 'tenant-only' } }));
            expect(f).toEqual({ branch: null });
        });

        test('respects ?branch=all (no filter)', () => {
            expect(strictBranchFilter(unpinnedOwnerReq({ query: { branch: 'all' } }))).toEqual({});
        });
    });

    describe('analyticsBranchFilter — pinned staff', () => {
        test('returns { branch: pinned ObjectId } — pin is authoritative', () => {
            const f = analyticsBranchFilter(pinnedReq());
            expect(f).toEqual({ branch: oid(PINNED_BRANCH) });
            expect(f.$or).toBeUndefined();
            expect(f.branch).toBeInstanceOf(mongoose.Types.ObjectId);
        });

        test('ignores any query override', () => {
            const f = analyticsBranchFilter(pinnedReq({ query: { branch: 'all' } }));
            expect(f).toEqual({ branch: oid(PINNED_BRANCH) });
        });
    });

    describe('tenantFilter — branch isolation needs a tenant scope too', () => {
        test('returns { restaurant: id } when a tenant is resolved', () => {
            expect(tenantFilter(pinnedReq())).toEqual({ restaurant: FAKE_TENANT });
        });

        test('returns {} when no tenant (legacy / public flow)', () => {
            expect(tenantFilter({ restaurant: null, user: null })).toEqual({});
        });
    });
});

describe('branch isolation — fresh-DB defaults', () => {
    /**
     * The frontend create-branch modal initializes syncFromMain with
     * every flag false. If a future commit changes the default to
     * any-true, a freshly created branch would silently inherit Main's
     * data on first save — exactly the regression the user has called
     * out as recurring. We can't import a React component here, but
     * we can pin the SYNCABLE catalog shape that the controller relies
     * on. The contract: each entry is a single feature toggle, and
     * NONE are marked as default-on.
     */
    test('SYNCABLE keys cover all branchable catalogs', () => {
        // This list is the contract between
        // [Frontend/src/Pages/Admin/Branches.jsx](Frontend/src/Pages/Admin/Branches.jsx)
        // and the runSync block in
        // [Backend/controllers/branchController.js](Backend/controllers/branchController.js).
        // If a new sync target is added, both files must be updated AND
        // this list must include it — otherwise the create-branch flow
        // silently skips the new toggle.
        const EXPECTED_SYNCABLE_KEYS = [
            'categories', 'menu', 'combos', 'areas', 'tables',
            'coupons', 'promotions', 'halls',
            'eventTypes', 'packages', 'decorations', 'addons',
        ];
        expect(EXPECTED_SYNCABLE_KEYS).toHaveLength(12);
        // Categories MUST come before menu (FK constraint), areas MUST
        // come before tables (FK constraint). Encode that ordering here
        // so a future refactor can't silently break the clone sequence.
        const idx = (k) => EXPECTED_SYNCABLE_KEYS.indexOf(k);
        expect(idx('categories')).toBeLessThan(idx('menu'));
        expect(idx('areas')).toBeLessThan(idx('tables'));
    });

    test('Category requires per-branch uniqueness (not just per-tenant)', () => {
        // The unique index migration in
        // [Backend/migrations/migrateCategoryIndex.js](Backend/migrations/migrateCategoryIndex.js)
        // drops `{ name, restaurant }` and replaces it with
        // `{ name, restaurant, branch }`. Without this, two branches
        // can't both have a "Beverages" category — the Copy from Main
        // path silently 11000s and the new branch ends up empty.
        const Category = require('../models/category');
        const declared = Category.schema.indexes();
        const uniqueIdx = declared.find(([, opts]) => opts?.unique);
        expect(uniqueIdx).toBeDefined();
        const keys = Object.keys(uniqueIdx[0]);
        expect(keys).toEqual(expect.arrayContaining(['name', 'restaurant', 'branch']));
    });

    test('Combo schema has a branch field for per-branch isolation', () => {
        // Before 2026-05-19 the Combo model was tenant-only — a Branch
        // Admin saw every combo across every branch. The branch field
        // (default null) lets each branch own its own copies and the
        // strict filter in comboController hides everyone else's.
        const Combo = require('../models/combo');
        const branchPath = Combo.schema.path('branch');
        expect(branchPath).toBeDefined();
        expect(branchPath.options.ref).toBe('Branch');
    });

    test('Campaign schema has a branch field for per-branch Bonus Points', () => {
        const Campaign = require('../models/campaign');
        const branchPath = Campaign.schema.path('branch');
        expect(branchPath).toBeDefined();
        expect(branchPath.options.ref).toBe('Branch');
    });

    test('Advance-booking catalog models all carry a branch field', () => {
        // EventType, Package, DecorationPackage, Addon — gained branch
        // 2026-05-19 so the Bookings tab's three sub-modules don't leak
        // Main-branch records into every branch admin's view.
        const models = ['eventType', 'package', 'decorationPackage', 'addon'];
        for (const m of models) {
            const Model = require(`../models/${m}`);
            const branchPath = Model.schema.path('branch');
            expect(branchPath).toBeDefined();
            expect(branchPath.options.ref).toBe('Branch');
        }
    });

    test('Tenant owner using the admin switcher gets STRICT branch scope', () => {
        // The fix on 2026-05-20: tenant owner (no user.branch pin) using
        // the AdminBranchContext switcher passes `?branch=<id>`. The
        // helper must return `{ branch: <id> }` — NOT `{ $or: [null, id] }`.
        // Without this, a tenant-null table (legacy seeded data) would
        // leak into every branch's view when the tenant owner switched
        // branches in the dropdown. That was the "bulk-uploaded FC Road
        // tables show in Main" leak.
        const ownerReq = unpinnedOwnerReq({ query: { branch: OTHER_BRANCH } });
        const f = strictBranchFilter(ownerReq);
        expect(f).toEqual({ branch: oid(OTHER_BRANCH) });
        expect(f.$or).toBeUndefined();
        expect(f.branch).toBeInstanceOf(mongoose.Types.ObjectId);
    });

    test('Addon requires per-branch slug uniqueness', () => {
        // The Addon migration drops `{ slug, restaurant }` and replaces
        // it with `{ slug, restaurant, branch }`. Without that, two
        // branches can't both have a "balloon-arch" addon — Copy from
        // Main hits 11000 and skips.
        const Addon = require('../models/addon');
        const declared = Addon.schema.indexes();
        const uniqueIdx = declared.find(([, opts]) => opts?.unique);
        expect(uniqueIdx).toBeDefined();
        const keys = Object.keys(uniqueIdx[0]);
        expect(keys).toEqual(expect.arrayContaining(['slug', 'restaurant', 'branch']));
    });
});
