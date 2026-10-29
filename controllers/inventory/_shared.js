const Inventory = require('../../models/inventory');
const logger = require('../../utils/logger');
const { notify } = require('../../services/notificationService');
const EVENTS = require('../../realtime/events');
const { tenantFilter, strictBranchFilter } = require('../../utils/tenantScope');

// ─── Allowed enums (mirrored from the Inventory schema) ─────────────────────
const ALLOWED_CATEGORIES = [
    'Raw Ingredients', 'Beverages', 'Dairy & Eggs', 'Spices & Seasonings',
    'Packaging', 'Cleaning Supplies', 'Kitchen Equipment', 'Bakery Items',
    'Fruits & Vegetables', 'Frozen Goods', 'Oils & Sauces', 'Other'
];
const ALLOWED_UNITS = ['kg', 'g', 'L', 'mL', 'pcs', 'dozen', 'box', 'pack', 'bottle', 'can'];

// Newest adjustmentHistory rows kept per item. Every atomic writer uses
// `$push … $slice: -200` (the literal below, four times); the CSV import
// trims in memory to the same number. Keep the two in step.
const ADJUSTMENT_HISTORY_MAX = 200;

// Stock quantities are rounded to 3 decimals on every write (see
// models/inventory.js roundQty) so float drift never refuses real stock.
const { roundQty } = Inventory;

// ─── Helpers ────────────────────────────────────────────────────────────────

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a branch filter for inventory reads.
 *
 * Branch-pinned staff are FORCED to their own branch — they cannot
 * widen scope via ?branch=all or ?branch=<otherId>. For tenant owners
 * the query param controls scope as before.
 *
 * Inventory `branch: null` historically meant "tenant-wide / unassigned",
 * NOT "shared with all branches". The migration in
 * Seed/migrateLegacyBranchNulls.js reassigns those legacy rows to the
 * tenant's main branch so Sub Admins no longer see them by accident.
 */
function branchFilter(req) {
    return strictBranchFilter(req);
}

/** Unit conversion table — convert `from` unit to `to` unit. Returns
 *  a multiplier, or null if units are incompatible. */
const UNIT_CONVERSIONS = {
    'kg_g': 1000, 'g_kg': 0.001,
    'L_mL': 1000, 'mL_L': 0.001,
};
function convertUnits(qty, from, to) {
    if (from === to) return qty;
    const key = `${from}_${to}`;
    if (UNIT_CONVERSIONS[key]) return qty * UNIT_CONVERSIONS[key];
    return null; // incompatible
}

/**
 * Single source of truth for status — used on both the write path
 * (adjustStock, deductInventoryForOrder, restoreInventoryForOrder)
 * and the read path (getAllItems, getSummary, getItemById), so rows
 * seeded via insertMany (which bypass the pre('save') hook) or edited
 * via updateOne don't drift out of sync with currentStock/minStock.
 */
function computeStatus(currentStock, minStock) {
    if (currentStock <= 0) return 'out-of-stock';
    if (currentStock <= (minStock || 0)) return 'low-stock';
    return 'in-stock';
}

/**
 * Persist + broadcast a stock-status alert to the admin audience when
 * an inventory item TRANSITIONS into low-stock or out-of-stock. Skips
 * silently when:
 *   - the status didn't actually change (nothing newsworthy),
 *   - the item recovered into 'in-stock' (no alert needed, the bell
 *     already cleared last time),
 *   - inputs are missing.
 *
 * Why a Notification doc + a socket event (not just one):
 *   - The Notification persists so an admin who walks up to the
 *     dashboard after the alert fired still sees it in the bell list
 *     and the unread count.
 *   - The socket `notification:new` triggers the existing live toast
 *     handler in NotificationContext, so connected admins get an
 *     immediate audible/visual ping without polling.
 *   - The legacy `inventory:alert` is kept for any inventory-specific
 *     consumers that want richer payload than the generic notification.
 *
 * Best-effort: all failures are swallowed so a notification miss can
 * never block the underlying stock write (which is the higher-stakes
 * operation).
 */
async function notifyAdminInventoryStatus({
    invItem,
    oldStatus,
    newStatus,
    restaurantId,
    branchId = null,
    trigger = '',
}) {
    try {
        if (!invItem || !restaurantId) return;
        if (oldStatus === newStatus) return;
        if (newStatus === 'in-stock') return;
        try { require('../../utils/webhookService').emitWebhookEvent(restaurantId, 'stock.low', require('../../utils/publicApiSerializers').serializeInventoryItem(invItem)); } catch { /* webhooks never affect stock writes */ }

        const isOut = newStatus === 'out-of-stock';
        const title = isOut
            ? 'Out of stock'
            : 'Low stock alert';
        const stockText = `${Math.round((invItem.currentStock ?? 0) * 1000) / 1000} ${invItem.unit || ''}`.trim();
        const description = isOut
            ? `${invItem.name} is out of stock${trigger ? ` (after ${trigger})` : ''}. Restock to keep dependent menu items orderable.`
            : `${invItem.name} dropped to ${stockText}${trigger ? ` (after ${trigger})` : ''}. Below the minimum threshold.`;

        await notify({
            restaurant: restaurantId,
            branch: branchId || invItem.branch || null,
            audience: 'admin',
            notification: {
                recipient: null,
                recipientRole: 'admin',
                category: 'System',
                priority: isOut ? 'high' : 'medium',
                title,
                description,
                meta: {
                    amount: invItem.currentStock ?? 0,
                },
            },
            // Generic notification event so the standard admin notification
            // handler picks it up (bell + toast + sound).
            payload: {
                title,
                description,
                category: 'System',
                priority: isOut ? 'high' : 'medium',
            },
            // Keep the legacy inventory-specific channel for any
            // dashboards that want the richer payload (item id, unit).
            also: [{
                event: EVENTS.INVENTORY_ALERT,
                payload: {
                    itemId: invItem.itemId,
                    name: invItem.name,
                    status: newStatus,
                    currentStock: invItem.currentStock ?? 0,
                    unit: invItem.unit,
                    trigger: trigger || undefined,
                },
            }],
        });
    } catch (err) {
        logger.warn('Inventory status alert failed (non-fatal):', err.message);
    }
}

// ─── ID Generation ──────────────────────────────────────────────────────────

const generateNextId = async (req, retries = 3) => {
    const tf = tenantFilter(req);
    for (let attempt = 0; attempt < retries; attempt++) {
        const last = await Inventory.findOne(tf).sort({ itemId: -1 });
        if (!last || !last.itemId) return 'INV-001';
        const num = parseInt(last.itemId.split('-')[1]) + 1;
        const nextId = `INV-${num.toString().padStart(3, '0')}`;
        const exists = await Inventory.findOne({ itemId: nextId, ...tf });
        if (!exists) return nextId;
    }
    return `INV-${Date.now().toString(36).toUpperCase()}`;
};

// ─── Validation ─────────────────────────────────────────────────────────────

const validateItemFields = ({ name, minStock, maxStock, costPerUnit, currentStock, expiryDate, shelfLifeDays }, isCreate = false) => {
    const errors = [];
    if (name !== undefined) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) errors.push('Item name cannot be empty');
        if (trimmed.length > 100) errors.push('Item name must be under 100 characters');
    }
    if (minStock !== undefined) {
        const n = Number(minStock);
        if (isNaN(n) || n < 0) errors.push('Min stock must be a non-negative number');
    }
    if (maxStock !== undefined) {
        const n = Number(maxStock);
        if (isNaN(n) || n < 0) errors.push('Max stock must be a non-negative number');
    }
    if (costPerUnit !== undefined) {
        const n = Number(costPerUnit);
        if (isNaN(n) || n < 0) errors.push('Cost per unit must be a non-negative number');
    }
    if (maxStock !== undefined && minStock !== undefined) {
        const max = Number(maxStock);
        const min = Number(minStock);
        if (max > 0 && min > max) errors.push(`Min stock (${min}) cannot exceed max stock (${max})`);
    }
    // currentStock must never be negative — neither on create nor on a
    // direct update. Stock-deduction flows (orders consuming inventory)
    // should clamp at 0 separately; this guard catches direct admin
    // typos like setting "current stock = -5" in the edit form.
    if (currentStock !== undefined) {
        const stock = Number(currentStock);
        if (isNaN(stock) || stock < 0) errors.push('Current stock cannot be negative');
    }
    if (isCreate && currentStock !== undefined && maxStock !== undefined) {
        const stock = Number(currentStock);
        const max = Number(maxStock);
        if (max > 0 && stock > max) errors.push(`Initial stock (${stock}) cannot exceed max stock (${max})`);
    }
    if (expiryDate) {
        const d = new Date(expiryDate);
        if (isNaN(d.getTime())) errors.push('Invalid expiry date');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (d < today) errors.push('Expiry date cannot be in the past');
    }
    if (shelfLifeDays !== undefined && shelfLifeDays !== null && shelfLifeDays !== '') {
        const n = Number(shelfLifeDays);
        if (isNaN(n) || n < 0) errors.push('Shelf life (days) must be a non-negative number');
    }
    return errors;
};

module.exports = {
    ALLOWED_CATEGORIES, ALLOWED_UNITS, ADJUSTMENT_HISTORY_MAX, roundQty, escapeRegex,
    branchFilter, convertUnits, computeStatus, notifyAdminInventoryStatus,
    generateNextId, validateItemFields,
};
