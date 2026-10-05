/**
 * utils/billing.js — frontend/backend parity and edge cases.
 *
 * utils/billing.js documents itself as "the exact mirror of
 * Frontend/src/utils/billing.js — the two must change together". If they
 * drift, the cart shows one total and createOrder enforces another
 * (TOTAL_MISMATCH), or a customer is shown a bill the server never charged.
 * billing.test.js covers the backend rules; this file adds:
 *
 *   - parity: the REAL frontend source (ESM, loaded through node:vm) is run
 *     against the backend over 300 generated bills plus every order-type
 *     spelling and tax-config shape — any future drift fails here
 *   - rounding of each component, sub-paisa subtotals, stacking of
 *     discounts against taxes, negative inputs, zero-value charges,
 *     order-type spellings, toTaxConfig flag handling
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const backend = require('../utils/billing');

// ── Load the frontend module (ESM) without a bundler ─────────────────
const FRONTEND_UTILS = path.join(__dirname, '..', '..', 'Frontend', 'src', 'utils');

function loadFrontendBilling() {
    const pricingSrc = fs.readFileSync(path.join(FRONTEND_UTILS, 'pricing.js'), 'utf8');
    const round2Src = pricingSrc.match(/export function round2\([\s\S]*?\n}/);
    if (!round2Src) throw new Error('round2 not found in Frontend/src/utils/pricing.js');

    const billingSrc = fs.readFileSync(path.join(FRONTEND_UTILS, 'billing.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^export \{[^}]*\};?$/gm, '')
        .replace(/^export (function|const|let|class) /gm, '$1 ');

    const source = `${round2Src[0].replace(/^export /, '')}\n${billingSrc}\n`
        + 'module.exports = { round2, computeBill, toTaxConfig, normaliseOrderType, SERVICE_CHARGE_TYPES, computeSubtotal };';
    const sandbox = { module: { exports: {} }, Number, Math, String, Array, Set, Date, isFinite };
    vm.runInNewContext(source, sandbox, { filename: 'Frontend/src/utils/billing.js' });
    return sandbox.module.exports;
}

const frontend = loadFrontendBilling();

// Deterministic PRNG so the generated cases are reproducible.
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

/** The fields createOrder stores / enforces and the UI renders. */
const moneyView = (b) => ({
    subtotal: b.subtotal,
    gst: b.gst,
    gstPct: b.gstPct,
    serviceCharge: b.serviceCharge,
    serviceChargePct: b.serviceChargePct,
    serviceChargeApplies: b.serviceChargeApplies,
    additionalCharges: b.additionalCharges.map((c) => ({ name: c.name, type: c.type, value: c.value, amount: c.amount })),
    additionalChargesTotal: b.additionalChargesTotal,
    total: b.total,
});

// ── Parity ───────────────────────────────────────────────────────────

describe('frontend billing mirrors the backend', () => {
    const ORDER_TYPES = ['dine-in', 'Dine In', 'DINE_IN', 'dinein', 'takeaway', 'Take Away', 'pickup', 'delivery',
        'Home Delivery', 'kiosk', 'KIOSK', '', undefined, 'catering'];

    test.each(ORDER_TYPES.map((t) => [t]))('normaliseOrderType(%p) agrees', (t) => {
        expect(frontend.normaliseOrderType(t)).toBe(backend.normaliseOrderType(t));
    });

    test.each([
        [null],
        [{}],
        [{ gst: { enabled: true, value: '18' }, serviceCharge: { enabled: false, value: 10 } }],
        [{ gst: { value: 5 }, serviceCharge: { enabled: true, value: 12.5 }, additionalCharges: [
            { name: 'A', type: 'Flat', value: 20 },
            { name: 'B', type: 'Percentage', value: 2, enabled: false },
            { name: 'C', type: 'Percentage', value: 1.5, enabled: true },
        ] }],
    ])('toTaxConfig(%p) agrees', (taxes) => {
        expect(frontend.toTaxConfig(taxes)).toEqual(backend.toTaxConfig(taxes));
    });

    test('the service-charge policy set is identical', () => {
        expect([...frontend.SERVICE_CHARGE_TYPES]).toEqual([...backend.SERVICE_CHARGE_TYPES]);
    });

    const rand = prng(424242);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const money = (max) => Math.round(rand() * max * 100) / 100;
    const cases = Array.from({ length: 300 }, (_, i) => {
        const input = {
            subtotal: pick([0, 0.01, 0.005, 99.99, 333.33, money(5000), money(200), -50]),
            taxConfig: {
                gstPct: pick([0, 5, 12, 18, 28, 2.5]),
                servicePct: pick([0, 5, 7.5, 10, 12.5]),
                additionalCharges: pick([
                    [],
                    [{ name: 'Packaging', type: 'Flat', value: pick([0, 10, 20, 25.555]) }],
                    [{ name: 'Green Tax', type: 'Percentage', value: pick([0, 1, 2, 2.75]) }],
                    [{ name: 'Packaging', type: 'Flat', value: 20 }, { name: 'Green Tax', type: 'Percentage', value: 2 }],
                ]),
            },
            orderType: pick(ORDER_TYPES),
            couponDiscount: pick([0, 0, money(300), 10000]),
            pointsRedeemed: pick([0, money(50)]),
            tipAmount: pick([0, money(100), 'abc']),
            deliveryFee: pick([0, money(80)]),
        };
        return [i, input];
    });

    test.each(cases)('generated bill %i agrees to the paisa', (_i, input) => {
        expect(moneyView(frontend.computeBill(input))).toEqual(moneyView(backend.computeBill(input)));
    });
});

// ── Backend edge cases ───────────────────────────────────────────────

describe('computeBill edge cases', () => {
    const CFG = { gstPct: 18, servicePct: 12.5, additionalCharges: [{ name: 'Green Tax', type: 'Percentage', value: 2 }] };

    test('each component is rounded on its own before summing', () => {
        const b = backend.computeBill({ subtotal: 333.33, taxConfig: CFG, orderType: 'dine-in' });

        expect(b).toMatchObject({ gst: 60, serviceCharge: 41.67, additionalChargesTotal: 6.67 });
        // 59.9994 → 60, 41.66625 → 41.67, 6.6666 → 6.67
        expect(b.total).toBe(441.67);
    });

    test('a sub-paisa subtotal is rounded before any tax is levied', () => {
        const b = backend.computeBill({ subtotal: 0.004, taxConfig: { gstPct: 18, additionalCharges: [{ name: 'P', type: 'Flat', value: 20 }] } });
        expect(b).toMatchObject({ subtotal: 0, gst: 0, additionalCharges: [], total: 0 });
    });

    test.each([
        // GST is on (subtotal − coupon), floored at 0; green tax stays on the gross 400.
        ['larger than the taxes', 150, 313],     // 400 + 18% of 250 = 45 + 0 + 8 = 453 − 150 + 10
        ['exactly cancelling the bill', 418, 0], // coupon ≥ subtotal → GST 0: 400 + 0 + 8 − 418 + 10 = 0
        ['larger than the whole bill', 10000, 0],
    ])('a coupon %s', (_label, coupon, total) => {
        const b = backend.computeBill({
            subtotal: 400, taxConfig: { gstPct: 18, servicePct: 10, additionalCharges: [{ name: 'Green Tax', type: 'Percentage', value: 2 }] },
            orderType: 'takeaway', couponDiscount: coupon, tipAmount: 10,
        });
        expect(b.total).toBe(total);
    });

    test('a negative subtotal never produces a negative bill or flat charges', () => {
        const b = backend.computeBill({ subtotal: -100, taxConfig: { gstPct: 5, additionalCharges: [{ name: 'P', type: 'Flat', value: 20 }] } });
        expect(b.additionalCharges).toEqual([]);
        expect(b.total).toBe(0);
    });

    test.each([
        ['a 0% percentage charge', { name: 'Zero', type: 'Percentage', value: 0 }],
        ['a ₹0 flat charge', { name: 'Free bag', type: 'Flat', value: 0 }],
        ['a percentage charge that rounds to nothing', { name: 'Tiny', type: 'Percentage', value: 0.001 }],
    ])('%s is dropped instead of rendering a ₹0 row', (_label, charge) => {
        const b = backend.computeBill({ subtotal: 100, taxConfig: { additionalCharges: [charge] } });
        expect(b.additionalCharges).toEqual([]);
        expect(b.additionalChargesTotal).toBe(0);
    });

    test.each([
        ['Dine In', true],
        ['DINE_IN', true],
        ['DineIn', true],
        ['PickUp', false],
        ['Home Delivery', false],
        ['KIOSK', false],
        ['catering', false],
    ])('order type %p attracts service charge: %p', (type, applies) => {
        const b = backend.computeBill({ subtotal: 100, taxConfig: { servicePct: 10 }, orderType: type });
        expect(b.serviceChargeApplies).toBe(applies);
        expect(b.serviceCharge).toBe(applies ? 10 : 0);
    });

    test('an unknown order type passes through normalised rather than defaulting to dine-in', () => {
        expect(backend.normaliseOrderType('Catering Order')).toBe('catering-order');
    });
});

describe('toTaxConfig flag handling', () => {
    test('a charge without an enabled flag is kept; an explicit false drops it', () => {
        const cfg = backend.toTaxConfig({ additionalCharges: [
            { name: 'Kept', type: 'Flat', value: 5 },
            { name: 'Dropped', type: 'Flat', value: 5, enabled: false },
        ] });
        expect(cfg.additionalCharges.map((c) => c.name)).toEqual(['Kept']);
    });

    test('GST or service charge without enabled:true reads as 0%', () => {
        expect(backend.toTaxConfig({ gst: { value: 18 }, serviceCharge: { value: 10 } })).toMatchObject({ gstPct: 0, servicePct: 0 });
    });

    test('numeric strings are accepted and junk reads as 0%', () => {
        expect(backend.toTaxConfig({ gst: { enabled: true, value: '12' }, serviceCharge: { enabled: true, value: 'ten' } }))
            .toMatchObject({ gstPct: 12, servicePct: 0 });
    });
});
