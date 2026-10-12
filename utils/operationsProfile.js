/**
 * operationsProfile — the single source of truth for "HOW does this
 * tenant operate?" (OPERATIONS_CONTROL_PANEL_DESIGN.md).
 *
 * featureAccess answers "MAY this tenant use module X" (plan, add-ons,
 * overrides). This file answers how the tenant runs day to day: which
 * operating modules it actually uses, who serves, when the customer pays.
 *
 * The Super Admin ticks operating MODULES (QR ordering, waiter, captain,
 * chef, customer payment) and answers a few questions (payment timing,
 * counter cash, table numbers). Every detailed flow flag is DERIVED from
 * those, then optional `advanced` fine-tune values win over the derived
 * ones, then plan access is intersected so the profile can only ever
 * switch things OFF — never grant a module the plan does not give.
 *
 * Stored shape (restaurant.operations, Super Admin owned):
 *   {
 *     version: 1,
 *     preset: 'fullService' | 'hotelPayFirstSelfOrder' | 'cafeCounterPayFirst' | 'kioskOnly' | 'custom',
 *     modules: { qrOrdering, waiter, captain, chef, customerPayment },
 *     answers: { dineInPayment, counterCash, useTables },   // null = derive
 *     advanced: { 'orderFlow.servedStep': false, ... },     // dot-path fine-tune
 *     updatedAt, updatedBy,
 *   }
 *
 * A restaurant with no `operations` (every tenant before this feature)
 * resolves to DEFAULT_PROFILE, which reproduces today's behaviour exactly.
 */

const { hasFeature } = require('./featureAccess');

const PROFILE_VERSION = 1;

const MODULE_KEYS = ['qrOrdering', 'waiter', 'captain', 'chef', 'customerPayment'];
const PAYMENT_MODES = ['payFirst', 'payAfter', 'either'];
const CHANNELS = ['dineIn', 'takeaway', 'kiosk', 'delivery'];
const SERVICE_MODELS = ['tableService', 'counterService', 'roomService'];
const PRESET_KEYS = ['fullService', 'hotelPayFirstSelfOrder', 'cafeCounterPayFirst', 'kioskOnly', 'custom'];

const HOLD_EXPIRY_MIN = 5;
const HOLD_EXPIRY_MAX = 240;
const HOLD_EXPIRY_DEFAULT = 20;

// Plan feature each operating module needs. A module the plan does not
// include can be ticked in the profile, but resolves OFF.
const MODULE_PLAN_FEATURE = {
    qrOrdering: 'dineIn',
    waiter: 'waiterDashboard',
    captain: 'waiterDashboard',
    chef: 'kitchenDisplay',
    customerPayment: 'paymentGateway',
};

// Every detailed flag the fine-tune form may set, with its value type.
// Anything else in `advanced` is rejected.
const ADVANCED_PATHS = {
    'serviceModel': SERVICE_MODELS,
    'orderFlow.customerSelfOrder': 'boolean',
    'orderFlow.staffOrder': 'boolean',
    'orderFlow.kitchenDisplay': 'boolean',
    'orderFlow.servedStep': 'boolean',
    'orderFlow.customerTracking': 'boolean',
    'payment.takeaway': PAYMENT_MODES,
    'payment.kiosk': PAYMENT_MODES,
    'payment.delivery': PAYMENT_MODES,
    'payment.holdUntilPaid': 'boolean',
    'payment.holdExpiryMinutes': 'number',
    'customerApp.callWaiter': 'boolean',
    'customerApp.requestBill': 'boolean',
    'customerApp.appendToOrder': 'boolean',
    'customerApp.tips': 'boolean',
    'tables.assignWaiters': 'boolean',
    'tables.mergeTables': 'boolean',
};

const ALL_MODULES_ON = Object.freeze({
    qrOrdering: true, waiter: true, captain: true, chef: true, customerPayment: true,
});

const EMPTY_ANSWERS = Object.freeze({ dineInPayment: null, counterCash: null, useTables: null });

/** Today's behaviour: every module in use, nothing answered, nothing fine-tuned. */
const DEFAULT_PROFILE = Object.freeze({
    version: PROFILE_VERSION,
    preset: 'fullService',
    modules: ALL_MODULES_ON,
    answers: EMPTY_ANSWERS,
    advanced: Object.freeze({}),
});

const PRESETS = Object.freeze({
    fullService: {
        label: 'Full-service restaurant',
        description: 'Waiters take orders and serve, the chef uses the kitchen screen, customers pay after the meal. Same as today.',
        modules: { ...ALL_MODULES_ON },
        answers: { ...EMPTY_ANSWERS },
    },
    hotelPayFirstSelfOrder: {
        label: 'Hotel / self-service, pay first',
        description: 'Customers scan, order and pay on their phone. KOT prints at the counter; customers collect when their number is called. No waiter, captain or kitchen screen.',
        modules: { qrOrdering: true, waiter: false, captain: false, chef: false, customerPayment: true },
        answers: { dineInPayment: 'payFirst', counterCash: true, useTables: true },
    },
    cafeCounterPayFirst: {
        label: 'Café / QSR counter, pay first',
        description: 'Customers order and pay first, the kitchen uses the kitchen screen, customers track the order and collect it.',
        modules: { qrOrdering: true, waiter: false, captain: false, chef: true, customerPayment: true },
        answers: { dineInPayment: 'payFirst', counterCash: true, useTables: true },
    },
    kioskOnly: {
        label: 'Kiosk only',
        description: 'Orders come from the self-order kiosk (and the counter). No QR table ordering, no waiters.',
        modules: { qrOrdering: false, waiter: false, captain: false, chef: true, customerPayment: true },
        answers: { dineInPayment: 'payFirst', counterCash: false, useTables: false },
    },
});

// ─── small helpers ───────────────────────────────────────────────────────

class OperationsProfileError extends Error {
    constructor(errors) {
        super(errors.join('; '));
        this.name = 'OperationsProfileError';
        this.errors = errors;
    }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
    return path.split('.').reduce((cur, p) => (cur == null ? undefined : cur[p]), obj);
}

function clampExpiry(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return HOLD_EXPIRY_DEFAULT;
    return Math.min(HOLD_EXPIRY_MAX, Math.max(HOLD_EXPIRY_MIN, v));
}

// ─── normalise / validate the STORED profile ────────────────────────────

/**
 * Fill defaults and check types. Throws OperationsProfileError listing
 * every problem. Accepts partial input; unknown keys are rejected so a
 * typo in the Super Admin form cannot silently do nothing.
 */
function normaliseProfile(input) {
    if (input == null) return clone(DEFAULT_PROFILE);
    if (!isPlainObject(input)) throw new OperationsProfileError(['operations must be an object']);

    const errors = [];
    const allowedTop = new Set(['version', 'preset', 'modules', 'answers', 'advanced', 'updatedAt', 'updatedBy']);
    for (const k of Object.keys(input)) {
        if (!allowedTop.has(k)) errors.push(`unknown field "${k}"`);
    }

    const preset = input.preset == null ? 'custom' : input.preset;
    if (!PRESET_KEYS.includes(preset)) errors.push(`preset must be one of ${PRESET_KEYS.join(', ')}`);

    const modules = { ...ALL_MODULES_ON };
    if (input.modules != null) {
        if (!isPlainObject(input.modules)) errors.push('modules must be an object');
        else {
            for (const [k, v] of Object.entries(input.modules)) {
                if (!MODULE_KEYS.includes(k)) errors.push(`unknown module "${k}"`);
                else if (typeof v !== 'boolean') errors.push(`modules.${k} must be true or false`);
                else modules[k] = v;
            }
        }
    }

    const answers = { ...EMPTY_ANSWERS };
    if (input.answers != null) {
        if (!isPlainObject(input.answers)) errors.push('answers must be an object');
        else {
            for (const [k, v] of Object.entries(input.answers)) {
                if (!(k in EMPTY_ANSWERS)) { errors.push(`unknown answer "${k}"`); continue; }
                if (v == null) continue;
                if (k === 'dineInPayment' && !PAYMENT_MODES.includes(v)) {
                    errors.push(`answers.dineInPayment must be one of ${PAYMENT_MODES.join(', ')}`);
                } else if (k !== 'dineInPayment' && typeof v !== 'boolean') {
                    errors.push(`answers.${k} must be true or false`);
                } else answers[k] = v;
            }
        }
    }

    const advanced = {};
    if (input.advanced != null) {
        if (!isPlainObject(input.advanced)) errors.push('advanced must be an object');
        else {
            for (const [path, v] of Object.entries(input.advanced)) {
                const type = ADVANCED_PATHS[path];
                if (!type) { errors.push(`unknown advanced setting "${path}"`); continue; }
                if (Array.isArray(type)) {
                    if (!type.includes(v)) errors.push(`${path} must be one of ${type.join(', ')}`);
                    else advanced[path] = v;
                } else if (type === 'number') {
                    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${path} must be a number`);
                    else advanced[path] = clampExpiry(v);
                } else if (typeof v !== 'boolean') {
                    errors.push(`${path} must be true or false`);
                } else advanced[path] = v;
            }
        }
    }

    if (errors.length) throw new OperationsProfileError(errors);

    const out = { version: PROFILE_VERSION, preset, modules, answers, advanced };
    if (input.updatedAt) out.updatedAt = input.updatedAt;
    if (input.updatedBy) out.updatedBy = input.updatedBy;
    return out;
}

// ─── derive the detailed flow from modules + answers ────────────────────

/**
 * Pure: stored (normalised) profile → full detailed flow, BEFORE plan
 * intersection. The rules here are §0.3 of the design doc.
 */
function deriveFlow(profile) {
    const m = profile.modules;
    const a = profile.answers;
    const floorStaff = m.waiter || m.captain;

    // Customer payment on + nobody at the table → customers pay first.
    // Customer payment off + self-service → pay first at the counter.
    // Anyone serving at the table → pay after the meal (today).
    const derivedDineIn = floorStaff ? 'payAfter' : 'payFirst';
    const dineIn = a.dineInPayment || derivedDineIn;

    // Counter cash is the only way to pay when customers can't pay on
    // their phone; otherwise it is off unless the owner allows it.
    const counterCash = a.counterCash == null ? !m.customerPayment : a.counterCash;

    const flow = {
        serviceModel: floorStaff ? 'tableService' : 'counterService',
        roles: { waiter: m.waiter, captain: m.captain, chef: m.chef },
        orderFlow: {
            customerSelfOrder: m.qrOrdering,
            staffOrder: true,                 // admin / counter can always enter orders
            kitchenDisplay: m.chef,
            servedStep: floorStaff,           // nobody serves → "done" completes the order
            customerTracking: m.chef,         // tracking = the chef's Preparing / Ready presses
        },
        payment: {
            dineIn,
            takeaway: 'payFirst',
            kiosk: 'payFirst',
            delivery: 'payFirst',
            methods: {
                online: m.customerPayment,
                wallet: m.customerPayment,
                counterCash,
            },
            holdUntilPaid: dineIn === 'payFirst',
            holdExpiryMinutes: HOLD_EXPIRY_DEFAULT,
        },
        customerApp: {
            callWaiter: floorStaff,
            requestBill: floorStaff && dineIn !== 'payFirst',
            appendToOrder: true,
            tips: floorStaff,
        },
        tables: {
            useTables: a.useTables == null ? true : a.useTables,
            assignWaiters: floorStaff,
            mergeTables: true,
        },
    };

    for (const [path, value] of Object.entries(profile.advanced || {})) {
        setPath(flow, path, path === 'payment.holdExpiryMinutes' ? clampExpiry(value) : value);
    }
    return flow;
}

/**
 * Problems with a profile that would leave the restaurant unable to work.
 * Errors block saving; warnings are shown to the Super Admin.
 */
function validateProfile(profile) {
    const errors = [];
    const warnings = [];
    const flow = deriveFlow(profile);
    const floorStaff = flow.roles.waiter || flow.roles.captain;

    for (const ch of CHANNELS) {
        if (flow.payment[ch] !== 'payAfter') {
            const methods = flow.payment.methods;
            if (!methods.online && !methods.wallet && !methods.counterCash) {
                errors.push(`${ch} is set to pay first, but no way to pay first is allowed (turn on customer payment or cash at the counter)`);
                break;
            }
        }
    }
    if (flow.payment.dineIn === 'payFirst' && !flow.payment.holdUntilPaid
        && (flow.payment.methods.counterCash || flow.payment.methods.wallet)) {
        errors.push('pay first with cash at the counter or wallet needs "hold unpaid orders from the kitchen" on — otherwise unpaid orders reach the kitchen');
    }
    if (flow.orderFlow.servedStep && !floorStaff) {
        errors.push('the "served" step is on but there is no waiter or captain to mark orders served');
    }
    if (flow.customerApp.callWaiter && !floorStaff) {
        warnings.push('"Call waiter" is on but there is no waiter or captain to answer it');
    }
    if (flow.customerApp.tips && !floorStaff) {
        warnings.push('tips are on but there is no waiter or captain to receive them — tips will be turned off');
    }
    if (flow.payment.dineIn === 'payFirst' && !flow.payment.methods.counterCash) {
        warnings.push('dine-in is pay first with online payment only — customers cannot order if online payment fails');
    }
    if (flow.customerApp.requestBill && flow.payment.dineIn === 'payFirst') {
        warnings.push('"Ask for bill" has no meaning when customers pay before ordering');
    }
    return { errors, warnings };
}

// ─── resolve: stored profile × plan access ──────────────────────────────

/**
 * Fully-resolved operations view for a restaurant document (plain object
 * or Mongoose doc). The profile can only switch things OFF: every access
 * flag is ANDed with the plan (featureAccess.hasFeature).
 *
 * Behavioural steps (servedStep, payment timing, tracking, served/pay
 * rules) come from the stored profile only, NOT from the plan — a tenant
 * whose plan lacks the waiter app today must keep today's flow.
 *
 * `branchId` is accepted for the later per-branch overrides (design §2.1);
 * it does nothing yet.
 */
// eslint-disable-next-line no-unused-vars
function resolveOperations(restaurant, { branchId = null } = {}) {
    let profile;
    try {
        profile = normaliseProfile(restaurant?.operations);
    } catch {
        // A corrupt stored profile must never break login or ordering —
        // fall back to today's behaviour.
        profile = clone(DEFAULT_PROFILE);
    }
    const flow = deriveFlow(profile);

    const can = (key) => (restaurant ? hasFeature(restaurant, key) : true);
    const planBlocks = [];

    for (const mod of MODULE_KEYS) {
        if (profile.modules[mod] && !can(MODULE_PLAN_FEATURE[mod])) {
            planBlocks.push({ module: mod, feature: MODULE_PLAN_FEATURE[mod] });
        }
    }

    const resolved = clone(flow);
    resolved.roles.waiter = flow.roles.waiter && can('waiterDashboard');
    resolved.roles.captain = flow.roles.captain && can('waiterDashboard');
    resolved.roles.chef = flow.roles.chef && can('kitchenDisplay');
    resolved.orderFlow.kitchenDisplay = flow.orderFlow.kitchenDisplay && can('kitchenDisplay');
    resolved.payment.methods.online = flow.payment.methods.online && can('paymentGateway');
    resolved.payment.methods.wallet = flow.payment.methods.wallet && can('walletLoyalty');
    // Tips are behavioural (no waiter → no tips), NOT plan-gated here:
    // tenants whose plan lacks tipManagement accepted tips before this
    // feature and must keep doing so (tip settlement has its own gate).
    resolved.channels = {
        dineIn: can('dineIn'),
        takeaway: can('takeaway'),
        kiosk: can('kiosk'),
    };

    // Pay-first dine-in that has lost every payment method (e.g. plan
    // downgraded) falls back to pay-after rather than blocking ordering.
    // Takeaway / kiosk / delivery keep today's behaviour untouched.
    const m = resolved.payment.methods;
    if (!m.online && !m.wallet && !m.counterCash && resolved.payment.dineIn !== 'payAfter') {
        resolved.payment.dineIn = 'payAfter';
        resolved.payment.holdUntilPaid = false;
        resolved.customerApp.requestBill = flow.roles.waiter || flow.roles.captain;
    }

    return {
        version: profile.version,
        preset: profile.preset,
        modules: { ...profile.modules },
        ...resolved,
        planBlocks,
    };
}

/**
 * Customer-safe subset for the menu bootstrap and QR-scan payloads.
 * No roles, no plan details — only what the customer app needs to pick
 * its flow.
 */
function publicOperationsOf(restaurant, opts = {}) {
    const r = resolveOperations(restaurant, opts);
    return {
        serviceModel: r.serviceModel,
        orderFlow: {
            customerSelfOrder: r.orderFlow.customerSelfOrder,
            customerTracking: r.orderFlow.customerTracking,
        },
        payment: {
            dineIn: r.payment.dineIn,
            takeaway: r.payment.takeaway,
            kiosk: r.payment.kiosk,
            delivery: r.payment.delivery,
            methods: { ...r.payment.methods },
        },
        customerApp: { ...r.customerApp },
        tables: { useTables: r.tables.useTables },
    };
}

const ROLE_LABELS = { waiter: 'Waiter app', captain: 'Captain app', chef: 'Kitchen screen (chef app)' };
const PAY_LABELS = { payFirst: 'pay first', payAfter: 'pay after the meal', either: 'customer chooses' };
const CUSTOMER_APP_LABELS = {
    callWaiter: '"Call waiter" button',
    requestBill: '"Ask for bill" button',
    appendToOrder: '"Add more items"',
    tips: 'Tips',
};

/**
 * Plain-language list of what changes between two RESOLVED views — shown
 * to the Super Admin before saving and kept in the audit entry.
 * Returns [{ area, severity: 'info' | 'warning', message }].
 */
function diffImpact(before, after) {
    const out = [];
    const push = (area, message, severity = 'info') => out.push({ area, severity, message });
    const onOff = (v) => (v ? 'switched on' : 'switched off');

    for (const role of ['waiter', 'captain', 'chef']) {
        if (before.roles[role] !== after.roles[role]) {
            push('roles', `${ROLE_LABELS[role]} ${onOff(after.roles[role])}.`, after.roles[role] ? 'info' : 'warning');
        }
    }
    if (before.orderFlow.customerSelfOrder !== after.orderFlow.customerSelfOrder) {
        push('orderFlow', after.orderFlow.customerSelfOrder
            ? 'Customers can order from the table QR.'
            : 'Customers can no longer order from the QR (menu only); staff enter orders.', after.orderFlow.customerSelfOrder ? 'info' : 'warning');
    }
    if (before.orderFlow.customerTracking !== after.orderFlow.customerTracking) {
        push('orderFlow', after.orderFlow.customerTracking
            ? 'Customers can track their order live.'
            : 'No live order tracking — customers see "Order confirmed, collect when your number is called".');
    }
    if (before.orderFlow.servedStep !== after.orderFlow.servedStep) {
        push('orderFlow', after.orderFlow.servedStep
            ? 'Waiters mark orders "served".'
            : 'Nobody marks "served" — an order is complete when the kitchen finishes (or, with no kitchen screen, once it is paid and the KOT is sent).');
    }
    for (const ch of CHANNELS) {
        if (before.payment[ch] !== after.payment[ch]) {
            const name = ch === 'dineIn' ? 'Dine-in' : ch[0].toUpperCase() + ch.slice(1);
            push('payment', `${name}: ${PAY_LABELS[before.payment[ch]]} → ${PAY_LABELS[after.payment[ch]]}.`, 'warning');
        }
    }
    if (after.payment.dineIn === 'payFirst' && before.payment.dineIn !== 'payFirst') {
        push('payment', 'The kitchen sees a dine-in order only after it is paid.');
    }
    for (const method of ['online', 'wallet', 'counterCash']) {
        if (before.payment.methods[method] !== after.payment.methods[method]) {
            const label = method === 'counterCash' ? 'Cash at the counter' : method === 'online' ? 'Online payment' : 'Wallet payment';
            push('payment', `${label} ${onOff(after.payment.methods[method])}.`);
        }
    }
    for (const key of Object.keys(CUSTOMER_APP_LABELS)) {
        if (before.customerApp[key] !== after.customerApp[key]) {
            push('customerApp', `${CUSTOMER_APP_LABELS[key]} ${onOff(after.customerApp[key])}.`);
        }
    }
    if (before.tables.useTables !== after.tables.useTables) {
        push('tables', after.tables.useTables ? 'Table numbers in use.' : 'No table numbers — token numbers instead.');
    }
    if (before.serviceModel !== after.serviceModel) {
        push('service', after.serviceModel === 'counterService'
            ? 'Customers collect their food at the counter.'
            : after.serviceModel === 'roomService' ? 'Food is delivered to rooms.' : 'Food is served at the table.');
    }
    return out;
}

/**
 * The tenant's operations profile WITHOUT plan intersection — "does this
 * restaurant run this way?". Use it for rules that must not change for
 * tenants that never set a profile (e.g. creating a waiter account on a
 * plan without the waiter app stays allowed, as today).
 */
function profileFlow(restaurant) {
    let profile;
    try {
        profile = normaliseProfile(restaurant?.operations);
    } catch {
        profile = clone(DEFAULT_PROFILE);
    }
    return deriveFlow(profile);
}

/** Profile for a preset key (stored shape), ready to normalise / save. */
function profileFromPreset(key) {
    const p = PRESETS[key];
    if (!p) throw new OperationsProfileError([`unknown preset "${key}"`]);
    return normaliseProfile({ preset: key, modules: { ...p.modules }, answers: { ...p.answers } });
}

function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

module.exports = {
    PROFILE_VERSION,
    MODULE_KEYS,
    MODULE_PLAN_FEATURE,
    PAYMENT_MODES,
    CHANNELS,
    SERVICE_MODELS,
    PRESET_KEYS,
    PRESETS,
    ADVANCED_PATHS,
    DEFAULT_PROFILE,
    HOLD_EXPIRY_DEFAULT,
    OperationsProfileError,
    normaliseProfile,
    deriveFlow,
    validateProfile,
    resolveOperations,
    publicOperationsOf,
    profileFromPreset,
    profileFlow,
    diffImpact,
    getPath,
};
