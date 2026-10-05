/**
 * Unit tests for utils/priceResolver — the authoritative pricing rule.
 *
 * Why these matter: createOrder prices every line with resolvePrice()
 * and then rejects the order if the client-computed total disagrees
 * ("Order total does not match the server-calculated price"). The
 * frontend's utils/pricing.js is written to mirror this file exactly.
 * If this behaviour changes without the frontend changing with it,
 * customers cannot check out at all — so pin the contract here.
 *
 * Coverage:
 *   1. No branch context → tenant-wide default price
 *   2. Branch with no override → falls back to default
 *   3. Branch override → branch basePrice wins
 *   4. Active branch offer → finalPrice is discounted
 *   5. Expired branch offer → offer ignored, basePrice charged
 *   6. Offer with no expiry → treated as open-ended (active)
 *   7. pricingSource reports which branch of the rule fired
 */

const { resolvePrice, applyBranchPrice } = require('../utils/priceResolver');

const BRANCH_A = '507f1f77bcf86cd799439011';
const BRANCH_B = '507f1f77bcf86cd799439012';

/** Minimal menu-item shape: only the fields the resolver reads. */
function item(overrides = {}) {
    return {
        basePrice: 200,
        finalPrice: 200,
        offerPercentage: 0,
        offerExpiryDate: null,
        branchPrices: [],
        ...overrides,
    };
}

describe('resolvePrice — default (tenant-wide) pricing', () => {
    test('returns the item default when no branch is given', () => {
        const r = resolvePrice(item({ basePrice: 200, finalPrice: 180 }), null);
        expect(r.basePrice).toBe(200);
        expect(r.finalPrice).toBe(180);
        expect(r.pricingSource).toBe('default');
    });

    test('returns the default when the item has no branch overrides', () => {
        const r = resolvePrice(item({ finalPrice: 180 }), BRANCH_A);
        expect(r.finalPrice).toBe(180);
        expect(r.pricingSource).toBe('default');
    });

    test('returns the default when no override matches this branch', () => {
        const r = resolvePrice(
            item({
                finalPrice: 180,
                branchPrices: [{ branch: BRANCH_B, basePrice: 150, offerPercentage: 0 }],
            }),
            BRANCH_A,
        );
        expect(r.finalPrice).toBe(180);
        expect(r.pricingSource).toBe('default');
    });
});

describe('resolvePrice — branch overrides', () => {
    test('a matching branch override replaces the default price', () => {
        const r = resolvePrice(
            item({
                basePrice: 200,
                finalPrice: 200,
                branchPrices: [{ branch: BRANCH_A, basePrice: 150, offerPercentage: 0 }],
            }),
            BRANCH_A,
        );
        expect(r.basePrice).toBe(150);
        expect(r.finalPrice).toBe(150);
        expect(r.pricingSource).toBe('branch');
    });

    test('accepts an ObjectId-like branch argument, not just a string', () => {
        // createOrder passes req.branch._id — an ObjectId, not a string.
        // The resolver must .toString() both sides or every branch
        // price would silently miss and fall back to the default.
        const objectIdLike = { toString: () => BRANCH_A };
        const r = resolvePrice(
            item({ branchPrices: [{ branch: BRANCH_A, basePrice: 150 }] }),
            objectIdLike,
        );
        expect(r.pricingSource).toBe('branch');
        expect(r.finalPrice).toBe(150);
    });
});

describe('resolvePrice — branch offers', () => {
    test('an unexpired offer discounts finalPrice', () => {
        const tomorrow = new Date(Date.now() + 86400000);
        const r = resolvePrice(
            item({
                branchPrices: [{
                    branch: BRANCH_A,
                    basePrice: 200,
                    offerPercentage: 25,
                    offerExpiryDate: tomorrow,
                }],
            }),
            BRANCH_A,
        );
        expect(r.basePrice).toBe(200);
        expect(r.finalPrice).toBe(150); // 200 - 25%
        expect(r.offerPercentage).toBe(25);
    });

    test('an offer with no expiry date is open-ended, not ignored', () => {
        const r = resolvePrice(
            item({
                branchPrices: [{ branch: BRANCH_A, basePrice: 200, offerPercentage: 50 }],
            }),
            BRANCH_A,
        );
        expect(r.finalPrice).toBe(100);
    });

    test('an EXPIRED offer is ignored and basePrice is charged', () => {
        const yesterday = new Date(Date.now() - 86400000);
        const r = resolvePrice(
            item({
                branchPrices: [{
                    branch: BRANCH_A,
                    basePrice: 200,
                    offerPercentage: 25,
                    offerExpiryDate: yesterday,
                }],
            }),
            BRANCH_A,
        );
        expect(r.finalPrice).toBe(200);
        expect(r.offerPercentage).toBe(0);
    });

    test('a zero-percent offer leaves the price untouched', () => {
        const r = resolvePrice(
            item({ branchPrices: [{ branch: BRANCH_A, basePrice: 200, offerPercentage: 0 }] }),
            BRANCH_A,
        );
        expect(r.finalPrice).toBe(200);
        expect(r.offerPercentage).toBe(0);
    });
});

describe('applyBranchPrice', () => {
    test('writes the resolved price back onto the item', () => {
        const doc = item({
            branchPrices: [{ branch: BRANCH_A, basePrice: 150, offerPercentage: 0 }],
        });
        applyBranchPrice(doc, BRANCH_A);
        expect(doc.basePrice).toBe(150);
        expect(doc.finalPrice).toBe(150);
        expect(doc._pricingSource).toBe('branch');
    });

    test('is a no-op on price when there is nothing to override', () => {
        const doc = item({ basePrice: 200, finalPrice: 180 });
        applyBranchPrice(doc, BRANCH_A);
        expect(doc.finalPrice).toBe(180);
        expect(doc._pricingSource).toBe('default');
    });
});

describe('the contract the frontend mirrors', () => {
    // utils/pricing.js resolveUnitPrice() prefers finalPrice over
    // basePrice. These assert the server agrees, because a divergence
    // here is what makes checkout reject an otherwise valid cart.
    test('finalPrice is what the customer pays, not basePrice', () => {
        const r = resolvePrice(item({ basePrice: 200, finalPrice: 180 }), null);
        expect(r.finalPrice).toBeLessThan(r.basePrice);
        expect(r.finalPrice).toBe(180);
    });

    test('a free item resolves to 0, not to a falsy-coerced fallback', () => {
        // The frontend uses `?? `, not `||`, precisely so a legitimate
        // zero survives. Pin that 0 is reachable here too.
        const r = resolvePrice(item({ basePrice: 0, finalPrice: 0 }), null);
        expect(r.finalPrice).toBe(0);
    });
});

// ── Offer expiry, paise rounding and branch edge cases ───────────────
// Tests whose name starts with "BUG:" pin behaviour that is wrong today;
// they are expected to fail until the source is fixed.

describe('resolvePrice — offer expiry and rounding', () => {
    const DAY = 86400000;

    test('an active tenant-wide offer is charged from the stored finalPrice', () => {
        const r = resolvePrice(item({ basePrice: 200, offerPercentage: 20, finalPrice: 160, offerExpiryDate: new Date(Date.now() + DAY) }), BRANCH_A);
        expect(r).toMatchObject({ finalPrice: 160, offerPercentage: 20, pricingSource: 'default' });
    });

    // Regression (fixed 2026-10): resolvePrice drops a tenant-wide offer once
    // offerExpiryDate has passed (finalPrice → basePrice, offer 0); the
    // frontend mirror (utils/pricing.js) does the same so checkout agrees.
    test('an expired tenant-wide offer is no longer applied', () => {
        const r = resolvePrice(item({ basePrice: 200, offerPercentage: 20, finalPrice: 160, offerExpiryDate: new Date(Date.now() - DAY) }), null);
        expect(r.finalPrice).toBe(200);
        expect(r.offerPercentage).toBe(0);
    });

    // Regression (fixed 2026-10): resolved final prices are rounded to whole
    // paise (₹89.99 − 10 % = 80.99, not 80.991).
    test.each([
        ['a branch override', () => resolvePrice(item({ branchPrices: [{ branch: BRANCH_A, basePrice: 89.99, offerPercentage: 10 }] }), BRANCH_A), 80.99],
        ['a branch override at 15%', () => resolvePrice(item({ branchPrices: [{ branch: BRANCH_A, basePrice: 199, offerPercentage: 15 }] }), BRANCH_A), 169.15],
    ])('%s resolves to a whole number of paise', (_label, run, expected) => {
        expect(run().finalPrice).toBe(expected);
    });

    test('a branch offer that expires exactly now is no longer active', () => {
        const now = new Date();
        jest.useFakeTimers().setSystemTime(now);
        try {
            const r = resolvePrice(item({ branchPrices: [{ branch: BRANCH_A, basePrice: 300, offerPercentage: 10, offerExpiryDate: now }] }), BRANCH_A);
            expect(r).toMatchObject({ finalPrice: 300, offerPercentage: 0 });
        } finally {
            jest.useRealTimers();
        }
    });

    test.each([
        ['a 100% branch offer', { basePrice: 300, offerPercentage: 100 }, 0],
        ['a ₹0 branch price', { basePrice: 0, offerPercentage: 10 }, 0],
        ['a 0% branch offer', { basePrice: 250, offerPercentage: 0 }, 250],
    ])('%s resolves to ₹%d', (_label, bp, expected) => {
        expect(resolvePrice(item({ branchPrices: [{ branch: BRANCH_A, ...bp }] }), BRANCH_A).finalPrice).toBe(expected);
    });

    test('the branch id may be an ObjectId or a string; another branch\'s override is ignored', () => {
        const { Types } = require('mongoose');
        const menu = item({ basePrice: 200, finalPrice: 200, branchPrices: [{ branch: new Types.ObjectId(BRANCH_A), basePrice: 150 }] });

        expect(resolvePrice(menu, new Types.ObjectId(BRANCH_A)).finalPrice).toBe(150);
        expect(resolvePrice(menu, BRANCH_A).finalPrice).toBe(150);
        expect(resolvePrice(menu, BRANCH_B)).toMatchObject({ finalPrice: 200, pricingSource: 'default' });
    });

    test('applyBranchPrice shows the base price once a branch offer has expired', () => {
        const menu = item({ branchPrices: [{ branch: BRANCH_A, basePrice: 300, offerPercentage: 25, offerExpiryDate: new Date(Date.now() - DAY) }] });
        applyBranchPrice(menu, BRANCH_A);
        expect(menu).toMatchObject({ basePrice: 300, finalPrice: 300, offerPercentage: 0, _pricingSource: 'branch' });
    });
});
