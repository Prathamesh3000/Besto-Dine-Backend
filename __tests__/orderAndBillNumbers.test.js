/**
 * Order numbers (time-zone date part + duplicate-key retry) and bill numbers
 * (per branch, restarting each Indian financial year). Models are mocked: no
 * database, no server.
 */
const mockBillFindOneAndUpdate = jest.fn();
const mockBillDropIndex = jest.fn().mockResolvedValue();
const mockRestaurantFindById = jest.fn();
const mockOrderSave = jest.fn();

jest.mock('uuid', () => ({ v4: () => require('crypto').randomUUID() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/billCounter', () => ({
    findOneAndUpdate: (...a) => mockBillFindOneAndUpdate(...a),
    collection: { dropIndex: (...a) => mockBillDropIndex(...a) },
}));
jest.mock('../models/restaurant', () => ({
    findById: (...a) => mockRestaurantFindById(...a),
}));
jest.mock('../models/order', () => {
    const Order = function (data) { this.data = data; };
    Order.prototype.save = function (...a) { return mockOrderSave(this.data, ...a); };
    return Order;
});

const mongoose = require('mongoose');
const idGen = require('../utils/idGenerator');
const { nextBillNo, allocateBillNo, financialYearOf, publicBill, billFinalizedError } = require('../utils/billWorkspace');
const { formatBillNo } = require('../utils/billNumber');
const { persistOrderDocs, isOrderIdDuplicate, ORDER_ID_MAX_RETRIES } = require('../services/orderCreateService');

const leanOf = (v) => ({ lean: () => Promise.resolve(v) });

describe('idGenerator date part uses the restaurant time zone', () => {
    // 2026-03-31 20:00 UTC = 2026-04-01 01:30 in Kolkata (+5:30)
    const instant = new Date('2026-03-31T20:00:00Z');

    test('Asia/Kolkata rolls over to the next local day, UTC does not', () => {
        expect(idGen.getDatePart('Asia/Kolkata', instant)).toBe('260401');
        expect(idGen.getDatePart('UTC', instant)).toBe('260331');
    });

    test('missing or invalid zone falls back to Asia/Kolkata', () => {
        expect(idGen.getDatePart(undefined, instant)).toBe('260401');
        expect(idGen.getDatePart('Not/AZone', instant)).toBe('260401');
    });

    test('format and prefixes are unchanged', () => {
        expect(idGen.orderId('UTC')).toMatch(/^ORD-\d{6}-[0-9A-F]{6}$/);
        expect(idGen.takeawayOrderId()).toMatch(/^ORT-\d{6}-[0-9A-F]{6}$/);
        expect(idGen.kioskOrderId('America/New_York')).toMatch(/^KSK-\d{6}-[0-9A-F]{6}$/);
    });
});

describe('persistOrderDocs retries on an orderId duplicate-key error', () => {
    const dupOrderId = () => Object.assign(new Error('E11000 duplicate key error collection: x index: orderId_1 dup key'), { code: 11000, keyPattern: { orderId: 1 } });
    const req = { restaurant: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, body: {} };
    let sessionObj;

    beforeEach(() => {
        mockOrderSave.mockReset();
        sessionObj = { withTransaction: jest.fn(async (fn) => fn()), endSession: jest.fn() };
        jest.spyOn(mongoose, 'startSession').mockResolvedValue(sessionObj);
    });
    afterEach(() => jest.restoreAllMocks());

    const ctxFor = (primary, counter = null) => ({
        primaryDocData: primary, counterDocData: counter, validUserId: null, clientIdempotencyKey: null,
        authoritativeSubtotal: 0, authoritativePointsRedeemed: 0, authoritativeCouponCode: null,
        authoritativeCouponDiscount: 0, couponId: null, orderTz: 'Asia/Kolkata',
    });

    test('isOrderIdDuplicate only matches the orderId index', () => {
        expect(isOrderIdDuplicate(dupOrderId())).toBe(true);
        expect(isOrderIdDuplicate({ code: 11000, message: 'E11000 ... index: idempotency_per_tenant dup key' })).toBe(false);
        expect(isOrderIdDuplicate({ code: 11000, message: 'E11000 ... index: razorpayOrderId_1 dup key' })).toBe(false);
        expect(isOrderIdDuplicate(new Error('boom'))).toBe(false);
        expect(isOrderIdDuplicate(null)).toBe(false);
    });

    test('collides once, then succeeds with a fresh id and the same prefix', async () => {
        mockOrderSave.mockRejectedValueOnce(dupOrderId()).mockImplementation(async (d) => d);
        const primary = { orderId: 'ORT-260101-AAAAAA' };
        const out = await persistOrderDocs(req, ctxFor(primary));
        expect(mockOrderSave).toHaveBeenCalledTimes(2);
        expect(out.savedOrder.orderId).toMatch(/^ORT-\d{6}-[0-9A-F]{6}$/);
        expect(out.savedOrder.orderId).not.toBe('ORT-260101-AAAAAA');
    });

    test('gives up after the bounded number of retries and rethrows', async () => {
        mockOrderSave.mockRejectedValue(dupOrderId());
        await expect(persistOrderDocs(req, ctxFor({ orderId: 'ORD-260101-AAAAAA' }))).rejects.toMatchObject({ code: 11000 });
        expect(mockOrderSave).toHaveBeenCalledTimes(ORDER_ID_MAX_RETRIES + 1);
    });

    test('a non-orderId error is not retried', async () => {
        mockOrderSave.mockRejectedValue(new Error('validation failed'));
        await expect(persistOrderDocs(req, ctxFor({ orderId: 'ORD-260101-AAAAAA' }))).rejects.toThrow('validation failed');
        expect(mockOrderSave).toHaveBeenCalledTimes(1);
    });
});

describe('financialYearOf (Indian FY, 1 April - 31 March)', () => {
    test.each([
        ['2026-03-31T10:00:00Z', 'Asia/Kolkata', '2025-26'],
        ['2026-03-31T20:00:00Z', 'Asia/Kolkata', '2026-27'], // already 1 April in India
        ['2026-03-31T20:00:00Z', 'UTC', '2025-26'],
        ['2026-10-28T00:00:00Z', 'Asia/Kolkata', '2026-27'],
        ['2027-01-15T00:00:00Z', 'Asia/Kolkata', '2026-27'],
        ['2099-04-01T00:00:00Z', 'Asia/Kolkata', '2099-00'],
        ['2026-10-28T00:00:00Z', 'bad/zone', '2026-27'],
    ])('%s in %s -> %s', (iso, tz, expected) => {
        expect(financialYearOf(tz, new Date(iso))).toBe(expected);
    });
});

describe('nextBillNo', () => {
    const R = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const now = new Date('2026-10-28T00:00:00Z');

    beforeEach(() => {
        mockBillFindOneAndUpdate.mockReset();
        mockRestaurantFindById.mockReset();
        mockRestaurantFindById.mockReturnValue({ select: () => leanOf({ timezone: 'Asia/Kolkata' }) });
    });

    test('no restaurant -> null', async () => {
        expect(await nextBillNo(null)).toBeNull();
    });

    test('existing counter for this FY: one atomic $inc keyed by restaurant, branch and FY', async () => {
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf({ seq: 8 }));
        expect(await nextBillNo(R, B, { now })).toBe(8);
        expect(mockBillFindOneAndUpdate).toHaveBeenCalledTimes(1);
        const [filter, update] = mockBillFindOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ restaurant: R, branch: B, financialYear: '2026-27' });
        expect(update).toEqual({ $inc: { seq: 1 } });
    });

    test('legacy counter without a FY is adopted into the current FY (numbering continues)', async () => {
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf(null)).mockReturnValueOnce(leanOf({ seq: 501 }));
        expect(await nextBillNo(R, null, { now })).toBe(501);
        const [filter, update] = mockBillFindOneAndUpdate.mock.calls[1];
        expect(filter).toEqual({ restaurant: R, branch: null, financialYear: null });
        expect(update).toEqual({ $inc: { seq: 1 }, $set: { financialYear: '2026-27' } });
    });

    test('new FY with no counters: upserts a fresh series starting at 1', async () => {
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf(null)).mockReturnValueOnce(leanOf(null)).mockReturnValueOnce(leanOf({ seq: 1 }));
        expect(await nextBillNo(R, B, { now })).toBe(1);
        const [filter, , opts] = mockBillFindOneAndUpdate.mock.calls[2];
        expect(filter).toEqual({ restaurant: R, branch: B, financialYear: '2026-27' });
        expect(opts).toMatchObject({ upsert: true });
    });

    test('an upsert race (E11000) is retried through the $inc path', async () => {
        const dup = Object.assign(new Error('E11000'), { code: 11000 });
        mockBillFindOneAndUpdate
            .mockReturnValueOnce(leanOf(null)).mockReturnValueOnce(leanOf(null))
            .mockReturnValueOnce({ lean: () => Promise.reject(dup) })
            .mockReturnValueOnce(leanOf({ seq: 2 }));
        expect(await nextBillNo(R, B, { now })).toBe(2);
    });

    test('FY comes from the restaurant time zone when none is passed', async () => {
        mockRestaurantFindById.mockReturnValue({ select: () => leanOf({ timezone: 'UTC' }) });
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf({ seq: 3 }));
        await nextBillNo(R, B, { now: new Date('2026-03-31T20:00:00Z') });
        expect(mockBillFindOneAndUpdate.mock.calls[0][0].financialYear).toBe('2025-26');
    });
});

describe('allocateBillNo returns the FY of the counter it used', () => {
    const R = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    beforeEach(() => {
        mockBillFindOneAndUpdate.mockReset();
        mockRestaurantFindById.mockReset();
        mockRestaurantFindById.mockReturnValue({ select: () => leanOf({ timezone: 'Asia/Kolkata' }) });
    });
    test('same FY value as the counter filter, across the 1 April boundary', async () => {
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf({ seq: 9 }));
        const a = await allocateBillNo(R, B, { now: new Date('2026-03-31T10:00:00Z') });
        expect(a).toEqual({ billNo: 9, financialYear: '2025-26' });
        expect(mockBillFindOneAndUpdate.mock.calls[0][0].financialYear).toBe('2025-26');
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf({ seq: 1 }));
        const b = await allocateBillNo(R, B, { now: new Date('2026-03-31T20:00:00Z') }); // 1 Apr IST
        expect(b).toEqual({ billNo: 1, financialYear: '2026-27' });
    });
    test('adopted legacy counter and fresh upsert both report the FY', async () => {
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf(null)).mockReturnValueOnce(leanOf({ seq: 501 }));
        expect(await allocateBillNo(R, null, { now: new Date('2026-10-28T00:00:00Z') })).toEqual({ billNo: 501, financialYear: '2026-27' });
        mockBillFindOneAndUpdate.mockReset();
        mockBillFindOneAndUpdate.mockReturnValueOnce(leanOf(null)).mockReturnValueOnce(leanOf(null)).mockReturnValueOnce(leanOf({ seq: 1 }));
        expect(await allocateBillNo(R, B, { now: new Date('2026-10-28T00:00:00Z') })).toEqual({ billNo: 1, financialYear: '2026-27' });
    });
    test('no restaurant -> null', async () => {
        expect(await allocateBillNo(null)).toBeNull();
    });
});

describe('formatBillNo', () => {
    test('FY + number', () => expect(formatBillNo({ billNo: 5, financialYear: '2026-27' })).toBe('2026-27/5'));
    test('legacy bill (no FY) -> plain number', () => {
        expect(formatBillNo({ billNo: 5 })).toBe('5');
        expect(formatBillNo({ billNo: 5, financialYear: null })).toBe('5');
        expect(formatBillNo({ billNo: 0, financialYear: '2026-27' })).toBe('2026-27/0');
    });
    test('no number -> empty string', () => {
        expect(formatBillNo(null)).toBe('');
        expect(formatBillNo({})).toBe('');
        expect(formatBillNo({ billNo: null, financialYear: '2026-27' })).toBe('');
    });
    test('publicBill exposes financialYear and billNoDisplay; legacy bills unchanged', () => {
        expect(publicBill({ bill: { billNo: 5, financialYear: '2026-27', status: 'final' } })).toMatchObject({ billNo: 5, financialYear: '2026-27', billNoDisplay: '2026-27/5' });
        expect(publicBill({ bill: { billNo: 5 } })).toMatchObject({ billNo: 5, financialYear: null, billNoDisplay: '5' });
        expect(publicBill({ bill: { status: 'draft' } }).billNoDisplay).toBeNull();
    });
    test('BILL_FINALIZED message uses the FY form', () => {
        const err = billFinalizedError({ orderId: 'ORD-1', bill: { billNo: 7, financialYear: '2026-27' } });
        expect(JSON.stringify(err.body || err.payload || err)).toContain('2026-27/7');
    });
});
