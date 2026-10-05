/**
 * utils/paymentDefaults.js (resolveLoyaltySettings) and
 * utils/razorpayErrors.js (describeRazorpayError, razorpayErrorSummary).
 *
 * Coverage:
 *   - loyalty/refund settings: defaults, tenant overrides, loyalty off,
 *     and zero values the Settings schema allows (min: 0)
 *   - Razorpay SDK rejection shape, ordinary Errors, primitives, null,
 *     unserialisable objects, summary fallbacks
 *
 * Tests whose name starts with "BUG:" pin behaviour that is wrong today;
 * they are expected to fail until the source is fixed.
 */
const { PAYMENT_DEFAULTS, resolveLoyaltySettings } = require('../utils/paymentDefaults');
const { describeRazorpayError, razorpayErrorSummary } = require('../utils/razorpayErrors');

describe('resolveLoyaltySettings', () => {
    test.each([
        ['no settings', null],
        ['settings without a wallet block', {}],
        ['an empty wallet block', { wallet: {} }],
    ])('falls back to the platform defaults for %s', (_label, settings) => {
        expect(resolveLoyaltySettings(settings)).toEqual({
            enableLoyalty: true,
            minBillToEarn: 100,
            pointsPerRupee: 1,
            pointsToRupee: 0.1,
            pointsExpiryDays: 365,
            refundMode: 'original',
        });
    });

    test('tenant values override every default', () => {
        const wallet = {
            enableLoyalty: true, minBillToEarn: 250, pointsPerRupee: 2,
            pointsToRupee: 0.25, pointsExpiryDays: 30, refundMode: 'wallet',
        };
        expect(resolveLoyaltySettings({ wallet })).toEqual(wallet);
    });

    test('loyalty switched off by the tenant stays off', () => {
        expect(resolveLoyaltySettings({ wallet: { enableLoyalty: false } }).enableLoyalty).toBe(false);
    });

    test('the defaults object is the documented platform policy', () => {
        expect(PAYMENT_DEFAULTS).toMatchObject({ refundMode: 'original', maxRechargeAmount: 10000, pointsToRupee: 0.1 });
    });

    // Regression (fixed 2026-10): resolveLoyaltySettings keeps a stored 0 (explicit null/undefined checks instead of ||).
    test.each([
        ['minBillToEarn', 0],
        ['pointsPerRupee', 0],
        ['pointsToRupee', 0],
        ['pointsExpiryDays', 0],
    ])('a tenant setting of %s = %i is honoured', (field, value) => {
        expect(resolveLoyaltySettings({ wallet: { [field]: value } })[field]).toBe(value);
    });
});

describe('describeRazorpayError', () => {
    test('flattens the SDK rejection object (no .message) into its useful fields', () => {
        const sdkErr = {
            statusCode: 400,
            error: {
                code: 'BAD_REQUEST_ERROR', description: 'receipt: the length must be no more than 40.',
                field: 'receipt', reason: 'input_validation_failed', step: 'payment_initiation', source: 'business',
            },
        };
        expect(describeRazorpayError(sdkErr)).toEqual({
            statusCode: 400, code: 'BAD_REQUEST_ERROR', description: 'receipt: the length must be no more than 40.',
            field: 'receipt', reason: 'input_validation_failed', step: 'payment_initiation', source: 'business',
        });
    });

    test('keeps the message and stack of an ordinary Error', () => {
        const err = new Error('ETIMEDOUT');
        expect(describeRazorpayError(err)).toEqual({ error: 'ETIMEDOUT', stack: err.stack });
    });

    test.each([
        [null, { error: 'unknown error' }],
        [undefined, { error: 'unknown error' }],
        ['socket hang up', { error: '"socket hang up"' }],
        [{ weird: true }, { error: '{"weird":true}' }],
    ])('never returns an empty object for %p', (input, expected) => {
        expect(describeRazorpayError(input)).toEqual(expected);
    });

    test('an unserialisable value is stringified instead of throwing', () => {
        const circular = { name: 'loop' };
        circular.self = circular;
        expect(describeRazorpayError(circular)).toEqual({ error: '[object Object]' });
    });
});

describe('razorpayErrorSummary', () => {
    test.each([
        ['the gateway description', { error: { description: 'Payment amount is invalid' } }, 'Payment amount is invalid'],
        ['the Error message', new Error('network down'), 'network down'],
        ['a generic fallback', { error: {} }, 'Payment gateway error'],
    ])('prefers %s', (_label, input, expected) => {
        expect(razorpayErrorSummary(input)).toBe(expected);
    });
});
