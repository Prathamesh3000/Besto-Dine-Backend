// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant');
const SubscriptionPlan = require('../../models/subscriptionPlan');
const { recordAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');
const {
    ADDON_CATALOG,
    TIERED_KEYS,
    isAddonActive,
} = require('../../utils/featureAccess');

// GET /api/v1/superadmin/addon-catalog
exports.getAddonCatalog = (_req, res) => {
    const catalog = Object.entries(ADDON_CATALOG).map(([key, v]) => ({ key, ...v }));
    return res.status(200).json({ success: true, data: catalog });
};

// POST /api/v1/superadmin/restaurants/:id/addons
// Body: { key, price?, endDate?, note? }
exports.addRestaurantAddon = async (req, res) => {
    try {
        const { id } = req.params;
        const { key, note } = req.body || {};
        if (!SubscriptionPlan.FEATURE_KEYS.includes(key) || TIERED_KEYS.has(key)) {
            return res.status(400).json({ success: false, message: `"${key}" is not a module that can be sold as an add-on.` });
        }
        let price = req.body?.price;
        if (price === undefined || price === null || price === '') price = ADDON_CATALOG[key]?.monthlyPrice ?? 0;
        price = Number(price);
        if (!Number.isFinite(price) || price < 0) {
            return res.status(400).json({ success: false, message: 'Price must be a number of 0 or more.' });
        }
        let endDate = null;
        if (req.body?.endDate) {
            endDate = new Date(req.body.endDate);
            if (Number.isNaN(endDate.getTime()) || endDate <= new Date()) {
                return res.status(400).json({ success: false, message: 'End date must be a valid future date.' });
            }
        }

        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

        if ((restaurant.addons || []).some(a => a.key === key && isAddonActive(a))) {
            return res.status(409).json({ success: false, code: 'ADDON_EXISTS', message: 'This add-on is already active for the restaurant.' });
        }

        restaurant.addons.push({
            key,
            price,
            status: 'active',
            startDate: new Date(),
            endDate: endDate || undefined,
            note: typeof note === 'string' ? note.slice(0, 300) : '',
            addedBy: req.user?.email || '',
        });
        await restaurant.save();
        const added = restaurant.addons[restaurant.addons.length - 1];

        await recordAudit(req, {
            action: 'restaurant.addon.add',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { key, price, endDate },
        });

        return res.status(201).json({ success: true, data: { addon: added, addons: restaurant.addons } });
    } catch (err) {
        logger.error('addRestaurantAddon error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to add add-on' });
    }
};

// DELETE /api/v1/superadmin/restaurants/:id/addons/:addonId
// Cancels (not deletes) so the history stays for billing questions.
exports.cancelRestaurantAddon = async (req, res) => {
    try {
        const { id, addonId } = req.params;
        if (!mongoose.isValidObjectId(addonId)) {
            return res.status(400).json({ success: false, message: 'Invalid add-on id' });
        }
        const restaurant = await Restaurant.findById(id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        const addon = restaurant.addons.id(addonId);
        if (!addon) return res.status(404).json({ success: false, message: 'Add-on not found' });
        if (addon.status === 'cancelled') {
            return res.status(200).json({ success: true, data: { addon, addons: restaurant.addons } });
        }
        addon.status = 'cancelled';
        addon.cancelledAt = new Date();
        addon.cancelledBy = req.user?.email || '';
        await restaurant.save();

        await recordAudit(req, {
            action: 'restaurant.addon.cancel',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { key: addon.key, price: addon.price },
        });

        return res.status(200).json({ success: true, data: { addon, addons: restaurant.addons } });
    } catch (err) {
        logger.error('cancelRestaurantAddon error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel add-on' });
    }
};
