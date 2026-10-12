const Table = require('../models/table');
const Area = require('../models/area');
const Branch = require('../models/branch');
const Settings = require('../models/settings');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');
const Order = require('../models/order');
const Reservation = require('../models/reservation');
const User = require('../models/user');
const Request = require('../models/request');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { signTypedToken, verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const fs = require('fs');
const path = require('path');
const { getIO, emitToStaff, emitToAdmin, emitToWaiter } = require('../utils/socket');
const { getSettings } = require('../utils/settingsCache');
const { publicFeaturesOf } = require('../utils/publicFeatureFlags');
const { publicOperationsOf } = require('../utils/operationsProfile');
const { parseCsv } = require('../utils/csvParser');
const logger = require('../utils/logger');

// Scan-session JWT — binds a guest's session to the physical table they
// scanned, so a guest can't POST /orders with someone else's tableId.
// Issued in getTableByToken, validated in orderController.createOrder
// AND socket.js canJoin (CRIT-12 session-room gating).
//
// TTL rationale: 4h covers a typical dine-in session (order → eat →
// pay → leave) with generous buffer for slow checkout, without
// keeping a QR-issued credential live for days. The value is
// configurable via env for ops — e.g. quick-service counters can
// tighten to 1h, banquet-hall bookings can extend to 6h.
//
// Accepts any value jsonwebtoken's expiresIn understands (number = seconds,
// or string like '1h', '30m', '90s'). Invalid strings throw at sign time,
// which is exactly what we want — we'd rather fail noisy at deploy than
// silently issue a never-expiring token.
const SCAN_TOKEN_TTL = process.env.SCAN_TOKEN_TTL || '4h';

const { tenantFilter, tenantId, pinnedBranchId, branchScopeClause } = require('../utils/tenantScope');
const { getMainBranchId } = require('../utils/mainBranch');
const { resolveMergeLeader, freeTableOrUnmergeGroup } = require('../utils/tableMerge');
const { callerPartyKeys, tableUnavailableError } = require('../utils/tableOccupancy');

// QA #14 — tell diners bound to these tables (they auto-join the
// `table:<id>` room from their scan token) that the table can no longer
// take orders, so the customer app locks ordering straight away instead
// of failing at Place Order.
function emitTableUnavailable(tableIds, reason) {
    try {
        const io = getIO();
        if (!io) return;
        for (const id of tableIds) {
            if (id) io.to(`table:${id}`).emit(EVENTS.TABLE_UNAVAILABLE, { tableId: String(id), reason });
        }
    } catch (err) {
        logger.warn('Socket emit failed:', err.message);
    }
}
const { claimSeat, releaseSeats } = require('../utils/tableSeats');
const { devError } = require('../utils/AppError');
const { pickAllowed, TABLE_UPDATE_FIELDS } = require('../utils/bodyAllowlist');

/**
 * Phase 6 step 2 — validate that a branch id supplied in the body
 * belongs to the caller's tenant. Returns:
 *   { ok: true, branchId }       — valid branch OR null passed
 *   { ok: false, message }       — invalid / wrong-tenant branch
 *
 * `null` / the empty string mean "no branch chosen": the table goes to
 * the tenant's Main branch (utils/mainBranch). A table is a physical
 * thing at one location, and the admin Tables view filters strictly by
 * the selected branch — a branch:null table was invisible there. Only a
 * tenant with no branch at all still gets a tenant-level (null) table.
 */
async function resolveBranch(req, rawBranchId) {
    // Branch-pinned staff (Sub Admins) always create tables at their
    // own branch. They cannot create tenant-level (null) tables nor
    // target another branch — body.branch is ignored for them.
    const pinned = pinnedBranchId(req);
    if (pinned) return { ok: true, branchId: pinned };

    if (rawBranchId === null || rawBranchId === undefined || rawBranchId === '') {
        return { ok: true, branchId: await getMainBranchId(req) };
    }
    if (!mongoose.isValidObjectId(rawBranchId)) {
        return { ok: false, message: 'Invalid branch id' };
    }
    const exists = await Branch.exists({
        _id: rawBranchId,
        ...tenantFilter(req),
        isActive: true,
    });
    if (!exists) {
        return { ok: false, message: 'Branch not found or not part of your restaurant' };
    }
    return { ok: true, branchId: rawBranchId };
}

// Branch-pinned staff may only act on their own branch's tables
// (tenant-level tables with branch=null stay reachable). Returns true
// when `table` belongs to another branch.
function isOtherBranchTable(req, table) {
    const callerPin = pinnedBranchId(req);
    if (!callerPin || !table?.branch) return false;
    return String(table.branch._id || table.branch) !== String(callerPin._id || callerPin);
}
const branchMismatch = (res) => res.status(403).json({
    success: false, code: 'BRANCH_MISMATCH', message: 'This table belongs to another branch.',
});

// Create a new table
const createTable = async (req, res) => {
    try {
        const { name, capacity, area, branch: rawBranch } = req.body;

        // Phase 6 step 2 — validate the optional branch assignment
        // BEFORE touching the table collection. Bad / cross-tenant
        // branch ids abort early with a clear 400.
        const branchCheck = await resolveBranch(req, rawBranch);
        if (!branchCheck.ok) {
            return res.status(400).json({ success: false, message: branchCheck.message });
        }

        // ── Enforce the plan's maxTables limit (0 / missing = uncapped,
        // same reading as the superadmin plan-change usage check).
        const maxTables = req.restaurant?.getLimit?.('maxTables') ?? 0;
        if (maxTables > 0) {
            const tableCount = await Table.countDocuments({ ...tenantFilter(req), isDeleted: { $ne: true } });
            if (tableCount >= maxTables) {
                return res.status(403).json({
                    success: false,
                    code: 'TABLE_LIMIT_REACHED',
                    message: `Your plan allows ${maxTables} table(s). You currently have ${tableCount}. Upgrade your plan to add more.`,
                    current: tableCount,
                    limit: maxTables,
                });
            }
        }

        // Check for existing table in the same area (scoped to tenant).
        // Soft-deleted tables don't count — their name may be reused.
        const existingTable = await Table.findOne({ name: name.trim(), area, isDeleted: { $ne: true }, ...tenantFilter(req) });
        if (existingTable) {
            return res.status(400).json({ success: false, message: 'Table with this name already exists in the selected area.' });
        }

        // Generate a unique token for the QR code
        // We use randomBytes to generate a unique cryptographically secure slug
        const token = crypto.randomBytes(6).toString('hex');
        const uniqueQrToken = `tb-${token}`; // e.g., 'tb-1a2b3c4d5e6f'

        const table = new Table({
            name: name.trim(),
            capacity: Number(capacity),
            area,
            qrToken: uniqueQrToken,
            restaurant: tenantId(req),
            branch: branchCheck.branchId,  // null = tenant-level, ObjectId = assigned
        });

        await table.save();

        // Populate area + branch before returning so the UI can render
        // the full label without a second round-trip.
        const populatedTable = await Table.findById(table._id)
            .populate('area', 'name isActive')
            .populate('branch', 'name slug');
        res.status(201).json({ success: true, message: 'Table created successfully', table: populatedTable });
    } catch (error) {
        // Handle Mongoose duplicate key error (fallback)
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Table with this name already exists in the selected area.' });
        }
        res.status(500).json({ success: false, message: 'Error creating table', ...devError(error) });
    }
};

/**
 * Branch filter for the LIST endpoint. Mirrors areaController's
 * areaBranchFilter so the customer-facing flow shows the same scope:
 *
 *   - Pinned staff (Sub Admin)  → strict { branch: pinned }
 *   - Tenant owner with ?branch → respect override (id / all / tenant-only)
 *   - Customer with selected branch (no auth) → permissive
 *     { $or: [{ branch: null }, { branch: selected }] }
 *
 * The customer-permissive pattern matters because the admin Tables UI
 * has no branch picker — every table the tenant owner creates lands
 * with `branch: null`. Without the $or fallback, a customer who picks
 * the Main branch in the picker would see ZERO tables (their selected
 * branch matches nothing) even though seeded tables exist tenant-wide.
 * Areas already use this pattern; we'd hit the exact same bug here
 * if we inherited the strict filter.
 */
function tableBranchFilter(req) {
    // Main-branch views also include branch:null tables (they belong to
    // Main — utils/tenantScope.branchScopeClause); other branches stay strict.
    const pinned = pinnedBranchId(req);
    if (pinned) return branchScopeClause(req, pinned._id || pinned);

    // Tenant owner via admin switcher: `?branch=<id>` narrows STRICTLY
    // to that branch (no null fallback). Without this, a tenant-null
    // table seeded before per-branch scoping would appear in every
    // branch's view — which is exactly the leak the user flagged after
    // bulk-uploading FC Road tables and finding them in Main's view.
    // The customer flow keeps the permissive shared+branch view because
    // it goes through req.branch (X-Branch-Id header), not the query
    // string.
    const raw = req?.query?.branch;
    if (raw === 'all') return {};
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) {
        return branchScopeClause(req, raw);
    }
    if (req?.branch?._id) {
        return { $or: [{ branch: null }, { branch: req.branch._id }] };
    }
    return {};
}

// Get all tables
const getTables = async (req, res) => {
    try {
        // Optional filters
        const { areaId, area, status } = req.query;
        // Soft-deleted tables stay in the collection for referential
        // integrity but must never appear in a floor listing.
        let query = { ...tenantFilter(req), ...tableBranchFilter(req), isDeleted: { $ne: true } };

        const targetArea = areaId || area;
        if (targetArea) query.area = targetArea;
        if (status) query.status = status;

        const tables = await Table.find(query)
            // See adminBootstrapController: qrToken is select:false and
            // the admin QR modal cannot build a working code without it.
            // +seats → serialised as `seatsTaken` (count only) by the
            // schema's toJSON transform; identities never leave.
            .select('+qrToken +seats')
            .populate('area', 'name isActive')
            .populate('branch', 'name slug')
            .populate('currentDiner.user', 'name mobile email')
            .sort({ name: 1 });

        res.status(200).json({ success: true, tables });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching tables', ...devError(error) });
    }
};

// GET /api/v1/tables/bookable — CUSTOMER-facing table list.
//
// Why this exists separately from getTables(): the staff listing
// populates `currentDiner.user` with the seated customer's name,
// mobile and email, plus assignedWaiter and live status. None of that
// may reach a customer, so the staff route stays `staffOnly` and this
// one returns a deliberately narrow projection.
//
// Before this endpoint existed, the customer "Book a Table" flow
// called the staff route and got a flat 403 "Access denied. Staff
// only." — the booking journey was impossible to complete.
const getBookableTables = async (req, res) => {
    try {
        const { areaId, area } = req.query;
        const query = {
            ...tenantFilter(req),
            ...tableBranchFilter(req),
            // Deleted tables must never be offered for booking.
            isDeleted: { $ne: true },
            // 'disabled' tables are out of service; anything else is
            // shown, with availability conveyed by `isAvailable` below
            // so the UI can dim rather than hide a busy table.
            status: { $ne: 'disabled' },
        };
        const targetArea = areaId || area;
        if (targetArea) {
            if (!mongoose.isValidObjectId(targetArea)) {
                return res.status(400).json({ success: false, message: 'Invalid area' });
            }
            query.area = targetArea;
        }

        const tables = await Table.find(query)
            // Explicit projection — never `.select('-x')`, so a field
            // added to the schema later can't leak by default.
            .select('name capacity status area')
            .populate('area', 'name isActive')
            .sort({ name: 1 })
            .lean();

        // Hide tables in areas the admin has switched off.
        const visible = tables.filter((t) => t.area?.isActive !== false);

        res.status(200).json({
            success: true,
            tables: visible.map((t) => ({
                _id: t._id,
                name: t.name,
                capacity: t.capacity,
                area: t.area ? { _id: t.area._id, name: t.area.name } : null,
                // A boolean, not the raw status string — the customer
                // has no business knowing 'merged' vs 'occupied'.
                isAvailable: t.status === 'free',
            })),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching tables', ...devError(error) });
    }
};

// Get a single table by QR Token (used for scanning flow)
// Marks the table as 'occupied' on first scan so the admin dashboard reflects
// the customer sitting down — even before they place an order.
//
// Phase 1: also returns the table's owning restaurant (slug + name) so the
// frontend can store `X-Restaurant-Slug` and scope every subsequent customer
// request to the right tenant. The qrToken lookup itself is intentionally
// global because the token is cryptographically random — the restaurant link
// is recovered from the table doc.
// QR tokens are generated as `tb-<12-hex-chars>` in createTable. Reject any
// scan URL that doesn't match the exact format so attackers can't probe the
// Table collection with free-form input (regex injection via malformed
// Mongo queries, enumeration latency leaks, etc.).
const QR_TOKEN_REGEX = /^tb-[a-f0-9]{12}$/;

const getTableByToken = async (req, res) => {
    try {
        const { qrToken } = req.params;
        if (!QR_TOKEN_REGEX.test(qrToken || '')) {
            return res.status(404).json({ success: false, message: 'Invalid or expired QR code.' });
        }
        // qrToken is globally unique + cryptographically random; this lookup
        // is what ESTABLISHES the tenant for the customer session.
        // AUDIT-EXEMPT: global QR-token lookup (tenant discovery)
        const table = await Table.findOne({ qrToken }, null, { skipTenantScope: true })
            .select('+qrToken')
            .populate('area', 'name isActive')
            .populate('restaurant', 'name slug status subscription featureOverrides addons operations logo branding')
            .populate('branch', 'name slug displayLabel city addressLine1');

        // Soft-deleted tables keep their document (and qrToken) for
        // billing history, so the sticker still resolves — refuse it.
        if (!table || table.isDeleted) {
            return res.status(404).json({ success: false, code: 'TABLE_UNAVAILABLE', message: 'This table is no longer available. Please scan the QR code at your table.' });
        }

        if (!table.isActive || table.status === 'disabled') {
            return res.status(403).json({ success: false, message: 'This table is currently disabled or inactive.' });
        }

        // Block QR scans against suspended/cancelled tenants — the table
        // physically still has the sticker, but the restaurant cannot serve.
        if (table.restaurant && ['suspended', 'cancelled'].includes(table.restaurant.status)) {
            return res.status(403).json({
                success: false,
                code: 'TENANT_SUSPENDED',
                message: 'This restaurant is temporarily unavailable. Please try again later.',
            });
        }

        // Merged tables share ONE active order across the group. If the
        // customer scanned a non-leader sibling (e.g. scanned Table 6 in a
        // merged 5+6+7 group where Table 5 holds the order), swap in the
        // leader's doc + ID here so:
        //   • the scanToken we sign below binds to the leader (createOrder
        //     will accept posts against the leader's tableId),
        //   • the cart / bill preview reflects the combined group order,
        //   • the customer can't accidentally open a second active order
        //     on their own seat.
        // If the group is merged but nobody holds an order yet,
        // resolveMergeLeader returns the scanned table itself — so the
        // customer who scans first implicitly becomes the leader.
        let effectiveTable = table;
        const isMerged = table.status === 'merged' || (Array.isArray(table.mergedWith) && table.mergedWith.length > 0);
        if (isMerged) {
            const leaderLean = await resolveMergeLeader(table._id, { restaurant: table.restaurant?._id || table.restaurant });
            if (leaderLean && String(leaderLean._id) !== String(table._id)) {
                const leaderDoc = await Table.findOne({ _id: leaderLean._id, restaurant: table.restaurant?._id || table.restaurant })
                    .populate('area', 'name isActive')
                    .populate('restaurant', 'name slug status subscription featureOverrides addons operations logo branding')
                    .populate('branch', 'name slug displayLabel city addressLine1');
                if (leaderDoc) effectiveTable = leaderDoc;
            }
        }

        // Re-scan continuity: ScanTable.jsx forwards the diner's previous
        // scan token (if any). When it was issued for this same table we
        // reuse its sessionId so the diner keeps the same party identity
        // — their existing orders, order-room access and seat.
        let priorSessionId = null;
        const priorToken = req.headers['x-scan-token'];
        if (priorToken) {
            try {
                const decoded = verifyTypedToken(priorToken, TOKEN_TYPES.SCAN);
                if (String(decoded.tableId) === String(effectiveTable._id)) priorSessionId = decoded.sessionId || null;
            } catch { /* expired / invalid — issue a fresh session */ }
        }

        // Decide the party's scan session FIRST — a re-scan keeps its
        // prior session, a new phone gets the id we are about to sign —
        // then reserve a seat for it (QA #13). claimSeat is atomic: a
        // full table answers 409 here, before the diner builds a cart,
        // and N phones scanning a K-seat table at once yield exactly K
        // seats. Staff scanning the sticker (callerPartyKeys → null)
        // never take a seat. Seats live on the merge leader.
        const sessionId = priorSessionId || crypto.randomUUID();
        const seat = await claimSeat({
            table: effectiveTable,
            tenantFilterObj: { restaurant: effectiveTable.restaurant?._id || effectiveTable.restaurant },
            keys: callerPartyKeys(req, sessionId),
        });
        if (!seat.ok) return res.status(seat.status).json(seat.body);

        // Auto-occupy the table on QR scan so the admin dashboard updates in real time.
        // Skip if it's already occupied/merged/reserved (don't clobber existing state).
        if (effectiveTable.status === 'free') {
            effectiveTable.status = 'occupied';
            await effectiveTable.save();
            try {
                emitToStaff(getIO(), effectiveTable.branch, EVENTS.TABLE_UPDATED, { tableId: effectiveTable._id, status: 'occupied' });
            } catch (err) {
                logger.warn('Socket emit failed:', err.message);
            }
        }

        // Build the response — include a `restaurant` block the frontend
        // can use to store the active tenant slug + customer-facing
        // feature flags. The frontend uses the feature flags to hide
        // modules the tenant hasn't paid for (Wallet, Bookings, Coupons)
        // so customers don't tap through to a 403.
        const tableObj = effectiveTable.toObject();

        // Resolve the customer-facing logo. Three possible sources, in
        // priority order, mirroring what Settings.getSettings would return
        // for a branch-scoped customer reader:
        //   1. Branch-level Settings.general.logoUrl  (per-location override)
        //   2. Tenant-level Settings.general.logoUrl  (chain-wide brand)
        //   3. Restaurant.logo                        (legacy field, used by
        //                                              /public/restaurants/by-slug)
        // Admins typically upload via the Settings page → ends up at
        // Settings.general.logoUrl, NOT on Restaurant.logo, which is why
        // the previous version of this endpoint showed a letter chip.
        let resolvedLogoUrl = '';
        try {
            const restaurantId = tableObj.restaurant?._id || tableObj.restaurant;
            const branchId = tableObj.branch?._id || tableObj.branch || null;
            if (restaurantId) {
                const lookups = [];
                if (branchId) {
                    lookups.push(Settings.findOne({ restaurant: restaurantId, branch: branchId })
                        .select('general.logoUrl').lean());
                }
                lookups.push(Settings.findOne({ restaurant: restaurantId, branch: null })
                    .select('general.logoUrl').lean());
                const results = await Promise.all(lookups);
                for (const s of results) {
                    const u = s?.general?.logoUrl;
                    if (u && String(u).trim()) { resolvedLogoUrl = String(u).trim(); break; }
                }
            }
        } catch (logoErr) {
            // Non-fatal — letter fallback in the UI is acceptable.
            logger.warn('Scan logo lookup failed (non-fatal): ' + logoErr.message);
        }

        if (tableObj.restaurant) {
            tableObj.restaurant = {
                _id: tableObj.restaurant._id,
                name: tableObj.restaurant.name,
                slug: tableObj.restaurant.slug,
                features: publicFeaturesOf(tableObj.restaurant),
                operations: publicOperationsOf(tableObj.restaurant, {
                    branchId: tableObj.branch?._id || tableObj.branch || null,
                }),
                // Customer-facing logo — Settings.general.logoUrl first,
                // then Restaurant.logo as a last resort. ScanTable.jsx
                // reads `restaurant.logo` for the hero.
                logo: resolvedLogoUrl || tableObj.restaurant.logo || null,
                branding: tableObj.restaurant.branding || null,
            };
        }

        // Sign a short-lived scan-session token. The frontend stores this
        // and sends it back as X-Scan-Token on guest order create, so a
        // guest cannot POST an order against a tableId they never scanned.
        // Staff users have JWTs and skip this path entirely.
        //
        // CRIT-12 — the token also carries a per-scan sessionId (random
        // UUID). Orders created in this session are stamped with the
        // same sessionId, and the socket `order:<id>` room gate checks
        // it. Prevents today's diner on Table 7 from joining an order
        // room belonging to yesterday's diner on the same table.
        //
        // Note: we bind the token to the EFFECTIVE (leader) table for
        // merged groups — the original QR token remains the scanned
        // sticker's for audit, but all order writes must target the
        // leader so they hit the group's single active order.
        try {
            tableObj.scanToken = signTypedToken(
                TOKEN_TYPES.SCAN,
                {
                    tableId: String(effectiveTable._id),
                    restaurantId: String(effectiveTable.restaurant?._id || effectiveTable.restaurant || ''),
                    qrToken: effectiveTable.qrToken,
                    sessionId,
                },
                { expiresIn: SCAN_TOKEN_TTL }
            );
            tableObj.scanSessionId = sessionId;
        } catch (err) {
            logger.warn('Scan token sign failed:', err.message);
        }

        // ── Repeat-QR-scan detection ──────────────────────────────────
        // The admin Settings page has a "Repeat QR Code Scan Alert"
        // toggle ("This appears to be a repeat scan. The table has
        // already completed its order and payment.") but the gating
        // logic was missing entirely — the toggle did nothing. Detect
        // here: if the same table has a Paid + Served order in the
        // last 60 minutes, this scan is almost certainly a confused
        // re-scan (the previous diners are still in the chair, or a
        // new party sat down before staff reset the table). Emit a
        // staff notification + return a `repeatScan` flag so the
        // customer-facing landing page can show a heads-up.
        try {
            const tenantForRepeat = effectiveTable.restaurant?._id || effectiveTable.restaurant || null;
            if (tenantForRepeat) {
                const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);
                const recentCompleted = await Order.findOne({
                    restaurant: tenantForRepeat,
                    table: effectiveTable._id,
                    paymentStatus: 'Paid',
                    status: { $in: ['served', 'completed'] },
                    $or: [
                        { paidAt: { $gte: sixtyMinAgo } },
                        { updatedAt: { $gte: sixtyMinAgo } },
                    ],
                })
                    .select('orderId paidAt updatedAt')
                    .sort({ paidAt: -1, updatedAt: -1 })
                    .lean();

                if (recentCompleted) {
                    tableObj.repeatScan = true;
                    tableObj.lastCompletedOrderId = recentCompleted.orderId;

                    // Gate the staff notification on the admin toggle —
                    // the flag in the response stays regardless so the
                    // customer UI can warn even when the toggle is off.
                    let repeatToggleOn = true;
                    try {
                        const s = await getSettings(tenantForRepeat);
                        if (s && s.notifications?.repeatQR === false) repeatToggleOn = false;
                    } catch (_) { /* default to on */ }

                    if (repeatToggleOn) {
                        const tableLabel = effectiveTable.tableNumber || effectiveTable.name || effectiveTable._id;
                        const notifBranch = effectiveTable.branch?._id || effectiveTable.branch || null;
                        // Two notifications — one for admin, one for waiter — so the
                        // alert lands wherever staff happen to be looking.
                        await notify({
                            restaurant: tenantForRepeat,
                            branch: notifBranch,
                            audience: ['admin', 'waiter'],
                            notification: {
                                recipientRole: ['admin', 'waiter'],
                                title: 'Repeat QR scan detected',
                                description: `Table ${tableLabel} was scanned again but its last order (${recentCompleted.orderId}) is already paid and served. Reset the table or assist the diner.`,
                                category: 'Table',
                                priority: 'medium',
                                meta: { tableId: String(effectiveTable._id), tableLabel, lastOrderId: recentCompleted.orderId },
                            },
                        });
                    }
                }
            }
        } catch (repeatErr) {
            // Detection failure must not block the scan — log and move on.
            logger.warn('Repeat QR scan detection failed (non-fatal):', repeatErr.message);
        }

        res.status(200).json(tableObj);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching table data', ...devError(error) });
    }
};

// Update a table
const updateTable = async (req, res) => {
    try {
        const { id } = req.params;
        // Explicit allowlist (see utils/bodyAllowlist.js). Waiter
        // assignment, QR token, merge state, diner snapshot, alerts,
        // activeOrder and soft-delete fields each have their own
        // endpoint / server flow and are never taken from this body.
        const updates = pickAllowed(req.body, TABLE_UPDATE_FIELDS);

        const table = await Table.findOne({ _id: id, ...tenantFilter(req) });
        if (!table) {
            return res.status(404).json({ success: false, message: 'Table not found' });
        }

        // Same branch gate as assignWaiter: a branch-pinned captain /
        // Branch Admin may only edit tables at their own branch
        // (tenant-level tables with branch=null stay reachable).
        const callerPin = pinnedBranchId(req);
        const callerBranch = callerPin ? String(callerPin._id || callerPin) : null;
        if (callerBranch && table.branch && String(table.branch) !== callerBranch) {
            return res.status(403).json({ success: false, code: 'BRANCH_MISMATCH', message: 'This table belongs to another branch.' });
        }

        // Phase 6 step 2 — if the update is moving the table to a
        // different branch, validate the target. Accepts the same
        // nil-variants as createTable (undefined / null / '' → the
        // Main branch). If `branch` isn't in the body at all, the
        // existing assignment is preserved.
        if (Object.prototype.hasOwnProperty.call(updates, 'branch')) {
            const branchCheck = await resolveBranch(req, updates.branch);
            if (!branchCheck.ok) {
                return res.status(400).json({ success: false, message: branchCheck.message });
            }
            updates.branch = branchCheck.branchId;
        }

        // If name or area is changed, we'd ideally validate uniqueness again,
        // but Mongoose index will catch duplicate keys.

        Object.keys(updates).forEach(key => {
            if (updates[key] !== undefined) {
                table[key] = updates[key];
            }
        });

        // Any path that flips the table back to 'free' (e.g. the floor
        // view's status toggle → PUT /tables/:id) must also drop the diner
        // snapshot — otherwise the next customer who occupies the table
        // would see the previous diner's name leak into the admin drawer.
        if (updates.status === 'free') {
            table.currentDiner = { user: null, name: '', phone: '', isRegistered: false, claimedAt: null };
        }

        await table.save();

        // A table reset to free, or taken out of service, releases every
        // seat reservation (QA #13). Merged groups keep seats on the
        // leader, so clear the siblings too.
        if (updates.status === 'free' || updates.status === 'disabled' || updates.isActive === false) {
            await releaseSeats([table._id, ...(table.mergedWith || [])], tenantFilter(req));
        }
        if (updates.status === 'disabled' || updates.isActive === false) {
            emitTableUnavailable([table._id, ...(table.mergedWith || [])], 'disabled');
        }

        const populatedTable = await Table.findById(table._id)
            .populate('area', 'name isActive')
            .populate('branch', 'name slug');

        try { emitToStaff(getIO(), table.branch, EVENTS.TABLE_UPDATED, { tableId: table._id, status: table.status }); } catch (err) { logger.warn('Socket emit failed:', err.message) }

        res.status(200).json({ success: true, message: 'Table updated successfully', table: populatedTable });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Table with this name already exists in the selected area.' });
        }
        res.status(500).json({ success: false, message: 'Error updating table', ...devError(error) });
    }
};

// Delete a table
const deleteTable = async (req, res) => {
    try {
        const { id } = req.params;
        const tf = tenantFilter(req);

        // Check for active reservations (scoped to tenant)
        const activeRes = await Reservation.findOne({
            table: id,
            status: { $in: ['Pending', 'Approved', 'Confirmed', 'Seated'] },
            ...tf,
        });
        if (activeRes) {
            return res.status(400).json({ success: false, message: 'Cannot delete table with active reservations. Cancel them first.' });
        }

        // Check if part of a merge group (scoped to tenant)
        const mergeRef = await Table.findOne({ mergedWith: id, ...tf });
        if (mergeRef) {
            return res.status(400).json({ success: false, message: 'Cannot delete table that is part of a merge group. Unmerge first.' });
        }

        const current = await Table.findOne({ _id: id, isDeleted: { $ne: true }, ...tf })
            .select('status mergedWith name branch').lean();
        if (!current) {
            return res.status(404).json({ success: false, message: 'Table not found' });
        }
        if (isOtherBranchTable(req, current)) return branchMismatch(res);
        if (Array.isArray(current.mergedWith) && current.mergedWith.length > 0) {
            return res.status(400).json({ success: false, message: 'Cannot delete table that is part of a merge group. Unmerge first.' });
        }

        // Block deletion while the table still has an unsettled bill —
        // a live order, OR a served order that hasn't been paid yet (the
        // normal state of an occupied table after food arrives). The old
        // check only looked at new/preparing/ready, so an occupied table
        // with served-but-unpaid food could be deleted and the diner's
        // "add more items" then re-opened the order and sent it to the
        // kitchen and waiter.
        const Order = require('../models/order');
        const openOrder = await Order.findOne({
            table: id,
            ...tf,
            $or: [
                { status: { $in: ['awaiting-payment', 'new', 'preparing', 'ready'] } },
                { status: 'served', paymentStatus: { $nin: ['Paid', 'Refunded'] } },
            ],
        }).select('_id orderId').lean();
        if (openOrder) {
            return res.status(400).json({
                success: false,
                code: 'TABLE_HAS_ACTIVE_ORDER',
                message: `Table has an open order (${openOrder.orderId}). Settle or cancel it before deleting.`,
            });
        }

        // A diner can be seated (scanned in) before placing any order.
        if (current.status === 'occupied') {
            return res.status(400).json({
                success: false,
                code: 'TABLE_OCCUPIED',
                message: `Table "${current.name}" is occupied. Free the table before deleting it.`,
            });
        }

        // SOFT delete. A hard findOneAndDelete orphaned every order,
        // reservation and in-flight customer session that referenced
        // this table — and because createOrder's table lookup swallows
        // a miss, customers could keep ordering against a table the
        // admin had removed. Flagging instead keeps those references
        // resolvable and lets historical bills still print a name.
        // The status guard closes the race where a diner occupies the
        // table between the checks above and this write.
        const table = await Table.findOneAndUpdate(
            { _id: id, isDeleted: { $ne: true }, status: { $ne: 'occupied' }, 'mergedWith.0': { $exists: false }, ...tf },
            { $set: { isDeleted: true, deletedAt: new Date(), status: 'disabled', seats: [] } },
            { returnDocument: 'after' },
        );

        if (!table) {
            return res.status(409).json({
                success: false,
                code: 'TABLE_OCCUPIED',
                message: 'The table was just occupied. Free it before deleting.',
            });
        }

        emitTableUnavailable([table._id], 'deleted');
        res.status(200).json({ success: true, message: 'Table deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting table', ...devError(error) });
    }
};

// Regenerate QR Token
const regenerateQrToken = async (req, res) => {
    try {
        const { id } = req.params;
        const table = await Table.findOne({ _id: id, ...tenantFilter(req) });

        if (!table) {
            return res.status(404).json({ success: false, message: 'Table not found' });
        }

        // Generate a new unique token
        const token = crypto.randomBytes(6).toString('hex');
        table.qrToken = `tb-${token}`;

        await table.save();

        const populatedTable = await Table.findById(table._id).populate('area', 'name isActive');
        res.status(200).json({ success: true, message: 'QR Token regenerated successfully', table: populatedTable });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error regenerating QR token', ...devError(error) });
    }
};

// Operations profile: table merging switched off (tables.mergeTables).
function mergeDisabled(req) {
    if (!req.restaurant) return false;
    const { resolveOperations } = require('../utils/operationsProfile');
    return resolveOperations(req.restaurant).tables.mergeTables === false;
}
function mergeDisabledReply(res) {
    return res.status(400).json({
        success: false,
        code: 'MERGE_DISABLED',
        message: 'Merging tables is turned off for this restaurant.',
    });
}

// Merge tables
const mergeTables = async (req, res) => {
    try {
        const { tableIds } = req.body;

        if (mergeDisabled(req)) return mergeDisabledReply(res);

        if (!tableIds || !Array.isArray(tableIds) || tableIds.length < 2) {
            return res.status(400).json({ success: false, message: 'At least two tables are required to merge.' });
        }

        const tables = await Table.find({ _id: { $in: tableIds }, ...tenantFilter(req) });

        if (tables.length !== tableIds.length) {
            return res.status(404).json({ success: false, message: 'One or more tables not found.' });
        }
        if (tables.some((t) => isOtherBranchTable(req, t))) return branchMismatch(res);

        // Check if same area
        const areaId = tables[0].area.toString();
        const sameArea = tables.every(t => t.area.toString() === areaId);
        if (!sameArea) {
            return res.status(400).json({ success: false, message: 'Tables must belong to the same area to be merged.' });
        }

        // Check for occupied/reserved/alert statuses
        const occupiedTables = tables.filter(t => t.status === 'occupied');
        const reservedTables = tables.filter(t => t.status === 'reserved');
        const alertTables = tables.filter(t => t.status === 'alert');
        const disabledTables = tables.filter(t => t.status === 'disabled' || t.status === 'merged');

        if (disabledTables.length > 0) {
            return res.status(400).json({ success: false, message: 'One or more tables are already merged or disabled.' });
        }

        if (reservedTables.length > 0) {
            return res.status(400).json({ success: false, message: 'Cannot merge tables that are currently reserved.' });
        }

        if (alertTables.length > 0) {
            return res.status(400).json({ success: false, message: 'Please resolve alerts on tables before merging.' });
        }

        if (occupiedTables.length > 1) {
            return res.status(400).json({ success: false, message: 'Multiple tables have active orders. You can only merge one occupied table with free tables.' });
        }

        // Atomic merge: update all tables in a single operation (prevents partial state on crash)
        const mergeOps = tableIds.map(id => ({
            updateOne: {
                filter: { _id: id },
                update: {
                    $set: {
                        status: 'merged',
                        mergedWith: tableIds.filter(tid => tid.toString() !== id.toString())
                    }
                }
            }
        }));
        await Table.bulkWrite(mergeOps);

        // Seat reservations (QA #13) live on the merge leader and count
        // against the group's summed capacity. Move any seats already
        // taken at a member (e.g. diners who scanned the occupied table
        // before the merge) onto the leader so the whole group is one pool.
        try {
            const tf = tenantFilter(req);
            const leader = await resolveMergeLeader(tableIds[0], tf);
            if (leader) {
                const members = await Table.find({ _id: { $in: tableIds }, ...tf }).select('+seats').lean();
                const moved = [];
                for (const m of members) {
                    if (String(m._id) !== String(leader._id) && Array.isArray(m.seats) && m.seats.length) moved.push(...m.seats);
                }
                if (moved.length) {
                    await Table.updateMany(
                        { _id: { $in: tableIds.filter((tid) => String(tid) !== String(leader._id)) }, ...tf },
                        { $set: { seats: [] } },
                    );
                    await Table.updateOne(
                        { _id: leader._id, ...tf },
                        { $push: { seats: { $each: moved.map(({ _id, ...seat }) => seat) } } },
                    );
                }
            }
        } catch (err) {
            logger.warn('mergeTables: seat consolidation failed: ' + err.message);
        }

        // Per-tenant settings (was the legacy no-arg single-tenant lookup).
        const settings = await getSettings(req);
        // All merged tables share the same branch (validated above by "same area" rule).
        const branchForMerge = tables[0]?.branch || null;

        if (!settings || settings.notifications?.tableMerge !== false) {
            const tableNames = tables.map(t => t.name).join(', ');
            // Row is tenant-level (no branch), live toast goes to the branch.
            await notify({
                restaurant: tenantId(req),
                notification: {
                    title: 'Tables Merged',
                    description: `Tables [${tableNames}] have been merged.`,
                    category: 'Service',
                    recipientRole: 'admin',
                    meta: { tableIds },
                },
            });
            await notify({
                restaurant: tenantId(req),
                branch: branchForMerge,
                audience: ['admin', 'waiter'],
                persist: false,
                payload: { title: 'Tables Merged', description: `[${tableNames}] merged.` },
            });
        }

        await notify({
            restaurant: tenantId(req),
            branch: branchForMerge,
            audience: 'staff',
            persist: false,
            event: EVENTS.TABLE_UPDATED,
            payload: { action: 'merged', tableIds },
        });

        res.status(200).json({ success: true, message: 'Tables merged successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error merging tables', ...devError(error) });
    }
};

// Unmerge Tables
const unmergeTables = async (req, res) => {
    try {
        // We can accept a single tableId that is part of a merged group, and unmerge the entire group it belongs to
        const { tableId } = req.body;

        if (mergeDisabled(req)) return mergeDisabledReply(res);

        const table = await Table.findOne({ _id: tableId, ...tenantFilter(req) });
        if (!table || table.status !== 'merged') {
            return res.status(400).json({ success: false, message: 'Table is not merged' });
        }
        if (isOtherBranchTable(req, table)) return branchMismatch(res);

        const allMergedIds = [table._id, ...(table.mergedWith || [])];

        // Refuse to split a group that's mid-service. The merge group
        // shares one order tied to the leader's tableId — splitting now
        // would orphan that order (siblings would flip to 'free' while
        // the leader still holds an unpaid order) and the kitchen ticket
        // would no longer match the seating. Settle / void the order
        // first, then unmerge.
        const liveOrder = await Table.findOne({
            _id: { $in: allMergedIds },
            activeOrder: { $ne: null },
            ...tenantFilter(req),
        }).select('_id').lean();
        if (liveOrder) {
            return res.status(400).json({
                success: false,
                message: 'Cannot unmerge: this group has an active order. Settle or void the order first.',
            });
        }

        // Reset all tables in this group (scoped to tenant)
        await Table.updateMany(
            { _id: { $in: allMergedIds }, ...tenantFilter(req) },
            // Seats live on the group leader; splitting the group
            // releases them (QA #13) — diners re-claim on their next
            // scan / order.
            { $set: { status: 'free', mergedWith: [], seats: [] } }
        );

        // Per-tenant settings (was the legacy no-arg single-tenant lookup).
        const settings = await getSettings(req);

        if (!settings || settings.notifications?.tableMerge !== false) {
          // Row is tenant-level (no branch), live toast goes to the branch.
          await notify({
              restaurant: tenantId(req),
              notification: {
                  title: 'Tables Unmerged',
                  description: `A group of tables has been unmerged.`,
                  category: 'Service',
                  recipientRole: 'admin',
              },
          });
          await notify({
              restaurant: tenantId(req),
              branch: table.branch,
              audience: ['admin', 'waiter'],
              persist: false,
              payload: { title: 'Tables Unmerged', description: 'Table group unmerged.' },
          });
        }

        await notify({
            restaurant: tenantId(req),
            branch: table.branch,
            audience: 'staff',
            persist: false,
            event: EVENTS.TABLE_UPDATED,
            payload: { action: 'unmerged' },
        });

        res.status(200).json({ success: true, message: 'Tables unmerged successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error unmerging tables', ...devError(error) });
    }
};

// Assign a waiter to a table
const assignWaiter = async (req, res) => {
    try {
        const { id } = req.params;
        const { waiterId } = req.body;

        const table = await Table.findOne({ _id: id, ...tenantFilter(req) }).populate('area', 'name');
        if (!table) {
            return res.status(404).json({ success: false, message: 'Table not found' });
        }

        // Operations profile: nobody serves at the table, so there is no
        // one to assign. Clearing an old assignment is still allowed.
        if (waiterId && req.restaurant) {
            const { resolveOperations } = require('../utils/operationsProfile');
            if (!resolveOperations(req.restaurant).tables.assignWaiters) {
                return res.status(400).json({
                    success: false,
                    code: 'WAITERS_NOT_IN_USE',
                    message: 'This restaurant is set up without waiters, so tables are not assigned to anyone.',
                });
            }
        }

        // A branch-pinned captain may only reassign tables at their own
        // branch (tenant-level tables with branch=null stay reachable).
        const callerPin = pinnedBranchId(req);
        const callerBranch = callerPin ? String(callerPin._id || callerPin) : null;
        if (callerBranch && table.branch && String(table.branch) !== callerBranch) {
            return res.status(403).json({ success: false, code: 'BRANCH_MISMATCH', message: 'This table belongs to another branch.' });
        }

        // Validate the waiter belongs to this tenant before stamping it on a
        // tenant table. This endpoint is now reachable by captains (head
        // waiters reassigning their floor), so don't trust a raw id from the
        // client — verify it resolves to a real floor-staff user in-tenant.
        // `waiterId` may be null/empty to CLEAR the assignment.
        if (waiterId) {
            if (!mongoose.isValidObjectId(waiterId)) {
                return res.status(400).json({ success: false, message: 'Invalid waiter id' });
            }
            const waiter = await User.findOne({
                _id: waiterId,
                role: { $in: ['waiter', 'captain'] },
                status: 'active',
                ...tenantFilter(req),
            }).select('_id branch');
            if (!waiter) {
                return res.status(404).json({ success: false, message: 'Waiter not found in this restaurant' });
            }
            // Don't hand a table to someone working a different branch.
            if (waiter.branch && table.branch && String(waiter.branch) !== String(table.branch)) {
                return res.status(400).json({ success: false, code: 'BRANCH_MISMATCH', message: 'That waiter works at a different branch.' });
            }
        }
        const previousWaiterId = table.assignedWaiter ? String(table.assignedWaiter) : null;

        table.assignedWaiter = waiterId || null;
        await table.save();

        const populatedTable = await Table.findById(table._id).populate('assignedWaiter', 'name staffId');

        // Open service requests on this table follow the table: a request
        // auto-accepted for the previous waiter would otherwise stay on a
        // waiter who no longer serves it, and the new one never sees it.
        // (Clearing the assignment leaves requests where they are.)
        if (waiterId) {
            try {
                const handover = [{ status: 'pending' }];
                if (previousWaiterId) handover.push({ status: 'accepted', waiter: previousWaiterId });
                await Request.updateMany(
                    { table: table._id, $or: handover, ...tenantFilter(req) },
                    { $set: { waiter: waiterId, status: 'accepted', acceptedAt: new Date() } },
                );
            } catch (err) { logger.warn('assignWaiter: request handover failed:', err.message); }
        }

        // Notify the waiter. meta uses the schema's real keys (table/area);
        // the old { tableId, tableName } keys were silently dropped by
        // Mongoose strict mode, so the notification carried no table.
        if (waiterId && String(waiterId) !== previousWaiterId) {
            await notify({
                restaurant: tenantId(req),
                branch: table.branch || null,
                recipients: waiterId,
                notification: {
                    title: 'Table Assigned',
                    description: `You have been assigned to Table ${table.name}${table.area?.name ? ` (${table.area.name})` : ''}`,
                    category: 'Service',
                    recipientRole: 'waiter',
                    meta: { table: table.name, area: table.area?.name || null },
                },
                payload: { title: 'Table Assigned', description: `You have been assigned to Table ${table.name}` },
            });
        }
        // Refresh every floor view (captain floor, waiter grids, admin).
        await notify({
            restaurant: tenantId(req),
            branch: table.branch,
            audience: 'staff',
            persist: false,
            event: EVENTS.TABLE_UPDATED,
            payload: { tableId: String(table._id), action: 'assigned' },
        });

        res.status(200).json({ success: true, message: 'Waiter assigned successfully', table: populatedTable });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error assigning waiter', ...devError(error) });
    }
};

// POST /api/v1/tables/:id/free
// Force-free a table. Operates on EVERY still-active unpaid order on the
// table (independent-orders model), not just the single `activeOrder`
// pointer — an abandoned guest can leave several unpaid rounds behind.
// Behaviour:
//   • no active-unpaid orders, or all empty + unpaid → cancel the empties
//     and free. Unsticks "occupied but empty" tables.
//   • some orders have items or money, and `force` is NOT set → refuse
//     409 with a cascade PREVIEW ({ orderCount, totalAmount }) so the
//     operator can confirm exactly what gets written off.
//   • some orders have items or money, and `force: true` → write off the
//     whole open bill: cancel every active-unpaid order (restoring any
//     deducted inventory), then free. This is the "previous guest left
//     without paying — reset the table for the next diner" path.
// Then defer to the standard free/unmerge helper so the cleanup path
// stays consistent with the auto-sweeper.
const freeTable = async (req, res) => {
    try {
        const { id } = req.params;
        const tf = tenantFilter(req);
        // Accept the flag from body OR query so a simple POST with
        // `?force=true` works as well as a JSON body.
        const force = req.body?.force === true || String(req.query.force || '').toLowerCase() === 'true';

        const table = await Table.findOne({ _id: id, ...tf }).select('_id status activeOrder branch restaurant');
        if (!table) {
            return res.status(404).json({ success: false, message: 'Table not found' });
        }
        if (isOtherBranchTable(req, table)) return branchMismatch(res);

        // Every order still occupying the table — independent-orders model.
        const openOrders = await Order.find({
            table: table._id,
            status: { $in: ['awaiting-payment', 'new', 'preparing', 'ready', 'served'] },
            paymentStatus: { $ne: 'Paid' },
            ...tf,
        }).select('_id status paymentStatus items amountPaid total inventoryDeducted restaurant branch orderId');

        // Split into "real" (has items or money — a genuine bill) vs empty.
        const realOrders = openOrders.filter(o =>
            (Array.isArray(o.items) && o.items.length > 0)
            || o.paymentStatus === 'Partially Paid'
            || Number(o.amountPaid || 0) > 0
        );

        if (realOrders.length > 0 && !force) {
            // Cascade preview — let the operator see what a force-close
            // would write off before committing (per cascade-delete UX).
            const totalAmount = realOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);
            return res.status(409).json({
                success: false,
                code: 'ORDER_NOT_EMPTY',
                orderCount: realOrders.length,
                totalAmount: Math.round(totalAmount * 100) / 100,
                message: `This table has ${realOrders.length} open order(s) totalling ₹${Math.round(totalAmount * 100) / 100}. Close or cancel the bill first, or force-close to write it off.`,
            });
        }

        // Cancel every active-unpaid order on the table (force path writes
        // off real bills; the no-force path only ever reaches here for
        // empty orders). Restore deducted inventory and notify open views.
        if (openOrders.length > 0) {
            let restoreInventoryForOrder;
            try { ({ restoreInventoryForOrder } = require('./inventoryController')); } catch { /* optional */ }
            for (const o of openOrders) {
                const hadItems = Array.isArray(o.items) && o.items.length > 0;
                // AUDIT-EXEMPT: _id from the tenant-filtered openOrders query above
                await Order.updateOne(
                    { _id: o._id, status: { $ne: 'cancelled' } },
                    { $set: {
                        status: 'cancelled',
                        cancelReason: hadItems ? 'walkout' : 'admin-void',
                        cancelReasonNote: 'Table closed by staff — open bill written off / reset for next diner',
                        cancelledAt: new Date(),
                    } }
                );
                if (o.inventoryDeducted && restoreInventoryForOrder) {
                    restoreInventoryForOrder(o, tenantId(req), req.user?._id)
                        .catch(err => logger.warn(`freeTable inventory restore failed for ${o.orderId}: ${err.message}`));
                }
                try { getIO().to(`order:${o._id}`).emit(EVENTS.ORDER_UPDATED, { orderId: String(o._id), status: 'cancelled' }); } catch { /* best-effort */ }
            }
        }

        // Staff reset → every seat on the table / group is released.
        const { freedIds } = await freeTableOrUnmergeGroup(table._id, tf, { clearSeats: true });

        try {
            const io = getIO();
            for (const freedId of freedIds) {
                emitToStaff(io, table.branch, EVENTS.TABLE_UPDATED, { tableId: freedId, status: 'free' });
            }
        } catch { /* socket best-effort */ }

        return res.status(200).json({
            success: true,
            message: openOrders.length > 0
                ? `Table freed — ${openOrders.length} open order(s) closed`
                : 'Table freed',
            freedTableIds: freedIds,
            closedOrderCount: openOrders.length,
        });
    } catch (error) {
        logger.error('freeTable error', { error: error.message });
        return res.status(500).json({ success: false, message: 'Failed to free table' });
    }
};

// Claim an occupied table for the calling customer.
// Called by the customer app right after login when the user lands from
// the QR-scan path (`fromQrScan`). The QR scan itself runs unauthenticated
// — it has to, because ScanTable.jsx wipes the session before issuing the
// scan token — so without this endpoint the admin drawer has no way to
// know which logged-in user is sitting at the table until they actually
// place an order.
//
// Idempotent and safe to call repeatedly. Refuses to overwrite a diner
// snapshot that already points at another order's user (covers the rare
// race where staff add items on the customer's behalf before the customer
// finishes login).
const claimTable = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid table id' });
        }

        // Customer-only path. Staff have their own occupancy flows
        // (assign waiter, take order on behalf of guest) — letting them
        // hit this endpoint would silently overwrite the diner snapshot
        // with the staff member's name, which is misleading.
        if (req.user.role !== 'customer') {
            return res.status(403).json({ success: false, message: 'Only customers can claim a table.' });
        }

        const table = await Table.findOne({ _id: id, ...tenantFilter(req) });
        if (!table || table.isDeleted) {
            return res.status(404).json({ success: false, code: 'TABLE_UNAVAILABLE', message: 'This table is no longer available. Please scan the QR code at your table.' });
        }
        if (table.isActive === false || table.status === 'disabled') {
            return res.status(409).json({ success: false, code: 'TABLE_DISABLED', message: 'This table is out of service. Please ask a staff member for help.' });
        }

        // Seat — the customer joins (or, if their scan session already
        // holds a seat, refreshes and adds their user id to) a seat on
        // the merge leader. A customer who isn't seated can't join a
        // table that is full (QA #13).
        let claimSessionId = null;
        if (req.headers['x-scan-token']) {
            try {
                const decoded = verifyTypedToken(req.headers['x-scan-token'], TOKEN_TYPES.SCAN);
                if (String(decoded.tableId) === String(table._id)) claimSessionId = decoded.sessionId || null;
            } catch { /* optional */ }
        }
        const seatTable = (await resolveMergeLeader(table._id, tenantFilter(req))) || table;
        const seat = await claimSeat({ table: seatTable, tenantFilterObj: tenantFilter(req), keys: callerPartyKeys(req, claimSessionId) });
        if (!seat.ok) return res.status(seat.status).json(seat.body);

        // Don't clobber a diner snapshot that already belongs to a
        // different user (e.g. someone else claimed it first, or staff
        // started an order on this table for another guest).
        const existingDinerUser = table.currentDiner?.user?.toString();
        if (existingDinerUser && existingDinerUser !== req.user.id.toString()) {
            return res.status(409).json({
                success: false,
                code: 'TABLE_CLAIMED_BY_OTHER',
                message: 'This table is already linked to another diner.',
            });
        }

        table.currentDiner = {
            user: req.user.id,
            name: req.user.name || '',
            phone: req.user.mobile || '',
            isRegistered: true,
            claimedAt: new Date(),
        };
        await table.save();

        try {
            emitToStaff(getIO(), table.branch, EVENTS.TABLE_UPDATED, { tableId: table._id, status: table.status });
        } catch (err) {
            logger.warn('Socket emit failed:', err.message);
        }

        return res.status(200).json({ success: true, table });
    } catch (error) {
        logger.error('claimTable error', { error: error.message });
        return res.status(500).json({ success: false, message: 'Failed to claim table' });
    }
};

// ── BULK ONBOARDING ──────────────────────────────────────────────────────────
// Lets a new tenant/branch wire up tables in minutes: download a starter CSV
// pre-filled with common Indian cafe/restaurant areas → owner deletes the
// rows that don't apply → upload → backend auto-creates the missing areas,
// generates qr tokens, inserts every table in one bulk write.

// Path to the curated starter template shipped with the backend.
const TABLES_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'tables-master-template.csv');

// Stream the starter CSV as an attachment so the browser triggers a
// download rather than rendering it inline. We send a Disposition with a
// suggested filename to keep the UX consistent across browsers.
const downloadTablesTemplate = (req, res) => {
    try {
        if (!fs.existsSync(TABLES_TEMPLATE_PATH)) {
            logger.error('Tables template missing on disk', { path: TABLES_TEMPLATE_PATH });
            return res.status(500).json({ success: false, message: 'Starter template not available' });
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="tables-master-template.csv"');
        // No-store: the template is tiny and we don't want stale caching to
        // hide future template updates from existing admins.
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(TABLES_TEMPLATE_PATH).pipe(res);
    } catch (error) {
        logger.error('downloadTablesTemplate error', { error: error.message });
        res.status(500).json({ success: false, message: 'Failed to serve template' });
    }
};

// QR token shape required by getTableByToken's QR_TOKEN_REGEX
// (`^tb-[a-f0-9]{12}$`). crypto.randomBytes(6).toString('hex') → 12 hex chars,
// so the format below matches single-create + regenerate exactly. Keeping
// these in lock-step is what lets bulk-imported tables be scanned.
const newQrToken = () => `tb-${crypto.randomBytes(6).toString('hex')}`;

// POST /api/v1/tables/import
// Body: multipart/form-data with `file` = .csv (header: area,name,capacity)
// - Unknown areas are auto-created scoped to the caller's tenant + branch.
// - Each row is processed independently; a bad row is skipped with an error
//   entry and the rest still import.
// - Returns { success, created, areasCreated, errorCount, errors:[{row,message}] }.
const importTablesCsv = async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: 'CSV file is required (form field: file)' });
        }

        const rows = parseCsv(req.file.buffer.toString('utf8'));
        if (rows.length < 2) {
            return res.status(400).json({ success: false, message: 'CSV must contain a header row and at least one data row' });
        }

        const header = rows[0].map(h => String(h || '').trim().toLowerCase());
        const idx = {
            area:     header.indexOf('area'),
            name:     header.indexOf('name'),
            capacity: header.indexOf('capacity'),
        };
        const missing = ['area', 'name', 'capacity'].filter(col => idx[col] === -1);
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `CSV missing required columns: ${missing.join(', ')}`,
            });
        }

        // Resolve the branch context once.
        //   - Sub Admin uploader → forced to their pinned branch (body
        //     ignored).
        //   - Tenant owner       → prefer (in priority order):
        //       1. body.branch from the multipart form (if any)
        //       2. ?branch=<id> from the admin axios interceptor (the
        //          branch they're currently viewing in the switcher)
        //       3. req.branch._id (X-Branch-Id header)
        //       4. null = tenant-level
        // Why: before this fallback every CSV-imported table landed
        // at branch:null and was then HIDDEN by the strict branch
        // filter when the owner viewed any specific branch — the
        // UI reported "added successfully" but the page stayed empty.
        // Mirrors the same fix applied to inventory + combo importers.
        let rawBranch = req.body?.branch || null;
        if (!rawBranch && !pinnedBranchId(req)) {
            const q = req?.query?.branch;
            if (q && mongoose.isValidObjectId(q)) {
                rawBranch = q;
            } else if (req?.branch?._id) {
                rawBranch = String(req.branch._id);
            }
        }
        const branchCheck = await resolveBranch(req, rawBranch);
        if (!branchCheck.ok) {
            return res.status(400).json({ success: false, message: branchCheck.message });
        }
        const branchId = branchCheck.branchId;
        const restaurantId = tenantId(req);

        if (!restaurantId) {
            return res.status(400).json({ success: false, message: 'Tenant context required for bulk import' });
        }

        // Cache area lookups so a 50-row CSV with 10 distinct areas doesn't
        // do 50 round trips. Key by lowercased name — matches the
        // case-insensitive lookup against the unique (name, restaurant, branch)
        // index on the Area collection.
        const areaCache = new Map();
        let areasCreated = 0;
        let areasExisting = 0;
        const resolveAreaId = async (rawName) => {
            const name = String(rawName || '').trim();
            if (!name) return null;
            const key = name.toLowerCase();
            if (areaCache.has(key)) return areaCache.get(key);

            // Case-insensitive lookup mirrors how menu CSV import resolves
            // categories — the exact string `Garden` in the template should
            // match an existing `garden` area instead of creating a duplicate.
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            let area = await Area.findOne({
                name: new RegExp(`^${escaped}$`, 'i'),
                restaurant: restaurantId,
                branch: branchId,
            });
            if (!area) {
                area = await Area.create({
                    name,
                    restaurant: restaurantId,
                    branch: branchId,
                    isActive: true,
                });
                areasCreated += 1;
            } else {
                areasExisting += 1;
            }
            areaCache.set(key, area._id);
            return area._id;
        };

        // Build a (lowercase) set of existing table names per area so we can
        // pre-filter duplicates without 100 round trips. The DB unique index
        // (name, area) is still the source of truth — this just keeps the
        // happy path fast and the messages friendly.
        const existingNamesByArea = new Map();
        const getExistingNamesForArea = async (areaId) => {
            const cacheKey = String(areaId);
            if (existingNamesByArea.has(cacheKey)) return existingNamesByArea.get(cacheKey);
            const docs = await Table.find({ area: areaId, restaurant: restaurantId, isDeleted: { $ne: true } }).select('name').lean();
            const set = new Set(docs.map(d => String(d.name).trim().toLowerCase()));
            existingNamesByArea.set(cacheKey, set);
            return set;
        };

        // Three buckets per row:
        //   errors[]   — validation problems the owner must fix (bad capacity,
        //                missing field, etc.). These never silently pass.
        //   skipped[]  — table already present (in our DB or duplicated within
        //                this same CSV). Expected during partial re-imports;
        //                surfaced as informational, NOT as an error.
        //   toInsert[] — clean rows queued for the bulk insertMany.
        const errors = [];
        const skipped = [];
        const toInsert = [];
        // Track (areaId|nameLower) tuples we've already queued in this batch
        // so the same CSV can't quietly insert two rows that collide with
        // each other (the bulk insertMany would otherwise hit the unique
        // index halfway through and abort the rest).
        const stagedKeys = new Set();

        for (let i = 1; i < rows.length; i++) {
            // CSV row numbers are 1-based with the header as row 1, so the
            // user sees the first data row as row 2.
            const rowNum = i + 1;
            const cells = rows[i];
            const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

            try {
                const areaName = get('area');
                const name = get('name');
                const capacityRaw = get('capacity');

                if (!areaName) throw new Error('area is required');
                if (!name) throw new Error('name is required');
                if (name.length > 50) throw new Error('name must be 50 characters or fewer');

                const capacity = Number(capacityRaw);
                if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) {
                    throw new Error('capacity must be an integer between 1 and 50');
                }

                const areaId = await resolveAreaId(areaName);

                // Duplicate handling: an existing table in the same (area, name)
                // is NOT an error — the owner re-uploaded the template after
                // already seeding some rows, which is the supported partial-
                // import flow. We just record it under `skipped` so the UI
                // can show a friendly "already in your system" panel.
                const existing = await getExistingNamesForArea(areaId);
                const nameLower = name.toLowerCase();
                if (existing.has(nameLower)) {
                    skipped.push({ row: rowNum, area: areaName, name, reason: 'already in your system' });
                    continue;
                }

                // Same idea for an in-batch dupe (owner pasted the same row
                // twice in the CSV). Treat the second occurrence as skipped
                // so they don't see a scary red error for a benign mistake.
                const dedupeKey = `${areaId}|${nameLower}`;
                if (stagedKeys.has(dedupeKey)) {
                    skipped.push({ row: rowNum, area: areaName, name, reason: 'duplicate row in this file' });
                    continue;
                }
                stagedKeys.add(dedupeKey);

                toInsert.push({
                    name,
                    capacity,
                    area: areaId,
                    qrToken: newQrToken(),
                    restaurant: restaurantId,
                    branch: branchId,
                    status: 'free',
                    isActive: true,
                });
            } catch (rowErr) {
                errors.push({ row: rowNum, message: rowErr.message });
            }
        }

        // Plan maxTables limit (0 / missing = uncapped) — rows past the
        // remaining allowance are reported as errors, not inserted.
        const maxTables = req.restaurant?.getLimit?.('maxTables') ?? 0;
        if (maxTables > 0 && toInsert.length) {
            const tableCount = await Table.countDocuments({ restaurant: restaurantId, isDeleted: { $ne: true } });
            const room = Math.max(0, maxTables - tableCount);
            if (toInsert.length > room) {
                for (const doc of toInsert.splice(room)) {
                    errors.push({ row: null, message: `"${doc.name}" not added — your plan allows ${maxTables} table(s).` });
                }
            }
        }

        let created = 0;
        if (toInsert.length) {
            // ordered:false lets MongoDB skip a row that loses an index race
            // (concurrent admin creates the same name while we're importing)
            // instead of aborting the whole batch.
            try {
                const inserted = await Table.insertMany(toInsert, { ordered: false });
                created = inserted.length;
            } catch (bulkErr) {
                // BulkWriteError surfaces per-doc failures in writeErrors[];
                // We split those: duplicate-key collisions are skipped
                // (race condition with a concurrent admin create — same
                // semantic as the in-row pre-check above), everything else
                // is a real error the owner should see.
                if (bulkErr?.writeErrors?.length) {
                    created = toInsert.length - bulkErr.writeErrors.length;
                    for (const we of bulkErr.writeErrors) {
                        const doc = toInsert[we.index] || {};
                        const isDuplicate = we.code === 11000 || /duplicate key/i.test(we.errmsg || we.message || '');
                        if (isDuplicate) {
                            skipped.push({
                                row: null,
                                area: '',
                                name: doc.name || '',
                                reason: 'already in your system',
                            });
                        } else {
                            errors.push({
                                row: null,
                                message: `Failed to insert "${doc.name}": ${we.errmsg || we.message || 'write conflict'}`,
                            });
                        }
                    }
                } else {
                    throw bulkErr;
                }
            }
        }

        return res.status(200).json({
            success: true,
            created,
            areasCreated,
            areasExisting,
            skippedCount: skipped.length,
            skipped,
            errorCount: errors.length,
            errors,
        });
    } catch (err) {
        logger.error('Tables CSV import error', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to import CSV' });
    }
};

// QA #14 — lightweight check the customer app runs when it comes back
// online / into view, in case it missed the TABLE_UNAVAILABLE push.
// Reveals only whether the table can take orders.
const getTableAvailability = async (req, res) => {
    try {
        const table = await Table.findOne({ _id: req.params.id, ...tenantFilter(req) })
            .select('isDeleted isActive status').lean();
        const unavailable = tableUnavailableError(table);
        if (unavailable) {
            return res.status(200).json({ success: true, available: false, code: unavailable.body.code });
        }
        return res.status(200).json({ success: true, available: true });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error checking table', ...devError(error) });
    }
};

module.exports = {
    getTableAvailability,
    createTable,
    getTables,
    getBookableTables,
    getTableByToken,
    updateTable,
    deleteTable,
    regenerateQrToken,
    mergeTables,
    unmergeTables,
    assignWaiter,
    freeTable,
    claimTable,
    downloadTablesTemplate,
    importTablesCsv,
};
