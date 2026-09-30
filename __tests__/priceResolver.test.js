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
