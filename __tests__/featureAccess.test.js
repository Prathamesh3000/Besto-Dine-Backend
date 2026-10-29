/**
 * Plan module access — utils/featureAccess + middlewares/featureGate.
 *
 * Pure logic, no Mongo: restaurants are plain objects shaped like the
 * Restaurant document (subscription.features, featureOverrides, addons).
 */
const {
    featureTier, hasFeature, hasTier, effectiveFeatures, activeAddonKeys, isAddonActive,
} = require('../utils/featureAccess');
const { featureGate, featureGateAny, staffAppGate } = require('../middlewares/featureGate');
const { publicFeaturesOf } = require('../utils/publicFeatureFlags');
const { LINEUP, SILVER_FEATURES, GOLD_FEATURES, PREMIUM_FEATURES } = require('../config/planLineup');
const SubscriptionPlan = require('../models/subscriptionPlan');

const tenant = (features = {}, extra = {}) => ({ subscription: { features, planName: 'Gold' }, ...extra });
const DAY = 86400000;

describe('featureAccess — resolution order', () => {
    test('no restaurant (legacy single-tenant) → everything allowed', () => {
        expect(hasFeature(null, 'inventory')).toBe(true);
        expect(featureTier(undefined, 'revenueAnalytics')).toBe('advanced');
    });

    test('plan snapshot decides when nothing else applies', () => {
        const r = tenant({ inventory: true, crm: false });
        expect(hasFeature(r, 'inventory')).toBe(true);
        expect(hasFeature(r, 'crm')).toBe(false);
        expect(hasFeature(r, 'kiosk')).toBe(false);          // missing key = off
    });

    test('override false beats plan and add-on; override true beats a missing plan key', () => {
        const r = tenant({ inventory: true }, {
            featureOverrides: { inventory: false, crm: true },
            addons: [{ key: 'inventory', status: 'active' }],
        });
        expect(hasFeature(r, 'inventory')).toBe(false);
        expect(hasFeature(r, 'crm')).toBe(true);
    });

    test('an active add-on switches a module on', () => {
        const r = tenant({ kiosk: false }, { addons: [{ key: 'kiosk', status: 'active' }] });
        expect(hasFeature(r, 'kiosk')).toBe(true);
    });

    test('cancelled, expired and not-yet-started add-ons do nothing', () => {
        const now = Date.now();
        const r = tenant({}, {
            addons: [
                { key: 'kiosk', status: 'cancelled' },
                { key: 'crm', status: 'active', endDate: new Date(now - DAY) },
                { key: 'inventory', status: 'active', startDate: new Date(now + DAY) },
                { key: 'eInvoice', status: 'active', endDate: new Date(now + DAY) },
            ],
        });
        expect(hasFeature(r, 'kiosk')).toBe(false);
        expect(hasFeature(r, 'crm')).toBe(false);
        expect(hasFeature(r, 'inventory')).toBe(false);
        expect(hasFeature(r, 'eInvoice')).toBe(true);
        expect([...activeAddonKeys(r)]).toEqual(['eInvoice']);
        expect(isAddonActive({ key: 'x', status: 'active' })).toBe(true);
    });

    test('campaigns falls back to couponPromotions only when the snapshot has no campaigns key', () => {
        expect(hasFeature(tenant({ couponPromotions: true }), 'campaigns')).toBe(true);
        expect(hasFeature(tenant({ couponPromotions: false }), 'campaigns')).toBe(false);
        expect(hasFeature(tenant({ couponPromotions: true, campaigns: false }), 'campaigns')).toBe(false);
        expect(hasFeature(tenant({ couponPromotions: false, campaigns: true }), 'campaigns')).toBe(true);
    });

    test('tiers: plan string, override string / boolean, add-on = top tier', () => {
        expect(featureTier(tenant({ revenueAnalytics: 'standard' }), 'revenueAnalytics')).toBe('standard');
        expect(featureTier(tenant({ revenueAnalytics: 'none' }), 'revenueAnalytics')).toBe('none');
        expect(featureTier(tenant({ revenueAnalytics: 'basic' }, { featureOverrides: { revenueAnalytics: 'advanced' } }), 'revenueAnalytics')).toBe('advanced');
        expect(featureTier(tenant({ revenueAnalytics: 'advanced' }, { featureOverrides: { revenueAnalytics: false } }), 'revenueAnalytics')).toBe('none');
        expect(featureTier(tenant({ revenueAnalytics: 'basic' }, { featureOverrides: { revenueAnalytics: true } }), 'revenueAnalytics')).toBe('advanced');
        expect(hasTier(tenant({ revenueAnalytics: 'standard' }), 'revenueAnalytics', 'advanced')).toBe(false);
        expect(hasTier(tenant({ revenueAnalytics: 'standard' }), 'revenueAnalytics', 'basic')).toBe(true);
    });

    test('effectiveFeatures folds add-ons, overrides and fallbacks into one map', () => {
        const r = tenant({ inventory: true, couponPromotions: true, revenueAnalytics: 'basic' }, {
            featureOverrides: { inventory: false },
            addons: [{ key: 'kiosk', status: 'active' }],
        });
        const eff = effectiveFeatures(r, ['inventory', 'kiosk', 'campaigns', 'crm', 'revenueAnalytics']);
        expect(eff).toMatchObject({
            inventory: false, kiosk: true, campaigns: true, crm: false, couponPromotions: true, revenueAnalytics: 'basic',
        });
    });

    test('Restaurant#hasFeature delegates to the same rules', () => {
        const Restaurant = require('../models/restaurant');
        const r = new Restaurant({ name: 'x', slug: 'x', subscription: { features: { kiosk: false } }, addons: [{ key: 'kiosk' }] });
        expect(r.hasFeature('kiosk')).toBe(true);
    });

    test('publicFeaturesOf reports kiosk / paymentGateway including add-ons', () => {
        const flags = publicFeaturesOf(tenant({ paymentGateway: true }, { addons: [{ key: 'kiosk', status: 'active' }] }));
        expect(flags.kiosk).toBe(true);
        expect(flags.paymentGateway).toBe(true);
        expect(flags.walletLoyalty).toBe(false);
        expect(publicFeaturesOf(null).kiosk).toBe(false);
    });
});

// ── middleware ──────────────────────────────────────────────────────────

function run(mw, req) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(body) { resolve({ next: false, status: this.statusCode, body }); return this; },
        };
        mw(req, res, () => resolve({ next: true }));
    });
}

describe('featureGate', () => {
    test('locked → 403 FEATURE_LOCKED with staff copy; customer copy for guests', async () => {
        const r = tenant({ inventory: false });
        const staff = await run(featureGate('inventory'), { restaurant: r, user: { role: 'admin' } });
        expect(staff).toMatchObject({ next: false, status: 403, body: { code: 'FEATURE_LOCKED', feature: 'inventory', currentPlan: 'Gold' } });
        expect(staff.body.message).toMatch(/Upgrade/);
        const guest = await run(featureGate('inventory'), { restaurant: r });
        expect(guest.body.message).toMatch(/doesn't offer inventory management/);
    });

    test('revoked by override → FEATURE_REVOKED', async () => {
        const out = await run(featureGate('crm'), { restaurant: tenant({ crm: true }, { featureOverrides: { crm: false } }), user: { role: 'admin' } });
        expect(out.body.code).toBe('FEATURE_REVOKED');
    });

    test('add-on unlocks the route', async () => {
        const out = await run(featureGate('kiosk'), { restaurant: tenant({}, { addons: [{ key: 'kiosk', status: 'active' }] }) });
        expect(out.next).toBe(true);
    });

    test('minTier blocks a lower tier and reports required/current tier', async () => {
        const gate = featureGate('revenueAnalytics', { minTier: 'advanced' });
        const low = await run(gate, { restaurant: tenant({ revenueAnalytics: 'standard' }), user: { role: 'admin' } });
        expect(low).toMatchObject({ status: 403, body: { code: 'FEATURE_LOCKED', requiredTier: 'advanced', currentTier: 'standard' } });
        const ok = await run(gate, { restaurant: tenant({ revenueAnalytics: 'advanced' }) });
        expect(ok.next).toBe(true);
        expect(() => featureGate('revenueAnalytics', { minTier: 'ultra' })).toThrow(/unknown tier/);
    });

    test('featureGateAny passes when one key is on, even if another is revoked', async () => {
        const r = tenant({ advanceBookingHall: true }, { featureOverrides: { advanceBookingTable: false } });
        expect((await run(featureGateAny('advanceBookingTable', 'advanceBookingHall'), { restaurant: r })).next).toBe(true);
        expect((await run(featureGateAny('crm', 'inventory'), { restaurant: r })).status).toBe(403);
    });
});

describe('staffAppGate', () => {
    const noApps = tenant({ kitchenDisplay: false, waiterDashboard: false });

    test.each([
        ['chef', 'kitchenDisplay'],
        ['waiter', 'waiterDashboard'],
        ['captain', 'waiterDashboard'],
    ])('%s on a plan without %s → 403 on any API call', async (role, feature) => {
        const out = await run(staffAppGate, { restaurant: noApps, user: { role }, path: '/orders/live' });
        expect(out).toMatchObject({ status: 403, body: { code: 'FEATURE_LOCKED', feature } });
    });

    test('auth and public endpoints stay open so the app can sign in / out', async () => {
        for (const path of ['/auth/me', '/auth/logout', '/public/plans']) {
            expect((await run(staffAppGate, { restaurant: noApps, user: { role: 'chef' }, path })).next).toBe(true);
        }
        // '/authx' is not '/auth'
        expect((await run(staffAppGate, { restaurant: noApps, user: { role: 'chef' }, path: '/authx' })).status).toBe(403);
    });

    test('admins, managers, customers and guests are not affected', async () => {
        for (const user of [{ role: 'admin' }, { role: 'manager' }, { role: 'customer' }, undefined]) {
            expect((await run(staffAppGate, { restaurant: noApps, user, path: '/orders/live' })).next).toBe(true);
        }
    });

    test('plan with the app, or an add-on for it → allowed', async () => {
        expect((await run(staffAppGate, { restaurant: tenant({ kitchenDisplay: true }), user: { role: 'chef' }, path: '/orders/kitchen' })).next).toBe(true);
        const withAddon = tenant({ waiterDashboard: false }, { addons: [{ key: 'waiterDashboard', status: 'active' }] });
        expect((await run(staffAppGate, { restaurant: withAddon, user: { role: 'waiter' }, path: '/orders/live' })).next).toBe(true);
    });
});

describe('plan line-up (config/planLineup.js)', () => {
    const keys = [...SubscriptionPlan.FEATURE_KEYS, 'revenueAnalytics'];

    test('every plan sets every module explicitly', () => {
        for (const plan of LINEUP) {
            expect(Object.keys(plan.features).sort()).toEqual([...keys].sort());
        }
    });

    test('Silver runs the outlet; Gold adds retention; Premium adds halls, kiosk and integrations', () => {
        const on = (f) => Object.entries(f).filter(([, v]) => v === true).map(([k]) => k).sort();
        expect(on(SILVER_FEATURES)).toEqual([
            'accountingExport', 'aggregatorOrders', 'dataExport', 'dineIn', 'inventory', 'kitchenDisplay',
            'multiBranch', 'paymentGateway', 'takeaway', 'tipManagement', 'waiterDashboard',
        ]);
        expect(on(GOLD_FEATURES).filter(k => !SILVER_FEATURES[k]).sort()).toEqual([
            'advanceBookingTable', 'campaigns', 'couponPromotions', 'crm', 'publicApi', 'staffPerformance', 'walletLoyalty',
        ]);
        expect(on(PREMIUM_FEATURES).filter(k => !GOLD_FEATURES[k]).sort()).toEqual([
            'advanceBookingHall', 'eInvoice', 'kiosk', 'webhooks', 'whiteLabelBranding',
        ]);
        expect([SILVER_FEATURES, GOLD_FEATURES, PREMIUM_FEATURES].map(f => f.revenueAnalytics)).toEqual(['basic', 'standard', 'advanced']);
    });

    test('prices and slugs', () => {
        expect(LINEUP.map(p => [p.slug, p.price])).toEqual([['silver', 699], ['gold', 1799], ['premium', 2999], ['enterprise', 0]]);
    });
});
