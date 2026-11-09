/**
 * Billing cycles for the SaaS plans (PRICING_PACKAGING.md §3).
 *
 *   monthly   — 1 month,  cancel any time
 *   annual    — 12 months, prepaid
 *   biennial  — 24 months, prepaid ("2-year prepay")
 *
 * Plan prices are stored in rupees BEFORE GST. GST (18%) is added on top at
 * checkout, so everything that moves money works in integer PAISE here to
 * avoid float drift: Razorpay is charged round(base x 1.18) and an invoice
 * shows base, GST, rate and total.
 *
 * Pure functions, no I/O — shared by the models, the Razorpay wrapper, the
 * payment-apply helper, the webhook, the invoice PDF and the MRR reports.
 */
'use strict';

const CYCLES = { monthly: 1, annual: 12, biennial: 24 };
const CYCLE_KEYS = Object.keys(CYCLES);
const DEFAULT_CYCLE = 'monthly';

const DEFAULT_GST_RATE = 18;

// Platform GST rate in percent. BILLING_GST_RATE overrides (e.g. a rate change
// or 0 for a tax-exempt deployment); anything unparseable falls back to 18.
function gstRate() {
    const raw = process.env.BILLING_GST_RATE;
    if (raw === undefined || raw === '') return DEFAULT_GST_RATE;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_GST_RATE;
}

function isCycle(c) {
    return typeof c === 'string' && Object.prototype.hasOwnProperty.call(CYCLES, c);
}

// Unknown / missing cycle → monthly (every pre-annual tenant is monthly).
function normalizeCycle(c) {
    return isCycle(c) ? c : DEFAULT_CYCLE;
}

function monthsFor(cycle) {
    return CYCLES[normalizeCycle(cycle)];
}

// +n calendar months, clamped to the last day of the target month
// (31 Jan + 1 month → 28/29 Feb, not 3 Mar; 29 Feb + 12 months → 28 Feb).
function addMonths(from, months) {
    const d = new Date(from);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
}

function addCycle(from, cycle) {
    return addMonths(from, monthsFor(cycle));
}

const toPaise = (rupees) => Math.round(Number(rupees) * 100);

// Base price (rupees, excl. GST) → { basePaise, gstPaise, totalPaise, gstRate }.
function priceWithGst(basePrice, rate = gstRate()) {
    const basePaise = toPaise(basePrice);
    const totalPaise = Math.round(basePaise * (100 + rate) / 100);
    return { basePaise, gstPaise: totalPaise - basePaise, totalPaise, gstRate: rate };
}

// GST-inclusive total (paise) → { basePaise, gstPaise, totalPaise, gstRate }.
function splitGst(totalPaise, rate = gstRate()) {
    const total = Math.round(Number(totalPaise) || 0);
    const basePaise = Math.round(total * 100 / (100 + rate));
    return { basePaise, gstPaise: total - basePaise, totalPaise: total, gstRate: rate };
}

// Price per month, in rupees (2dp), of a cycle price.
function monthlyEquivalent(price, cycle) {
    const p = Number(price);
    if (!Number.isFinite(p)) return 0;
    return Math.round((p / monthsFor(cycle)) * 100) / 100;
}

// Percent saved vs paying the monthly list price for the same months.
function savingsPct(price, cycle, monthlyPrice) {
    const m = Number(monthlyPrice);
    if (!(m > 0) || !(Number(price) > 0)) return 0;
    const pct = (1 - monthlyEquivalent(price, cycle) / m) * 100;
    return Math.max(0, Math.round(pct));
}

/**
 * The base price (rupees, excl. GST) of `cycle` on a plan document / lean
 * object, or null when the plan does not sell that cycle.
 *
 *   plan.prices[cycle]  — explicit per-cycle price (null = unavailable)
 *   plan.price          — the monthly list price (kept for every older reader)
 *
 * A legacy plan with billingCycle 'yearly' and no `prices` block carries its
 * single price as an annual price.
 */
function priceForPlan(plan, cycle) {
    if (!plan) return null;
    const c = normalizeCycle(cycle);
    const prices = plan.prices || {};
    const explicit = prices[c];
    if (typeof explicit === 'number' && explicit > 0) return explicit;
    const hasAnyExplicit = CYCLE_KEYS.some(k => typeof prices[k] === 'number' && prices[k] > 0);
    if (hasAnyExplicit) return null;
    if (plan.billingCycle === 'yearly') return c === 'annual' && plan.price > 0 ? plan.price : null;
    if (c === 'monthly' && typeof plan.price === 'number' && plan.price > 0) return plan.price;
    return null;
}

// Cycles the plan sells, in monthly → biennial order.
function availableCycles(plan) {
    return CYCLE_KEYS.filter(c => priceForPlan(plan, c) !== null);
}

/**
 * Price rows for a plan card / the public pricing page. Money in RUPEES:
 * price = base (excl. GST), gst = GST on top, total = what is charged,
 * perMonthEquivalent = base / months, savingsPctVsMonthly = vs paying monthly.
 */
function buildCycleRows(plan) {
    const rate = gstRate();
    const monthly = priceForPlan(plan, 'monthly');
    const rows = [];
    for (const cycle of CYCLE_KEYS) {
        const base = priceForPlan(plan, cycle);
        if (base === null) continue;
        const money = priceWithGst(base, rate);
        rows.push({
            cycle,
            months: monthsFor(cycle),
            price: base,
            gst: money.gstPaise / 100,
            total: money.totalPaise / 100,
            perMonthEquivalent: monthlyEquivalent(base, cycle),
            savingsPctVsMonthly: cycle === 'monthly' ? 0 : savingsPct(base, cycle, monthly),
        });
    }
    return rows;
}

// Razorpay plan shape for a cycle.
const RAZORPAY_INTERVAL = {
    monthly:  { period: 'monthly', interval: 1 },
    annual:   { period: 'yearly',  interval: 1 },
    biennial: { period: 'yearly',  interval: 2 },
};

// total_count per cycle — effectively "until the customer cancels".
const RAZORPAY_TOTAL_COUNT = { monthly: 120, annual: 10, biennial: 5 };

/**
 * Invoice money split for a captured payment. When the customer paid at least
 * the GST-inclusive price of the plan the amount is split into base + GST.
 * Anything below that is a pre-GST legacy charge (an existing monthly
 * subscription still on its old Razorpay plan): shown as base only, no GST.
 */
function invoiceAmounts(paidPaise, basePrice) {
    const paid = Math.round(Number(paidPaise) || 0);
    const rate = gstRate();
    if (typeof basePrice === 'number' && basePrice > 0) {
        const expected = priceWithGst(basePrice, rate).totalPaise;
        if (paid < expected) return { baseAmount: paid, gstAmount: 0, gstRate: 0, amount: paid };
    }
    const s = splitGst(paid, rate);
    return { baseAmount: s.basePaise, gstAmount: s.gstPaise, gstRate: rate, amount: paid };
}

module.exports = {
    CYCLES,
    CYCLE_KEYS,
    DEFAULT_CYCLE,
    DEFAULT_GST_RATE,
    RAZORPAY_INTERVAL,
    RAZORPAY_TOTAL_COUNT,
    gstRate,
    isCycle,
    normalizeCycle,
    monthsFor,
    addMonths,
    addCycle,
    priceWithGst,
    splitGst,
    monthlyEquivalent,
    savingsPct,
    priceForPlan,
    availableCycles,
    buildCycleRows,
    invoiceAmounts,
};
