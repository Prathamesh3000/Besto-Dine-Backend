/**
 * utils/upiQr — UPI deep-link builder, VPA / payee normalisation, masking and
 * amount-due arithmetic (pure).
 */
const {
    buildUpiUri, buildNote, normalizeVpa, normalizePayeeName, maskVpa, amountDue, qrDataUrl, UpiError, MAX_UPI_AMOUNT,
} = require('../utils/upiQr');

const parse = (uri) => {
    const u = new URL(uri.replace('upi://pay?', 'https://x/?'));
    return Object.fromEntries(u.searchParams.entries());
};

describe('buildUpiUri', () => {
    test('canonical shape and parameter order', () => {
        const uri = buildUpiUri({ vpa: 'cafe@okaxis', payeeName: 'Tip Top Cafe', amount: 245.5, orderRef: 'ORD-123', note: 'Table T-08 ORD-123' });
        expect(uri).toBe('upi://pay?pa=cafe@okaxis&pn=Tip%20Top%20Cafe&am=245.50&cu=INR&tn=Table%20T-08%20ORD-123&tr=ORD-123');
    });

    test('amount always has 2 decimals and is rounded', () => {
        expect(parse(buildUpiUri({ vpa: 'a1@upi', amount: 10 })).am).toBe('10.00');
        expect(parse(buildUpiUri({ vpa: 'a1@upi', amount: 10.005 })).am).toBe('10.01');
        expect(parse(buildUpiUri({ vpa: 'a1@upi', amount: '99.9' })).am).toBe('99.90');
    });

    test('ampersand, unicode, quotes and spaces in the payee name are percent-encoded', () => {
        const uri = buildUpiUri({ vpa: 'a1@upi', payeeName: 'Ram & Sons "Cafe" Café स्वाद', amount: 5 });
        expect(uri).not.toMatch(/\s/);
        expect(uri.split('&').length).toBe(4); // pa, pn, am, cu - the name's & did not split the query
        expect(parse(uri).pn).toBe('Ram & Sons "Cafe" Café स्वाद');
        expect(uri).toContain('%26');
    });

    test('values never carry leading/trailing spaces or control characters', () => {
        const uri = buildUpiUri({ vpa: '  Cafe@OkAxis ', payeeName: '  \t Spaced\n  Name  ', amount: 1, note: '  hi\r\nthere  ' });
        const q = parse(uri);
        expect(q.pa).toBe('cafe@okaxis');
        expect(q.pn).toBe('Spaced Name');
        expect(q.tn).toBe('hi there');
        expect(uri).not.toMatch(/%0[0-9A-F]|%20&|=%20/i);
    });

    test('note is capped at 80 characters; order ref at 35 and stripped to safe characters', () => {
        const q = parse(buildUpiUri({ vpa: 'a1@upi', amount: 1, note: 'x'.repeat(200), orderRef: 'ORD 12/3#' + 'z'.repeat(60) }));
        expect(q.tn.length).toBe(80);
        expect(q.tr).toMatch(/^ORD123z+$/);
        expect(q.tr.length).toBe(35);
    });

    test('empty name / note / ref are omitted', () => {
        expect(buildUpiUri({ vpa: 'a1@upi', amount: 1 })).toBe('upi://pay?pa=a1@upi&am=1.00&cu=INR');
    });

    test.each([0, -5, NaN, undefined, null, 'abc', MAX_UPI_AMOUNT + 1, Infinity])('amount %p is rejected', (amount) => {
        expect(() => buildUpiUri({ vpa: 'a1@upi', amount })).toThrow(UpiError);
        try { buildUpiUri({ vpa: 'a1@upi', amount }); } catch (e) { expect(e.code).toBe('INVALID_AMOUNT'); }
    });

    test('the maximum amount is accepted; a bad VPA is rejected', () => {
        expect(parse(buildUpiUri({ vpa: 'a1@upi', amount: MAX_UPI_AMOUNT })).am).toBe(`${MAX_UPI_AMOUNT}.00`);
        for (const vpa of ['', 'nope', 'a@b', 'x y@upi', undefined]) {
            expect(() => buildUpiUri({ vpa, amount: 1 })).toThrow(/UPI ID/);
        }
    });
});

describe('normalizeVpa / normalizePayeeName / maskVpa', () => {
    test('VPA: trim + lowercase, "" clears, invalid -> null (same pattern as staff wallet)', () => {
        expect(normalizeVpa('  Shop.Name@OkSBI ')).toBe('shop.name@oksbi');
        expect(normalizeVpa('')).toBe('');
        expect(normalizeVpa(null)).toBe('');
        expect(normalizeVpa('bad')).toBeNull();
        expect(normalizeVpa('a@b')).toBeNull();
        expect(normalizeVpa(123)).toBeNull();
        expect(normalizeVpa(`${'a'.repeat(98)}@upi`)).toBeNull(); // > 100
        expect(normalizeVpa(`${'a'.repeat(90)}@upi`)).toBe(`${'a'.repeat(90)}@upi`);
    });

    test('payee name: control chars stripped, <= 60, "" clears', () => {
        expect(normalizePayeeName('  My\u0007 Cafe\n ')).toBe('My Cafe');
        expect(normalizePayeeName('')).toBe('');
        expect(normalizePayeeName('x'.repeat(60))).toHaveLength(60);
        expect(normalizePayeeName('x'.repeat(61))).toBeNull();
        expect(normalizePayeeName(5)).toBeNull();
    });

    test('mask keeps 2 characters and the handle only', () => {
        expect(maskVpa('cafe@okaxis')).toBe('ca***@okaxis');
        expect(maskVpa('a1@upi')).toBe('a1***@upi');
        expect(maskVpa('')).toBe('');
        expect(maskVpa('weird')).toBe('***');
    });
});

describe('amountDue / buildNote / qrDataUrl', () => {
    test('total (tip included) - manual discount - already paid, never negative', () => {
        expect(amountDue({ total: 230, manualDiscount: 30, amountPaid: 0 })).toBe(200);
        expect(amountDue({ total: 230, manualDiscount: 30, amountPaid: 50 })).toBe(150);
        expect(amountDue({ total: 100, manualDiscount: 500 })).toBe(0);
        expect(amountDue({})).toBe(0);
        expect(amountDue({ total: 10.125 })).toBe(10.13);
    });

    test('note', () => {
        expect(buildNote({ tableLabel: 'T-08', orderId: 'ORD-123' })).toBe('Table T-08 ORD-123');
        expect(buildNote({ orderId: 'ORD-9' })).toBe('ORD-9');
        expect(buildNote({ tableLabel: 'x'.repeat(200), orderId: 'ORD-9' }).length).toBe(80);
    });

    test('qrDataUrl returns a PNG data URL', async () => {
        const url = await qrDataUrl('upi://pay?pa=a1@upi&am=1.00&cu=INR');
        expect(url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    });
});
