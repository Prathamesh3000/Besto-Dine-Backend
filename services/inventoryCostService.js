'use strict';

/**
 * Weighted-average inventory costing (Phase 5).
 *
 * Pure functions + one guarded DB hook. Rules:
 *   - avgCost is null/undefined when unknown. Never invented from costPerUnit
 *     (unless INVENTORY_AVGCOST_SEED_FROM_LIST_COST=true, default off).
 *   - On receipt (restock / GRN / transfer_in):
 *       new = (oldQty*oldCost + inQty*inCost) / (oldQty + inQty)
 *     oldQty is floored at 0 (never negative); result rounded to 4 decimals.
 *   - Receipt with missing / non-positive cost, or zero inQty: avgCost unchanged.
 *   - Old stock on hand with unknown cost + a costed receipt: stays unknown
 *     (blending a known cost into unknown stock would invent a number).
 *   - Empty shelf (oldQty 0) + costed receipt: avgCost = inCost.
 *   - usage / waste / correction / transfer_out never touch avgCost.
 */

const COST_FACTOR = 10000;
const round4 = (n) => Math.round(Number(n) * COST_FACTOR) / COST_FACTOR + 0;
const isCost = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
const seedFromListCost = () => String(process.env.INVENTORY_AVGCOST_SEED_FROM_LIST_COST || '').toLowerCase() === 'true';

/**
 * @returns {number|null} the new average cost, or the (normalised) old cost
 * when the receipt carries no usable cost.
 */
function weightedAverageCost({ oldQty, oldCost, inQty, inCost, listCost } = {}) {
    let known = isCost(oldCost) ? round4(oldCost) : null;
    const qIn = Number(inQty);
    const qOld = Math.max(0, Number.isFinite(Number(oldQty)) ? Number(oldQty) : 0);
    if (!(qIn > 0) || !isCost(inCost) || Number(inCost) <= 0) return known;
    if (known === null && qOld > 0 && seedFromListCost() && isCost(listCost)) known = round4(listCost);
    if (qOld === 0) return round4(inCost);
    if (known === null) return null;
    return round4((qOld * known + qIn * Number(inCost)) / (qOld + qIn));
}

/**
 * Hook: call right after an atomic stock increase. Best-effort and guarded:
 * it never throws and never changes stock. `doc` is the inventory doc as
 * returned by Inventory.incStock (state after the increase).
 * Optimistic: the update only applies if avgCost is still what we read.
 */
async function recordReceiptCost({ Inventory, filter, doc, previousStock, inQty, unitCost }) {
    try {
        if (!(Number(inQty) > 0) || !isCost(unitCost) || Number(unitCost) <= 0) return null;
        const oldCost = isCost(doc?.avgCost) ? doc.avgCost : null;
        const next = weightedAverageCost({ oldQty: previousStock, oldCost, inQty, inCost: unitCost, listCost: doc?.costPerUnit });
        if (next === null || next === oldCost) return next;
        const guard = oldCost === null ? { $in: [null] } : oldCost;
        const res = await Inventory.updateOne({ ...filter, restaurant: doc.restaurant, avgCost: guard }, { $set: { avgCost: next, avgCostUpdatedAt: new Date() } });
        return (res && (res.matchedCount === 0 || res.modifiedCount === 0)) ? null : next;
    } catch {
        return null;
    }
}

/**
 * Valuation rows -> report. Known-cost stock is valued at avgCost. Items with
 * unknown cost are flagged and NOT added to the total; their value at the list
 * cost (costPerUnit) is reported separately as a reference.
 */
function buildValuation(items, branchNames = {}) {
    const rows = [];
    const cats = new Map();
    const branches = new Map();
    const totals = { value: 0, unknownCostItems: 0, unknownCostListValue: 0, items: 0 };
    const add = (map, key, label, row) => {
        const e = map.get(key) || { key, label, items: 0, value: 0, unknownCostItems: 0, unknownCostListValue: 0 };
        e.items += 1;
        e.value = round4(e.value + row.value);
        if (row.unknownCost) { e.unknownCostItems += 1; e.unknownCostListValue = round4(e.unknownCostListValue + row.listValue); }
        map.set(key, e);
    };
    for (const it of items || []) {
        const qty = Math.max(0, Number(it.currentStock) || 0);
        const unknownCost = !isCost(it.avgCost);
        const value = unknownCost ? 0 : round4(qty * Number(it.avgCost));
        const listValue = round4(qty * (isCost(it.costPerUnit) ? Number(it.costPerUnit) : 0));
        const row = {
            _id: it._id, itemId: it.itemId, name: it.name, category: it.category, unit: it.unit,
            branch: it.branch || null, currentStock: qty,
            avgCost: unknownCost ? null : Number(it.avgCost), listCost: Number(it.costPerUnit) || 0,
            value, listValue, unknownCost,
        };
        rows.push(row);
        totals.items += 1;
        totals.value = round4(totals.value + value);
        if (unknownCost) { totals.unknownCostItems += 1; totals.unknownCostListValue = round4(totals.unknownCostListValue + listValue); }
        add(cats, it.category || 'Other', it.category || 'Other', row);
        const bKey = it.branch ? String(it.branch) : 'main';
        add(branches, bKey, branchNames[bKey] || (bKey === 'main' ? 'Main / unassigned' : bKey), row);
    }
    rows.sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name)));
    return {
        totals,
        byItem: rows,
        byCategory: [...cats.values()].sort((a, b) => b.value - a.value),
        byBranch: [...branches.values()].sort((a, b) => b.value - a.value),
    };
}

module.exports = { weightedAverageCost, recordReceiptCost, buildValuation, round4, isCost };
