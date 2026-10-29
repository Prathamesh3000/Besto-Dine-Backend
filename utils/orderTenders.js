'use strict';
/**
 * Defensive "how was this order paid" helper. Orders carry either the new
 * `payments[]` split (method + amount per tender) or only the legacy single
 * `paymentMethod` string with `amountPaid`. Callers get one normalised list
 * of { method, amount } with method in cash|upi|card|wallet|online|other,
 * whichever shape the order has. Never throws on odd data.
 */
const METHOD_MAP = {
    cash: 'cash',
    upi: 'upi',
    card: 'card', 'credit card': 'card', 'debit card': 'card',
    wallet: 'wallet', 'bestodine wallet': 'wallet',
    razorpay: 'online', online: 'online', netbanking: 'online',
};

function normaliseMethod(m) {
    const k = String(m || '').trim().toLowerCase();
    if (!k || k === 'not selected') return null;
    if (METHOD_MAP[k]) return METHOD_MAP[k];
    if (k.includes('upi')) return 'upi';
    if (k.includes('card')) return 'card';
    if (k.includes('cash')) return 'cash';
    if (k.includes('wallet')) return 'wallet';
    if (k.includes('razorpay') || k.includes('online')) return 'online';
    return 'other';
}

const toPaise = (n) => Math.round((Number(n) || 0) * 100);

/**
 * @returns {{method:string, paise:number}[]}  merged per method, paise > 0.
 * An empty array means "tender unknown" (caller posts to the party ledger).
 */
function orderTenders(order) {
    const out = new Map();
    const add = (method, paise) => {
        if (!method || !(paise > 0)) return;
        out.set(method, (out.get(method) || 0) + paise);
    };
    const payments = Array.isArray(order?.payments) ? order.payments : [];
    if (payments.length) {
        for (const p of payments) add(normaliseMethod(p?.method) || 'other', toPaise(p?.amount));
    } else {
        const method = normaliseMethod(order?.paymentMethod) || normaliseMethod(order?.payment?.method);
        const amount = Number(order?.amountPaid) > 0 ? order.amountPaid : order?.payment?.amount;
        add(method, toPaise(amount));
    }
    return [...out.entries()].filter(([, v]) => v > 0).map(([method, paise]) => ({ method, paise }));
}

module.exports = { orderTenders, normaliseMethod };
