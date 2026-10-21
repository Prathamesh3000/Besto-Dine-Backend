/**
 * Operations Control Panel — Super Admin API + tenant read-only view
 * (OPERATIONS_CONTROL_PANEL_DESIGN.md §4, §12.1).
 *
 *   GET    /superadmin/operations/presets                       catalogue for the UI
 *   GET    /superadmin/restaurants/:id/operations               stored + resolved profile + per-branch overrides
 *   POST   /superadmin/restaurants/:id/operations/preview       impact, nothing saved (body may carry branchId)
 *   PUT    /superadmin/restaurants/:id/operations               validate, save, audit, notify
 *   PUT    /superadmin/restaurants/:id/operations/branches/:branchId    save one branch's overrides
 *   DELETE /superadmin/restaurants/:id/operations/branches/:branchId    remove one branch's overrides
 *   GET    /settings/operations                                 tenant admin, read-only (caller's branch)
 *
 * All rules live in utils/operationsProfile; this file only loads, saves,
 * audits and reports.
 *
 * Save concurrency (PUT): body `{ operations, expectedUpdatedAt }` where
 * expectedUpdatedAt is the `data.updatedAt` the panel got from GET (null
 * when the restaurant had no profile). Mismatch → 409
 * `{ success:false, code:'OPERATIONS_STALE', message, data:<GET payload> }`;
 * the panel shows the current profile and lets the operator re-apply.
 * Omitting expectedUpdatedAt keeps the old unconditional save.
 * Every 200 / 409 body carries `data.updatedAt` to use on the next PUT.
 *
 * Per-branch overrides (§12.1): GET adds
 *   branches: [{ branch:{_id,name,isActive}, overrides|null, hasOverride,
 *                updatedAt|null, resolved, validation }]
 * for every ACTIVE branch. The branch PUT body is
 * `{ overrides, expectedUpdatedAt }` where `overrides` is a PARTIAL stored
 * profile (preset / modules / answers / advanced — unknown keys dropped);
 * the MERGED profile (tenant + overrides) is normalised and validated
 * (400 on errors, warnings returned). expectedUpdatedAt compares against
 * that branch entry's updatedAt (null = "no override yet"); mismatch →
 * 409 OPERATIONS_STALE with the GET payload. 200 / 409 bodies add
 * `branchId` and `branch` (that branch's entry) next to the GET payload.
 */
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Branch = require('../models/branch');
const User = require('../models/user');
const Order = require('../models/order');
const { recordAudit } = require('../utils/audit');
const logger = require('../utils/logger');
const EVENTS = require('../realtime/events');
const {
    PRESETS, MODULE_KEYS, MODULE_PLAN_FEATURE, ADVANCED_PATHS,
    OperationsProfileError, normaliseProfile, validateProfile, resolveOperations,
    diffImpact, DEFAULT_PROFILE,
    normaliseOverrides, mergeProfileOverrides, branchOverrideEntry, storedProfileFor, requestBranchId,
} = require('../utils/operationsProfile');

const RESTAURANT_FIELDS = 'name slug status subscription featureOverrides addons operations operationsByBranch';

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
        key: 'kotPrinter',
        label: 'Where do KOTs / bills print?',
        help: 'For onboarding only — printers are set up in the restaurant\'s Settings → Printers. This answer does not change printing yet. With no printer, KOTs show on the admin screen.',
        informational: true,
        options: [
            { value: null, label: 'Decide from the modules (kitchen printer with the chef module, counter printer without)' },
            { value: 'kitchen', label: 'Kitchen printer' },
            { value: 'counter', label: 'Counter printer' },
            { value: 'none', label: 'No printer — KOTs show on the admin screen' },
        ],
    },
    {
        key: 'useTables',
        label: 'Does the restaurant use table numbers?',
        help: 'No = token-number mode: dine-in orders get a token (T-001…) instead of a table; the Tables dashboard becomes a token board.',
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

const toIso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Active branches of a tenant, oldest first (Main is normally first). Never throws. */
async function activeBranches(restaurantId) {
    try {
        return await Branch.find({ restaurant: restaurantId, isActive: true })
            .select('name isActive createdAt').sort({ createdAt: 1 }).lean();
    } catch (err) {
        logger.warn('operations: branch list failed: ' + err.message);
        return [];
    }
}

/** One branch's entry for the GET payload. */
function branchPayload(restaurant, branch) {
    const entry = branchOverrideEntry(restaurant, branch._id);
    const overrides = entry ? normaliseOverrides(entry.overrides) : null;
    let validation;
    try {
        validation = validateProfile(normaliseProfile(storedProfileFor(restaurant, branch._id)));
    } catch (err) {
        validation = { errors: err.errors || [err.message], warnings: [] };
    }
    return {
        branch: { _id: branch._id, name: branch.name, isActive: branch.isActive !== false },
        overrides,
        hasOverride: !!entry,
        updatedAt: toIso(entry?.updatedAt),
        resolved: resolveOperations(restaurant, { branchId: branch._id }),
        validation,
    };
}

async function buildPayload(restaurant, { branches } = {}) {
    const { profile, isDefault, corrupt } = storedProfile(restaurant);
    const list = branches || await activeBranches(restaurant._id);
    return {
        restaurant: { _id: restaurant._id, name: restaurant.name, slug: restaurant.slug },
        profile,
        isDefault,
        ...(corrupt ? { corrupt: true } : {}),
        // Concurrency token for PUT (send it back as `expectedUpdatedAt`);
        // null while the restaurant has no profile yet.
        updatedAt: storedUpdatedAtIso(restaurant),
        resolved: resolveOperations(restaurant),
        validation: validateProfile(profile),
        // §12.1 — every active branch with its override (or null) and
        // what it resolves to.
        branches: list.map((b) => branchPayload(restaurant, b)),
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
    if (!Array.isArray(restaurant.operationsByBranch)) restaurant.operationsByBranch = [];
    return restaurant;
}

/**
 * The ACTIVE branch `branchId` of this tenant; 400 on a malformed id, 404
 * (BRANCH_NOT_FOUND) for another tenant's branch, an unknown one or an
 * inactive one. Returns the lean branch or null (response already sent).
 */
async function loadBranch(res, restaurant, branchId) {
    if (!mongoose.isValidObjectId(branchId)) {
        res.status(400).json({ success: false, message: 'Invalid branch id' });
        return null;
    }
    const branch = await Branch.findOne({ _id: branchId, restaurant: restaurant._id, isActive: true })
        .select('name isActive').lean();
    if (!branch) {
        res.status(404).json({ success: false, code: 'BRANCH_NOT_FOUND', message: 'Branch not found for this restaurant (or inactive)' });
        return null;
    }
    return branch;
}

/**
 * Parse body.operations; sends 400 and returns null on bad input.
 * Returns { candidate, normaliseWarnings } — the warnings are adjustments
 * made while normalising that the response must show alongside
 * validateProfile's warnings.
 */
function parseCandidate(req, res) {
    if (!req.body || typeof req.body !== 'object' || req.body.operations === undefined) {
        res.status(400).json({ success: false, message: 'operations is required' });
        return null;
    }
    // updatedAt / updatedBy are server-owned
    const { updatedAt, updatedBy, ...input } = req.body.operations || {};
    const normaliseWarnings = [];
    try {
        return { candidate: normaliseProfile(input, { warnings: normaliseWarnings }), normaliseWarnings };
    } catch (err) {
        if (err instanceof OperationsProfileError) {
            res.status(400).json({ success: false, code: 'INVALID_OPERATIONS', message: err.message, errors: err.errors });
            return null;
        }
        throw err;
    }
}

/**
 * Parse a branch override (`body.overrides`, or `body.operations` as a
 * fallback for the preview) and normalise the MERGED profile. Sends 400
 * and returns null on bad input. Returns { overrides, candidate,
 * normaliseWarnings } where `overrides` is the sparse diff to store and
 * `candidate` the normalised merged profile.
 */
function parseOverrides(req, res, restaurant) {
    const raw = req.body && typeof req.body === 'object'
        ? (req.body.overrides !== undefined ? req.body.overrides : req.body.operations)
        : undefined;
    if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        res.status(400).json({ success: false, message: 'overrides is required (an object with any of preset, modules, answers, advanced)' });
        return null;
    }
    const overrides = normaliseOverrides(raw);
    if (!Object.keys(overrides).length) {
        res.status(400).json({
            success: false, code: 'INVALID_OPERATIONS',
            message: 'overrides has no known settings — to reset the branch to the tenant profile use DELETE',
            errors: ['overrides has no known settings'],
        });
        return null;
    }
    const normaliseWarnings = [];
    try {
        const merged = mergeProfileOverrides(restaurant.operations ?? null, overrides) || {};
        const { updatedAt, updatedBy, ...input } = merged;
        return { overrides, candidate: normaliseProfile(input, { warnings: normaliseWarnings }), normaliseWarnings };
    } catch (err) {
        if (err instanceof OperationsProfileError) {
            res.status(400).json({ success: false, code: 'INVALID_OPERATIONS', message: err.message, errors: err.errors });
            return null;
        }
        throw err;
    }
}

const uniq = (arr) => [...new Set(arr)];

/** Stored profile's updatedAt as an ISO string, or null when there is no profile / no stamp. */
function storedUpdatedAtIso(restaurant) {
    return toIso(restaurant?.operations?.updatedAt);
}

/**
 * Optimistic concurrency (design §10): the panel sends back the
 * `expectedUpdatedAt` it loaded (profile.updatedAt from GET; null when the
 * restaurant had no profile yet). Omitted → no check (older clients).
 * `currentIso` is the stamp to compare against (tenant profile, or one
 * branch entry). Returns { check: false } | { check: true, stale, expected }.
 */
function concurrencyCheck(req, currentIso) {
    if (!req.body || !('expectedUpdatedAt' in req.body)) return { check: false };
    const raw = req.body.expectedUpdatedAt;
    let expected = null;
    if (raw !== null && raw !== undefined && raw !== '') {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return { check: true, invalid: true };
        expected = d.toISOString();
    }
    return { check: true, expected, stale: expected !== currentIso };
}

const INVALID_STAMP = { success: false, code: 'INVALID_OPERATIONS', message: 'expectedUpdatedAt must be a date or null', errors: ['expectedUpdatedAt must be a date or null'] };

async function staleResponse(res, restaurant, extra = {}) {
    return res.status(409).json({
        success: false,
        code: 'OPERATIONS_STALE',
        message: 'This operations profile was changed by someone else since you loaded it. Review the current profile and apply your changes again.',
        data: { ...await buildPayload(restaurant), ...extra },
    });
}

/** `restaurant` with one branch entry replaced / added / removed — the local image of a write. */
function withBranchEntry(restaurant, branchId, entry) {
    const bid = String(branchId);
    const rest = (restaurant.operationsByBranch || []).filter((e) => String(e.branch?._id || e.branch) !== bid);
    return { ...restaurant, operationsByBranch: entry ? [...rest, entry] : rest };
}

/**
 * Before/after impact plus the live counts that make it concrete: staff
 * accounts that would lose app access, open unpaid dine-in bills at the
 * moment of the switch (§9). `afterRestaurant` is the restaurant as it
 * would be after the save; with a `branchId` both views are resolved for
 * that branch and the counts are scoped to it.
 */
async function buildImpact(restaurant, afterRestaurant, { branchId = null } = {}) {
    const opts = { branchId };
    const before = resolveOperations(restaurant, opts);
    const after = resolveOperations(afterRestaurant, opts);
    const impact = diffImpact(before, after);
    const scope = branchId ? { branch: new mongoose.Types.ObjectId(String(branchId)) } : {};

    const blockedRoles = ['waiter', 'captain', 'chef'].filter(r => before.roles[r] && !after.roles[r]);
    if (blockedRoles.length) {
        const counts = await User.aggregate([
            { $match: { restaurant: restaurant._id, role: { $in: blockedRoles }, status: 'active', ...scope } },
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
            ...scope,
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

/**
 * Open staff apps refetch /auth/me; customer apps pick the change up on
 * their next menu-bootstrap fetch. Tenant-wide: every staff role (admin,
 * manager, waiter, captain, kitchen) in every branch room. `branchId` in
 * the payload tells a branch-aware client whether the change concerns it
 * (null = tenant profile).
 */
async function notifyOperationsUpdated(restaurant, { updatedAt, preset, branchId = null }) {
    try {
        const { getIO, emitToTenantStaff } = require('../utils/socket');
        const io = getIO();
        await emitToTenantStaff(io, restaurant._id, EVENTS.TENANT_OPERATIONS_UPDATED, {
            restaurant: String(restaurant._id),
            updatedAt: toIso(updatedAt),
            preset,
            branchId: branchId ? String(branchId) : null,
        });
    } catch (sockErr) {
        logger.warn('operations update: socket notify failed: ' + sockErr.message);
    }
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
        return res.status(200).json({ success: true, data: await buildPayload(restaurant) });
    } catch (err) {
        logger.error('getRestaurantOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load operations profile' });
    }
};

// POST /superadmin/restaurants/:id/operations/preview
//   body { operations }                       tenant profile candidate
//   body { branchId, overrides }              one branch's override candidate
exports.previewRestaurantOperations = async (req, res) => {
    try {
        const restaurant = await loadRestaurant(req, res);
        if (!restaurant) return;

        const branchId = req.body?.branchId;
        if (branchId !== undefined && branchId !== null && branchId !== '') {
            const branch = await loadBranch(res, restaurant, String(branchId));
            if (!branch) return;
            const parsed = parseOverrides(req, res, restaurant);
            if (!parsed) return;
            const { overrides, candidate, normaliseWarnings } = parsed;
            const { errors, warnings: validationWarnings } = validateProfile(candidate);
            const warnings = uniq([...normaliseWarnings, ...validationWarnings]);
            const after = withBranchEntry(restaurant, branch._id, { branch: branch._id, overrides, updatedAt: new Date() });
            const { after: resolved, impact } = await buildImpact(restaurant, after, { branchId: branch._id });
            return res.status(200).json({
                success: true,
                data: { branchId: String(branch._id), overrides, profile: candidate, resolved, errors, warnings, impact },
            });
        }

        const parsed = parseCandidate(req, res);
        if (!parsed) return;
        const { candidate, normaliseWarnings } = parsed;
        const { errors, warnings: validationWarnings } = validateProfile(candidate);
        const warnings = uniq([...normaliseWarnings, ...validationWarnings]);
        const { after, impact } = await buildImpact(restaurant, { ...restaurant, operations: candidate });
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
        const parsed = parseCandidate(req, res);
        if (!parsed) return;
        const { candidate, normaliseWarnings } = parsed;

        const { errors, warnings: validationWarnings } = validateProfile(candidate);
        const warnings = uniq([...normaliseWarnings, ...validationWarnings]);
        if (errors.length) {
            return res.status(400).json({
                success: false, code: 'INVALID_OPERATIONS', message: errors.join('; '), errors, warnings,
            });
        }

        // Optimistic concurrency: the panel must have loaded the version
        // it is overwriting (expectedUpdatedAt). See concurrencyCheck.
        const cc = concurrencyCheck(req, storedUpdatedAtIso(restaurant));
        if (cc.check && cc.invalid) return res.status(400).json(INVALID_STAMP);
        if (cc.check && cc.stale) return staleResponse(res, restaurant);

        const { impact } = await buildImpact(restaurant, { ...restaurant, operations: candidate });
        const beforeStored = restaurant.operations || null;
        const toSave = { ...candidate, updatedAt: new Date(), updatedBy: req.user?._id || null };

        // The write itself is pinned on the stamp we compared against, so
        // two saves racing past the check above cannot both win.
        const pin = cc.check
            ? (cc.expected
                ? { 'operations.updatedAt': new Date(cc.expected) }
                : { 'operations.updatedAt': { $exists: false } })
            : {};
        const write = await Restaurant.updateOne({ _id: restaurant._id, ...pin }, { $set: { operations: toSave } });
        if (cc.check && !(write.matchedCount ?? write.n ?? 1)) {
            const fresh = await Restaurant.findById(restaurant._id).select(RESTAURANT_FIELDS).lean();
            return staleResponse(res, fresh || restaurant);
        }

        await recordAudit(req, {
            action: 'restaurant.operations.update',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: { before: beforeStored, after: candidate, preset: candidate.preset, impact },
        });

        await notifyOperationsUpdated(restaurant, { updatedAt: toSave.updatedAt, preset: candidate.preset });

        const saved = { ...restaurant, operations: toSave };
        return res.status(200).json({ success: true, data: { ...await buildPayload(saved), warnings, impact } });
    } catch (err) {
        logger.error('updateRestaurantOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to save operations profile' });
    }
};

// PUT /superadmin/restaurants/:id/operations/branches/:branchId
// body { overrides, expectedUpdatedAt }
exports.updateBranchOperations = async (req, res) => {
    try {
        const restaurant = await loadRestaurant(req, res);
        if (!restaurant) return;
        const branch = await loadBranch(res, restaurant, req.params.branchId);
        if (!branch) return;
        const parsed = parseOverrides(req, res, restaurant);
        if (!parsed) return;
        const { overrides, candidate, normaliseWarnings } = parsed;

        const { errors, warnings: validationWarnings } = validateProfile(candidate);
        const warnings = uniq([...normaliseWarnings, ...validationWarnings]);
        if (errors.length) {
            return res.status(400).json({
                success: false, code: 'INVALID_OPERATIONS', message: errors.join('; '), errors, warnings,
            });
        }

        const existing = branchOverrideEntry(restaurant, branch._id);
        const cc = concurrencyCheck(req, toIso(existing?.updatedAt));
        if (cc.check && cc.invalid) return res.status(400).json(INVALID_STAMP);
        if (cc.check && cc.stale) return staleResponse(res, restaurant, { branchId: String(branch._id), branch: branchPayload(restaurant, branch) });

        const now = new Date();
        const entry = { branch: branch._id, overrides, updatedAt: now };
        const after = withBranchEntry(restaurant, branch._id, entry);
        const { impact } = await buildImpact(restaurant, after, { branchId: branch._id });

        // Pinned write: the entry we compared against must still be there
        // unchanged (or still absent), so two racing saves cannot both win.
        let write;
        if (existing) {
            const stampPin = cc.check ? { updatedAt: cc.expected ? new Date(cc.expected) : null } : {};
            write = await Restaurant.updateOne(
                { _id: restaurant._id, operationsByBranch: { $elemMatch: { branch: branch._id, ...stampPin } } },
                { $set: { 'operationsByBranch.$.overrides': overrides, 'operationsByBranch.$.updatedAt': now } },
            );
        } else {
            write = await Restaurant.updateOne(
                { _id: restaurant._id, 'operationsByBranch.branch': { $ne: branch._id } },
                { $push: { operationsByBranch: entry } },
            );
        }
        if (!(write.matchedCount ?? write.n ?? 1)) {
            const fresh = await Restaurant.findById(restaurant._id).select(RESTAURANT_FIELDS).lean() || restaurant;
            return staleResponse(res, fresh, { branchId: String(branch._id), branch: branchPayload(fresh, branch) });
        }

        await recordAudit(req, {
            action: 'restaurant.operations.branch.update',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                branchId: String(branch._id),
                branchName: branch.name,
                before: existing ? normaliseOverrides(existing.overrides) : null,
                after: overrides,
                merged: candidate,
                preset: candidate.preset,
                impact,
            },
        });

        await notifyOperationsUpdated(restaurant, { updatedAt: now, preset: candidate.preset, branchId: branch._id });

        return res.status(200).json({
            success: true,
            data: { ...await buildPayload(after), branchId: String(branch._id), branch: branchPayload(after, branch), warnings, impact },
        });
    } catch (err) {
        logger.error('updateBranchOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to save branch operations overrides' });
    }
};

// DELETE /superadmin/restaurants/:id/operations/branches/:branchId
exports.deleteBranchOperations = async (req, res) => {
    try {
        const restaurant = await loadRestaurant(req, res);
        if (!restaurant) return;
        const branch = await loadBranch(res, restaurant, req.params.branchId);
        if (!branch) return;

        const existing = branchOverrideEntry(restaurant, branch._id);
        if (!existing) {
            return res.status(404).json({ success: false, code: 'OVERRIDE_NOT_FOUND', message: 'This branch has no operations override' });
        }

        const after = withBranchEntry(restaurant, branch._id, null);
        const { impact } = await buildImpact(restaurant, after, { branchId: branch._id });
        await Restaurant.updateOne(
            { _id: restaurant._id },
            { $pull: { operationsByBranch: { branch: branch._id } } },
        );

        await recordAudit(req, {
            action: 'restaurant.operations.branch.delete',
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                branchId: String(branch._id),
                branchName: branch.name,
                before: normaliseOverrides(existing.overrides),
                after: null,
                impact,
            },
        });

        const now = new Date();
        const { profile } = storedProfile(after);
        await notifyOperationsUpdated(restaurant, { updatedAt: now, preset: profile.preset, branchId: branch._id });

        return res.status(200).json({
            success: true,
            data: { ...await buildPayload(after), branchId: String(branch._id), branch: branchPayload(after, branch), impact },
        });
    } catch (err) {
        logger.error('deleteBranchOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to remove branch operations overrides' });
    }
};

// GET /settings/operations — the tenant admin sees its own profile, read-only,
// resolved for the branch the request acts for (pinned / ?branch / Main).
exports.getMyOperations = async (req, res) => {
    try {
        const restaurant = req.restaurant;
        if (!restaurant) {
            return res.status(200).json({ success: true, data: { resolved: resolveOperations(null), isDefault: true, branchId: null } });
        }
        const branchId = requestBranchId(req);
        const entry = branchOverrideEntry(restaurant, branchId);
        return res.status(200).json({
            success: true,
            data: {
                resolved: resolveOperations(restaurant, { branchId }),
                isDefault: !restaurant.operations && !entry,
                branchId,
                branchOverridden: !!entry,
                updatedAt: entry?.updatedAt || restaurant.operations?.updatedAt || null,
            },
        });
    } catch (err) {
        logger.error('getMyOperations error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load operations profile' });
    }
};
