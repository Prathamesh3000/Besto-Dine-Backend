/**
 * KOT rounds and ticket numbers (CAPTAIN_FLOW_UPDATE_PLAN.md Phase 2, D6).
 *
 *  - kotNo     per-order round: 1 on create, +1 on every append / repeat.
 *              Stored on each order line (item.kotNo) and in order.kots[].
 *  - ticketNo  daily per-branch ticket number printed on the slip
 *              ("KOT #12"). Restarts each server-local day (same day
 *              boundary as the token-number counter) per restaurant+branch.
 *
 * Everything is optional on the order: a legacy order (no kotNo on its
 * lines, no kots[]) is treated as a single round 1.
 *
 * Concurrency: the round is allocated with ONE atomic findOneAndUpdate on
 * the order (pipeline update: kotRoundSeq = max(kotRoundSeq, floor) + 1),
 * not by reading max(item.kotNo) and adding one in memory. Two concurrent
 * appends each hold a stale in-memory copy of the order, so a read-then-
 * write would hand both the same round; the server-side $max/$add cannot.
 * `floor` seeds legacy orders (no counter yet) from the highest round the
 * caller can see. The in-memory doc's kotRoundSeq is deliberately NOT
 * updated: it is not a modified path, so the later order.save() never
 * writes it back and cannot roll the counter backwards.
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const KotTicketCounter = require('../models/kotTicketCounter');
const { localDayKey } = require('./orderToken');

/** Highest round on the order; lines without kotNo count as round 1. */
function maxRound(order) {
    let max = 1;
    for (const it of order?.items || []) {
        const n = Number(it.kotNo) || 1;
        if (n > max) max = n;
    }
    for (const k of order?.kots || []) {
        if ((Number(k.kotNo) || 0) > max) max = Number(k.kotNo);
    }
    return max;
}

/** Next daily ticket number for restaurant + branch (null branch = tenant-level). */
async function nextTicketNo(restaurantId, branchId = null, date = new Date()) {
    if (!restaurantId) return null;
    const day = typeof date === 'string' ? date : localDayKey(date);
    const counter = await KotTicketCounter.findOneAndUpdate(
        { restaurant: restaurantId, branch: branchId || null, day },
        { $inc: { seq: 1 }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' },
    ).lean();
    return counter.seq;
}

/** Atomically claim the next round number of an existing order. */
async function allocateRound(order) {
    const floor = maxRound(order);
    const updated = await Order.findOneAndUpdate(
        { _id: order._id },
        [{ $set: { kotRoundSeq: { $add: [{ $max: [{ $ifNull: ['$kotRoundSeq', 0] }, floor] }, 1] } } }],
        { returnDocument: 'after', projection: { kotRoundSeq: 1 }, updatePipeline: true },
    ).lean();
    return updated.kotRoundSeq;
}

function sumQty(items) {
    return (items || []).reduce((n, i) => n + (Number(i.quantity) || 1), 0);
}

/**
 * Round 1 for a brand-new order doc (plain data, not yet saved): stamps
 * kotNo on every line, sets kotRoundSeq and the first kots[] entry.
 */
function stampFirstRound(docData, { ticketNo, sentBy = null, sentAt = new Date() } = {}) {
    if (!docData || !Array.isArray(docData.items)) return null;
    for (const it of docData.items) {
        it.kotNo = 1;
        if (!it._id) it._id = new mongoose.Types.ObjectId(); // so kots[].items can point at the line
    }
    docData.kotRoundSeq = 1;
    docData.kots = [{
        kotNo: 1, ticketNo: ticketNo ?? null, sentAt, sentBy: sentBy || null,
        itemCount: sumQty(docData.items),
        items: docData.items.map((i) => ({ itemId: i._id, name: i.name, quantity: Number(i.quantity) || 1 })),
    }];
    return { kotNo: 1, ticketNo: ticketNo ?? null };
}

/**
 * BEFORE merging `incoming` lines into order.items: claim the next round +
 * a ticket number and stamp kotNo on the incoming lines. A later failure
 * (e.g. QUANTITY_EXCEEDED) can leave a gap in the numbers; gaps are fine,
 * duplicates are not.
 */
async function beginAppendRound(order, incoming, { sentBy = null } = {}) {
    const kotNo = await allocateRound(order);
    const ticketNo = await nextTicketNo(order.restaurant, order.branch || null);
    for (const it of incoming) it.kotNo = kotNo;
    return { kotNo, ticketNo, sentBy, sentAt: new Date() };
}

/**
 * AFTER merging: log the send in order.kots[]. Lines that merged into an
 * existing row are resolved to that row's _id so the round still lists them.
 */
function recordRound(order, round, incoming) {
    const { orderLineKey } = require('../services/orderHelpers');
    const items = incoming.map((inc) => {
        const line = (order.items || []).find((t) => orderLineKey(t) === orderLineKey(inc));
        return { itemId: line?._id, name: inc.name, quantity: Math.max(1, Math.floor(Number(inc.quantity) || 1)) };
    });
    if (!order.kots) order.kots = [];
    order.kots.push({
        kotNo: round.kotNo, ticketNo: round.ticketNo, sentAt: round.sentAt, sentBy: round.sentBy || null,
        itemCount: items.reduce((n, i) => n + i.quantity, 0), items,
    });
}

/** Rounds of an order with legacy (kotNo-less) lines grouped as round 1. */
function roundsOf(order) {
    const byNo = new Map();
    const get = (n) => {
        if (!byNo.has(n)) byNo.set(n, { kotNo: n, ticketNo: null, sentAt: null, sentBy: null, entry: null, docs: [] });
        return byNo.get(n);
    };
    for (const k of order.kots || []) {
        const r = get(Number(k.kotNo));
        r.entry = k; r.ticketNo = k.ticketNo ?? null; r.sentAt = k.sentAt || null; r.sentBy = k.sentBy || null;
    }
    for (const it of order.items || []) {
        const r = get(Number(it.kotNo) || 1);
        r.docs.push(it);
    }
    for (const r of byNo.values()) {
        if (!r.sentAt) {
            // Legacy / un-logged round: earliest line time, else order creation.
            const times = r.docs.map((d) => d.addedAt).filter(Boolean).map((d) => new Date(d).getTime());
            r.sentAt = times.length ? new Date(Math.min(...times)) : (order.createdAt || null);
        }
    }
    for (const r of byNo.values()) {
        const snap = r.entry && r.entry.items && r.entry.items.length ? r.entry.items : null;
        r.lines = snap
            ? snap.map((si) => {
                const doc = (order.items || []).find((d) => si.itemId && String(d._id) === String(si.itemId)) || null;
                return { _id: si.itemId || doc?._id || null, name: si.name || doc?.name, quantity: si.quantity, doc };
            })
            : r.docs.map((d) => ({ _id: d._id, name: d.name, quantity: d.quantity, doc: d }));
    }
    return [...byNo.values()].sort((a, b) => a.kotNo - b.kotNo);
}

/** Printable line items of a round: the order line, with the quantity that round sent. */
function roundItems(round) {
    return round.lines.map((l) => {
        const base = l.doc ? (typeof l.doc.toObject === 'function' ? l.doc.toObject() : { ...l.doc }) : { name: l.name };
        return { ...base, name: l.name || base.name, quantity: l.quantity };
    });
}

/** Header numbers for a slip: the round's, or the whole-order reprint's. */
function kotForSlip(order, kotNo) {
    const rounds = roundsOf(order);
    const r = rounds.find((x) => x.kotNo === kotNo);
    if (!r) return null;
    return { kotNo: r.kotNo, ticketNo: r.ticketNo };
}

module.exports = {
    maxRound, nextTicketNo, allocateRound, stampFirstRound, beginAppendRound, recordRound, roundsOf, roundItems, kotForSlip,
};
