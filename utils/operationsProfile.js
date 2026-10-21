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
 *     answers: { dineInPayment, counterCash, useTables, kotPrinter },   // null = derive
 *     advanced: { 'orderFlow.servedStep': false, ... },     // dot-path fine-tune
 *     updatedAt, updatedBy,
 *   }
 *
 * A restaurant with no `operations` (every tenant before this feature)
 * resolves to DEFAULT_PROFILE, which reproduces today's behaviour exactly.
 *
 * Per-branch overrides (design §12.1): restaurant.operationsByBranch is
 * [{ branch, overrides, updatedAt }] where `overrides` is a PARTIAL stored
 * profile (any of preset / modules / answers / advanced). resolveOperations
 * (restaurant, { branchId }) deep-merges the branch's overrides over the
 * tenant profile BEFORE normalise / validate / plan intersection. No
 * branchId, or no entry for that branch → the tenant profile, byte for
 * byte what the tenant-only resolver returned.
 *
 *   resolveOperations(restaurant, { branchId })       full resolved view
 *   publicOperationsOf(restaurant, { branchId })      customer-safe subset
 *   profileFlow(restaurant, { branchId })             flow without plan intersection
 *   resolveOperationsForRequest(req)                  = resolveOperations(req.restaurant, { branchId: requestBranchId(req) })
 *   requestBranchId(req)                              pinned / X-Branch-Id branch → ?branch → req.mainBranchId → null
 *
 * `branchId` may also be passed bare (string / ObjectId) instead of { branchId }.
 * The restaurant document must be loaded WITH `operationsByBranch` (every
 * select that lists `operations` should list it too) for overrides to apply.
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
    'tables.useTables': 'boolean',
    'tables.assignWaiters': 'boolean',
    'tables.mergeTables': 'boolean',
};

const ALL_MODULES_ON = Object.freeze({
    qrOrdering: true, waiter: true, captain: true, chef: true, customerPayment: true,
});

// Where KOTs / bills print (design §0.4 question 3). INFORMATIONAL for
// onboarding only: printers are configured in Settings → Printers and
// nothing in the print path reads this yet. null = derive from modules.
const KOT_PRINTER_OPTIONS = ['kitchen', 'counter', 'none'];

const EMPTY_ANSWERS = Object.freeze({ dineInPayment: null, counterCash: null, useTables: null, kotPrinter: null });

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
 *
 * `opts.warnings` (array) collects non-blocking adjustments made while
 * normalising so the save / preview response can show them (none are
 * made today; the hook stays for callers).
 */
// eslint-disable-next-line no-unused-vars
function normaliseProfile(input, { warnings } = {}) {
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
                if (k === 'dineInPayment') {
                    if (!PAYMENT_MODES.includes(v)) errors.push(`answers.dineInPayment must be one of ${PAYMENT_MODES.join(', ')}`);
                    else answers[k] = v;
                } else if (k === 'kotPrinter') {
                    if (!KOT_PRINTER_OPTIONS.includes(v)) errors.push(`answers.kotPrinter must be one of ${KOT_PRINTER_OPTIONS.join(', ')}`);
                    else answers[k] = v;
                } else if (typeof v !== 'boolean') {
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
            // useTables:false = token-number mode (design §12.2): dine-in
            // orders carry a token instead of a table. Flows through as
            // answered; null = tables on (today).
            useTables: a.useTables == null ? true : a.useTables,
            assignWaiters: floorStaff,
            mergeTables: true,
        },
        // Informational (onboarding): where KOTs / bills print. Nothing in
        // the print path reads this yet (printers: Settings → Printers).
        // Default = today's set-up — a kitchen printer when the kitchen
        // screen / chef module is in use, the counter printer otherwise.
        printing: {
            kotAt: a.kotPrinter || (m.chef ? 'kitchen' : 'counter'),
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
    if (!flow.orderFlow.customerSelfOrder && !flow.orderFlow.staffOrder) {
        errors.push('orderFlow.staffOrder: staff ordering cannot be off while QR ordering is also off — nobody could place an order (turn on QR ordering or leave staff ordering on)');
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

// ─── per-branch overrides (design §12.1) ────────────────────────────────

const OVERRIDE_SECTIONS = { modules: MODULE_KEYS, answers: Object.keys(EMPTY_ANSWERS), advanced: Object.keys(ADVANCED_PATHS) };
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** `{ branchId }`, a bare id / ObjectId / populated branch doc, or nothing → id string or null. */
function branchIdOf(opts) {
    if (opts == null) return null;
    if (typeof opts === 'object' && !(opts instanceof Date)) {
        if ('branchId' in opts) return branchIdOf(opts.branchId);
        if (typeof opts.toHexString === 'function') return opts.toHexString();
        if (opts._id) return branchIdOf(opts._id);
        return null;
    }
    const s = String(opts);
    return s && s !== 'null' && s !== 'undefined' ? s : null;
}

/**
 * Keep only the keys of a branch override that exist in the stored profile
 * shape (preset, modules.<MODULE_KEYS>, answers.<EMPTY_ANSWERS>,
 * advanced.<ADVANCED_PATHS>). Unknown keys and `undefined` values are
 * dropped silently — a branch override is a sparse diff, not a form that
 * needs typo protection; TYPES are still checked when the merged profile
 * goes through normaliseProfile. Returns {} for nothing / not an object.
 */
function normaliseOverrides(partial) {
    if (!isPlainObject(partial)) return {};
    const out = {};
    if (partial.preset !== undefined && partial.preset !== null) out.preset = partial.preset;
    for (const [section, keys] of Object.entries(OVERRIDE_SECTIONS)) {
        if (!isPlainObject(partial[section])) continue;
        const kept = {};
        for (const k of keys) {
            if (partial[section][k] !== undefined) kept[k] = partial[section][k];
        }
        if (Object.keys(kept).length) out[section] = kept;
    }
    return out;
}

/** The stored override entry for a branch ({ branch, overrides, updatedAt }) or null. */
function branchOverrideEntry(restaurant, branchId) {
    const bid = branchIdOf(branchId);
    const list = restaurant?.operationsByBranch;
    if (!bid || !Array.isArray(list) || !list.length) return null;
    const hit = list.find((e) => e && e.branch && String(e.branch._id || e.branch) === bid);
    return hit || null;
}

/**
 * Deep-merge a branch override over a STORED tenant profile — both in the
 * stored shape, result in the stored shape, still un-normalised. Override
 * keys win section by section (modules / answers / advanced are merged
 * key-wise, preset replaced). `null` in an override answer means "back to
 * derive" and wins too. Unknown override keys are dropped
 * (normaliseOverrides).
 */
function mergeProfileOverrides(stored, overrides) {
    const base = isPlainObject(stored) ? stored : {};
    const ov = normaliseOverrides(overrides);
    if (!Object.keys(ov).length) return stored == null ? null : base;
    const out = { ...base };
    if (ov.preset !== undefined) out.preset = ov.preset;
    for (const section of Object.keys(OVERRIDE_SECTIONS)) {
        if (!ov[section]) continue;
        out[section] = { ...(isPlainObject(base[section]) ? base[section] : {}), ...ov[section] };
    }
    return out;
}

/**
 * The stored-shape profile that applies to a branch: the tenant profile
 * with that branch's overrides merged in, or the tenant profile itself
 * when there is no override. Un-normalised.
 */
function storedProfileFor(restaurant, branchId) {
    const entry = branchOverrideEntry(restaurant, branchId);
    const tenant = restaurant?.operations ?? null;
    if (!entry) return tenant;
    return mergeProfileOverrides(tenant, entry.overrides);
}

/**
 * Normalised profile for a branch with the never-break fallbacks: a bad
 * merged profile falls back to the tenant profile, a bad tenant profile
 * to DEFAULT_PROFILE (today's behaviour).
 */
function effectiveProfile(restaurant, branchId) {
    const bid = branchIdOf(branchId);
    if (bid && branchOverrideEntry(restaurant, bid)) {
        try {
            return normaliseProfile(storedProfileFor(restaurant, bid));
        } catch { /* corrupt override → tenant profile */ }
    }
    try {
        return normaliseProfile(restaurant?.operations);
    } catch {
        // A corrupt stored profile must never break login or ordering —
        // fall back to today's behaviour.
        return clone(DEFAULT_PROFILE);
    }
}

/**
 * Fully-resolved operations view for a restaurant document (plain object
 * or Mongoose doc). The profile can only switch things OFF: every access
 * flag is ANDed with the plan (featureAccess.hasFeature).
 *
 * Behavioural steps (servedStep, payment timing, tracking, served/pay
 * rules) come from the stored profile only, NOT from the plan — a tenant
 * whose plan lacks the waiter app today must keep today's flow.
 *
 * `opts` = { branchId } (or a bare branch id): the branch's overrides from
 * restaurant.operationsByBranch are merged over the tenant profile first
 * (design §12.1). No branch / no override → the tenant profile.
 */
function resolveOperations(restaurant, opts = {}) {
    const profile = effectiveProfile(restaurant, branchIdOf(opts));
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

/**
 * Does THIS order follow the pay-first rules (every round pays for
 * itself; a paid round still cooking keeps its table; no aggregated
 * table bill)? Decided from the order first, the tenant second:
 *   - order.paymentChannel 'payFirst' → yes, 'payAfter' → no (recorded at
 *     creation — the only way to tell the two kinds apart on an 'either'
 *     tenant's table);
 *   - no channel recorded (orders before the field, staff / POS orders)
 *     → the tenant's resolved dine-in mode, exactly as before.
 * `ops` is a RESOLVED profile (resolveOperations / loadOps) or null. No
 * profile and no channel → false (today's pay-after behaviour).
 */
function orderIsPayFirst(order, ops) {
    if (!order) return false;
    if (order.paymentChannel === 'payFirst') return true;
    if (order.paymentChannel === 'payAfter') return false;
    return ops?.payment?.dineIn === 'payFirst';
}

/**
 * Mongo match for the orders orderIsPayFirst() would say yes to, for the
 * same resolved `ops`. Spread into an Order query.
 */
function payFirstOrderMatch(ops) {
    return ops?.payment?.dineIn === 'payFirst'
        ? { paymentChannel: { $ne: 'payAfter' } }   // recorded pay-first OR nothing recorded
        : { paymentChannel: 'payFirst' };
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
function profileFlow(restaurant, opts = {}) {
    return deriveFlow(effectiveProfile(restaurant, branchIdOf(opts)));
}

// ─── request helpers (for controllers / services holding a req) ─────────

/**
 * The branch a staff / customer request acts for, as a string id or null:
 *   1. req.branch (tenantContext: the staff member's pinned branch, or a
 *      validated X-Branch-Id header)
 *   2. ?branch=<id> (admin branch switcher; tenantContext already 404s a
 *      foreign / unknown id; keywords like 'all' are skipped)
 *   3. req.mainBranchId (records with branch:null belong to Main)
 *   4. null → tenant profile
 */
function requestBranchId(req) {
    if (!req) return null;
    const pinned = branchIdOf(req.branch);
    if (pinned) return pinned;
    const q = req.query?.branch;
    if (typeof q === 'string' && OBJECT_ID_RE.test(q)) return q;
    return branchIdOf(req.mainBranchId);
}

/** resolveOperations(req.restaurant, { branchId: requestBranchId(req) }). */
function resolveOperationsForRequest(req) {
    return resolveOperations(req?.restaurant || null, { branchId: requestBranchId(req) });
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
    KOT_PRINTER_OPTIONS,
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
    orderIsPayFirst,
    payFirstOrderMatch,
    // per-branch overrides (§12.1)
    normaliseOverrides,
    mergeProfileOverrides,
    branchOverrideEntry,
    storedProfileFor,
    effectiveProfile,
    branchIdOf,
    requestBranchId,
    resolveOperationsForRequest,
};
