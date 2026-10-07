/**
 * utils/receiptRenderer.js — pure KOT / bill / test-page renderer.
 * No DB, no socket: assertions are on the plain-text lines the print
 * agent will send to the printer.
 */
const {
    renderKot, renderBill, renderTest, toPlainText, columnsFor, wrap, row, money,
} = require('../utils/receiptRenderer');

const order = () => ({
    _id: 'o1',
    orderId: 'ORD-0042',
    type: 'dine-in',
    createdAt: new Date('2026-10-06T09:02:00.000Z'),
    items: [
        { name: 'Paneer Tikka', price: 250, quantity: 2, vegType: 'veg', prepStation: 'kitchen', instructions: 'less spicy', selectedSizes: [{ name: 'Large' }], selectedToppings: [{ name: 'Extra cheese', price: 30 }] },
        { name: 'Chicken Biryani', price: 180, quantity: 1, vegType: 'non-veg', prepStation: 'kitchen' },
        { name: 'Cold Coffee', price: 120, quantity: 1, vegType: 'veg', prepStation: 'bar' },
    ],
    gst: 34, gstPercentage: 5,
    serviceCharge: 68, serviceChargePercentage: 10,
    additionalCharges: [{ name: 'Packaging', type: 'Flat', value: 20, amount: 20 }],
    couponCode: 'WELCOME', couponDiscount: 50,
    manualDiscount: 0,
    total: 752,
    paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 752,
    tipAmount: 0,
});

const settings = () => ({
    general: {
        cafeName: 'The Coffee House',
        address: '12 MG Road, Pune 411001',
        contactNumber: '9876543210',
        timezone: 'Asia/Kolkata',
        legal: { gstin: '27AAAAA0000A1Z5', fssaiLicense: '12345678901234', legalBusinessName: 'Coffee House Pvt Ltd' },
    },
});

const textLines = (doc) => doc.lines.filter((l) => typeof l.t === 'string').map((l) => l.t);

describe('helpers', () => {
    test('columnsFor maps paper width to columns (80 mm = 48, 58 mm = 32, unknown = 48)', () => {
        expect(columnsFor('80')).toBe(48);
        expect(columnsFor('58')).toBe(32);
        expect(columnsFor(undefined)).toBe(48);
    });

    test('money formats rupees with two decimals, Indian grouping, no symbol', () => {
        expect(money(752)).toBe('752.00');
        expect(money(123456.5)).toBe('1,23,456.50');
        expect(money('x')).toBe('0.00');
    });

    test('wrap never exceeds the width and hard-breaks long words', () => {
        const lines = wrap('Supercalifragilisticexpialidocious paneer tikka', 10);
        expect(lines.every((l) => l.length <= 10)).toBe(true);
        expect(lines.join('')).toContain('Supercalif');
    });

    test('row keeps the right column on the first line and pads to width', () => {
        const lines = row('Paneer Tikka with a very long name indeed', '[V]', 24);
        expect(lines[0]).toHaveLength(24);
        expect(lines[0].endsWith(' [V]')).toBe(true);
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.every((l) => l.length === 24)).toBe(true);
    });
});

describe('renderKot', () => {
    test('80 mm kitchen KOT: banner, order id, table, items with veg marks, instructions, cut', () => {
        const o = order();
        const doc = renderKot({
            cafeName: 'The Coffee House', order: o, items: o.items.filter((i) => i.prepStation === 'kitchen'),
            station: 'kitchen', tableLabel: '5, 6', reason: 'create', waiterName: 'Ramesh', paperWidth: '80',
        });
        const text = toPlainText(doc);
        expect(doc.width).toBe(48);
        expect(doc.kind).toBe('kot');
        expect(text).toContain('*** KITCHEN KOT ***');
        expect(text).toContain('ORD-0042');
        expect(text).toContain('DINE-IN');
        expect(text).toContain('Table 5, 6');
        expect(text).toContain('2 x Paneer Tikka (Large)');
        expect(text).toContain('[V]');
        expect(text).toContain('[N]');
        expect(text).toContain('+ Extra cheese');
        expect(text).toContain('> less spicy');
        expect(text).not.toContain('Cold Coffee');        // bar item is not on the kitchen ticket
        expect(text).toContain('Waiter: Ramesh');
        expect(text).toContain('Items: 3');
        expect(text).not.toContain('ADDED ITEMS');
        expect(doc.lines.at(-1)).toEqual({ cut: true });
        expect(doc.lines.some((l) => l.drawer)).toBe(false);
        expect(textLines(doc).every((l) => l.length <= 48)).toBe(true);
    });

    test('append reason prints the ADDED ITEMS banner; reprint prints REPRINT; bar station is titled BAR KOT', () => {
        const o = order();
        const bar = o.items.filter((i) => i.prepStation === 'bar');
        expect(toPlainText(renderKot({ order: o, items: bar, station: 'bar', reason: 'append', paperWidth: '80' }))).toContain('--- ADDED ITEMS ---');
        expect(toPlainText(renderKot({ order: o, items: bar, station: 'bar', reason: 'reprint', paperWidth: '80' }))).toContain('** REPRINT **');
        expect(toPlainText(renderKot({ order: o, items: bar, station: 'bar', reason: 'append', paperWidth: '80' }))).toContain('*** BAR KOT ***');
    });

    test('takeaway / delivery / kiosk labels and 58 mm width', () => {
        const o = { ...order(), type: 'takeaway', customerName: 'Priya', delivery: { requested: true } };
        const doc = renderKot({ order: o, items: o.items, station: 'kitchen', tableLabel: null, reason: 'create', paperWidth: '58' });
        const text = toPlainText(doc);
        expect(doc.width).toBe(32);
        expect(text).toContain('DELIVERY');
        expect(text).toContain('Priya');
        expect(textLines(doc).every((l) => l.length <= 32)).toBe(true);
        expect(toPlainText(renderKot({ order: { ...order(), source: 'kiosk' }, items: [], station: 'kitchen', reason: 'create' }))).toContain('KIOSK');
    });
});

describe('renderBill', () => {
    test('80 mm GST bill: header, item table, CGST/SGST split, charges, coupon, total, paid, drawer on cash', () => {
        const doc = renderBill({ settings: settings(), order: order(), tableLabel: '5', paperWidth: '80', openDrawer: true });
        const text = toPlainText(doc);
        expect(doc.kind).toBe('bill');
        expect(text).toContain('The Coffee House');
        expect(text).toContain('Coffee House Pvt Ltd');
        expect(text).toContain('GSTIN 27AAAAA0000A1Z5');
        expect(text).toContain('FSSAI 12345678901234');
        expect(text).toContain('Bill ORD-0042');
        expect(text).toContain('Table 5');
        expect(text).toContain('DINE-IN');
        expect(text).toMatch(/Paneer Tikka \(Large\)\s+2\s+250\.00\s+500\.00/);
        expect(text).toMatch(/\+ Extra cheese\s+30\.00\s+60\.00/);
        // subtotal = 2×250 + 2×30 + 180 + 120 = 860 (toppings included via lineItemsSubtotal)
        expect(text).toMatch(/Subtotal\s+860\.00/);
        expect(text).toMatch(/Coupon WELCOME\s+-50\.00/);
        expect(text).toMatch(/CGST 2\.5%\s+17\.00/);
        expect(text).toMatch(/SGST 2\.5%\s+17\.00/);
        expect(text).toMatch(/Service charge 10%\s+68\.00/);
        expect(text).toMatch(/Packaging\s+20\.00/);
        expect(text).toMatch(/TOTAL\s+752\.00/);
        expect(text).toMatch(/Paid \(Cash\)\s+752\.00/);
        expect(text).not.toContain('Balance due');
        expect(text).toContain('Thank you, visit again!');
        expect(doc.lines.some((l) => l.cut)).toBe(true);
        expect(doc.lines.at(-1)).toEqual({ drawer: true });
        expect(textLines(doc).every((l) => l.length <= 48)).toBe(true);
    });

    test('58 mm bill uses the two-line item layout and stays within 32 columns', () => {
        const doc = renderBill({ settings: settings(), order: order(), tableLabel: '5', paperWidth: '58' });
        const text = toPlainText(doc);
        expect(doc.width).toBe(32);
        expect(text).toContain('Paneer Tikka (Large)');
        expect(text).toMatch(/2 x 250\.00\s+500\.00/);
        expect(textLines(doc).every((l) => l.length <= 32)).toBe(true);
        expect(doc.lines.some((l) => l.drawer)).toBe(false);
    });

    test('takeaway with no tax lines: omits CGST/SGST/service charge, shows pending payment and balance', () => {
        const o = { ...order(), type: 'takeaway', gst: 0, serviceCharge: 0, additionalCharges: [], couponDiscount: 0, couponCode: '', total: 860, paymentStatus: 'Pending', amountPaid: 0, paymentMethod: 'Not selected' };
        const text = toPlainText(renderBill({ settings: settings(), order: o, tableLabel: null, paperWidth: '80' }));
        expect(text).toContain('TAKEAWAY');
        expect(text).not.toContain('CGST');
        expect(text).not.toContain('Service charge');
        expect(text).not.toContain('Coupon');
        expect(text).toMatch(/Payment\s+PENDING/);
        expect(text).not.toContain('Paid (');
    });

    test('manual discount and partial payment show payable and balance due', () => {
        const o = { ...order(), manualDiscount: 52, amountPaid: 500, paymentMethod: 'UPI', paymentStatus: 'Partially Paid' };
        const text = toPlainText(renderBill({ settings: settings(), order: o, tableLabel: '5', paperWidth: '80' }));
        expect(text).toMatch(/Discount\s+-52\.00/);
        expect(text).toMatch(/AMOUNT PAYABLE\s+700\.00/);
        expect(text).toMatch(/Paid \(UPI\)\s+500\.00/);
        expect(text).toMatch(/Balance due\s+200\.00/);
    });

    test('tolerates missing settings and empty order', () => {
        const doc = renderBill({ settings: null, order: { orderId: 'X', items: [] }, tableLabel: null });
        expect(toPlainText(doc)).toContain('Bill X');
        expect(doc.lines.some((l) => l.cut)).toBe(true);
    });
});

describe('renderTest', () => {
    test('test page carries the printer name, station, a full-width column ruler and a cut', () => {
        const doc = renderTest({ cafeName: 'The Coffee House', printer: { name: 'Kitchen 1', station: 'kitchen', paperWidth: '58' } });
        const text = toPlainText(doc);
        expect(doc.kind).toBe('test');
        expect(doc.width).toBe(32);
        expect(text).toContain('PRINTER TEST');
        expect(text).toContain('Printer: Kitchen 1');
        expect(text).toContain('Station: kitchen');
        expect(text).toContain('32 cols');
        expect(textLines(doc)).toContain('12345678901234567890123456789012');
        expect(doc.lines.at(-1)).toEqual({ cut: true });
    });
});

describe('toPlainText', () => {
    test('renders rules, feeds, cut and drawer markers', () => {
        const text = toPlainText({ width: 10, lines: [{ t: 'a' }, { hr: true }, { feed: 2 }, { cut: true }, { drawer: true }] });
        expect(text).toBe('a\n----------\n\n\n--- cut ---\n--- drawer ---');
    });
});
