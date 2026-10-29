/**
 * incentiveService — item-wise staff incentives (CAPTAIN_FLOW §8-9,
 * CAPTAIN_FLOW_UPDATE_PLAN Phase 5, decisions D2 / D3 / D11).
 *
 * D3  An incentive is earned when the item line is SERVED and the order is
 *     PAID. Whichever happens second triggers the accrual:
 *       only one of the two true  -> entry 'pending'
 *       both true                 -> entry 'confirmed'
 *     (Items are served per order: order.status === 'served'.)
 * D2  The staff member credited is the order's waiter of record
 *     (order.waiter) AT ACCRUAL TIME. A pending entry follows the waiter of
 *     record if it changes before confirmation; a confirmed entry never
 *     moves. Orders with no waiter (guest / kiosk self-order) earn nothing,
 *     and so does a waiter of record whose role is not in the campaign's
 *     staffRoles.
 * D11 Gated by the `incentives` plan module (utils/featureAccess). The hot
 *     paths call `accrueSafe` / `reverseIfVoidSafe`, which never throw and
 *     exit after ONE indexed query when the tenant has no campaigns.
 *
 * Idempotency: unique (order, itemKey, campaign). Duplicate payment
 * callbacks, retries and concurrent hooks collapse into one row.
 * Reversed is terminal: a reversed entry is never revived.
 *
 * Caps are best-effort under concurrency (read-then-write): two accruals for
 * the same staff racing at the exact cap boundary can overshoot by one line.
 */
const mongoose = require('mongoose');
const IncentiveCampaign = require('../models/incentiveCampaign');
const IncentiveEntry = require('../models/incentiveEntry');
const Restaurant = require('../models/restaurant');
const Order = require('../models/order');
const User = require('../models/user');
const { hasFeature } = require('../utils/featureAccess');
const { formatBillNo } = require('../utils/billNumber');
const logger = require('../utils/logger');

const DEFAULT_TZ = process.env.ANALYTICS_TIMEZONE || 'Asia/Kolkata';
const ROLES = ['captain', 'waiter'];

// --- time helpers -----------------------------------------------------------
function safeTz(tz) {
    const t = typeof tz === 'string' ? tz.trim() : '';
    if (!t) return DEFAULT_TZ;
    try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; } catch { return DEFAULT_TZ; }
}

/** Business day (YYYY-MM-DD) of an instant in the given timezone. */
function dayKey(date, tz) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(date));
}

function tzOffsetMs(instantMs, tz) {
    const p = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(instantMs));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instants [start, end] of a local calendar day (YYYY-MM-DD) in tz. */
function dayBounds(day, tz) {
    const zone = safeTz(tz);
    const [y, m, d] = day.split('-').map(Number);
    const at = (h, mi, s, ms) => {
        const wall = Date.UTC(y, m - 1, d, h, mi, s, ms);
        let guess = wall - tzOffsetMs(wall, zone);
        guess = wall - tzOffsetMs(guess, zone);
        return new Date(guess);
    };
    return { start: at(0, 0, 0, 0), end: at(23, 59, 59, 999) };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDayString = (v) => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());

// --- campaign status (derived) ---------------------------------------------
function campaignStatus(c, now = new Date()) {
    if (c.paused) return 'paused';
    if (now < new Date(c.startDate)) return 'upcoming';
    if (now > new Date(c.endDate)) return 'ended';
    return 'active';
}

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const idStr = (v) => (v == null ? '' : String(v._id || v));

// --- accrual ---------------------------------------------------------------
function branchMatches(campaign, orderBranch) {
    if (!campaign.branch) return true;
    return !!orderBranch && idStr(campaign.branch) === idStr(orderBranch);
}

/** Lines of the order that earn under at least one campaign -> [{line, campaign}] */
function matchLines(order, campaigns, staffRole) {
    const out = [];
    for (const line of order.items || []) {
        if (!line?._id || !line.menuItem || !(line.quantity > 0)) continue;
        const cands = campaigns.filter((c) =>
            c.items.some((i) => idStr(i) === String(line.menuItem))
            && c.staffRoles.includes(staffRole));
        if (!cands.length) continue;
        const exclusive = cands.filter((c) => c.stacking === 'exclusive');
        const chosen = exclusive.length
            ? [exclusive.reduce((best, c) => (c.rule.ratePerItem > best.rule.ratePerItem ? c : best))]
            : cands;
        for (const c of chosen) out.push({ line, campaign: c });
    }
    return out;
}

/**
 * Create / update ledger rows for an order. Returns a small summary (used by
 * tests): { created, updated, skipped }. Throws on unexpected errors - use
 * accrueSafe from request paths.
 */
async function accrueForOrder(order, { now = new Date() } = {}) {
    const summary = { created: 0, updated: 0, skipped: 0 };
    if (!order || !order.restaurant) return summary;
    if (order.status === 'cancelled' || order.paymentStatus === 'Refunded') return summary;
    const served = order.status === 'served';
    const paid = order.paymentStatus === 'Paid';
    if (!served && !paid) return summary;

    const restaurantId = idStr(order.restaurant);
    // Cheap early exit: one indexed query; tenants without campaigns stop here.
    const campaigns = await IncentiveCampaign.find({ restaurant: restaurantId }).limit(200).lean();
    if (!campaigns.length) return summary;

    const restaurant = await Restaurant.findById(restaurantId).select('subscription addons featureOverrides timezone').lean();
    if (!restaurant || !hasFeature(restaurant, 'incentives', now)) return summary;
    const tz = safeTz(restaurant.timezone);

    const orderId = order._id;
    const existing = await IncentiveEntry.find({ order: orderId, restaurant: restaurantId });
    // An entry's itemKey is the line id, or `<lineId>|q<total>` for a top-up row.
    const lineOf = (e) => String(e.itemKey).split('|')[0];
    // Quantity already credited per line+campaign (every state: a reversed row
    // is not re-credited), so a line that grew after accrual gets only the delta.
    const creditedByKey = new Map();
    for (const e of existing) {
        const k = `${lineOf(e)}|${idStr(e.campaign)}`;
        creditedByKey.set(k, (creditedByKey.get(k) || 0) + (Number(e.quantity) || 0));
    }

    const state = served && paid ? 'confirmed' : 'pending';
    const servedAt = served ? (order.servedAt || now) : null;
    const paidAt = paid ? (order.paidAt || now) : null;

    // Waiter of record (D2) + role eligibility.
    let staff = null;
    if (order.waiter) {
        staff = await User.findOne({ _id: order.waiter, restaurant: restaurantId }).select('role').lean();
        if (staff && !ROLES.includes(staff.role)) staff = null;
    }

    // Lines that vanished from the order lose their entries.
    const lineIds = new Set((order.items || []).map((l) => idStr(l._id)));
    const orphan = existing.filter((e) => e.state !== 'reversed' && !lineIds.has(lineOf(e))).map((e) => e._id);
    if (orphan.length) {
        await IncentiveEntry.updateMany(
            { _id: { $in: orphan }, restaurant: restaurantId, state: { $ne: 'reversed' } },
            { $set: { state: 'reversed', reversedAt: now, reverseReason: 'item removed from order' } },
        );
    }

    // 1) Existing pending rows: advance them (confirm, refresh timestamps / staff).
    for (const e of existing) {
        if (e.state !== 'pending' || !lineIds.has(lineOf(e))) continue;
        const set = { servedAt: servedAt || e.servedAt, paidAt: paidAt || e.paidAt, state };
        if (staff && idStr(e.staff) !== idStr(staff._id)) {
            const camp = campaigns.find((c) => idStr(c._id) === idStr(e.campaign));
            if (camp && camp.staffRoles.includes(staff.role)) { set.staff = staff._id; set.staffRole = staff.role; }
        }
        const r = await IncentiveEntry.updateOne({ _id: e._id, restaurant: restaurantId, state: 'pending' }, { $set: set });
        if (r.modifiedCount) summary.updated += 1;
    }

    // 2) New rows for matching lines under campaigns that are running now.
    if (!staff) return summary;
    const running = campaigns.filter((c) =>
        campaignStatus(c, now) === 'active' && branchMatches(c, order.branch));
    if (!running.length) return summary;

    const rid = new mongoose.Types.ObjectId(restaurantId);
    const day = dayKey(servedAt || paidAt || now, tz);
    for (const { line, campaign } of matchLines(order, running, staff.role)) {
        const key = `${line._id}|${idStr(campaign._id)}`;
        const credited = creditedByKey.get(key) || 0;
        // Quantity reductions are not trimmed here (no reduction path exists for
        // served/paid lines); only growth is topped up.
        if (credited > 0 && !(Number(line.quantity) > credited)) { summary.skipped += 1; continue; }
        const totalQty = Number(line.quantity);
        const itemKey = credited > 0 ? `${line._id}|q${totalQty}` : String(line._id);

        let qty = totalQty - credited;
        const rate = money(campaign.rule.ratePerItem);
        if (campaign.maxPerStaffPerDay > 0) {
            const [{ q = 0 } = {}] = await IncentiveEntry.aggregate([
                { $match: { restaurant: rid, campaign: campaign._id, staff: staff._id, day, state: { $ne: 'reversed' } } },
                { $group: { _id: null, q: { $sum: '$quantity' } } },
            ]);
            qty = Math.min(qty, campaign.maxPerStaffPerDay - q);
        }
        if (campaign.budgetCap > 0 && rate > 0) {
            const [{ a = 0 } = {}] = await IncentiveEntry.aggregate([
                { $match: { restaurant: rid, campaign: campaign._id, state: { $ne: 'reversed' } } },
                { $group: { _id: null, a: { $sum: '$amount' } } },
            ]);
            qty = Math.min(qty, Math.floor((campaign.budgetCap - a + 1e-9) / rate));
        }
        if (!(qty > 0)) { summary.skipped += 1; continue; }

        try {
            await IncentiveEntry.create({
                restaurant: restaurantId,
                branch: order.branch || null,
                campaign: campaign._id,
                order: orderId,
                orderId: order.orderId || '',
                billNo: formatBillNo(order.bill),
                itemKey,
                menuItem: mongoose.isValidObjectId(line.menuItem) ? line.menuItem : null,
                itemName: line.name || '',
                quantity: qty,
                rate,
                amount: money(qty * rate),
                staff: staff._id,
                staffRole: staff.role,
                state,
                day,
                servedAt,
                paidAt,
            });
            summary.created += 1;
        } catch (err) {
            if (err?.code !== 11000) throw err;
            summary.skipped += 1;   // a concurrent caller won; theirs is the row
        }
    }
    return summary;
}

// Background work started by the request-path hooks; tests await idle().
const inflight = new Set();
function track(p) {
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
}
/** Resolves when every fire-and-forget hook started so far has finished. */
async function idle() {
    while (inflight.size) await Promise.allSettled([...inflight]);
}

/** Minimal plain copy: the hook runs after the request moved on. */
function snapshot(order) {
    return {
        _id: order._id, orderId: order.orderId, restaurant: order.restaurant, branch: order.branch || null,
        status: order.status, paymentStatus: order.paymentStatus, servedAt: order.servedAt, paidAt: order.paidAt,
        waiter: order.waiter || null, bill: order.bill ? { billNo: order.bill.billNo, financialYear: order.bill.financialYear } : undefined,
        items: (order.items || []).map((l) => ({ _id: l._id, menuItem: l.menuItem, name: l.name, quantity: l.quantity })),
    };
}

/**
 * Fire-and-forget hook for request paths (paid / served): never throws, never
 * delays or fails the caller, logs failures. Returns the tracked promise.
 */
function accrueSafe(order) {
    let snap;
    try { snap = snapshot(order); } catch (err) {
        logger.warn(`incentive snapshot failed: ${err.message}`);
        return Promise.resolve(null);
    }
    return track((async () => {
        try { return await accrueForOrder(snap); } catch (err) {
            logger.warn(`incentive accrual failed for ${snap.orderId || snap._id}: ${err.message}`);
            return null;
        }
    })());
}

// --- reversal --------------------------------------------------------------
/** Set every pending / confirmed entry of the order to 'reversed'. */
async function reverseForOrder(orderOrId, reason = 'order reversed') {
    const orderId = orderOrId && orderOrId._id ? orderOrId._id : orderOrId;
    if (!orderId) return { reversed: 0 };
    // AUDIT-EXEMPT: keyed by the order's own _id (callers hold an order already loaded under its tenant, or the cross-tenant reconcile job)
    const r = await IncentiveEntry.updateMany(
        { order: orderId, state: { $in: ['pending', 'confirmed'] } },
        { $set: { state: 'reversed', reversedAt: new Date(), reverseReason: String(reason).slice(0, 300) } },
    );
    const n = r.modifiedCount || 0;
    if (n) logger.info(`Incentive entries reversed for order ${orderOrId.orderId || orderId}: ${n} (${reason})`);
    return { reversed: n };
}

/**
 * Reverse only when the order is truly void (cancelled or fully refunded).
 * A partial refund keeps its entries (it cannot be mapped to item lines).
 * Reads fresh state so callers do not need the saved document.
 */
async function reverseIfVoid(orderOrId, reason) {
    const orderId = orderOrId && orderOrId._id ? orderOrId._id : orderOrId;
    if (!orderId) return { reversed: 0 };
    const has = await IncentiveEntry.exists({ order: orderId, state: { $in: ['pending', 'confirmed'] } });
    if (!has) return { reversed: 0 };
    const o = await Order.findById(orderId).select('status paymentStatus').lean().setOptions({ skipTenantScope: true });
    if (!o || (o.status !== 'cancelled' && o.paymentStatus !== 'Refunded')) return { reversed: 0 };
    return reverseForOrder(orderId, reason || (o.status === 'cancelled' ? 'order cancelled' : 'order refunded'));
}

function reverseIfVoidSafe(orderOrId, reason) {
    return track((async () => {
        try { return await reverseIfVoid(orderOrId, reason); } catch (err) {
        logger.warn(`incentive reversal failed for ${orderOrId?.orderId || orderOrId?._id || orderOrId}: ${err.message}`);
            return null;
        }
    })());
}

// --- reconciliation --------------------------------------------------------
/**
 * Safety net for paths that bypass the hooks (sweepers, table clears, wallet
 * edge cases): (1) reverse entries whose order was cancelled / refunded,
 * (2) re-run accrual for recently touched served-or-paid orders of tenants
 * that have campaigns. Idempotent; scheduled from server.js.
 */
async function reconcile({ lookbackHours = 48, restaurant = null } = {}) {
    const out = { reversed: 0, accrued: 0, tenants: 0 };
    const scope = restaurant ? { restaurant: idStr(restaurant) } : {};
    const since = new Date(Date.now() - lookbackHours * 3600 * 1000);

    const open = await IncentiveEntry.distinct('order', { ...scope, state: { $in: ['pending', 'confirmed'] } }).setOptions({ skipTenantScope: true });
    if (open.length) {
        // AUDIT-EXEMPT: system reconcile job; `open` holds order ids read from the ledger, which is scoped to `scope` when a tenant is given
        const voided = await Order.find({
            _id: { $in: open }, $or: [{ status: 'cancelled' }, { paymentStatus: 'Refunded' }],
        }).select('_id orderId').lean().setOptions({ skipTenantScope: true });
        for (const o of voided) out.reversed += (await reverseForOrder(o, 'reconcile: order void')).reversed;
    }

    const tenants = await IncentiveCampaign.distinct('restaurant', scope).setOptions({ skipTenantScope: true });
    out.tenants = tenants.length;
    const nowD = new Date();
    for (const rid of tenants) {
        // Cheap-first: feature gate, then a campaign active now or ended within the window.
        const restaurant = await Restaurant.findById(rid).select('subscription addons featureOverrides').lean();
        if (!restaurant || !hasFeature(restaurant, 'incentives', nowD)) continue;
        const camps = await IncentiveCampaign.find({ restaurant: rid }).limit(200).lean().setOptions({ skipTenantScope: true });
        const live = camps.some((c) => campaignStatus(c, nowD) === 'active'
            || (c.endDate && new Date(c.endDate) >= since));
        if (!live) continue;
        const orders = await Order.find({
            restaurant: rid, updatedAt: { $gte: since },
            status: { $ne: 'cancelled' }, $or: [{ status: 'served' }, { paymentStatus: 'Paid' }],
        }).select('_id orderId restaurant branch status paymentStatus servedAt paidAt waiter bill.billNo bill.financialYear items._id items.menuItem items.name items.quantity')
            .limit(5000).lean().setOptions({ skipTenantScope: true });
        for (let i = 0; i < orders.length; i += 10) {
            const results = await Promise.all(orders.slice(i, i + 10).map((o) => accrueSafe(o)));
            for (const s of results) if (s) out.accrued += s.created + s.updated;
        }
    }
    return out;
}

let started = false;
function startScheduledIncentiveReconcile() {
    if (started) return;
    started = true;
    if (String(process.env.INCENTIVE_RECONCILE_DISABLED).toLowerCase() === 'true') return;
    const minutes = Number(process.env.INCENTIVE_RECONCILE_MINUTES) || 60;
    const { runWithoutContext } = require('../utils/requestContext');
    require('../utils/scheduler').scheduleJob('incentive-reconcile', minutes * 60 * 1000,
        () => runWithoutContext(() => reconcile()));
}

module.exports = {
    accrueForOrder, accrueSafe, idle, reverseForOrder, reverseIfVoid, reverseIfVoidSafe, reconcile,
    startScheduledIncentiveReconcile,
    campaignStatus, dayKey, dayBounds, safeTz, isDayString,
};
