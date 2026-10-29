const mongoose = require('mongoose');
const Inventory = require('../../models/inventory');
const Recipe = require('../../models/recipe');
const logger = require('../../utils/logger');
const { roundQty, convertUnits, computeStatus, notifyAdminInventoryStatus } = require('./_shared');

/**
 * Pre-flight stock check for an incoming / appended order. Called from
 * orderController.createOrder + appendOrderItems BEFORE the order is
 * persisted, so the customer is told up-front when an ingredient is
 * out of stock instead of finding out at "Start Preparing" time when
 * the chef silently fails to deduct.
 *
 * Items without a recipe are skipped (treated as "no inventory tracked"
 * — same backwards-compatible behaviour the deduction path uses).
 *
 * @param {Array}    items        — order line items (must carry menuItem id + quantity)
 * @param {ObjectId} restaurantId — tenant id
 * @param {ObjectId|null} branch  — order's branch (null = tenant-wide)
 * @returns {Promise<{ ok: boolean, shortages: Array, byItem: Object }>}
 *
 *   shortages → [{ menuItem, name, ingredient, needed, available, unit }]
 *   byItem    → totals across the whole order (for atomic checks vs.
 *               per-line so two coffees competing for the same beans
 *               don't both pass when only one of them fits)
 */
exports.checkInventoryForOrder = async (items, restaurantId, branch = null) => {
    const result = { ok: true, shortages: [], warnings: [], byItem: {} };

    const validItems = (Array.isArray(items) ? items : []).filter(it => {
        const id = it?.menuItem?.toString?.() || it?.menuItem;
        return id && mongoose.isValidObjectId(id) && (it.quantity || 1) > 0;
    });
    if (validItems.length === 0) return result;

    const menuItemIds = [...new Set(validItems.map(it =>
        (it.menuItem.toString?.() || it.menuItem)
    ))];

    // Branch-aware recipe lookup mirrors deductInventoryForOrder so the
    // pre-check uses the exact same recipe the deduction will later use.
    const recipes = await Recipe.find({
        menuItem: { $in: menuItemIds },
        restaurant: restaurantId,
        branch: { $in: [branch, null] },
    }).lean();

    const recipeMap = {};
    for (const r of recipes) {
        const key = r.menuItem.toString();
        const isBranchSpecific = r.branch && branch && String(r.branch) === String(branch);
        if (!recipeMap[key] || isBranchSpecific) recipeMap[key] = r;
    }

    // Aggregate ingredient needs across ALL line items first, then check
    // once per inventory id. Without aggregation, ordering 5 coffees in
    // five separate lines would each pass the stock check independently
    // even though together they exceed the bean stock.
    const needsByInv = {}; // invId → { needed (in inv unit), unitMatched, sources: [{name, qty}] }
    const skippedItems = [];

    for (const it of validItems) {
        const miId = it.menuItem.toString?.() || it.menuItem;
        const recipe = recipeMap[miId];
        if (!recipe) {
            skippedItems.push(miId);
            continue;
        }
        const orderQty = it.quantity || 1;
        const multiplier = orderQty / (recipe.yield || 1);
        for (const ing of recipe.ingredients) {
            const invId = ing.inventoryItem.toString?.() || ing.inventoryItem;
            const slot = needsByInv[invId] || (needsByInv[invId] = {
                rawByUnit: {},
                sources: [],
            });
            slot.rawByUnit[ing.unit] = (slot.rawByUnit[ing.unit] || 0) + ing.quantity * multiplier;
            slot.sources.push({ menuItem: miId, name: it.name || '', qty: orderQty });
        }
    }

    const invIds = Object.keys(needsByInv);
    if (invIds.length === 0) return result;

    const invItems = await Inventory.find({
        _id: { $in: invIds },
        restaurant: restaurantId,
    }).lean();

    const invMap = {};
    for (const inv of invItems) invMap[inv._id.toString()] = inv;

    for (const invId of invIds) {
        const inv = invMap[invId];
        const slot = needsByInv[invId];
        if (!inv) {
            // Recipe references an inventory item that no longer exists.
            // Surface it so the admin knows the recipe is broken.
            result.ok = false;
            result.shortages.push({
                ingredient: invId,
                name: '(deleted ingredient)',
                needed: 0, available: 0, unit: '',
                reason: 'INVENTORY_MISSING',
            });
            continue;
        }

        // Sum every (qty, recipe-unit) pair into the inventory's unit so
        // a recipe in g and inventory in kg still adds up correctly.
        let totalNeeded = 0;
        let unitMismatch = null;
        for (const [recipeUnit, qty] of Object.entries(slot.rawByUnit)) {
            const converted = convertUnits(qty, recipeUnit, inv.unit);
            if (converted === null) {
                unitMismatch = `${recipeUnit}↔${inv.unit}`;
                break;
            }
            totalNeeded += converted;
        }

        if (unitMismatch) {
            // A unit mismatch (e.g. recipe in mL but inventory in "bottle") is
            // an ADMIN recipe-configuration problem, not a real stock shortage.
            // Blocking a paying customer's order — and refunding them — over a
            // misconfiguration is the wrong trade-off. So we DON'T fail the
            // order: we skip this ingredient (the deduction path skips it the
            // same way) and record a warning for the admin to fix the recipe.
            logger.warn('Stock pre-check: skipped unconvertible ingredient', {
                ingredient: invId, name: inv.name, mismatch: unitMismatch, restaurant: String(restaurantId),
            });
            result.warnings.push({
                ingredient: invId,
                name: inv.name,
                available: inv.currentStock,
                unit: inv.unit,
                reason: `Unit mismatch ${unitMismatch} — ingredient not stock-checked`,
            });
            continue;
        }

        if (roundQty(inv.currentStock) < roundQty(totalNeeded)) {
            result.ok = false;
            result.shortages.push({
                ingredient: invId,
                name: inv.name,
                needed: Math.round(totalNeeded * 1000) / 1000,
                available: inv.currentStock,
                unit: inv.unit,
            });
        }
    }

    return result;
};

/**
 * Deduct inventory for an order's items based on their recipes.
 * Called internally — not an HTTP endpoint.
 *
 * @param {Object} order    — the order document (with items populated)
 * @param {ObjectId} restaurantId — tenant id
 * @param {ObjectId|null} userId  — who triggered (chef or system)
 * @returns {{ deducted: Array, errors: Array }}
 */
exports.deductInventoryForOrder = async (order, restaurantId, userId = null) => {
    const results = { deducted: [], errors: [], skipped: [] };

    try {
        // Idempotency guard — if we already deducted for this order,
        // don't do it again. Atomic flip: the $set-if-false is the
        // single source of truth, so two concurrent "start preparing"
        // transitions can't both win.
        const Order = require('../../models/order');
        const claim = await Order.findOneAndUpdate(
            { _id: order._id, restaurant: restaurantId, inventoryDeducted: { $ne: true } },
            { $set: { inventoryDeducted: true, inventoryDeductedAt: new Date() } },
            { returnDocument: 'after' }
        );
        if (!claim) {
            results.skipped.push({ reason: 'already-deducted', order: order.orderId });
            return results;
        }

        // Collect unique menu item IDs from the order
        const menuItemIds = [...new Set(
            order.items
                .map(i => i.menuItem?.toString?.() || i.menuItem)
                .filter(id => id && mongoose.isValidObjectId(id))
        )];

        if (menuItemIds.length === 0) return results;

        // Fetch all recipes for these menu items in one query. Both
        // the branch-specific recipe (order.branch) and the tenant-
        // level fallback (branch: null) may exist — we prefer the
        // branch-specific one when deducting for this order.
        const orderBranch = order.branch || null;
        const recipes = await Recipe.find({
            menuItem: { $in: menuItemIds },
            restaurant: restaurantId,
            branch: { $in: [orderBranch, null] },
        }).lean();

        const recipeMap = {};
        for (const r of recipes) {
            const key = r.menuItem.toString();
            const isBranchSpecific = r.branch && orderBranch && String(r.branch) === String(orderBranch);
            // Prefer the branch-specific recipe; only fall back to the
            // null-branch one if no branch-specific recipe exists.
            if (!recipeMap[key] || isBranchSpecific) recipeMap[key] = r;
        }

        // Process each order item
        for (const orderItem of order.items) {
            const miId = orderItem.menuItem?.toString?.() || orderItem.menuItem;
            if (!miId) continue;

            const recipe = recipeMap[miId];
            if (!recipe) {
                results.skipped.push({ menuItem: miId, name: orderItem.name || miId, reason: 'No recipe defined' });
                continue;
            }

            const orderQty = orderItem.quantity || 1;
            const multiplier = orderQty / (recipe.yield || 1);

            for (const ing of recipe.ingredients) {
                const invId = ing.inventoryItem;
                const neededRaw = ing.quantity * multiplier;

                try {
                    // Read current inventory item
                    const invItem = await Inventory.findOne({ _id: invId, restaurant: restaurantId });
                    if (!invItem) {
                        results.errors.push({ inventoryItem: invId, reason: 'Inventory item not found' });
                        continue;
                    }

                    // Convert units if needed (rounded to the stock precision)
                    const converted = convertUnits(neededRaw, ing.unit, invItem.unit);
                    if (converted === null) {
                        results.errors.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            reason: `Unit mismatch: recipe uses ${ing.unit}, inventory is ${invItem.unit}`,
                        });
                        continue;
                    }
                    const needed = roundQty(converted);

                    // Atomic RELATIVE deduction ($inc guarded by $gte) — two
                    // orders deducting the same ingredient concurrently both
                    // land. When stock is short, take what is left with a
                    // compare-and-set on the value read (retry if it moved).
                    // Every row is tagged with the order so a cancel restores
                    // exactly what was taken (see restoreInventoryForOrder).
                    let outcome = null;
                    for (let attempt = 0; attempt < 5 && !outcome; attempt++) {
                        const inc = await Inventory.incStock(
                            { _id: invId, restaurant: restaurantId, currentStock: { $gte: needed } },
                            -needed
                        );
                        if (inc) { outcome = { kind: 'full', ...inc }; break; }
                        const cur = await Inventory.findOne({ _id: invId, restaurant: restaurantId }).select('currentStock').lean();
                        if (!cur) break;
                        if (cur.currentStock >= needed) continue; // restocked meanwhile — retry the full deduction
                        const had = roundQty(cur.currentStock);
                        const taken = await Inventory.findOneAndUpdate(
                            { _id: invId, restaurant: restaurantId, currentStock: cur.currentStock },
                            {
                                $set: { currentStock: 0, status: 'out-of-stock' },
                                $push: {
                                    adjustmentHistory: {
                                        $each: [{
                                            type: 'usage',
                                            quantity: had,
                                            previousStock: had,
                                            newStock: 0,
                                            reason: `Auto (partial): Order ${order.orderId} — needed ${needed} ${invItem.unit}, had ${had}`,
                                            adjustedBy: userId,
                                            order: order._id,
                                            date: new Date(),
                                        }],
                                        $slice: -200,
                                    },
                                },
                            },
                            { returnDocument: 'after' }
                        );
                        if (taken) outcome = { kind: 'partial', had };
                    }

                    if (!outcome) {
                        results.errors.push({ inventoryItem: invId, name: invItem.name, reason: 'Stock changed concurrently — not deducted' });
                        continue;
                    }

                    if (outcome.kind === 'full') {
                        const { previousStock, newStock, doc: updated } = outcome;
                        await Inventory.updateOne(
                            { _id: invId, restaurant: restaurantId },
                            {
                                $push: {
                                    adjustmentHistory: {
                                        $each: [{
                                            type: 'usage',
                                            quantity: needed,
                                            previousStock,
                                            newStock,
                                            reason: `Auto: Order ${order.orderId} — ${orderItem.name || ''} ×${orderQty}`,
                                            adjustedBy: userId,
                                            order: order._id,
                                            date: new Date(),
                                        }],
                                        $slice: -200,
                                    },
                                },
                            }
                        );
                        const newStatus = computeStatus(newStock, updated.minStock);
                        if (updated.status !== newStatus) {
                            // R-10: tenant-scope the status sync. `restaurantId` is the
                            // function parameter passed by the caller (orderController),
                            // so this is the authoritative tenant for the order being
                            // processed — not a client-controlled value.
                            await Inventory.updateOne(
                                { _id: invId, restaurant: restaurantId },
                                { status: newStatus }
                            );
                        }

                        results.deducted.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            deducted: needed,
                            unit: invItem.unit,
                            remaining: newStock,
                            status: newStatus,
                        });

                        // Persistent admin alert + live socket. Only fires
                        // when the status TRANSITIONS into low/out so a
                        // long-running low-stock streak doesn't repeatedly
                        // ping the admin every time the chef starts a new
                        // order with the same ingredient.
                        await notifyAdminInventoryStatus({
                            invItem: { ...invItem.toObject(), currentStock: newStock },
                            oldStatus: invItem.status,
                            newStatus,
                            restaurantId,
                            branchId: invItem.branch || order.branch || null,
                            trigger: `Order ${order.orderId}`,
                        });
                    } else {
                        // The partial path forces newStock=0, so the item
                        // is definitely out-of-stock now. Notify regardless
                        // of the prior status — this is a real shortage
                        // the admin needs to address immediately.
                        await notifyAdminInventoryStatus({
                            invItem: { ...invItem.toObject(), currentStock: 0 },
                            oldStatus: invItem.status === 'out-of-stock' ? 'low-stock' : invItem.status,
                            newStatus: 'out-of-stock',
                            restaurantId,
                            branchId: invItem.branch || order.branch || null,
                            trigger: `Order ${order.orderId} (partial deduction)`,
                        });
                        results.errors.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            reason: `Insufficient: needed ${needed} ${invItem.unit}, had ${outcome.had}`,
                        });
                    }
                } catch (err) {
                    results.errors.push({ inventoryItem: invId, reason: err.message });
                }
            }
        }
    } catch (err) {
        logger.error('deductInventoryForOrder failed:', err.message);
        results.errors.push({ reason: err.message });
    }

    return results;
};

/**
 * Reverse the deductions from deductInventoryForOrder. Called when an
 * in-progress order is cancelled so the kitchen doesn't lose stock for
 * food that was never actually made / sold.
 *
 * Restores exactly what the deduction TOOK: deductInventoryForOrder tags
 * each 'usage' row with the order id, and those rows (net of earlier
 * 'return' rows for the same order) cap what is added back — so a
 * partial deduction (only 0.1 of 0.3 kg was there) restores 0.1, not
 * 0.3. The recipe walk is kept for per-line reasons; any recorded amount
 * the current recipe no longer lists is restored at the end. Orders
 * deducted before rows were tagged fall back to recipe × quantity.
 * Writes a `type: 'return'` adjustmentHistory entry (not `restock`) so
 * the analytics tab doesn't treat a cancel as a supplier delivery.
 *
 * Safe to call even if `order.inventoryDeducted` is false (no-op).
 */
exports.restoreInventoryForOrder = async (order, restaurantId, userId = null) => {
    const results = { restored: [], errors: [], skipped: [] };

    try {
        const Order = require('../../models/order');
        // Atomic claim so a double-cancel doesn't double-restore.
        const claim = await Order.findOneAndUpdate(
            { _id: order._id, restaurant: restaurantId, inventoryDeducted: true },
            { $set: { inventoryDeducted: false } },
            { returnDocument: 'after' }
        );
        if (!claim) {
            results.skipped.push({ reason: 'not-deducted', order: order.orderId });
            return results;
        }

        // What this order's deduction actually took, per inventory item.
        // null → no tagged rows (legacy order): fall back to the recipe.
        const tagged = await Inventory.find({ restaurant: restaurantId, 'adjustmentHistory.order': order._id })
            .select('adjustmentHistory.order adjustmentHistory.type adjustmentHistory.quantity')
            .lean();
        const recorded = tagged.length ? {} : null;
        for (const inv of tagged) {
            let net = 0;
            for (const h of inv.adjustmentHistory || []) {
                if (!h.order || String(h.order) !== String(order._id)) continue;
                if (h.type === 'usage') net += h.quantity || 0;
                else if (h.type === 'return') net -= h.quantity || 0;
            }
            recorded[String(inv._id)] = roundQty(net);
        }

        const restoreOne = async (invItem, wanted, reason) => {
            const invId = invItem._id;
            const key = String(invId);
            let amount = wanted;
            if (recorded) {
                const left = recorded[key] || 0;
                amount = Math.min(amount, left);
                recorded[key] = roundQty(left - amount);
            }
            amount = roundQty(amount);
            if (amount <= 0) {
                results.skipped.push({ inventoryItem: invId, name: invItem.name, reason: 'Nothing deducted for this order' });
                return;
            }

            // Capped at maxStock to avoid restoring above the ceiling (e.g.
            // someone adjusted the max down after deduction). Relative $inc;
            // with a cap, guarded by the value the cap was computed from.
            let cur = invItem;
            let inc = null;
            let give = 0;
            for (let attempt = 0; attempt < 5 && cur; attempt++) {
                const cap = cur.maxStock > 0 ? cur.maxStock : Number.POSITIVE_INFINITY;
                give = roundQty(Math.min(amount, cap - cur.currentStock));
                if (give <= 0) break;
                inc = await Inventory.incStock(
                    Number.isFinite(cap)
                        ? { _id: invId, restaurant: restaurantId, currentStock: cur.currentStock }
                        : { _id: invId, restaurant: restaurantId },
                    give
                );
                if (inc) break;
                cur = await Inventory.findOne({ _id: invId, restaurant: restaurantId }).select('currentStock maxStock').lean();
            }
            if (!inc) {
                results.skipped.push({ inventoryItem: invId, name: invItem.name, reason: 'At max stock' });
                return;
            }

            await Inventory.updateOne(
                { _id: invId, restaurant: restaurantId },
                {
                    $push: {
                        adjustmentHistory: {
                            $each: [{
                                type: 'return',
                                quantity: give,
                                previousStock: inc.previousStock,
                                newStock: inc.newStock,
                                reason,
                                adjustedBy: userId,
                                order: order._id,
                                date: new Date(),
                            }],
                            $slice: -200,
                        },
                    },
                }
            );

            const newStatus = computeStatus(inc.newStock, inc.doc.minStock);
            if (inc.doc.status !== newStatus) {
                // R-10: tenant-scope the status sync inside
                // restoreInventoryForOrder. `restaurantId` is the
                // function parameter from orderController.
                await Inventory.updateOne(
                    { _id: invId, restaurant: restaurantId },
                    { status: newStatus }
                );
            }

            results.restored.push({
                inventoryItem: invId,
                name: invItem.name,
                restored: give,
                unit: invItem.unit,
                newStock: inc.newStock,
            });
        };

        const menuItemIds = [...new Set(
            order.items
                .map(i => i.menuItem?.toString?.() || i.menuItem)
                .filter(id => id && mongoose.isValidObjectId(id))
        )];

        const orderBranch = order.branch || null;
        const recipes = menuItemIds.length ? await Recipe.find({
            menuItem: { $in: menuItemIds },
            restaurant: restaurantId,
            branch: { $in: [orderBranch, null] },
        }).lean() : [];

        const recipeMap = {};
        for (const r of recipes) {
            const key = r.menuItem.toString();
            const isBranchSpecific = r.branch && orderBranch && String(r.branch) === String(orderBranch);
            if (!recipeMap[key] || isBranchSpecific) recipeMap[key] = r;
        }

        for (const orderItem of order.items) {
            const miId = orderItem.menuItem?.toString?.() || orderItem.menuItem;
            if (!miId) continue;
            const recipe = recipeMap[miId];
            if (!recipe) continue;

            const orderQty = orderItem.quantity || 1;
            const multiplier = orderQty / (recipe.yield || 1);

            for (const ing of recipe.ingredients) {
                const invId = ing.inventoryItem;
                const neededRaw = ing.quantity * multiplier;

                try {
                    const invItem = await Inventory.findOne({ _id: invId, restaurant: restaurantId });
                    if (!invItem) {
                        results.errors.push({ inventoryItem: invId, reason: 'Inventory item not found' });
                        continue;
                    }

                    const needed = convertUnits(neededRaw, ing.unit, invItem.unit);
                    if (needed === null) {
                        results.errors.push({
                            inventoryItem: invId,
                            name: invItem.name,
                            reason: `Unit mismatch: ${ing.unit} → ${invItem.unit}`,
                        });
                        continue;
                    }

                    await restoreOne(invItem, needed, `Auto: Cancelled Order ${order.orderId} — ${orderItem.name || ''} ×${orderQty}`);
                } catch (err) {
                    results.errors.push({ inventoryItem: invId, reason: err.message });
                }
            }
        }

        // Recorded deductions the current recipe no longer lists (recipe
        // edited after the order was prepared) are still given back.
        for (const [key, left] of Object.entries(recorded || {})) {
            if (left <= 0) continue;
            try {
                const invItem = await Inventory.findOne({ _id: key, restaurant: restaurantId });
                if (invItem) await restoreOne(invItem, left, `Auto: Cancelled Order ${order.orderId}`);
            } catch (err) {
                results.errors.push({ inventoryItem: key, reason: err.message });
            }
        }
    } catch (err) {
        logger.error('restoreInventoryForOrder failed:', err.message);
        results.errors.push({ reason: err.message });
    }

    return results;
};
