/**
 * Unit tests for utils/billing — the server-side tax authority.
 *
 * The rule under test: service charge pays for TABLE SERVICE. A
 * takeaway, delivery or kiosk customer receives none, so billing them
 * for it charges for a service never rendered. Before this module the
 * charge was applied unconditionally in twelve separate client-side
 * copies of the bill math, and the server modelled no taxes at all.
 *
 * Frontend/src/utils/billing.js is the exact mirror of this file. If
 * one changes, the other must change in the same commit — these tests
 * are the contract both sides are held to.
 */

const { computeBill, toTaxConfig, normaliseOrderType } = require('../utils/billing');

const TAXES = {
    gst: { enabled: true, value: 10 },
    serviceCharge: { enabled: true, value: 5 },
    additionalCharges: [
        { name: 'Packaging', type: 'Flat', value: 20, enabled: true },
        { name: 'Green Tax', type: 'Percentage', value: 2, enabled: true },
        { name: 'Disabled Fee', type: 'Flat', value: 99, enabled: false },
    ],
};

describe('toTaxConfig', () => {
    test('flattens enabled taxes and drops disabled charges', () => {
        const tc = toTaxConfig(TAXES);
        expect(tc.gstPct).toBe(10);
        expect(tc.servicePct).toBe(5);
        expect(tc.additionalCharges).toHaveLength(2);
        expect(tc.additionalCharges.map((c) => c.name)).not.toContain('Disabled Fee');
    });

    test('a disabled tax reads as 0%, not as its configured value', () => {
        const tc = toTaxConfig({
            gst: { enabled: false, value: 10 },
            serviceCharge: { enabled: false, value: 5 },
        });
        expect(tc.gstPct).toBe(0);
        expect(tc.servicePct).toBe(0);
    });

    test('tolerates a missing taxes document', () => {
        expect(toTaxConfig(null)).toEqual({ gstPct: 0, servicePct: 0, additionalCharges: [] });
    });
});

describe('normaliseOrderType', () => {
    test.each([
        ['dine-in', 'dine-in'], ['dineIn', 'dine-in'], ['DINE_IN', 'dine-in'],
        ['takeaway', 'takeaway'], ['take-away', 'takeaway'], ['pickup', 'takeaway'],
        ['delivery', 'delivery'], ['home-delivery', 'delivery'],
        ['kiosk', 'kiosk'],
    ])('%s → %s', (input, expected) => {
        expect(normaliseOrderType(input)).toBe(expected);
    });

    test('an unknown/empty type defaults to dine-in', () => {
        expect(normaliseOrderType('')).toBe('dine-in');
        expect(normaliseOrderType(undefined)).toBe('dine-in');
    });
});

describe('service charge policy — the bug this module exists to fix', () => {
    const taxConfig = toTaxConfig(TAXES);

    test('dine-in IS charged service charge', () => {
        const b = computeBill({ subtotal: 1000, taxConfig, orderType: 'dine-in' });
        expect(b.serviceCharge).toBe(50);
        expect(b.serviceChargePct).toBe(5);
        expect(b.serviceChargeApplies).toBe(true);
    });

    test.each(['takeaway', 'delivery', 'kiosk'])(
        '%s is NOT charged service charge',
        (orderType) => {
            const b = computeBill({ subtotal: 1000, taxConfig, orderType });
            expect(b.serviceCharge).toBe(0);
            expect(b.serviceChargeApplies).toBe(false);
        },
    );

    test('the suppressed pct is reported as 0 so no "(5%) ₹0.00" row renders', () => {
        // The UI guards its service-charge row on serviceChargePct > 0.
        // Reporting the configured 5% while charging 0 would print a
        // contradictory line on every takeaway bill.
        const b = computeBill({ subtotal: 1000, taxConfig, orderType: 'takeaway' });
        expect(b.serviceChargePct).toBe(0);
    });

    test('takeaway total is exactly the service charge lower than dine-in', () => {
        const dineIn = computeBill({ subtotal: 1000, taxConfig, orderType: 'dine-in' });
        const takeaway = computeBill({ subtotal: 1000, taxConfig, orderType: 'takeaway' });
        expect(dineIn.total - takeaway.total).toBe(50);
    });

    test('GST and additional charges are unaffected by order type', () => {
        const dineIn = computeBill({ subtotal: 1000, taxConfig, orderType: 'dine-in' });
        const takeaway = computeBill({ subtotal: 1000, taxConfig, orderType: 'takeaway' });
        expect(takeaway.gst).toBe(dineIn.gst);
        expect(takeaway.additionalChargesTotal).toBe(dineIn.additionalChargesTotal);
    });
});

describe('additional charges', () => {
    const taxConfig = toTaxConfig(TAXES);

    test('flat and percentage charges are computed per their type', () => {
        const b = computeBill({ subtotal: 1000, taxConfig, orderType: 'dine-in' });
        const byName = Object.fromEntries(b.additionalCharges.map((c) => [c.name, c.amount]));
        expect(byName.Packaging).toBe(20);      // flat
        expect(byName['Green Tax']).toBe(20);   // 2% of 1000
        expect(b.additionalChargesTotal).toBe(40);
    });

    test('an empty cart attracts no flat charges', () => {
        // Otherwise a ₹20 packaging fee appears on a ₹0 bill.
        const b = computeBill({ subtotal: 0, taxConfig, orderType: 'dine-in' });
        expect(b.additionalCharges).toEqual([]);
        expect(b.total).toBe(0);
    });
});

describe('discounts, tips and delivery', () => {
    const taxConfig = toTaxConfig({ gst: { enabled: true, value: 10 } });

    test('coupon and points reduce the total; tip and delivery add to it', () => {
        const b = computeBill({
            subtotal: 1000, taxConfig, orderType: 'takeaway',
            couponDiscount: 100, pointsRedeemed: 50, tipAmount: 30, deliveryFee: 40,
        });
        // 1000 + 100 gst - 100 - 50 + 30 + 40
        expect(b.total).toBe(1020);
    });

    test('a bill can never go negative', () => {
        // An over-large coupon should zero the bill, not hand money back.
        const b = computeBill({
            subtotal: 100, taxConfig, orderType: 'dine-in', couponDiscount: 9999,
        });
        expect(b.total).toBe(0);
    });
});

describe('rounding', () => {
    test('money is rounded to 2dp, never carrying float dust', () => {
        const taxConfig = toTaxConfig({ gst: { enabled: true, value: 18 } });
        const b = computeBill({ subtotal: 333.33, taxConfig, orderType: 'takeaway' });
        expect(b.gst).toBe(60);           // 333.33 * 0.18 = 59.9994
        expect(Number.isInteger(b.total * 100)).toBe(true);
    });

    test('non-numeric inputs degrade to 0 rather than NaN', () => {
        const b = computeBill({ subtotal: undefined, taxConfig: {}, orderType: 'dine-in' });
        expect(b.total).toBe(0);
        expect(Number.isNaN(b.gst)).toBe(false);
    });
});
