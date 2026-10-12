/**
 * notificationService — the single place that sends notifications
 * (BUGS_REPORT #32). Persists Notification rows and pushes the live
 * socket event in one call, and NEVER throws into the caller.
 *
 * Usage
 * ─────
 *   const { notify } = require('../services/notificationService');
 *   const EVENTS = require('../realtime/events');
 *
 *   // 1. Admin bell + toast for one branch (persist + emit):
 *   await notify({
 *       restaurant: order.restaurant,            // tenant id (required to persist)
 *       branch: order.branch || null,            // null = tenant-level
 *       audience: 'admin',                       // role rooms to emit to
 *       notification: {                          // Notification doc fields
 *           recipientRole: 'admin',              // default derived from audience
 *           title: 'Payment Confirmed',
 *           description: `₹${order.total} received for ${order.orderId}`,
 *           category: 'Payment', priority: 'medium',
 *           meta: { orderId: order.orderId, amount: order.total },
 *       },
 *       // payload defaults to { title, description } of `notification`
 *   });
 *
 *   // 2. Targeted users (one row per recipient + emit to each user room),
 *   //    with extra events to the same targets after the main one:
 *   await notify({
 *       restaurant, branch,
 *       recipients: [waiterId],                  // id | id[]
 *       notification: { recipientRole: 'waiter', title, description, category: 'Service' },
 *       payload: { title: 'New Request', description: `Table ${t} — ${type}` },
 *       also: [{ event: EVENTS.REQUEST_NEW, payload: savedRequest }],
 *   });
 *
 *   // 3. Socket-only (no Notification row):
 *   notify({ restaurant, branch, audience: ['admin', 'waiter'], persist: false,
 *            event: EVENTS.TABLE_UPDATED, payload: { tableId } });
 *
 *   // 4. After the response (fire-and-forget) — safe: the promise never
 *   //    rejects and the tenant is taken from `restaurant`, not from the
 *   //    request context, so emits are not dropped once the request ends.
 *   res.status(201).json(...);
 *   notify({ ... });
 *
 * Options
 * ───────
 *   event        socket event name (default EVENTS.NOTIFICATION_NEW)
 *   restaurant   tenant id / doc. Required when persisting; also used as the
 *                tenant for role-room emits.
 *   branch       branch id / doc, or null (tenant-level)
 *   audience     'admin' | 'staff' | 'kitchen' | 'waiter' | 'captain', or an
 *                array of them. 'staff' = admin + waiter + kitchen (emitToStaff).
 *   recipients   user id(s). Persist: one row per recipient (recipient field).
 *                Emit: to each user's own room (String(userId)).
 *   rooms        extra raw socket rooms (e.g. `order:<orderId>`, `table:<id>`)
 *   notification Notification doc fields (title, description, category,
 *                priority, meta, recipientRole, status). recipientRole may be
 *                an array → one row per role. Omit to skip persisting.
 *   payload      socket payload (default { title, description })
 *   also         [{ event, payload }] — extra events sent to the same targets,
 *                in order, right after `event`.
 *   persist      write Notification rows (default true; needs `notification`)
 *   io           Socket.io server (default: utils/socket getIO(), lazily)
 *
 * Returns Promise<{ ok, docs, persisted, emitted, error }> — never rejects.
 *   ok        false when persisting or emitting failed (error set)
 *   docs      saved Notification documents ([] when not persisted)
 *
 * Notes
 *   - Rows are written first, then the socket events fire (same order the
 *     hand-written call sites used). The emit still happens if persisting
 *     failed, so a DB hiccup doesn't also swallow the live toast.
 *   - Invalid enum values (e.g. priority 'normal', category 'Booking') are
 *     coerced to the schema default ('medium' / 'System') with a warning
 *     instead of failing validation and losing the notification.
 */

const logger = require('../utils/logger');
const EVENTS = require('../realtime/events');

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const CATEGORIES = ['Order', 'Wallet', 'Points', 'Offer', 'Reward', 'Payment', 'Service', 'System'];
const ROLES = ['admin', 'chef', 'waiter', 'captain', 'customer', 'all'];

// audience → emit helper in utils/socket.js
const AUDIENCE_HELPERS = {
    admin: 'emitToAdmin',
    staff: 'emitToStaff',
    kitchen: 'emitToKitchen',
    waiter: 'emitToWaiter',
    captain: 'emitToCaptain',
};
// audience → default persisted recipientRole
const AUDIENCE_ROLE = {
    admin: 'admin',
    staff: 'all',
    kitchen: 'chef',
    waiter: 'waiter',
    captain: 'captain',
};

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const idOf = (v) => {
    if (!v) return null;
    if (typeof v === 'object' && v._id) return String(v._id);
    const s = String(v);
    return s && s !== '[object Object]' ? s : null;
};

// Lazy requires keep this module loadable in isolation and mockable.
function socketUtil() { return require('../utils/socket'); }
function NotificationModel() { return require('../models/notification'); }

function sanitizeDocFields(fields) {
    const out = { ...fields };
    if (out.priority != null && !PRIORITIES.includes(out.priority)) {
        logger.warn('notify: invalid priority coerced to medium', { priority: out.priority, title: out.title });
        out.priority = 'medium';
    }
    if (out.category != null && !CATEGORIES.includes(out.category)) {
        logger.warn('notify: invalid category coerced to System', { category: out.category, title: out.title });
        out.category = 'System';
    }
    return out;
}

function buildDocs({ restaurant, branch, recipients, notification, audience }) {
    const base = sanitizeDocFields(notification);
    // An explicit `recipient` in the doc fields (e.g. null for a tenant-wide
    // alert) is kept when no `recipients` are given.
    const hasExplicit = Object.prototype.hasOwnProperty.call(base, 'recipient');
    const explicitRecipient = base.recipient;
    delete base.recipient;
    let roles = toArray(base.recipientRole);
    delete base.recipientRole;
    if (!roles.length) {
        const first = toArray(audience)[0];
        roles = [AUDIENCE_ROLE[first] || (recipients.length ? 'customer' : 'admin')];
    }
    const docs = [];
    for (const role of roles) {
        if (!ROLES.includes(role)) logger.warn('notify: unknown recipientRole', { role });
        const row = { ...base, recipientRole: role, restaurant, branch: branch == null ? null : branch };
        if (recipients.length) {
            for (const r of recipients) docs.push({ ...row, recipient: r });
        } else {
            docs.push(hasExplicit ? { ...row, recipient: explicitRecipient } : row);
        }
    }
    return docs;
}

async function persistDocs(docs) {
    const Notification = NotificationModel();
    if (docs.length === 1) {
        const doc = await Notification.create(docs[0]);
        return [doc];
    }
    return Notification.insertMany(docs);
}

function emitAll({ io, restaurant, branch, audience, recipients, rooms, events }) {
    const util = socketUtil();
    const rid = idOf(restaurant);
    const bid = idOf(branch);
    // A branch-arg object carrying `restaurant` makes utils/socket resolve the
    // tenant synchronously from it (no request context / DB lookup needed),
    // which is what keeps post-response calls from being dropped.
    const branchArg = rid ? (bid ? { _id: bid, restaurant: rid } : { restaurant: rid }) : (branch || null);

    let emitted = false;
    for (const { event, payload } of events) {
        for (const a of toArray(audience)) {
            const helper = AUDIENCE_HELPERS[a];
            if (!helper || typeof util[helper] !== 'function') {
                logger.warn('notify: unknown audience', { audience: a, event });
                continue;
            }
            util[helper](io, branchArg, event, payload);
            emitted = true;
        }
        for (const r of recipients) {
            io.to(String(r)).emit(event, payload);
            emitted = true;
        }
        for (const room of toArray(rooms)) {
            if (!room) continue;
            io.to(room).emit(event, payload);
            emitted = true;
        }
    }
    return emitted;
}

/**
 * Persist + emit a notification. See the usage block at the top of the file.
 * @returns {Promise<{ok:boolean, docs:object[], persisted:boolean, emitted:boolean, error?:Error}>}
 */
// Operations profile: a restaurant set up without waiters / captain has
// nobody in those audiences — skip them instead of piling up unread
// notifications. Profile-only (no plan intersection), and tenants that
// never set a profile skip the lookup entirely.
async function dropUnusedFloorAudiences(restaurant, audience) {
    const list = toArray(audience);
    if (!restaurant || !list.some(a => a === 'waiter' || a === 'captain')) return audience;
    // No live DB connection (unit tests with mocked models): skip the
    // lookup rather than let it buffer until timeout.
    if (require('mongoose').connection.readyState !== 1) return audience;
    try {
        const Restaurant = require('../models/restaurant');
        const r = await Restaurant.findById(restaurant._id || restaurant).select('operations').lean();
        if (!r?.operations) return audience;
        const { profileFlow } = require('../utils/operationsProfile');
        const roles = profileFlow(r).roles;
        const kept = list.filter(a => (a === 'waiter' ? roles.waiter : a === 'captain' ? roles.captain : true));
        if (kept.length === list.length) return audience;
        return Array.isArray(audience) ? kept : (kept[0] || null);
    } catch {
        return audience;
    }
}

async function notify(opts = {}) {
    const result = { ok: true, docs: [], persisted: false, emitted: false, error: null };
    if (opts.audience && opts.restaurant) {
        const audience = await dropUnusedFloorAudiences(opts.restaurant, opts.audience);
        const recipientsLeft = toArray(opts.recipients).length || toArray(opts.rooms).length;
        if (!toArray(audience).length && !recipientsLeft) return result;
        opts = { ...opts, audience };
    }
    try {
        const {
            event = EVENTS.NOTIFICATION_NEW,
            restaurant = null,
            branch = null,
            audience = null,
            recipients: rawRecipients = null,
            rooms = null,
            notification = null,
            payload,
            also = null,
            persist = true,
            io: ioArg = null,
        } = opts;

        const recipients = toArray(rawRecipients).map(idOf).filter(Boolean);

        // ── (a) persist ───────────────────────────────────────────────
        if (persist && notification) {
            try {
                if (!restaurant) throw new Error('restaurant is required to persist a notification');
                const docs = buildDocs({ restaurant, branch, recipients, notification, audience });
                result.docs = await persistDocs(docs);
                result.persisted = true;
            } catch (err) {
                result.ok = false;
                result.error = err;
                logger.warn('notify: persist failed', { event, title: notification?.title, error: err.message });
            }
        }

        // ── (b) emit ──────────────────────────────────────────────────
        const hasTargets = toArray(audience).length || recipients.length || toArray(rooms).length;
        if (event && hasTargets) {
            try {
                let io = ioArg;
                if (!io) {
                    try { io = socketUtil().getIO(); } catch { io = null; }
                }
                if (io) {
                    const mainPayload = payload !== undefined
                        ? payload
                        : (notification ? { title: notification.title, description: notification.description } : {});
                    const events = [{ event, payload: mainPayload }];
                    for (const extra of toArray(also)) {
                        if (extra && extra.event) events.push({ event: extra.event, payload: extra.payload });
                    }
                    result.emitted = emitAll({ io, restaurant, branch, audience, recipients, rooms, events });
                } else {
                    logger.debug?.('notify: socket.io not initialised — emit skipped', { event });
                }
            } catch (err) {
                result.ok = false;
                result.error = result.error || err;
                logger.warn('notify: emit failed', { event, error: err.message });
            }
        }
    } catch (err) {
        // Defensive: nothing above should reach here.
        result.ok = false;
        result.error = err;
        try { logger.error('notify: unexpected failure', { error: err.message }); } catch { /* ignore */ }
    }
    return result;
}

module.exports = {
    notify,
    EVENTS,
    _internals: { buildDocs, sanitizeDocFields, AUDIENCE_HELPERS, AUDIENCE_ROLE },
};
