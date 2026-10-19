/**
 * Operations profile — utils/operationsProfile (OPERATIONS_CONTROL_PANEL_DESIGN.md).
 *
 * Pure logic, no Mongo: restaurants are plain objects shaped like the
 * Restaurant document (subscription.features, featureOverrides, addons,
 * operations).
 */
const {
    DEFAULT_PROFILE, PRESETS, PRESET_KEYS, MODULE_KEYS, ADVANCED_PATHS,
    OperationsProfileError,
    normaliseProfile, deriveFlow, validateProfile, resolveOperations,
    publicOperationsOf, profileFromPreset,
} = require('../utils/operationsProfile');

// Every plan module a tenant could have — "full plan" for tests that
// should not be affected by plan intersection.
const FULL_PLAN = {
    dineIn: true, takeaway: true, kitchenDisplay: true, waiterDashboard: true,
    paymentGateway: true, walletLoyalty: true, tipManagement: true, kiosk: true,
};
const tenant = (features = FULL_PLAN, extra = {}) => ({ subscription: { features }, ...extra });

// What every tenant does TODAY, before the ops profile exists. This is
// the contract: a tenant with no profile must resolve to exactly this.
const TODAY = {
    serviceModel: 'tableService',
    roles: { waiter: true, captain: true, chef: true },
    orderFlow: {
        customerSelfOrder: true, staffOrder: true, kitchenDisplay: true,
        servedStep: true, customerTracking: true,
    },
    payment: {
        dineIn: 'payAfter', takeaway: 'payFirst', kiosk: 'payFirst', delivery: 'payFirst',
        methods: { online: true, wallet: true, counterCash: false },
        holdUntilPaid: false, holdExpiryMinutes: 20,
    },
    customerApp: { callWaiter: true, requestBill: true, appendToOrder: true, tips: true },
    tables: { useTables: true, assignWaiters: true, mergeTables: true },
    // Informational only (design §0.4 q3): kitchen printer with the chef module.
    printing: { kotAt: 'kitchen' },
};

describe('operationsProfile — defaults equal today', () => {
    test('a restaurant with no operations field resolves to today\'s behaviour', () => {
        const r = resolveOperations(tenant());
        expect(r).toMatchObject(TODAY);
        expect(r.preset).toBe('fullService');
        expect(r.planBlocks).toEqual([]);
    });

    test('DEFAULT_PROFILE derives exactly today\'s flow', () => {
        expect(deriveFlow(normaliseProfile(DEFAULT_PROFILE))).toEqual(TODAY);
    });

    test('the fullService preset is the default', () => {
        expect(deriveFlow(profileFromPreset('fullService'))).toEqual(TODAY);
    });

    test('no restaurant at all (legacy single-tenant) → today\'s flow, everything allowed', () => {
        expect(resolveOperations(null)).toMatchObject(TODAY);
    });

    test('a corrupt stored profile falls back to today instead of throwing', () => {
        const r = resolveOperations(tenant(FULL_PLAN, { operations: { modules: 'nope' } }));
        expect(r).toMatchObject(TODAY);
    });

    test('default profile on a plan WITHOUT the waiter app keeps today\'s behavioural steps', () => {
        const plan = { ...FULL_PLAN, waiterDashboard: false, kitchenDisplay: false, tipManagement: false };
        const r = resolveOperations(tenant(plan));
        // access is intersected (same as staffAppGate today)…
        expect(r.roles).toEqual({ waiter: false, captain: false, chef: false });
        expect(r.orderFlow.kitchenDisplay).toBe(false);
        // tips are behavioural, not plan-gated: a plan without
        // tipManagement still accepted tips before profiles existed
        expect(r.customerApp.tips).toBe(true);
        // …but how the restaurant runs does NOT change
        expect(r.orderFlow.servedStep).toBe(true);
        expect(r.orderFlow.customerTracking).toBe(true);
        expect(r.payment.dineIn).toBe('payAfter');
        expect(r.customerApp.callWaiter).toBe(true);
        expect(r.customerApp.requestBill).toBe(true);
    });
});

describe('operationsProfile — modules drive the flow (design §0.3)', () => {
    const flowFor = (modules, answers = {}) =>
        deriveFlow(normaliseProfile({ modules, answers }));

    test('first client — QR ordering + customer payment only (modules 1 + 5)', () => {
        const f = flowFor({ qrOrdering: true, waiter: false, captain: false, chef: false, customerPayment: true });
        expect(f.serviceModel).toBe('counterService');
        expect(f.roles).toEqual({ waiter: false, captain: false, chef: false });
        expect(f.orderFlow).toMatchObject({
            customerSelfOrder: true, kitchenDisplay: false, servedStep: false, customerTracking: false,
        });
        expect(f.payment.dineIn).toBe('payFirst');
        expect(f.payment.holdUntilPaid).toBe(true);
        expect(f.payment.methods).toEqual({ online: true, wallet: true, counterCash: false });
        expect(f.customerApp).toEqual({ callWaiter: false, requestBill: false, appendToOrder: true, tips: false });
        expect(f.tables.assignWaiters).toBe(false);
    });

    test('chef on (1 + 3 + 5) → customer can track the order', () => {
        const f = flowFor({ qrOrdering: true, waiter: false, captain: false, chef: true, customerPayment: true });
        expect(f.orderFlow.customerTracking).toBe(true);
        expect(f.orderFlow.kitchenDisplay).toBe(true);
        expect(f.payment.dineIn).toBe('payFirst');
    });

    test('no customer payment + self-service (1 only) → pay first at the counter', () => {
        const f = flowFor({ qrOrdering: true, waiter: false, captain: false, chef: false, customerPayment: false });
        expect(f.payment.dineIn).toBe('payFirst');
        expect(f.payment.methods).toEqual({ online: false, wallet: false, counterCash: true });
        expect(f.payment.holdUntilPaid).toBe(true);
    });

    test('waiters but no customer payment (1 + 2 + 3) → pay after the meal at the counter', () => {
        const f = flowFor({ qrOrdering: true, waiter: true, captain: false, chef: true, customerPayment: false });
        expect(f.payment.dineIn).toBe('payAfter');
        expect(f.payment.methods.counterCash).toBe(true);
        expect(f.orderFlow.servedStep).toBe(true);
        expect(f.customerApp.requestBill).toBe(true);
    });

    test('captain without waiters still counts as floor staff', () => {
        const f = flowFor({ qrOrdering: true, waiter: false, captain: true, chef: true, customerPayment: true });
        expect(f.serviceModel).toBe('tableService');
        expect(f.orderFlow.servedStep).toBe(true);
        expect(f.customerApp.callWaiter).toBe(true);
        expect(f.tables.assignWaiters).toBe(true);
        expect(f.roles).toEqual({ waiter: false, captain: true, chef: true });
    });

    test('no QR ordering → customers cannot self-order', () => {
        const f = flowFor({ qrOrdering: false, waiter: true, captain: true, chef: true, customerPayment: true });
        expect(f.orderFlow.customerSelfOrder).toBe(false);
        expect(f.orderFlow.staffOrder).toBe(true);
    });

    test('answers override the derived defaults', () => {
        const f = flowFor(
            { qrOrdering: true, waiter: false, captain: false, chef: false, customerPayment: true },
            { dineInPayment: 'payAfter', counterCash: true, useTables: false },
        );
        expect(f.payment.dineIn).toBe('payAfter');
        expect(f.payment.holdUntilPaid).toBe(false);
        expect(f.payment.methods.counterCash).toBe(true);
        // useTables:false (token numbers) is not implemented yet — stays on (B12 guard)
        expect(f.tables.useTables).toBe(true);
    });

    test('advanced fine-tune wins over derived values', () => {
        const f = deriveFlow(normaliseProfile({
            advanced: { 'customerApp.tips': false, 'payment.takeaway': 'either', 'payment.holdExpiryMinutes': 45 },
        }));
        expect(f.customerApp.tips).toBe(false);
        expect(f.payment.takeaway).toBe('either');
        expect(f.payment.holdExpiryMinutes).toBe(45);
    });

    test('hold expiry is clamped to 5–240 minutes', () => {
        const lo = deriveFlow(normaliseProfile({ advanced: { 'payment.holdExpiryMinutes': 1 } }));
        const hi = deriveFlow(normaliseProfile({ advanced: { 'payment.holdExpiryMinutes': 9999 } }));
        expect(lo.payment.holdExpiryMinutes).toBe(5);
        expect(hi.payment.holdExpiryMinutes).toBe(240);
    });
});

describe('operationsProfile — plan intersection only switches OFF', () => {
    const allOn = normaliseProfile({});

    test.each([
        ['waiterDashboard', (r) => [r.roles.waiter, r.roles.captain]],
        ['kitchenDisplay', (r) => [r.roles.chef, r.orderFlow.kitchenDisplay]],
        ['paymentGateway', (r) => [r.payment.methods.online]],
        ['walletLoyalty', (r) => [r.payment.methods.wallet]],
        ['kiosk', (r) => [r.channels.kiosk]],
    ])('plan without %s → those flags resolve off', (feature, pick) => {
        const r = resolveOperations(tenant({ ...FULL_PLAN, [feature]: false }, { operations: allOn }));
        for (const v of pick(r)) expect(v).toBe(false);
    });

    test('profile off + plan on stays off (profile can switch off)', () => {
        const ops = normaliseProfile({ modules: { waiter: false, captain: false, chef: false } });
        const r = resolveOperations(tenant(FULL_PLAN, { operations: ops }));
        expect(r.roles).toEqual({ waiter: false, captain: false, chef: false });
    });

    test('the profile never grants: module ticked but not in plan → off, reported in planBlocks', () => {
        const r = resolveOperations(tenant({ dineIn: true }, { operations: allOn }));
        expect(r.roles).toEqual({ waiter: false, captain: false, chef: false });
        expect(r.payment.methods.online).toBe(false);
        expect(r.planBlocks.map(b => b.module).sort()).toEqual(['captain', 'chef', 'customerPayment', 'waiter']);
    });

    test('a Super Admin override granting the waiter app is respected (featureAccess order unchanged)', () => {
        const r = resolveOperations(tenant({ dineIn: true }, { featureOverrides: { waiterDashboard: true } }));
        expect(r.roles.waiter).toBe(true);
    });

    test('a paid kiosk add-on switches the kiosk channel on', () => {
        const r = resolveOperations(tenant({ ...FULL_PLAN, kiosk: false }, {
            addons: [{ key: 'kiosk', status: 'active' }],
        }));
        expect(r.channels.kiosk).toBe(true);
    });

    test('pay-first dine-in with every method lost to the plan falls back to pay after', () => {
        const ops = profileFromPreset('hotelPayFirstSelfOrder');
        ops.answers.counterCash = false;
        const r = resolveOperations(tenant({ dineIn: true }, { operations: ops }));
        expect(r.payment.dineIn).toBe('payAfter');
        expect(r.payment.holdUntilPaid).toBe(false);
        expect(r.payment.takeaway).toBe('payFirst');   // other channels untouched
    });

    test('pay-first dine-in keeps counter cash when online payment is not in the plan', () => {
        const r = resolveOperations(tenant({ dineIn: true }, { operations: profileFromPreset('hotelPayFirstSelfOrder') }));
        expect(r.payment.dineIn).toBe('payFirst');
        expect(r.payment.methods).toEqual({ online: false, wallet: false, counterCash: true });
    });
});

describe('operationsProfile — normalise rejects bad input', () => {
    const bad = (input) => {
        try { normaliseProfile(input); } catch (e) { return e; }
        throw new Error('expected normaliseProfile to throw');
    };

    test('unknown top-level field, module, answer and advanced path are rejected', () => {
        const e = bad({ foo: 1, modules: { cashier: true }, answers: { colour: 'red' }, advanced: { 'roles.waiter': true } });
        expect(e).toBeInstanceOf(OperationsProfileError);
        expect(e.errors).toEqual(expect.arrayContaining([
            'unknown field "foo"',
            'unknown module "cashier"',
            'unknown answer "colour"',
            'unknown advanced setting "roles.waiter"',
        ]));
    });

    test('wrong types are rejected', () => {
        const e = bad({
            preset: 'disco',
            modules: { waiter: 'yes' },
            answers: { dineInPayment: 'later', counterCash: 'maybe' },
            advanced: { 'payment.takeaway': 'never', 'orderFlow.servedStep': 1, 'payment.holdExpiryMinutes': 'ten' },
        });
        expect(e.errors).toHaveLength(7);
    });

    test('not an object', () => {
        expect(bad('x').errors).toEqual(['operations must be an object']);
        expect(bad([]).errors).toEqual(['operations must be an object']);
    });

    test('partial input is filled with defaults; missing preset becomes custom', () => {
        const p = normaliseProfile({ modules: { chef: false } });
        expect(p.modules).toEqual({ qrOrdering: true, waiter: true, captain: true, chef: false, customerPayment: true });
        expect(p.preset).toBe('custom');
        expect(p.answers).toEqual({ dineInPayment: null, counterCash: null, useTables: null, kotPrinter: null });
    });

    test('null / undefined → the default profile', () => {
        expect(normaliseProfile(null)).toEqual(JSON.parse(JSON.stringify(DEFAULT_PROFILE)));
        expect(normaliseProfile(undefined).preset).toBe('fullService');
    });

    test('every ADVANCED_PATHS entry is a real path in the derived flow', () => {
        const flow = deriveFlow(normaliseProfile({}));
        for (const path of Object.keys(ADVANCED_PATHS)) {
            const v = path.split('.').reduce((o, k) => o?.[k], flow);
            expect(v).not.toBeUndefined();
        }
    });
});

describe('operationsProfile — validation', () => {
    test('every preset is valid (no errors)', () => {
        for (const key of PRESET_KEYS.filter(k => k !== 'custom')) {
            expect(validateProfile(profileFromPreset(key)).errors).toEqual([]);
        }
    });

    test('the default profile has no errors and no warnings', () => {
        expect(validateProfile(normaliseProfile({}))).toEqual({ errors: [], warnings: [] });
    });

    test('pay first with no way to pay is an error', () => {
        const p = normaliseProfile({
            modules: { waiter: false, captain: false, customerPayment: false },
            answers: { counterCash: false },
        });
        expect(validateProfile(p).errors[0]).toMatch(/no way to pay first/);
    });

    test('served step forced on with nobody to serve is an error', () => {
        const p = normaliseProfile({
            modules: { waiter: false, captain: false },
            advanced: { 'orderFlow.servedStep': true },
        });
        expect(validateProfile(p).errors[0]).toMatch(/no waiter or captain/);
    });

    test('tips / call waiter forced on with no floor staff are warnings', () => {
        const p = normaliseProfile({
            modules: { waiter: false, captain: false },
            answers: { counterCash: true },
            advanced: { 'customerApp.tips': true, 'customerApp.callWaiter': true },
        });
        const { errors, warnings } = validateProfile(p);
        expect(errors).toEqual([]);
        expect(warnings.join(' ')).toMatch(/tips/);
        expect(warnings.join(' ')).toMatch(/Call waiter/);
    });

    test('online-only pay first warns there is no fallback', () => {
        const p = normaliseProfile({ modules: { waiter: false, captain: false } });
        expect(validateProfile(p).warnings.join(' ')).toMatch(/online payment fails/);
    });
});

describe('operationsProfile — presets and public subset', () => {
    test('every preset key has a definition and uses only known modules', () => {
        for (const key of PRESET_KEYS.filter(k => k !== 'custom')) {
            expect(PRESETS[key]).toBeDefined();
            expect(Object.keys(PRESETS[key].modules).sort()).toEqual([...MODULE_KEYS].sort());
        }
    });

    test('unknown preset throws', () => {
        expect(() => profileFromPreset('nope')).toThrow(OperationsProfileError);
    });

    test('hotel preset = first client flow', () => {
        const r = resolveOperations(tenant(FULL_PLAN, { operations: profileFromPreset('hotelPayFirstSelfOrder') }));
        expect(r.preset).toBe('hotelPayFirstSelfOrder');
        expect(r.payment.dineIn).toBe('payFirst');
        expect(r.orderFlow.customerTracking).toBe(false);
        expect(r.roles).toEqual({ waiter: false, captain: false, chef: false });
        expect(r.payment.methods.counterCash).toBe(true);
    });

    test('public subset carries only customer-facing fields', () => {
        const pub = publicOperationsOf(tenant());
        expect(Object.keys(pub).sort()).toEqual(['customerApp', 'orderFlow', 'payment', 'serviceModel', 'tables']);
        expect(pub).not.toHaveProperty('roles');
        expect(pub).not.toHaveProperty('planBlocks');
        expect(pub.payment).toEqual({
            dineIn: 'payAfter', takeaway: 'payFirst', kiosk: 'payFirst', delivery: 'payFirst',
            methods: { online: true, wallet: true, counterCash: false },
        });
        expect(pub.orderFlow).toEqual({ customerSelfOrder: true, customerTracking: true });
    });

    test('resolve does not mutate the stored profile', () => {
        const ops = profileFromPreset('cafeCounterPayFirst');
        const before = JSON.stringify(ops);
        resolveOperations(tenant(FULL_PLAN, { operations: ops }));
        expect(JSON.stringify(ops)).toBe(before);
    });
});

describe('operationsProfile — diffImpact (what changes on save)', () => {
    const { diffImpact } = require('../utils/operationsProfile');
    const today = resolveOperations(tenant());

    test('no change → nothing to report', () => {
        expect(diffImpact(today, resolveOperations(tenant()))).toEqual([]);
    });

    test('full service → hotel preset lists every visible change', () => {
        const hotel = resolveOperations(tenant(FULL_PLAN, { operations: profileFromPreset('hotelPayFirstSelfOrder') }));
        const msgs = diffImpact(today, hotel).map(i => i.message).join(' | ');
        expect(msgs).toMatch(/Waiter app switched off/);
        expect(msgs).toMatch(/Captain app switched off/);
        expect(msgs).toMatch(/Kitchen screen \(chef app\) switched off/);
        expect(msgs).toMatch(/Dine-in: pay after the meal → pay first/);
        expect(msgs).toMatch(/kitchen sees a dine-in order only after it is paid/);
        expect(msgs).toMatch(/No live order tracking/);
        expect(msgs).toMatch(/Cash at the counter switched on/);
        expect(msgs).toMatch(/"Call waiter" button switched off/);
        expect(msgs).toMatch(/collect their food at the counter/);
    });

    test('switching roles off and payment timing are warnings; switching on is info', () => {
        const hotel = resolveOperations(tenant(FULL_PLAN, { operations: profileFromPreset('hotelPayFirstSelfOrder') }));
        const down = diffImpact(today, hotel);
        expect(down.find(i => i.message.startsWith('Waiter app')).severity).toBe('warning');
        expect(down.find(i => i.message.startsWith('Dine-in')).severity).toBe('warning');
        const up = diffImpact(hotel, today);
        expect(up.find(i => i.message.startsWith('Waiter app')).severity).toBe('info');
    });
});

describe('operationsProfile — review fixes', () => {
    test('pay first with cash / wallet but the hold switched off is an error', () => {
        const p = normaliseProfile({
            modules: { waiter: false, captain: false },
            answers: { counterCash: true },
            advanced: { 'payment.holdUntilPaid': false },
        });
        expect(validateProfile(p).errors.join(' ')).toMatch(/hold unpaid orders/);
    });
});

describe('operationsProfile — ops-panel review fixes (B16, B12, B17)', () => {
    const { USE_TABLES_UNSUPPORTED_WARNING, KOT_PRINTER_OPTIONS } = require('../utils/operationsProfile');

    test('B16: QR ordering off AND staff ordering off is rejected — nobody could order', () => {
        const p = normaliseProfile({ modules: { qrOrdering: false }, advanced: { 'orderFlow.staffOrder': false } });
        const { errors } = validateProfile(p);
        expect(errors.some(e => e.startsWith('orderFlow.staffOrder:'))).toBe(true);
        // either one alone is fine
        expect(validateProfile(normaliseProfile({ modules: { qrOrdering: false } })).errors).toEqual([]);
        expect(validateProfile(normaliseProfile({ advanced: { 'orderFlow.staffOrder': false } })).errors).toEqual([]);
    });

    test('B12: useTables:false is not supported yet → normalised to true with a warning, save still valid', () => {
        const warnings = [];
        const p = normaliseProfile({ answers: { useTables: false } }, { warnings });
        expect(p.answers.useTables).toBe(true);
        expect(warnings).toEqual([USE_TABLES_UNSUPPORTED_WARNING]);
        expect(warnings[0]).toMatch(/token-number mode is not available yet/);
        expect(validateProfile(p).errors).toEqual([]);
        expect(deriveFlow(p).tables.useTables).toBe(true);
        // no collector → still normalised, no throw
        expect(normaliseProfile({ answers: { useTables: false } }).answers.useTables).toBe(true);
        // the kioskOnly preset (useTables:false) resolves with tables on
        expect(resolveOperations(tenant(FULL_PLAN, { operations: profileFromPreset('kioskOnly') })).tables.useTables).toBe(true);
        // a stored profile written before the rule (raw false) still resolves to tables on
        expect(deriveFlow({ ...DEFAULT_PROFILE, answers: { ...DEFAULT_PROFILE.answers, useTables: false } }).tables.useTables).toBe(true);
    });

    test('B17: printer question → answers.kotPrinter → printing.kotAt (informational, default = today)', () => {
        expect(KOT_PRINTER_OPTIONS).toEqual(['kitchen', 'counter', 'none']);
        expect(DEFAULT_PROFILE.answers.kotPrinter).toBeNull();
        // default profile (chef on) → kitchen printer; no chef → counter
        expect(deriveFlow(normaliseProfile(null)).printing).toEqual({ kotAt: 'kitchen' });
        expect(deriveFlow(profileFromPreset('hotelPayFirstSelfOrder')).printing).toEqual({ kotAt: 'counter' });
        expect(deriveFlow(profileFromPreset('cafeCounterPayFirst')).printing).toEqual({ kotAt: 'kitchen' });
        // the answer wins
        for (const v of KOT_PRINTER_OPTIONS) {
            expect(deriveFlow(normaliseProfile({ answers: { kotPrinter: v } })).printing.kotAt).toBe(v);
        }
        expect(resolveOperations(tenant(FULL_PLAN, { operations: { answers: { kotPrinter: 'none' } } })).printing.kotAt).toBe('none');
        // bad values are rejected; the customer-safe subset does not carry it
        expect(() => normaliseProfile({ answers: { kotPrinter: 'bluetooth' } })).toThrow(/answers.kotPrinter must be one of/);
        expect(publicOperationsOf(tenant()).printing).toBeUndefined();
    });
});

describe('operationsProfile — orderIsPayFirst / payFirstOrderMatch (per-round pay-first)', () => {
    const { orderIsPayFirst, payFirstOrderMatch } = require('../utils/operationsProfile');
    const opsOf = (profile) => resolveOperations(tenant(FULL_PLAN, profile ? { operations: profile } : {}));
    const payFirstOps = opsOf(profileFromPreset('cafeCounterPayFirst'));
    const eitherOps = opsOf({ ...profileFromPreset('cafeCounterPayFirst'), answers: { dineInPayment: 'either' } });
    const noProfileOps = opsOf(null);

    test('the recorded channel wins over the tenant mode', () => {
        expect(orderIsPayFirst({ paymentChannel: 'payFirst' }, eitherOps)).toBe(true);
        expect(orderIsPayFirst({ paymentChannel: 'payFirst' }, noProfileOps)).toBe(true);
        expect(orderIsPayFirst({ paymentChannel: 'payFirst' }, null)).toBe(true);
        expect(orderIsPayFirst({ paymentChannel: 'payAfter' }, payFirstOps)).toBe(false);
        expect(orderIsPayFirst({ paymentChannel: 'payAfter' }, eitherOps)).toBe(false);
    });

    test('no channel recorded → the tenant mode decides (orders before the field keep today\'s behaviour)', () => {
        expect(payFirstOps.payment.dineIn).toBe('payFirst');
        expect(orderIsPayFirst({}, payFirstOps)).toBe(true);
        expect(orderIsPayFirst({ paymentChannel: undefined }, payFirstOps)).toBe(true);
        expect(eitherOps.payment.dineIn).toBe('either');
        expect(orderIsPayFirst({}, eitherOps)).toBe(false);
    });

    test('no profile and no channel → false; a missing order → false', () => {
        expect(noProfileOps.payment.dineIn).toBe('payAfter');
        expect(orderIsPayFirst({}, noProfileOps)).toBe(false);
        expect(orderIsPayFirst({}, null)).toBe(false);
        expect(orderIsPayFirst({}, undefined)).toBe(false);
        expect(orderIsPayFirst(null, payFirstOps)).toBe(false);
    });

    test('payFirstOrderMatch mirrors the helper as a Mongo match', () => {
        // payFirst tenant: recorded pay-first OR nothing recorded
        expect(payFirstOrderMatch(payFirstOps)).toEqual({ paymentChannel: { $ne: 'payAfter' } });
        // either / payAfter / no profile: only a recorded pay-first round
        expect(payFirstOrderMatch(eitherOps)).toEqual({ paymentChannel: 'payFirst' });
        expect(payFirstOrderMatch(noProfileOps)).toEqual({ paymentChannel: 'payFirst' });
        expect(payFirstOrderMatch(null)).toEqual({ paymentChannel: 'payFirst' });
    });
});
