/**
 * Supplier invoices + payments (Plan 3B.3): aging, 3-way match, and the
 * atomic "payment cannot exceed outstanding" rule (models mocked).
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { agingBuckets, threeWayMatch, outstandingOf, statusFor } = require('../utils/supplierMath');

describe('supplierMath', () => {
    test('statusFor / outstandingOf', () => {
        expect(statusFor(100, 0)).toBe('unpaid');
        expect(statusFor(100, 40)).toBe('partial');
        expect(statusFor(100, 100)).toBe('paid');
        expect(outstandingOf({ total: 100, amountPaid: 30.5 })).toBe(69.5);
    });

    test('aging buckets by days past due, paid invoices ignored', () => {
        const asOf = new Date('2026-10-30T00:00:00Z');
        const day = (n) => new Date(asOf.getTime() - n * 86400000);
        const invs = [
            { supplier: 's1', supplierName: 'A', dueDate: day(-5), total: 100, amountPaid: 0 },   // not due
            { supplier: 's1', supplierName: 'A', dueDate: day(10), total: 200, amountPaid: 50 },  // 1-30 (150)
            { supplier: 's2', supplierName: 'B', dueDate: day(45), total: 300, amountPaid: 0 },   // 31-60
            { supplier: 's2', supplierName: 'B', dueDate: day(75), total: 400, amountPaid: 0 },   // 61-90
            { supplier: 's2', supplierName: 'B', dueDate: day(120), total: 500, amountPaid: 0 },  // 90+
            { supplier: 's2', supplierName: 'B', dueDate: day(200), total: 999, amountPaid: 999 }, // settled
        ];
        const r = agingBuckets(invs, asOf);
        expect(r.totals).toEqual({ notDue: 100, d1_30: 150, d31_60: 300, d61_90: 400, over90: 500, total: 1450 });
        const b = r.rows.find((x) => x.supplier === 's2');
        expect(b.total).toBe(1200);
        expect(r.rows[0].supplier).toBe('s2'); // largest first
    });
});

describe('threeWayMatch', () => {
    const po = (over = {}) => ({
        _id: 'po1', poNumber: 'PO-001', supplier: 's1', supplierName: 'A', status: 'received', grandTotal: 1180,
        lines: [{ inventoryItem: 'i1', name: 'Rice', unit: 'kg', orderedQty: 10, rate: 100, taxPercent: 18 }],
        receipts: [{ lines: [{ inventoryItem: 'i1', qty: 10 }] }],
        ...over,
    });

    test('matched: received value equals invoice total', () => {
        const r = threeWayMatch(po(), [{ _id: 'v1', invoiceNo: 'V1', total: 1180 }]);
        expect(r.status).toBe('matched');
        expect(r.flags).toEqual([]);
        expect(r.receivedValue).toBe(1180);
    });

    test('amount mismatch beyond tolerance', () => {
        const r = threeWayMatch(po(), [{ _id: 'v1', invoiceNo: 'V1', total: 1300 }]);
        expect(r.status).toBe('mismatch');
        expect(r.flags).toContain('AMOUNT_MISMATCH');
        expect(r.difference).toBe(120);
        expect(threeWayMatch(po(), [{ _id: 'v1', total: 1180.8 }]).status).toBe('matched'); // within Rs 1
    });

    test('invoice bills more quantity than was received', () => {
        const r = threeWayMatch(
            po({ receipts: [{ lines: [{ inventoryItem: 'i1', qty: 8 }] }], status: 'partially-received' }),
            [{ _id: 'v1', total: 944, lines: [{ inventoryItem: 'i1', qty: 10 }] }],
        );
        expect(r.status).toBe('mismatch');
        expect(r.flags).toContain('INVOICED_QTY_EXCEEDS_RECEIVED');
        expect(r.lines[0]).toMatchObject({ ordered: 10, received: 8, invoiced: 10 });
    });

    test('goods received but no invoice yet; nothing received and no invoice is just pending', () => {
        expect(threeWayMatch(po(), []).status).toBe('no-invoice');
        expect(threeWayMatch(po({ receipts: [], status: 'ordered' }), []).status).toBe('pending');
    });

    test('invoice with nothing received is flagged; over-receipt is flagged', () => {
        const r = threeWayMatch(po({ receipts: [], status: 'ordered' }), [{ _id: 'v', total: 1180 }]);
        expect(r.flags).toEqual(expect.arrayContaining(['INVOICED_NOT_RECEIVED', 'AMOUNT_MISMATCH']));
        const over = threeWayMatch(po({ receipts: [{ lines: [{ inventoryItem: 'i1', qty: 12 }] }] }), [{ _id: 'v', total: 1416 }]);
        expect(over.flags).toContain('OVER_RECEIVED');
    });

    test('multiple receipts and invoices are summed', () => {
        const r = threeWayMatch(
            po({ receipts: [{ lines: [{ inventoryItem: 'i1', qty: 4 }] }, { lines: [{ inventoryItem: 'i1', qty: 6 }] }] }),
            [{ _id: 'a', total: 590 }, { _id: 'b', total: 590 }],
        );
        expect(r.status).toBe('matched');
        expect(r.invoicedTotal).toBe(1180);
    });
});

describe('record payment (atomic guard)', () => {
    let ctrl; let SupplierInvoice; let SupplierPayment;
    const res = () => { const r = { statusCode: 200 }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
    const req = (body, id = '507f1f77bcf86cd799439011') => ({
        restaurant: { _id: 'r1', timezone: 'Asia/Kolkata' }, user: { _id: 'u1', role: 'admin' }, query: {}, params: { id }, body,
    });
    const call = async (rq) => { const rs = res(); await ctrl.recordPayment(rq, rs, (e) => { throw e; }); if (rs.statusCode >= 400) throw Object.assign(new Error(rs.body.message), { status: rs.statusCode, code: rs.body.code }); return rs; };

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../models/supplierInvoice', () => ({ findOneAndUpdate: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() }));
        jest.doMock('../models/supplierPayment', () => ({ create: jest.fn() }));
        jest.doMock('../models/supplier', () => ({}));
        jest.doMock('../models/purchaseOrder', () => ({}));
        SupplierInvoice = require('../models/supplierInvoice');
        SupplierPayment = require('../models/supplierPayment');
        ctrl = require('../controllers/supplierInvoiceController');
    });

    test('payment above the outstanding balance is refused with 400 and nothing is written', async () => {
        SupplierInvoice.findOneAndUpdate.mockResolvedValue(null); // conditional update did not match
        SupplierInvoice.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'i', total: 1000, amountPaid: 900 }) });
        await expect(call(req({ amount: 150 }))).rejects.toMatchObject({ status: 400, code: 'EXCEEDS_OUTSTANDING' });
        expect(SupplierPayment.create).not.toHaveBeenCalled();
        // the guard is part of the update filter itself (atomic), not a read-then-write
        const [filter, update] = SupplierInvoice.findOneAndUpdate.mock.calls[0];
        expect(filter.$expr).toBeDefined();
        expect(Array.isArray(update)).toBe(true);
    });

    test('unknown invoice -> 404', async () => {
        SupplierInvoice.findOneAndUpdate.mockResolvedValue(null);
        SupplierInvoice.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
        await expect(call(req({ amount: 10 }))).rejects.toMatchObject({ status: 404 });
    });

    test('valid payment records a SupplierPayment row', async () => {
        const inv = { _id: 'i', supplier: 's', branch: null, total: 1000, amountPaid: 400, toObject() { return { _id: 'i', total: 1000, amountPaid: 400 }; } };
        SupplierInvoice.findOneAndUpdate.mockResolvedValue(inv);
        SupplierPayment.create.mockImplementation(async (d) => d);
        const rs = await call(req({ amount: 400, method: 'upi', reference: 'UTR1' }));
        expect(rs.statusCode).toBe(201);
        expect(SupplierPayment.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 400, method: 'upi', reference: 'UTR1' }));
        expect(rs.body.invoice.outstanding).toBe(600);
    });

    test('if the payment row cannot be written the reserved amount is given back', async () => {
        const inv = { _id: 'i', supplier: 's', total: 1000, amountPaid: 400, toObject() { return {}; } };
        SupplierInvoice.findOneAndUpdate.mockResolvedValue(inv);
        SupplierPayment.create.mockRejectedValue(new Error('db down'));
        await expect(call(req({ amount: 400 }))).rejects.toMatchObject({ status: 500 });
        expect(SupplierInvoice.updateOne).toHaveBeenCalledTimes(1);
    });

    test('non-positive amounts are rejected before touching the DB', async () => {
        await expect(call(req({ amount: 0 }))).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
        expect(SupplierInvoice.findOneAndUpdate).not.toHaveBeenCalled();
    });
});
