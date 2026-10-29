'use strict';
/**
 * Per-tender payments (Plan task 2.3).
 *
 * An order records what was collected as `payments[]` lines
 * ({ method, amount, reference, receivedBy, at, source }). The legacy
 * summary fields (`paymentMethod`, `amountPaid`, `paymentStatus`,
 * `walletAmountPaid`) stay and are written on every change, so every
 * existing reader keeps working. Old orders are NOT backfilled: getTenders
 * synthesises the lines from the legacy fields on read.
 */

const TENDER_METHODS = ['cash', 'upi', 'card', 'wallet', 'razorpay', 'other'];
// What a staff member may enter at the counter. wallet / razorpay lines are
// only ever appended by the server flows that actually move that money.
const COUNTER_METHODS = ['cash', 'upi', 'card', 'other'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Same tolerance as the existing settle checks (utils/paymentState, status service).
const EPS = 0.01;

/** Normalise a free-text / legacy method to a tender method ('' when unknown). */
function normalizeMethod(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v || v === 'not selected' || v === 'none') return '';
    if (v === 'cash' || v === 'counter') return 'cash';
    if (v === 'upi' || v === 'upi-qr-manual') return 'upi';
    if (v === 'card' || v === 'credit card' || v === 'debit card') return 'card';
    if (v === 'wallet') return 'wallet';
    if (v === 'online' || v === 'razorpay' || v === 'stripe') return 'razorpay';
    if (TENDER_METHODS.includes(v)) return v;
    return 'other';
}

// The legacy `paymentMethod` text each tender method maps to (matches what
// the existing flows wrote: 'online' for gateway money, 'UPI' for the QR).
const LEGACY_LABEL = {
    cash: 'cash', upi: 'UPI', card: 'card', wallet: 'wallet', razorpay: 'online', other: 'other',
};

const plain = (o) => (o && typeof o.toObject === 'function' ? o.toObject() : o);

/**
 * The order's tender lines: payments[] when present, else one or two lines
 * synthesised from the legacy fields. Never throws; [] when nothing was paid.
 */
function getTenders(order) {
    const o = plain(order);
    if (!o) return [];
    if (Array.isArray(o.payments) && o.payments.length) {
        const lines = o.payments
            .map((p) => ({
                method: normalizeMethod(p.method) || 'other',
                amount: round2(p.amount),
                reference: p.reference || '',
                receivedBy: p.receivedBy || null,
                at: p.at || null,
                source: p.source || '',
            }))
            .filter((p) => p.amount > 0);
        // Money recorded before payments[] existed (e.g. a wallet part-payment
        // taken before deploy, then topped up by a line) is in amountPaid but
        // in no line: surface the gap as one legacy line so totals stay equal.
        const gap = round2(round2(o.amountPaid) - sumTenders(lines));
        if (gap > EPS) {
            const wallet = round2(o.walletAmountPaid);
            const method = wallet > 0 && Math.abs(wallet - gap) <= EPS
                ? 'wallet'
                : (String(o.paymentMethod || '').toLowerCase() === 'mixed' ? 'other' : (normalizeMethod(o.paymentMethod) || 'other'));
            lines.unshift({ method, amount: gap, reference: '', receivedBy: null, at: o.paidAt || null, source: 'legacy' });
        }
        return lines;
    }
    const paid = round2(o.amountPaid);
    if (paid <= 0) return [];
    const at = o.paidAt || null;
    const legacyRaw = String(o.paymentMethod || '').trim().toLowerCase();
    const wallet = Math.min(paid, round2(o.walletAmountPaid));
    // wallet + gateway split (razorpayController 'mixed'): wallet part is
    // walletAmountPaid, the remainder is the gateway capture.
    if (wallet > 0 && (legacyRaw === 'mixed' || legacyRaw === 'online')) {
        const rest = round2(paid - wallet);
        const lines = [{ method: 'wallet', amount: wallet, reference: '', receivedBy: null, at, source: 'legacy' }];
        if (rest > 0) {
            lines.push({
                method: 'razorpay', amount: rest, reference: o.razorpayPaymentId || '', receivedBy: null, at, source: 'legacy',
            });
        }
        return lines;
    }
    const method = normalizeMethod(o.paymentMethod) || 'other';
    return [{
        method,
        amount: paid,
        reference: method === 'razorpay' ? (o.razorpayPaymentId || '') : '',
        receivedBy: null, at, source: 'legacy',
    }];
}

/** Sum of tender amounts (rupees, 2dp). Accepts an order or a lines array. */
function sumTenders(input) {
    const lines = Array.isArray(input) ? input : getTenders(input);
    return round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
}

/** Per-method totals, e.g. { cash: 100, upi: 50 }. */
function totalsByMethod(input) {
    const lines = Array.isArray(input) ? input : getTenders(input);
    const out = {};
    for (const l of lines) out[l.method] = round2((out[l.method] || 0) + (Number(l.amount) || 0));
    return out;
}

/**
 * Summary written onto the legacy fields: { method, amountPaid, status,
 * walletAmountPaid, due, change }.
 *   method  'mixed' when more than one distinct method, the legacy label of
 *           the single method otherwise, 'Not selected' with no tenders.
 *   status  'Paid' when paid >= due - tolerance, 'Partially Paid' when
 *           0 < paid < due, else 'Pending'. `due` is what is left to pay
 *           (total - discount), tip included by the caller as it sees fit.
 *   change  paid beyond due (cash change), never negative.
 */
function summarizeTenders(input, { due = 0, tolerance = EPS } = {}) {
    const lines = Array.isArray(input) ? input : getTenders(input);
    const byMethod = totalsByMethod(lines);
    const methods = Object.keys(byMethod).filter((m) => byMethod[m] > 0);
    const paid = sumTenders(lines);
    const owed = round2(Math.max(0, due));
    let method = 'Not selected';
    if (methods.length > 1) method = 'mixed';
    else if (methods.length === 1) method = LEGACY_LABEL[methods[0]] || 'other';
    let status = 'Pending';
    if (paid > 0) status = paid >= owed - tolerance ? 'Paid' : 'Partially Paid';
    return {
        method,
        amountPaid: paid,
        status,
        walletAmountPaid: byMethod.wallet || 0,
        due: owed,
        change: round2(Math.max(0, paid - owed)),
        byMethod,
    };
}

/**
 * Validate staff-entered lines from a request body. Returns
 * { lines } or { error: { code, message } }. Lines carry method / amount /
 * reference only; the caller stamps receivedBy / at / source.
 */
function parseCounterTenders(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: { code: 'INVALID_PAYMENTS', message: 'payments must be a non-empty list of { method, amount }.' } };
    }
    if (raw.length > 10) {
        return { error: { code: 'INVALID_PAYMENTS', message: 'At most 10 payment lines are allowed.' } };
    }
    const lines = [];
    for (const p of raw) {
        const method = normalizeMethod(p && p.method);
        if (!COUNTER_METHODS.includes(method)) {
            return { error: { code: 'INVALID_PAYMENT_METHOD', message: `Payment method must be one of ${COUNTER_METHODS.join(', ')}.` } };
        }
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return { error: { code: 'INVALID_AMOUNT', message: 'Each payment amount must be a positive number.' } };
        }
        let reference = '';
        if (p.reference !== undefined && p.reference !== null && p.reference !== '') {
            if (typeof p.reference !== 'string' || p.reference.length > 40) {
                return { error: { code: 'INVALID_PAYMENT_REFERENCE', message: 'Payment reference must be text of at most 40 characters.' } };
            }
            reference = p.reference.trim();
        }
        lines.push({ method, amount: round2(amount), reference });
    }
    return { lines };
}

module.exports = {
    TENDER_METHODS,
    COUNTER_METHODS,
    LEGACY_LABEL,
    round2,
    normalizeMethod,
    getTenders,
    sumTenders,
    totalsByMethod,
    summarizeTenders,
    parseCounterTenders,
};
