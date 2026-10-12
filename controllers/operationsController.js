/**
 * Operations Control Panel — Super Admin API + tenant read-only view
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §4).
 *
 *   GET  /superadmin/operations/presets              catalogue for the UI
 *   GET  /superadmin/restaurants/:id/operations      stored + resolved profile
 *   POST /superadmin/restaurants/:id/operations/preview   impact, nothing saved
 *   PUT  /superadmin/restaurants/:id/operations      validate, save, audit, notify
 *   GET  /settings/operations                        tenant admin, read-only
 *
 * All rules live in utils/operationsProfile; this file only loads, saves,
 * audits and reports.
 */
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const User = require('../models/user');
const Order = require('../models/order');
const { recordAudit } = require('../utils/audit');
const logger = require('../utils/logger');
const EVENTS = require('../realtime/events');
const {
    PRESETS, MODULE_KEYS, MODULE_PLAN_FEATURE, ADVANCED_PATHS,
    OperationsProfileError, normaliseProfile, validateProfile, resolveOperations,
    diffImpact, DEFAULT_PROFILE,
} = require('../utils/operationsProfile');

const RESTAURANT_FIELDS = 'name slug status subscription featureOverrides addons operations';

const MODULE_INFO = {
    qrOrdering: {
        label: 'QR ordering',
        description: 'Customers scan the table QR, build a cart and place the order themselves.',
    },
    waiter: {
        label: 'Waiter',
        description: 'Waiters take orders at the table, serve food and answer "call waiter".',
    },
    captain: {
        label: 'Captain',
        description: 'Floor overview, assigns waiters to tables, frees tables; can also take orders and serve.',
    },
    chef: {
        label: 'Chef (kitchen screen)',
        description: 'The kitchen sees orders on a screen and presses Preparing / Ready. Customers can track their order only when this is on.',
    },
    customerPayment: {
        label: 'Customer payment',
        description: 'Customers pay from their phone — online (UPI / card) and wallet.',
    },
};

// The questions the Super Admin still answers after ticking modules (§0.4).
const QUESTIONS = [
    {
        key: 'dineInPayment',
        label: 'When does a dine-in customer pay?',
        options: [
            { value: null, label: 'Decide from the modules' },
            { value: 'payFirst', label: 'Before the order is sent to the kitchen' },
            { value: 'payAfter', label: 'After the meal' },
            { value: 'either', label: 'Customer chooses' },
        ],
    },
    {
        key: 'counterCash',
        label: 'When paying first, can the customer also pay cash at the counter?',
        help: 'The order waits ("awaiting payment") until the counter marks it paid; the kitchen does not see it before that.',
        options: [
            { value: null, label: 'Decide from the modules' },
            { value: true, label: 'Yes' },
            { value: false, label: 'No' },
        ],
    },
    {
        key: 'useTables',
        label: 'Does the restaurant use table numbers?',
        options: [
            { value: null, label: 'Yes (default)' },
            { value: true, label: 'Yes' },
            { value: false, label: 'No — token numbers instead' },
        ],
    },
];

function storedProfile(restaurant) {
    try {
        return { profile: normaliseProfile(restaurant.operations), isDefault: !restaurant.operations };
    } catch {
        // Corrupt stored value: show the defaults so the Super Admin can fix it.
        return { profile: normaliseProfile(null), isDefault: true, corrupt: true };
    }
}

function buildPayload(restaurant) {
    const { profile, isDefault, corrupt } = storedProfile(restaurant);
    return {
        restaurant: { _id: restaurant._id, name: restaurant.name, slug: restaurant.slug },
        profile,
        isDefault,
        ...(corrupt ? { corrupt: true } : {}),
        resolved: resolveOperations(restaurant),
        validation: validateProfile(profile),
    };
}

async function loadRestaurant(req, res) {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
        res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        return null;
    }
    const restaurant = await Restaurant.findById(id).select(RESTAURANT_FIELDS).lean();
    if (!restaurant) {
        res.status(404).json({ success: false, message: 'Restaurant not found' });
        return null;
    }
    return restaurant;
}

/** Parse body.operations; sends 400 and returns null on bad input. */
function parseCandidate(req, res) {
    if (!req.body || typeof req.body !== 'object' || req.body.operations === undefined) {
        res.status(400).json({ success: false, message: 'operations is required' });
        return null;
    }
    // updatedAt / updatedBy are server-owned
    const { updatedAt, updatedBy, ...input } = req.body.operations || {};
    try {
        return normaliseProfile(input);
    } catch (err) {
        if (err instanceof OperationsProfileError) {
            res.status(400).json({ success: false, code: 'INVALID_OPERATIONS', message: err.message, errors: err.errors });
            return null;
        }
        throw err;
    }
}

/**
 * Before/after impact plus the live counts that make it concrete: staff
 * accounts that would lose app access, open unpaid dine-in bills at the
 * moment of the switch (§9).
 */
async function buildImpact(restaurant, candidate) {
    const before = resolveOperations(restaurant);
    const after = resolveOperations({ ...restaurant, operations: candidate });
    const impact = diffImpact(before, after);

    const blockedRoles = ['waiter', 'captain', 'chef'].filter(r => before.roles[r] && !after.roles[r]);
    if (blockedRoles.length) {
        const counts = await User.aggregate([
            { $match: { restaurant: restaurant._id, role: { $in: blockedRoles }, status: 'active' } },
            { $group: { _id: '$role', n: { $sum: 1 } } },
        ]);
        for (const { _id: role, n } of counts) {
            if (n > 0) {
                impact.push({
                    area: 'staff',
                    severity: 'warning',
                    message: `${n} active ${role} account${n === 1 ? '' : 's'} will be blocked from the app (not deleted — switching the module back on restores access).`,
                });
            }
        }
    }

    if (before.payment.dineIn !== after.payment.dineIn) {
        const open = await Order.countDocuments({
            restaurant: restaurant._id,
            type: 'dine-in',
            status: { $ne: 'cancelled' },
            paymentStatus: { $nin: ['Paid', 'Refunded'] },
        });
        if (open > 0) {
            impact.push({
                area: 'payment',
                severity: 'warning',
                message: `${open} dine-in order${open === 1 ? ' is' : 's are'} open and unpaid right now. They stay payable the old way; the change applies to new orders only.`,
            });
        }
    }
    return { before, after, impact };
}

// GET /superadmin/operations/presets
exports.getPresets = (_req, res) => {
    res.status(200).json({
        success: true,
        data: {
            modules: MODULE_KEYS.map(key => ({ key, planFeature: MODULE_PLAN_FEATURE[key], ...MODULE_INFO[key] })),
            presets: Object.entries(PRESETS).map(([key, p]) => ({ key, ...p })),
            questions: QUESTIONS,
            advancedPaths: ADVANCED_PATHS,
            defaultProfile: DEFAULT_PROFILE,
        },
    });
};

// GET /superadmin/restaurants/:id/operations
exports.getRestaurantOperations = async (req, res) => {
    try {
        const restaurant = await loadRestaurant(req, res);
        if (!restaurant) return;
        return res.status(200).json({ success: true, data: buildPayload(restaurant) });
    } catch (err) {
        logger.error('getRestaurantOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load operations profile' });
    }
};

// POST /superadmin/restaurants/:id/operations/preview
exports.previewRestaurantOperations = async (req, res) => {
    try {
        const restaurant = await loadRestaurant(req, res);
        if (!restaurant) return;
        const candidate = parseCandidate(req, res);
        if (!candidate) return;
        const { errors, warnings } = validateProfile(candidate);
        const { after, impact } = await buildImpact(restaurant, candidate);
        return res.status(200).json({
            success: true,
            data: { profile: candidate, resolved: after, errors, warnings, impact },
        });
    } catch (err) {
        logger.error('previewRestaurantOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to preview operations profile' });
    }
};

// PUT /superadmin/restaurants/:id/operations
exports.updateRestaurantOperations = async (req, res) => {
    try {
        const restaurant = await loadRestaurant(req, res);
        if (!restaurant) return;
        const candidate = parseCandidate(req, res);
        if (!candidate) return;

        const { errors, warnings } = validateProfile(candidate);
        if (errors.length) {
            return res.status(400).json({
                success: false, code: 'INVALID_OPERATIONS', message: errors.join('; '), errors, warnings,
            });
        }

        const { impact } = await buildImpact(restaurant, candidate);
        const beforeStored = restaurant.operations || null;
        const toSave = { ...candidate, updatedAt: new Date(), updatedBy: req.user?._id || null };

        await Restaurant.updateOne({ _id: restaurant._id }, { $set: { operations: toSave } });

        await recordAudit(req, {
            action: 'restaurant.operations.update',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { before: beforeStored, after: candidate, preset: candidate.preset, impact },
        });

        // Open staff apps refetch /auth/me; customer apps pick the change up
        // on their next menu-bootstrap fetch.
        try {
            const { getIO, emitToStaff } = require('../utils/socket');
            const io = getIO();
            emitToStaff(io, null, EVENTS.TENANT_OPERATIONS_UPDATED, { restaurant: String(restaurant._id) });
        } catch (sockErr) {
            logger.warn('operations update: socket notify failed: ' + sockErr.message);
        }

        const saved = { ...restaurant, operations: toSave };
        return res.status(200).json({ success: true, data: { ...buildPayload(saved), warnings, impact } });
    } catch (err) {
        logger.error('updateRestaurantOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to save operations profile' });
    }
};

// GET /settings/operations — the tenant admin sees its own profile, read-only.
exports.getMyOperations = async (req, res) => {
    try {
        const restaurant = req.restaurant;
        if (!restaurant) {
            return res.status(200).json({ success: true, data: { resolved: resolveOperations(null), isDefault: true } });
        }
        return res.status(200).json({
            success: true,
            data: {
                resolved: resolveOperations(restaurant, { branchId: req.user?.branch || null }),
                isDefault: !restaurant.operations,
                updatedAt: restaurant.operations?.updatedAt || null,
            },
        });
    } catch (err) {
        logger.error('getMyOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load operations profile' });
    }
};
