/**
 * Ledger-lite (Plan 3B.3): pure posting builders + the idempotent post-day
 * service (models / loaders mocked).
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const P = require('../utils/ledgerPostings');
const { getTenders } = require('../utils/tenders');
const { businessDateOf, dayBounds, isValidYmd, eachDate } = require('../utils/businessDate');

const sum = (lines, k) => Math.round(lines.reduce((s, l) => s + l[k], 0) * 100) / 100;
const balanced = (lines) => sum(lines, 'debit') === sum(lines, 'credit');

describe('posting builders balance', () => {
    const order = { _id: 'o1', orderId: 'ORD-1', total: 1050, gst: 50, amountPaid: 1050, payments: [
        { method: 'cash', amount: 500, at: new Date('2026-10-29T06:00:00Z') },
        { method: 'upi', amount: 550, at: new Date('2026-10-29T06:01:00Z') },
    ] };

    test('each tender line posts Dr tender / Cr Sales + Output GST and balances', () => {
        const tenders = getTenders(order);
        const all = [];
        tenders.forEach((line, index) => {
            const lines = P.buildTenderPosting({ order, line, index, businessDate: '2026-10-29' });
            expect(balanced(lines)).toBe(true);
            all.push(...lines);
        });
        expect(P.assertBalanced(all)).toBe(true);
        // total debit equals what was collected; GST share is 50/1050 of each tender
        expect(sum(all, 'debit')).toBe(1050);
        const gst = all.filter((l) => l.account === P.ACCOUNTS.OUTPUT_GST);
        expect(sum(gst, 'credit')).toBeCloseTo(50, 1);
        expect(all.find((l) => l.account === P.ACCOUNTS.CASH).debit).toBe(500);
        expect(all.find((l) => l.account === P.ACCOUNTS.BANK).debit).toBe(550);
    });

    test('legacy order (no payments[]) is read from paymentMethod / amountPaid', () => {
        const legacy = { _id: 'o2', total: 200, gst: 0, amountPaid: 200, paymentMethod: 'card', paidAt: new Date() };
        const [line] = getTenders(legacy);
        const lines = P.buildTenderPosting({ order: legacy, line, index: 0, businessDate: '2026-10-29' });
        expect(lines.find((l) => l.account === P.ACCOUNTS.CARD).debit).toBe(200);
        expect(balanced(lines)).toBe(true);
    });

    test('wallet tender debits the wallet liability', () => {
        const w = { _id: 'o3', total: 100, amountPaid: 100, paymentMethod: 'wallet', walletAmountPaid: 100 };
        const lines = P.buildTenderPosting({ order: w, line: getTenders(w)[0], index: 0, businessDate: 'd' });
        expect(lines[0].account).toBe(P.ACCOUNTS.WALLET);
    });

    test('refund reverses sales + GST against the dominant tender and balances', () => {
        const lines = P.buildRefundPosting({ order, refund: { amount: 105 }, index: 0, businessDate: '2026-10-29' });
        expect(balanced(lines)).toBe(true);
        expect(lines.find((l) => l.account === P.ACCOUNTS.BANK).credit).toBe(105); // UPI was the larger tender
        expect(lines.find((l) => l.account === P.ACCOUNTS.OUTPUT_GST).debit).toBe(5);
    });

    test('expense, supplier invoice, supplier payment and PO payment balance', () => {
        const batches = [
            P.buildExpensePosting({ expense: { _id: 'e', amount: 300, method: 'cash', category: 'Gas' }, businessDate: 'd' }),
            P.buildInvoicePosting({ invoice: { _id: 'i', invoiceNo: 'A1', total: 1180, tax: 180 }, businessDate: 'd' }),
            P.buildSupplierPaymentPosting({ payment: { _id: 'p', amount: 500, method: 'upi' }, businessDate: 'd' }),
            P.buildPoPaymentPosting({ po: { _id: 'po', poNumber: 'PO-1' }, payment: { _id: 'pp', amount: 75.5, mode: 'cash' }, businessDate: 'd' }),
        ];
        batches.forEach((b) => expect(balanced(b)).toBe(true));
        expect(batches[0].find((l) => l.account === P.ACCOUNTS.CASH).credit).toBe(300);
        expect(batches[1].find((l) => l.account === P.ACCOUNTS.AP).credit).toBe(1180);
        expect(batches[1].find((l) => l.account === P.ACCOUNTS.INPUT_GST).debit).toBe(180);
        expect(batches[2].find((l) => l.account === P.ACCOUNTS.AP).debit).toBe(500);
    });

    test('assertBalanced throws on an unbalanced batch', () => {
        const bad = [
            { refType: 'x', refId: '1', debit: 10, credit: 0 },
            { refType: 'x', refId: '1', debit: 0, credit: 9 },
        ];
        expect(() => P.assertBalanced(bad)).toThrow(/Unbalanced/);
    });

    test('rounding odd amounts never breaks balance', () => {
        const o = { _id: 'o9', total: 333.33, gst: 15.87, amountPaid: 333.33, paymentMethod: 'cash', paidAt: new Date() };
        const lines = P.buildTenderPosting({ order: o, line: getTenders(o)[0], index: 0, businessDate: 'd' });
        expect(balanced(lines)).toBe(true);
    });
});

describe('business date helpers', () => {
    test('IST day bounds and conversion', () => {
        expect(businessDateOf(new Date('2026-10-28T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-29');
        const { start, end } = dayBounds('2026-10-29', 'Asia/Kolkata');
        expect(start.toISOString()).toBe('2026-10-28T18:30:00.000Z');
        expect(end.toISOString()).toBe('2026-10-29T18:30:00.000Z');
        expect(isValidYmd('2026-02-30')).toBe(false);
        expect(eachDate('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    });
});

describe('postDay service', () => {
    let store;
    let LedgerEntry;
    let loadSources;
    let ledger;

    beforeEach(() => {
        jest.resetModules();
        store = new Map();
        jest.doMock('../models/ledgerAccount', () => ({ bulkWrite: jest.fn().mockResolvedValue({}), find: jest.fn() }));
        jest.doMock('../models/ledgerEntry', () => ({
            // emulate the unique (restaurant, key) upsert
            bulkWrite: jest.fn(async (ops) => {
                let upsertedCount = 0;
                for (const op of ops) {
                    const k = op.updateOne.filter.key;
                    if (!store.has(k)) { store.set(k, op.updateOne.update.$setOnInsert); upsertedCount += 1; }
                }
                return { upsertedCount };
            }),
        }));
        jest.doMock('../services/ledgerSources', () => ({ loadSources: jest.fn() }));
        LedgerEntry = require('../models/ledgerEntry');
        ({ loadSources } = require('../services/ledgerSources'));
        ledger = require('../services/ledgerService');
        const order = { _id: 'o1', total: 1000, gst: 0, amountPaid: 1000, paymentMethod: 'cash', paidAt: new Date('2026-10-29T06:00:00Z') };
        loadSources.mockResolvedValue({
            tenders: [{ order, line: getTenders(order)[0], index: 0 }],
            refunds: [{ order: { ...order, refunds: [] }, refund: { amount: 100 }, index: 0 }],
            expenses: [{ _id: 'e1', amount: 50, method: 'cash', category: 'Misc' }],
            supplierPayments: [], invoices: [{ _id: 'inv1', invoiceNo: 'S1', total: 118, tax: 18 }], poPayments: [],
        });
    });

    test('posts balanced batches once; a second run inserts nothing', async () => {
        const first = await ledger.postDay('507f1f77bcf86cd799439011', '2026-10-29', { timeZone: 'Asia/Kolkata' });
        expect(first.inserted).toBe(first.lines);
        expect(first.lines).toBeGreaterThan(0);
        const debit = [...store.values()].reduce((s, e) => s + e.debit, 0);
        const credit = [...store.values()].reduce((s, e) => s + e.credit, 0);
        expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));

        const second = await ledger.postDay('507f1f77bcf86cd799439011', '2026-10-29', { timeZone: 'Asia/Kolkata' });
        expect(second.inserted).toBe(0);
        expect(second.skipped).toBe(first.lines);
        expect(store.size).toBe(first.lines);
        expect(LedgerEntry.bulkWrite).toHaveBeenCalledTimes(2);
    });

    test('rejects a malformed business date', async () => {
        await expect(ledger.postDay('507f1f77bcf86cd799439011', '29-10-2026')).rejects.toThrow(/YYYY-MM-DD/);
    });
});
