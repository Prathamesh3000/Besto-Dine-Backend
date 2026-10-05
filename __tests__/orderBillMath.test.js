/**
 * services/orderBillMath.js — pure bill arithmetic for orders.
 *
 * appendBillRecompute.test.js and repeatOrderBill.test.js cover the main
 * append / repeat scenarios. This file adds:
 *   - lineItemsSubtotal edge cases (quantity fallback, junk prices, floats)
 *   - billOrderType
 *   - the documented invariant of recomputeBillAfterAppend — for an order
 *     whose stored breakdown equals bill(own items), an append equals the
 *     from-scratch bill — checked over 200 generated orders
 *   - tax config changed since the order was placed (rate change, charge
 *     enabled / disabled), empty-before orders, legacy zero breakdowns,
 *     order types without service charge, non-numeric inputs
 *   - billFieldsForNewOrder per order type
 */
const { computeBill } = require('../utils/billing');
const {
    round2, lineItemsSubtotal, billOrderType, recomputeBillAfterAppend, billFieldsForNewOrder,
    recomputeBillForCoupon,
} = require('../services/orderBillMath');

// ── Helpers ──────────────────────────────────────────────────────────

const CFG = {
    gstPct: 5,
    servicePct: 10,
    additionalCharges: [
        { name: 'Packaging', type: 'Flat', value: 20 },
        { name: 'Green Tax', type: 'Percentage', value: 2 },
    ],
};

/** Stored money fields of an order created from `subtotal` with `cfg`. */
function storedBill(subtotal, cfg, type, { coupon = 0, points = 0, tip = 0, delivery = 0 } = {}) {
    const b = computeBill({ subtotal, taxConfig: cfg, orderType: type, couponDiscount: coupon, pointsRedeemed: points, tipAmount: tip, deliveryFee: delivery });
    return {
        total: b.total,
        gst: b.gst,
        serviceCharge: b.serviceCharge,
        additionalCharges: b.additionalCharges.map((c) => ({ ...c })),
        additionalChargesTotal: b.additionalChargesTotal,
        // The order carries its coupon; the append recompute reads it for
        // the GST base (GST is levied on subtotal − coupon).
        couponDiscount: coupon,
    };
}

// Deterministic PRNG so the generated cases are reproducible.
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

// ── lineItemsSubtotal ────────────────────────────────────────────────

describe('lineItemsSubtotal', () => {
    test('sums (price + toppings) × quantity', () => {
        expect(lineItemsSubtotal([
            { price: 200, quantity: 2, selectedToppings: [{ price: 30 }, { price: 15.5 }] },
            { price: 40, quantity: 3 },
        ])).toBe(611);
    });

    test.each([
        [undefined, 1],
        [0, 1],
        [null, 1],
        ['2', 2],
    ])('quantity %p counts as %i', (quantity, mult) => {
        expect(lineItemsSubtotal([{ price: 100, quantity }])).toBe(100 * mult);
    });

    test('junk prices and topping prices count as zero', () => {
        expect(lineItemsSubtotal([{ price: 'abc', quantity: 2, selectedToppings: [{ price: null }, { price: '5' }] }])).toBe(10);
    });

    test.each([[[]], [null], [undefined]])('an empty item list (%p) is zero', (items) => {
        expect(lineItemsSubtotal(items)).toBe(0);
    });

    test('is not rounded — callers must round (0.1 + 0.2)', () => {
        const raw = lineItemsSubtotal([{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }]);
        expect(raw).not.toBe(0.3);
        expect(round2(raw)).toBe(0.3);
    });
});

describe('round2', () => {
    test.each([
        [1.005, 1],      // binary 1.00499… — documented float behaviour
        [512.4, 512.4],
        ['abc', 0],
        [undefined, 0],
        [-3.333, -3.33],
    ])('round2(%p) = %p', (input, out) => {
        expect(round2(input)).toBe(out);
    });
});

describe('billOrderType', () => {
    test.each([
        [{ type: 'takeaway', delivery: { requested: true } }, 'delivery'],
        [{ type: 'dine-in', delivery: { requested: false } }, 'dine-in'],
        [{ type: 'takeaway' }, 'takeaway'],
        [null, undefined],
    ])('%p → %p', (order, type) => {
        expect(billOrderType(order)).toBe(type);
    });
});

// ── recomputeBillAfterAppend — documented invariant ─────────────────

describe('recomputeBillAfterAppend equals a from-scratch bill', () => {
    const rand = prng(20261003);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const money = (max) => Math.round(rand() * max * 100) / 100;

    const cases = Array.from({ length: 200 }, (_, i) => {
        const type = pick(['dine-in', 'takeaway', 'delivery']);
        const cfg = {
            gstPct: pick([0, 5, 12, 18]),
            servicePct: pick([0, 5, 10, 12.5]),
            additionalCharges: pick([
                [],
                [{ name: 'Packaging', type: 'Flat', value: pick([10, 20, 25.5]) }],
                [{ name: 'Green Tax', type: 'Percentage', value: pick([1, 2, 2.5]) }],
                CFG.additionalCharges,
            ]),
        };
        const before = money(2000) + 0.01;
        const added = money(800) + 0.01;
        const extras = {
            coupon: rand() < 0.4 ? money(before / 4) : 0,
            points: rand() < 0.3 ? money(50) : 0,
            tip: rand() < 0.3 ? money(100) : 0,
            delivery: type === 'delivery' ? money(80) : 0,
        };
        return [i, type, cfg, before, round2(before + added), extras];
    });

    test.each(cases)('case %i (%s)', (_i, type, cfg, before, after, extras) => {
        const bill = storedBill(before, cfg, type, extras);

        const next = recomputeBillAfterAppend({ bill, subtotalBefore: before, subtotalAfter: after, taxConfig: cfg, orderType: type });
        const scratch = storedBill(after, cfg, type, extras);

        expect(next.total).toBe(scratch.total);
        expect(next.gst).toBe(scratch.gst);
        expect(next.serviceCharge).toBe(scratch.serviceCharge);
        expect(next.additionalChargesTotal).toBe(scratch.additionalChargesTotal);
        expect(next.additionalCharges.map((c) => [c.name, c.amount])).toEqual(scratch.additionalCharges.map((c) => [c.name, c.amount]));
        expect(next.deltaSubtotal).toBe(round2(after - before));
    });
});

// ── recomputeBillAfterAppend — targeted cases ────────────────────────

describe('recomputeBillAfterAppend', () => {
    test('a flat charge is not charged again; a percentage charge grows with the items', () => {
        const bill = storedBill(300, CFG, 'dine-in');
        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 300, subtotalAfter: 400, taxConfig: CFG, orderType: 'dine-in' });

        expect(next.additionalCharges).toEqual([
            { name: 'Packaging', type: 'Flat', value: 20, amount: 20 },
            { name: 'Green Tax', type: 'Percentage', value: 2, amount: 8 },
        ]);
        // 400 + 20 + 40 + 20 + 8
        expect(next.total).toBe(488);
        expect(next.deltaCharges).toBe(17); // 5 gst + 10 service + 2 green tax
    });

    test('an order that had no items picks up the flat charge on its first append', () => {
        const empty = storedBill(0, CFG, 'takeaway');
        expect(empty).toMatchObject({ total: 0, additionalCharges: [] });

        const next = recomputeBillAfterAppend({ bill: empty, subtotalBefore: 0, subtotalAfter: 100, taxConfig: CFG, orderType: 'takeaway' });

        expect(next.additionalCharges.map((c) => [c.name, c.amount])).toEqual([['Packaging', 20], ['Green Tax', 2]]);
        expect(next.total).toBe(127); // 100 + 5 + 0 service + 20 + 2
    });

    test('a GST rate raised after ordering taxes only the appended items at the new rate', () => {
        const bill = storedBill(400, { gstPct: 5, servicePct: 0, additionalCharges: [] }, 'takeaway'); // gst 20
        const cfg18 = { gstPct: 18, servicePct: 0, additionalCharges: [] };

        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 400, subtotalAfter: 500, taxConfig: cfg18, orderType: 'takeaway' });

        expect(next.gst).toBe(38);           // 20 stored + 18 on the ₹100 added
        expect(next.gstPercentage).toBe(18);
        expect(next.total).toBe(538);
    });

    test('a charge enabled after ordering is added for the appended part only', () => {
        const bill = storedBill(400, { gstPct: 0, servicePct: 0, additionalCharges: [] }, 'dine-in');
        const cfg = { gstPct: 0, servicePct: 0, additionalCharges: [{ name: 'Green Tax', type: 'Percentage', value: 2 }] };

        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 400, subtotalAfter: 500, taxConfig: cfg, orderType: 'dine-in' });

        expect(next.additionalCharges).toEqual([{ name: 'Green Tax', type: 'Percentage', value: 2, amount: 2 }]);
        expect(next.additionalChargesTotal).toBe(2);
        expect(next.total).toBe(502);
    });

    test('a charge disabled after ordering keeps its stored amount and adds nothing', () => {
        const bill = storedBill(400, CFG, 'dine-in');

        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 400, subtotalAfter: 500, taxConfig: { gstPct: 5, servicePct: 10, additionalCharges: [] }, orderType: 'dine-in' });

        expect(next.additionalCharges.map((c) => [c.name, c.amount])).toEqual([['Packaging', 20], ['Green Tax', 8]]);
        expect(next.additionalChargesTotal).toBe(28);
    });

    test('a legacy order (taxes folded into total, zero breakdown) gains only the appended taxes', () => {
        const legacy = { total: 472, gst: 0, serviceCharge: 0, additionalCharges: [], additionalChargesTotal: 0 };

        const next = recomputeBillAfterAppend({ bill: legacy, subtotalBefore: 400, subtotalAfter: 500, taxConfig: CFG, orderType: 'dine-in' });

        // Δ: 100 items + 5 gst + 10 service + 2 green tax
        expect(next.total).toBe(589);
        expect(next.gst).toBe(5);
        expect(next.serviceCharge).toBe(10);
        expect(next.additionalCharges).toEqual([{ name: 'Green Tax', type: 'Percentage', value: 2, amount: 2 }]);
    });

    test("a split kitchen doc keeps the counter items' tax it already carries", () => {
        // Whole cart 1000 (kitchen 600 + counter 400) taxed on the kitchen doc.
        const whole = storedBill(1000, CFG, 'takeaway');
        const kitchenDoc = { ...whole, total: round2(600 + whole.gst + whole.serviceCharge + whole.additionalChargesTotal) };

        const next = recomputeBillAfterAppend({ bill: kitchenDoc, subtotalBefore: 600, subtotalAfter: 700, taxConfig: CFG, orderType: 'takeaway' });

        expect(next.gst).toBe(55);                       // 50 + 5
        expect(next.total).toBe(round2(kitchenDoc.total + 100 + 5 + 2));
    });

    test.each(['takeaway', 'delivery', 'kiosk'])('a %s order never gains a service charge', (type) => {
        const bill = storedBill(300, CFG, type);
        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 300, subtotalAfter: 600, taxConfig: CFG, orderType: type });
        expect(next.serviceCharge).toBe(0);
        expect(next.serviceChargePercentage).toBe(0);
    });

    test('non-numeric stored fields are treated as zero and the result is finite', () => {
        const next = recomputeBillAfterAppend({
            bill: { total: 'x', gst: undefined, serviceCharge: NaN, additionalCharges: [{ name: 'Packaging', type: 'Flat', value: 'y', amount: 'z' }] },
            subtotalBefore: 100, subtotalAfter: 200, taxConfig: CFG, orderType: 'dine-in',
        });
        for (const v of [next.total, next.gst, next.serviceCharge, next.additionalChargesTotal]) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
        }
        expect(next.additionalCharges[0]).toMatchObject({ value: 0, amount: 0 });
    });

    test('called with no arguments it returns a zero bill', () => {
        expect(recomputeBillAfterAppend({})).toMatchObject({ total: 0, gst: 0, serviceCharge: 0, additionalCharges: [], additionalChargesTotal: 0 });
    });

    test('the stored bill object is not mutated', () => {
        const bill = storedBill(300, CFG, 'dine-in');
        const snapshot = JSON.parse(JSON.stringify(bill));
        recomputeBillAfterAppend({ bill, subtotalBefore: 300, subtotalAfter: 450, taxConfig: CFG, orderType: 'dine-in' });
        expect(bill).toEqual(snapshot);
    });
});

// ── billFieldsForNewOrder ────────────────────────────────────────────

describe('billFieldsForNewOrder', () => {
    test.each(['dine-in', 'takeaway', 'delivery'])('matches computeBill for a %s order', (type) => {
        const f = billFieldsForNewOrder({ subtotal: 333.33, taxConfig: CFG, orderType: type });
        const b = computeBill({ subtotal: 333.33, taxConfig: CFG, orderType: type });
        expect(f).toEqual({
            total: b.total, gst: b.gst, gstPercentage: b.gstPct,
            serviceCharge: b.serviceCharge, serviceChargePercentage: b.serviceChargePct,
            additionalCharges: b.additionalCharges, additionalChargesTotal: b.additionalChargesTotal,
        });
    });

    test('a zero subtotal carries no flat charge', () => {
        expect(billFieldsForNewOrder({ subtotal: 0, taxConfig: CFG })).toMatchObject({ total: 0, additionalChargesTotal: 0, additionalCharges: [] });
    });

    test('defaults to an untaxed dine-in bill', () => {
        expect(billFieldsForNewOrder({ subtotal: 99.99 })).toMatchObject({ total: 99.99, gst: 0, serviceCharge: 0 });
    });
});


// ── GST after the coupon ─────────────────────────────────────────────

describe('append with a coupon (GST on subtotal − coupon)', () => {
    const cfg = { gstPct: 5, servicePct: 0, additionalCharges: [] };

    test('the stored coupon stays the GST base reduction before and after', () => {
        // Placed: ₹1000, ₹100 coupon → GST 5% of 900 = 45, total 945.
        const bill = storedBill(1000, cfg, 'takeaway', { coupon: 100 });
        expect(bill).toMatchObject({ gst: 45, total: 945 });

        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 1000, subtotalAfter: 1200, taxConfig: cfg, orderType: 'takeaway' });
        // After: GST 5% of (1200 − 100) = 55; total 1200 + 55 − 100 = 1155.
        expect(next.gst).toBe(55);
        expect(next.total).toBe(1155);
    });

    test('a coupon bigger than the old subtotal is honoured once the subtotal grows past it', () => {
        // ₹80 food, ₹100 coupon → GST base 0, total 0.
        const bill = storedBill(80, cfg, 'takeaway', { coupon: 100 });
        expect(bill).toMatchObject({ gst: 0, total: 0 });
        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 80, subtotalAfter: 300, taxConfig: cfg, orderType: 'takeaway' });
        // GST 5% of (300 − 100) = 10 (createOrder caps a coupon at the
        // subtotal, so this only arises for hand-edited/legacy data).
        expect(next.gst).toBe(10);
    });

    test('an explicit couponDiscount overrides bill.couponDiscount', () => {
        const bill = { ...storedBill(1000, cfg, 'takeaway'), couponDiscount: 999 };
        const next = recomputeBillAfterAppend({ bill, subtotalBefore: 1000, subtotalAfter: 1100, taxConfig: cfg, orderType: 'takeaway', couponDiscount: 0 });
        expect(next.gst).toBe(55); // 50 + 5% of 100
    });
});

describe('recomputeBillForCoupon (apply / swap / clear on an open order)', () => {
    // ₹1000 dine-in with 5% GST, 10% service — placed without a coupon.
    const placed = { total: 1150, gst: 50, gstPercentage: 5, serviceCharge: 100 };

    test('applying a ₹100 coupon re-stamps GST on the discounted base', () => {
        const next = recomputeBillForCoupon({ bill: placed, subtotal: 1000, oldCoupon: 0, newCoupon: 100 });
        // GST 5% of 900 = 45; total 1000 + 45 + 100 service − 100 = 1045
        expect(next).toEqual({ gst: 45, total: 1045 });
    });

    test('swapping ₹100 → ₹200 moves GST and total again', () => {
        const withCoupon = { ...placed, gst: 45, total: 1045 };
        const next = recomputeBillForCoupon({ bill: withCoupon, subtotal: 1000, oldCoupon: 100, newCoupon: 200 });
        // GST 5% of 800 = 40; total 1000 + 40 + 100 − 200 = 940
        expect(next).toEqual({ gst: 40, total: 940 });
    });

    test('clearing the coupon restores the original bill', () => {
        const next = recomputeBillForCoupon({ bill: { ...placed, gst: 40, total: 940 }, subtotal: 1000, oldCoupon: 200, newCoupon: 0 });
        expect(next).toEqual({ gst: 50, total: 1150 });
    });

    test('uses the STAMPED rate, not a live setting; a legacy order with no rate keeps GST', () => {
        const legacy = { total: 1050, gst: 0, gstPercentage: 0 };
        expect(recomputeBillForCoupon({ bill: legacy, subtotal: 1000, oldCoupon: 0, newCoupon: 100 }))
            .toEqual({ gst: 0, total: 950 });
    });

    test('matches computeBill from scratch', () => {
        const cfg = { gstPct: 18, servicePct: 10, additionalCharges: [{ name: 'Packaging', type: 'Flat', value: 20 }] };
        const before = computeBill({ subtotal: 733.33, taxConfig: cfg, orderType: 'dine-in', couponDiscount: 50 });
        const after = computeBill({ subtotal: 733.33, taxConfig: cfg, orderType: 'dine-in', couponDiscount: 120.5 });
        const next = recomputeBillForCoupon({
            bill: { total: before.total, gst: before.gst, gstPercentage: 18 }, subtotal: 733.33, oldCoupon: 50, newCoupon: 120.5,
        });
        expect(next).toEqual({ gst: after.gst, total: after.total });
    });
});
