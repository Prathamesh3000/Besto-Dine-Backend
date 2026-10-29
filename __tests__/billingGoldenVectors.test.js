/**
 * Golden-vector parity: the same vectors (vendor/bestodine-types/golden-vectors.json,
 * generated from the backend implementation) are run against the backend's
 * own utils/billing.computeBill AND the shared engine. The Frontend and
 * mobile-waiter run the identical file against theirs.
 */
const { computeBill } = require('../utils/billing');
const shared = require('../vendor/bestodine-types/cjs/engine');
const { vectors, fields } = require('../vendor/bestodine-types/golden-vectors.json');

const view = (b) => {
    const out = {};
    for (const k of fields) out[k] = b[k];
    return JSON.parse(JSON.stringify(out)); // normalises -0 and undefined keys
};
const clone = (x) => JSON.parse(JSON.stringify(x));

describe('computeBill golden vectors', () => {
    test('there are at least 40 vectors', () => {
        expect(vectors.length).toBeGreaterThanOrEqual(40);
    });

    test.each(vectors.map((v) => [v.name, v]))('backend: %s', (_n, v) => {
        expect(view(computeBill(clone(v.input)))).toEqual(v.expected);
    });

    test.each(vectors.map((v) => [v.name, v]))('shared engine: %s', (_n, v) => {
        expect(view(shared.computeBill(clone(v.input)))).toEqual(v.expected);
    });
});
