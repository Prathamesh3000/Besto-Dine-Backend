'use strict';
/**
 * Thermal receipt renderer — KOT, bill and test page.
 *
 * Pure module: no DB, no socket, no printer library. It produces a
 * neutral "receipt document" that the print agent (print-agent/) maps
 * to ESC/POS and that tests / the fake printer can read as plain text:
 *
 *   { version: 1, width: 48, lines: [
 *       { t: 'text', a: 'l'|'c'|'r', b?: true, s?: 2 },   // b = bold, s = double size
 *       { hr: true },                                      // dashed rule
 *       { feed: 3 },                                       // blank lines
 *       { cut: true },                                     // paper cut
 *       { drawer: true },                                  // cash-drawer kick
 *       { qr: 'upi://pay?...', size: 6, a: 'c', t: '[UPI QR: Rs 120.00]' }, // QR code (agent: GS ( k; `t` = text fallback)
 *   ] }
 *
 * Text is pre-padded to the column width (48 cols on 80 mm paper, 32 on
 * 58 mm) so the agent only has to print each line as-is. Amounts are
 * plain rupee numbers without the ₹ glyph — PC437 printers can't print
 * it and a bill that says "Rs." everywhere prints the same on all of them.
 */
const { lineItemsSubtotal } = require('../services/orderBillMath');

const COLS = Object.freeze({ '58': 32, '80': 48 });

function columnsFor(paperWidth) {
    return COLS[String(paperWidth)] || 48;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(n) {
    const v = Number(n);
    return inr.format(Number.isFinite(v) ? v : 0);
}

function text(s) {
    return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Word-wrap `s` into lines of at most `w` columns (long words are hard-broken). */
function wrap(s, w) {
    const words = text(s).split(' ').filter(Boolean);
    const out = [];
    let cur = '';
    for (let word of words) {
        while (word.length > w) {
            if (cur) { out.push(cur); cur = ''; }
            out.push(word.slice(0, w));
            word = word.slice(w);
        }
        if (!cur) cur = word;
        else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
        else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
}

function padRight(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
function padLeft(s, w)  { s = String(s); return s.length >= w ? s.slice(-w) : ' '.repeat(w - s.length) + s; }
function center(s, w) {
    s = String(s);
    if (s.length >= w) return s.slice(0, w);
    const left = Math.floor((w - s.length) / 2);
    return ' '.repeat(left) + s + ' '.repeat(w - s.length - left);
}

/**
 * Two-column row: `left` flush left, `right` flush right on the same
 * line. A long `left` wraps onto following lines; `right` stays on the
 * first one. Returns an array of width-`w` strings.
 */
function row(left, right, w) {
    const r = text(right);
    const avail = Math.max(1, w - (r ? r.length + 1 : 0));
    const lines = wrap(left, avail);
    return lines.map((l, i) => (i === 0
        ? padRight(l, avail) + (r ? ' ' + r : '')
        : padRight(l, w)));
}

function L(t, a = 'l', extra = {}) { return { t, a, ...extra }; }
function pushRow(lines, left, right, w, extra = {}) {
    for (const t of row(left, right, w)) lines.push(L(t, 'l', extra));
}
function pushWrapped(lines, s, w, a = 'l', extra = {}) {
    for (const t of wrap(s, w)) lines.push(L(a === 'c' ? center(t, w) : a === 'r' ? padLeft(t, w) : padRight(t, w), a, extra));
}
const HR = Object.freeze({ hr: true });
const UPI_QR_SIZE = 6; // ESC/POS QR module size (dots) used on the bill


function formatDateTime(d, timezone) {
    const date = d instanceof Date ? d : new Date(d || Date.now());
    const opts = { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true };
    try {
        return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: timezone || 'Asia/Kolkata' }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en-IN', opts).format(date);
    }
}
function formatTime(d, timezone) {
    const date = d instanceof Date ? d : new Date(d || Date.now());
    const opts = { hour: '2-digit', minute: '2-digit', hour12: true };
    try {
        return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: timezone || 'Asia/Kolkata' }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en-IN', opts).format(date);
    }
}

function orderTypeLabel(order) {
    if (order?.delivery?.requested) return 'DELIVERY';
    if (order?.type === 'takeaway') return 'TAKEAWAY';
    if (order?.source === 'kiosk') return 'KIOSK';
    return 'DINE-IN';
}

function sizeSuffix(item) {
    const s = Array.isArray(item.selectedSizes) && item.selectedSizes[0]?.name;
    return s ? ` (${text(s)})` : '';
}

function vegMark(item) {
    if (item.vegType === 'veg') return '[V]';
    if (item.vegType === 'non-veg') return '[N]';
    return '';
}

/** "KOT #12 (Round 2)"; legacy / unnumbered slips return ''. */
function kotHeaderText(kot) {
    if (!kot) return '';
    const hasTicket = kot.ticketNo != null;
    if (kot.kotNo != null) return hasTicket ? `KOT #${kot.ticketNo} (Round ${kot.kotNo})` : `KOT Round ${kot.kotNo}`;
    if (kot.rounds > 1) return `KOT Rounds 1-${kot.rounds} (all)`;
    return '';
}

const STATION_TITLE = Object.freeze({ kitchen: 'KITCHEN KOT', bar: 'BAR KOT', counter: 'COUNTER KOT' });

/**
 * Kitchen order ticket for ONE station.
 * @param {object} p
 * @param {string}  p.cafeName
 * @param {object}  p.order        order doc / lean object (orderId, type, source, delivery, customerName, createdAt)
 * @param {object[]} p.items       the lines to print (already filtered to this station)
 * @param {string}  p.station      kitchen | bar | counter
 * @param {string|null} p.tableLabel  "5" or "5, 6, 7" for merged groups
 * @param {string}  p.reason       create | append | reprint
 * @param {string}  [p.waiterName]
 * @param {string}  [p.paperWidth] '58' | '80'
 * @param {string}  [p.timezone]
 * @param {object}  [p.kot]        { ticketNo, kotNo, rounds? } — header "KOT #<ticketNo> (Round <kotNo>)".
 *                                 `rounds` > 1 with no kotNo = whole-order reprint ("Rounds 1-N").
 */
function renderKot({ cafeName, order, items, station, tableLabel, reason, waiterName, paperWidth, timezone, kot }) {
    const w = columnsFor(paperWidth);
    const lines = [];
    const title = STATION_TITLE[station] || 'KOT';
    lines.push(L(center(`*** ${title} ***`, w), 'c', { b: true, s: 2 }));
    if (cafeName) lines.push(L(center(text(cafeName), w), 'c'));
    const kotHeader = kotHeaderText(kot);
    if (kotHeader) lines.push(L(center(kotHeader, w), 'c', { b: true }));
    if (reason === 'append') lines.push(L(center('--- ADDED ITEMS ---', w), 'c', { b: true }));
    if (reason === 'reprint') lines.push(L(center('** REPRINT **', w), 'c', { b: true }));
    lines.push(HR);

    pushRow(lines, order?.orderId || '', orderTypeLabel(order), w, { b: true });
    const who = tableLabel ? `Table ${tableLabel}` : (order?.customerName ? text(order.customerName) : '');
    pushRow(lines, who, formatTime(reason === 'append' ? Date.now() : (order?.createdAt || Date.now()), timezone), w);
    lines.push(HR);

    let count = 0;
    for (const it of items || []) {
        const qty = Number(it.quantity) || 1;
        count += qty;
        pushRow(lines, `${qty} x ${text(it.name)}${sizeSuffix(it)}`, vegMark(it), w, { b: true });
        for (const t of it.selectedToppings || []) {
            if (t?.name) pushWrapped(lines, `   + ${text(t.name)}`, w);
        }
        if (it.instructions) pushWrapped(lines, `   > ${text(it.instructions)}`, w);
    }
    lines.push(HR);
    pushRow(lines, `Waiter: ${waiterName ? text(waiterName) : '-'}`, `Items: ${count}`, w);
    lines.push({ feed: 3 }, { cut: true });
    return { version: 1, width: w, kind: 'kot', lines };
}

/**
 * The money lines of a bill, derived once for everything that shows or
 * stores a bill total: the printed slip (renderBill), the preview and the
 * Save Bill snapshot all read this, so they cannot disagree.
 * `payable` = total - manual discount (never below 0); tip is shown on
 * the slip but is not part of it (it is collected separately).
 */
function billTotals(order) {
    const items = order?.items || [];
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const total = Number(order?.total) || 0;
    const manualDiscount = Number(order?.manualDiscount) || 0;
    const paid = Number(order?.amountPaid) || 0;
    return {
        subtotal: round2(lineItemsSubtotal(items)),
        coupon: Number(order?.couponDiscount) || 0,
        couponCode: order?.couponCode || '',
        gst: Number(order?.gst) || 0,
        gstPercentage: Number(order?.gstPercentage) || 0,
        serviceCharge: Number(order?.serviceCharge) || 0,
        serviceChargePercentage: Number(order?.serviceChargePercentage) || 0,
        additionalCharges: (order?.additionalCharges || [])
            .filter((c) => c && Number(c.amount) > 0)
            .map((c) => ({ name: text(c.name || 'Charge'), amount: Number(c.amount) })),
        deliveryFee: Number(order?.delivery?.fee) || 0,
        total,
        manualDiscount,
        payable: Math.max(0, round2(total - manualDiscount)),
        tip: Number(order?.tipAmount) || 0,
        paid,
        due: paid > 0 ? Math.max(0, round2(total - manualDiscount - paid)) : 0,
    };
}

/**
 * Customer bill (GST invoice layout).
 * @param {object} p
 * @param {object}  p.settings     { general: { cafeName, address, contactNumber, legal: { gstin, fssaiLicense, legalBusinessName }, timezone } }
 * @param {object}  p.order        order doc / lean object
 * @param {string|null} p.tableLabel
 * @param {string}  [p.paperWidth]
 * @param {boolean} [p.openDrawer] kick the cash drawer (cash settlement at the counter)
 * @param {{uri:string, amount:number, payeeName?:string}|null} [p.upi] UNPAID bill + configured UPI id:
 *        adds a centred "Scan to pay" block (QR for the exact amount due, the amount, the payee name).
 *        Never carries the raw UPI id as text.
 */
function renderBill({ settings, order, tableLabel, paperWidth, openDrawer, upi = null }) {
    const w = columnsFor(paperWidth);
    const g = settings?.general || {};
    const legal = g.legal || {};
    const timezone = g.timezone;
    const lines = [];

    pushWrapped(lines, g.cafeName || legal.legalBusinessName || 'Bill', w, 'c', { b: true, s: 2 });
    if (legal.legalBusinessName && legal.legalBusinessName !== g.cafeName) pushWrapped(lines, legal.legalBusinessName, w, 'c');
    if (g.address) pushWrapped(lines, g.address, w, 'c');
    if (g.contactNumber) pushWrapped(lines, `Ph: ${g.contactNumber}`, w, 'c');
    if (legal.gstin) pushWrapped(lines, `GSTIN ${legal.gstin}`, w, 'c');
    if (legal.fssaiLicense) pushWrapped(lines, `FSSAI ${legal.fssaiLicense}`, w, 'c');
    lines.push(HR);

    pushRow(lines, `Bill ${order?.orderId || ''}`, formatDateTime(order?.createdAt || Date.now(), timezone), w, { b: true });
    // Saved bill number (order.bill.billNo), when the bill has been saved.
    if (order?.bill?.billNo != null) pushRow(lines, `Bill No: ${order.bill.billNo}`, '', w, { b: true });
    const typeLabel = orderTypeLabel(order);
    pushRow(lines, tableLabel ? `Table ${tableLabel}` : typeLabel, tableLabel ? typeLabel : '', w);
    if (order?.customerName) pushRow(lines, `Customer: ${text(order.customerName)}`, '', w);
    lines.push(HR);

    // Item table. 80 mm: one line per item; 58 mm: name line + qty/rate/amount line.
    const items = order?.items || [];
    if (w >= 48) {
        const nameW = w - 4 - 9 - 11;
        lines.push(L(padRight('Item', nameW) + padLeft('Qty', 4) + padLeft('Rate', 9) + padLeft('Amount', 11), 'l', { b: true }));
        for (const it of items) {
            const qty = Number(it.quantity) || 1;
            const rate = Number(it.price) || 0;
            const nameLines = wrap(`${text(it.name)}${sizeSuffix(it)}`, nameW);
            lines.push(L(padRight(nameLines[0], nameW) + padLeft(String(qty), 4) + padLeft(money(rate), 9) + padLeft(money(qty * rate), 11)));
            for (const extra of nameLines.slice(1)) lines.push(L(padRight(extra, w)));
            for (const t of it.selectedToppings || []) {
                if (!t?.name) continue;
                const tp = Number(t.price) || 0;
                lines.push(L(padRight(`  + ${text(t.name)}`, nameW) + padLeft('', 4) + padLeft(money(tp), 9) + padLeft(money(qty * tp), 11)));
            }
        }
    } else {
        for (const it of items) {
            const qty = Number(it.quantity) || 1;
            const rate = Number(it.price) || 0;
            pushWrapped(lines, `${text(it.name)}${sizeSuffix(it)}`, w);
            pushRow(lines, `  ${qty} x ${money(rate)}`, money(qty * rate), w);
            for (const t of it.selectedToppings || []) {
                if (!t?.name) continue;
                const tp = Number(t.price) || 0;
                pushRow(lines, `  + ${text(t.name)}`, money(qty * tp), w);
            }
        }
    }
    lines.push(HR);

    const tot = billTotals(order);
    pushRow(lines, 'Subtotal', money(lineItemsSubtotal(items)), w);
    const coupon = tot.coupon;
    if (coupon > 0) pushRow(lines, `Coupon${order.couponCode ? ` ${text(order.couponCode)}` : ''}`, `-${money(coupon)}`, w);
    const gst = Number(order?.gst) || 0;
    if (gst > 0) {
        const pct = Number(order?.gstPercentage) || 0;
        const half = pct ? `${pct / 2}%` : '';
        pushRow(lines, `CGST ${half}`.trim(), money(gst / 2), w);
        pushRow(lines, `SGST ${half}`.trim(), money(gst / 2), w);
    }
    const sc = Number(order?.serviceCharge) || 0;
    if (sc > 0) pushRow(lines, `Service charge ${order.serviceChargePercentage ? `${order.serviceChargePercentage}%` : ''}`.trim(), money(sc), w);
    for (const c of order?.additionalCharges || []) {
        if (c && Number(c.amount) > 0) pushRow(lines, text(c.name || 'Charge'), money(c.amount), w);
    }
    const deliveryFee = Number(order?.delivery?.fee) || 0;
    if (deliveryFee > 0) pushRow(lines, 'Delivery', money(deliveryFee), w);

    const total = tot.total;
    pushRow(lines, 'TOTAL', money(total), w, { b: true, s: 2 });

    const manual = tot.manualDiscount;
    if (manual > 0) {
        pushRow(lines, 'Discount', `-${money(manual)}`, w);
        pushRow(lines, 'AMOUNT PAYABLE', money(total - manual), w, { b: true });
    }
    const tip = Number(order?.tipAmount) || 0;
    if (tip > 0) pushRow(lines, 'Tip (100% to staff)', money(tip), w);

    const paid = Number(order?.amountPaid) || 0;
    if (paid > 0) {
        const method = order.paymentMethod && order.paymentMethod !== 'Not selected' ? ` (${text(order.paymentMethod)})` : '';
        pushRow(lines, `Paid${method}`, money(paid), w);
        const due = Math.max(0, total - manual - paid);
        if (due > 0.005) pushRow(lines, 'Balance due', money(due), w, { b: true });
    } else if (order?.paymentStatus === 'Pending') {
        pushRow(lines, 'Payment', 'PENDING', w, { b: true });
    }
    if (upi && upi.uri && Number(upi.amount) > 0) {
        const amt = money(upi.amount);
        lines.push(HR);
        lines.push(L(center('Scan to pay', w), 'c', { b: true }));
        // `t` doubles as the preview marker and as the text an agent without
        // QR support (or an old agent that ignores `qr`) prints instead.
        lines.push({ qr: upi.uri, size: UPI_QR_SIZE, a: 'c', t: center(`[UPI QR: Rs ${amt}]`, w) });
        lines.push(L(center(`Pay Rs ${amt}`, w), 'c', { b: true }));
        if (upi.payeeName) pushWrapped(lines, text(upi.payeeName), w, 'c');
    }
    lines.push(HR);
    lines.push(L(center('All amounts in INR', w), 'c'));
    lines.push(L(center('Thank you, visit again!', w), 'c', { b: true }));
    lines.push({ feed: 3 }, { cut: true });
    if (openDrawer) lines.push({ drawer: true });
    return { version: 1, width: w, kind: 'bill', lines };
}

/** Test page: lets the admin check paper width, cut and that the right printer answered. */
function renderTest({ cafeName, printer, paperWidth, timezone }) {
    const w = columnsFor(paperWidth || printer?.paperWidth);
    const lines = [];
    lines.push(L(center('PRINTER TEST', w), 'c', { b: true, s: 2 }));
    if (cafeName) lines.push(L(center(text(cafeName), w), 'c'));
    lines.push(HR);
    pushRow(lines, `Printer: ${text(printer?.name || '-')}`, '', w);
    pushRow(lines, `Station: ${text(printer?.station || '-')}`, `${w} cols`, w);
    pushRow(lines, 'Time', formatDateTime(Date.now(), timezone), w);
    lines.push(HR);
    // Column ruler — if the last digit is missing, the paper width is wrong.
    lines.push(L(Array.from({ length: w }, (_, i) => String((i + 1) % 10)).join('')));
    lines.push(L(center('BOLD', w), 'c', { b: true }));
    lines.push(L(center('If you can read this,', w), 'c'));
    lines.push(L(center('printing works.', w), 'c'));
    lines.push({ feed: 3 }, { cut: true });
    return { version: 1, width: w, kind: 'test', lines };
}

/** Plain-text preview of a document (what the fake printer / tests show). */
function toPlainText(doc) {
    const w = doc?.width || 48;
    return (doc?.lines || []).map((l) => {
        if (l.hr) return '-'.repeat(w);
        if (l.feed) return '\n'.repeat(Math.max(0, l.feed - 1));
        if (l.cut) return '--- cut ---';
        if (l.drawer) return '--- drawer ---';
        return l.t ?? '';
    }).join('\n');
}

module.exports = {
    columnsFor, money, wrap, row, center,
    renderKot, renderBill, renderTest, toPlainText, billTotals,
    orderTypeLabel,
};
