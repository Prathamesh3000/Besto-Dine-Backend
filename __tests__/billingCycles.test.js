const bc = require('../utils/billingCycles');

describe('billingCycles', () => {
    afterEach(() => { delete process.env.BILLING_GST_RATE; });

    test('months per cycle; unknown cycle reads as monthly', () => {
        expect(bc.CYCLES).toEqual({ monthly: 1, annual: 12, biennial: 24 });
        expect(bc.monthsFor('annual')).toBe(12);
        expect(bc.monthsFor('biennial')).toBe(24);
        expect(bc.monthsFor('weekly')).toBe(1);
        expect(bc.monthsFor(undefined)).toBe(1);
        expect(bc.normalizeCycle('annual')).toBe('annual');
        expect(bc.normalizeCycle('x')).toBe('monthly');
    });

    test.each([
        [699, 82482, 12582, 82482],
        [6999, 825882, 125982, 825882],
        [11199, 1321482, 201582, 1321482],
        [29999, 3539882, 539982, 3539882],
        [47999, 5663882, 863982, 5663882],
    ])('priceWithGst(%p): total paise %p, gst %p', (base, total, gst) => {
        const r = bc.priceWithGst(base);
        expect(r).toEqual({ basePaise: base * 100, gstPaise: gst, totalPaise: total, gstRate: 18 });
        expect(r.basePaise + r.gstPaise).toBe(r.totalPaise);
    });

    test('rounds to whole paise (no float drift) for fractional prices', () => {
        const r = bc.priceWithGst(0.29);          // 29 paise * 1.18 = 34.22
        expect(r.basePaise).toBe(29);
        expect(r.totalPaise).toBe(34);
        expect(Number.isInteger(r.gstPaise)).toBe(true);
        expect(bc.priceWithGst(1999.99).totalPaise).toBe(Math.round(199999 * 1.18));
    });

    test('splitGst is the inverse of priceWithGst for every list price', () => {
        for (const base of [699, 1799, 2999, 6999, 17999, 29999, 11199, 28799, 47999]) {
            const p = bc.priceWithGst(base);
            expect(bc.splitGst(p.totalPaise)).toEqual({ basePaise: p.basePaise, gstPaise: p.gstPaise, totalPaise: p.totalPaise, gstRate: 18 });
        }
        expect(bc.splitGst(0)).toMatchObject({ basePaise: 0, gstPaise: 0 });
        expect(bc.splitGst('x')).toMatchObject({ totalPaise: 0 });
    });

    test('BILLING_GST_RATE overrides; garbage falls back to 18', () => {
        process.env.BILLING_GST_RATE = '5';
        expect(bc.priceWithGst(1000).totalPaise).toBe(105000);
        process.env.BILLING_GST_RATE = '0';
        expect(bc.priceWithGst(1000).totalPaise).toBe(100000);
        process.env.BILLING_GST_RATE = 'abc';
        expect(bc.gstRate()).toBe(18);
        process.env.BILLING_GST_RATE = '-3';
        expect(bc.gstRate()).toBe(18);
    });

    test('addMonths: calendar months, clamped to month end (leap years included)', () => {
        const d = (s) => new Date(`${s}T12:00:00`);
        expect(bc.addMonths(d('2027-01-31'), 1).getDate()).toBe(28);
        expect(bc.addMonths(d('2028-01-31'), 1).getDate()).toBe(29);
        const y = bc.addMonths(d('2028-02-29'), 12);
        expect([y.getFullYear(), y.getMonth(), y.getDate()]).toEqual([2029, 1, 28]);
        const b = bc.addCycle(d('2026-10-15'), 'biennial');
        expect([b.getFullYear(), b.getMonth(), b.getDate()]).toEqual([2028, 9, 15]);
        const a = bc.addCycle(d('2026-10-15'), 'annual');
        expect([a.getFullYear(), a.getMonth(), a.getDate()]).toEqual([2027, 9, 15]);
    });

    test('monthlyEquivalent + savings vs monthly', () => {
        expect(bc.monthlyEquivalent(6999, 'annual')).toBe(583.25);
        expect(bc.monthlyEquivalent(11199, 'biennial')).toBe(466.63);
        expect(bc.monthlyEquivalent(699, 'monthly')).toBe(699);
        expect(bc.savingsPct(6999, 'annual', 699)).toBe(17);
        expect(bc.savingsPct(11199, 'biennial', 699)).toBe(33);
        expect(bc.savingsPct(699, 'monthly', 699)).toBe(0);
        expect(bc.savingsPct(0, 'annual', 699)).toBe(0);
    });

    test('priceForPlan: explicit prices, monthly fallback to price, legacy yearly plan, unsold cycles', () => {
        const plan = { price: 699, prices: { monthly: 699, annual: 6999, biennial: null }, billingCycle: 'monthly' };
        expect(bc.priceForPlan(plan, 'annual')).toBe(6999);
        expect(bc.priceForPlan(plan, 'biennial')).toBeNull();
        expect(bc.availableCycles(plan)).toEqual(['monthly', 'annual']);
        // pre-annual plan: no prices block at all -> monthly only, from `price`
        expect(bc.priceForPlan({ price: 999 }, 'monthly')).toBe(999);
        expect(bc.priceForPlan({ price: 999 }, 'annual')).toBeNull();
        // legacy single-price yearly plan sells its price as annual
        expect(bc.priceForPlan({ price: 5000, billingCycle: 'yearly' }, 'annual')).toBe(5000);
        expect(bc.priceForPlan({ price: 5000, billingCycle: 'yearly' }, 'monthly')).toBeNull();
        // free plan sells nothing
        expect(bc.availableCycles({ price: 0 })).toEqual([]);
        expect(bc.priceForPlan(null, 'monthly')).toBeNull();
    });

    test('invoiceAmounts: GST split when the full total was paid, legacy base-only otherwise', () => {
        expect(bc.invoiceAmounts(825882, 6999)).toEqual({ baseAmount: 699900, gstAmount: 125982, gstRate: 18, amount: 825882 });
        expect(bc.invoiceAmounts(69900, 699)).toEqual({ baseAmount: 69900, gstAmount: 0, gstRate: 0, amount: 69900 });
        // price unknown -> assume the amount is GST-inclusive
        expect(bc.invoiceAmounts(11800)).toMatchObject({ baseAmount: 10000, gstAmount: 1800, gstRate: 18 });
    });

    test('buildCycleRows: the card rows the frontend renders (rupees)', () => {
        const rows = bc.buildCycleRows({ price: 699, prices: { monthly: 699, annual: 6999, biennial: 11199 } });
        expect(rows.map(r => r.cycle)).toEqual(['monthly', 'annual', 'biennial']);
        expect(rows[1]).toEqual({
            cycle: 'annual', months: 12, price: 6999, gst: 1259.82, total: 8258.82,
            perMonthEquivalent: 583.25, savingsPctVsMonthly: 17,
        });
    });
});
