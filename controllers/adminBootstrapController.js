const mongoose = require('mongoose');
const Table = require('../models/table');
const { exposeSeats } = require('../utils/tableSeats');
const Area = require('../models/area');
const Reservation = require('../models/reservation');
const User = require('../models/user');
const { tenantFilter, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { resolveSettingsForRequest } = require('./settingsController');
const logger = require('../utils/logger');

// Mirrors areaController.areaBranchFilter — kept inline so the bootstrap
// endpoint doesn't pull a controller-level dependency. If that branch
// shape ever drifts, fix it here too.
//
// Pinned staff (Branch Admin) get STRICT { branch: pinned } — tenant-
// level / other-branch areas no longer leak into their dashboard.
// Tenant owner with ?branch=<id> from the AdminBranchContext switcher
// gets the same strict view of that branch — without this, switching
// to "Main" in the dropdown still showed every branch's areas merged.
// Customer flow still gets the permissive shared+branch view.
function areaBranchFilter(req) {
    const pinned = pinnedBranchId(req);
    if (pinned) return { branch: pinned };

    // Tenant owner using the switcher → `?branch=<id>` narrows to that
    // branch. `?branch=all` or unset = unfiltered (sees everything).
    const raw = req?.query?.branch;
    if (raw === 'all') return null;
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) return { branch: raw };

    if (req?.branch?._id) return { $or: [{ branch: null }, { branch: req.branch._id }] };
    return null;
}

const STAFF_ROLE_FILTER = { role: { $nin: ['customer', 'superadmin'] } };

/**
 * GET /api/v1/admin/bootstrap
 *
 * Single round-trip replacement for the 5 parallel calls every admin
 * dashboard fires on first paint (tables, areas, reservations, staff,
 * settings). Server-side Promise.all is faster than 5 client round
 * trips because the network handshake + auth/tenant middleware run
 * once instead of five times.
 *
 * Tolerant: each section is settled independently. A slow / failing
 * sub-query returns null with an `_errors` array entry instead of
 * killing the whole response, so the admin UI can render whatever
 * landed and re-fetch the broken section on its own clock.
 *
 * Query: ?sections=tables,areas,reservations,staff,settings  (default = all)
 */
exports.getAdminBootstrap = async (req, res) => {
    const requested = (req.query.sections || 'tables,areas,reservations,staff,settings')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const want = (s) => requested.includes(s);

    const tasks = {};

    if (want('tables')) {
        const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };
        tasks.tables = Table.find(filter)
            // qrToken is `select: false` on the schema, so it must be
            // asked for explicitly. Without it the admin QR modal has no
            // token to encode and silently falls back to the table's
            // _id — producing a QR that scans to a 404 "Invalid or
            // expired QR code", because the scan route only accepts
            // `tb-<12 hex>`. Staff print this token on a physical label
            // at the table, so it is not secret from them.
            .select('+qrToken +seats')
            .populate('area', 'name isActive')
            .populate('branch', 'name slug')
            .populate('currentDiner.user', 'name mobile email')
            .sort({ name: 1 })
            .lean()
            // Seat identities never leave the server — only the count.
            .then((rows) => rows.map(exposeSeats));
    }

    if (want('areas')) {
        const filter = { ...tenantFilter(req) };
        const branchClause = areaBranchFilter(req);
        if (branchClause) Object.assign(filter, branchClause);
        tasks.areas = Area.find(filter).sort({ createdAt: -1 }).lean();
    }

    if (want('reservations')) {
        // Branch-pinned admin sees only their branch's reservations —
        // strictBranchFilter returns {} for tenant owner (sees all).
        const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };
        tasks.reservations = Reservation.find(filter)
            .populate('area', 'name')
            .populate('table', 'name capacity id')
            .populate('hall', 'name')
            .populate('user', 'name email mobile')
            .sort({ createdAt: -1 })
            .lean();
    }

    if (want('staff')) {
        const filter = { ...STAFF_ROLE_FILTER, ...tenantFilter(req) };
        const pinned = pinnedBranchId(req);
        if (pinned) {
            filter.branch = pinned;
        } else {
            const branchQ = req.query.branch;
            if (branchQ === 'none') filter.branch = null;
            else if (branchQ && mongoose.isValidObjectId(branchQ)) filter.branch = branchQ;
        }
        // Field projection — the admin dashboards (Tables, Orders, etc.)
        // only render `name + role + avatar` and occasionally `status`.
        // Sending the full User doc on every dashboard paint pulls
        // address, allergy, kitchenResponsibility, mustChangePassword,
        // and 15 other fields that nobody on this page reads. The
        // dedicated /staff endpoint (StaffDashboard) keeps returning
        // the fuller doc — only the bootstrap is trimmed.
        // Contact details (email / mobile / staffId) only for the roles
        // allowed to read GET /staff (adminOnly: admin, manager). Other
        // staff get the name + role + avatar the dashboards render.
        const canReadDirectory = ['admin', 'manager'].includes(req.user?.role);
        tasks.staff = User.find(filter)
            .select(canReadDirectory
                ? '_id name email mobile avatar staffId role status branch isTenantOwner'
                : '_id name avatar role status branch')
            .populate('branch', 'name slug city')
            .lean();
    }

    if (want('settings')) {
        // Use the same resolver that GET /settings runs so the admin
        // dashboard sees the merged shape (sub-branch inheritance,
        // tenant-level fallback, logo/banner inheritance). Bypassing
        // this and reading the raw Settings doc would silently strip
        // additionalCharges from sub-branch admins and break parity
        // with the customer bill preview.
        tasks.settings = resolveSettingsForRequest(req);
    }

    const keys = Object.keys(tasks);
    const results = await Promise.allSettled(keys.map(k => tasks[k]));

    const data = {};
    const errors = [];
    keys.forEach((key, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
            data[key] = r.value ?? null;
        } else {
            data[key] = null;
            errors.push({ section: key, message: r.reason?.message || 'Unknown error' });
            logger.warn('admin.bootstrap.section-failed', {
                section: key,
                error: r.reason?.message,
                tenant: req.restaurant?._id?.toString(),
            });
        }
    });

    // No browser caching. Real-time data — when a customer presses
    // "Call Waiter" the socket event triggers an immediate React Query
    // refetch on the admin dashboard, but if the browser is sitting on
    // a 5-second-old cached response it would serve THAT (without the
    // new table.alerts entry) instead of hitting the server. The brief
    // dev-mode StrictMode double-mount we used to dedupe is not worth
    // breaking live alert delivery.
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
        success: errors.length === 0,
        data,
        ...(errors.length ? { _errors: errors } : {}),
    });
};
