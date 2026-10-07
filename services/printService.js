'use strict';
/**
 * Thermal printing — job creation, dispatch to the branch's print agent
 * and acknowledgement.
 *
 * Flow: an order event (create / append / reprint / "Print bill") →
 * enqueue*() renders a receipt document (utils/receiptRenderer.js),
 * stores a PrintJob and emits `print:job` into the branch's printer
 * room (`t:<rid>:printer:<branchId>`). The print agent on the counter
 * PC (print-agent/) prints it and answers `print:ack`. Jobs raised while
 * no agent is connected stay `queued`; the agent asks for them with
 * `print:pending` when it connects.
 *
 * Every function here is safe to call from fire-and-forget hooks: it
 * logs and swallows its own errors so a printer problem can never fail
 * an order.
 */
const crypto = require('crypto');
const PrintJob = require('../models/printJob');
const Settings = require('../models/settings');
const Table = require('../models/table');
const User = require('../models/user');
const { getSettings, invalidateCache } = require('../utils/settingsCache');
const { getMainBranchId } = require('../utils/mainBranch');
const { getMergeGroupNames } = require('../utils/tableMerge');
const { printerRoom } = require('../utils/socketRooms');
const { signTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const EVENTS = require('../realtime/events');
const logger = require('../utils/logger');
const { renderKot, renderBill, renderTest } = require('../utils/receiptRenderer');

const DEFAULT_PRINTERS = Object.freeze({
    enabled: false,
    autoPrint: { kotOnCreate: true, kotOnAppend: true, billOnPaid: false },
    agent: { agentId: '', keyVersion: 0, issuedAt: null, lastSeenAt: null },
    list: [],
});

const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : (v ? String(v) : null));

function io() {
    // Lazy: utils/socket.js requires this module from its handshake.
    return require('../utils/socket').getIO();
}

/**
 * Which Settings doc holds the printers for an order at `branchId`, and
 * which branch id the agent room is keyed by.
 *
 * Tenant owners (unpinned admins) edit the tenant-level doc
 * (branch:null) while every order carries a branch id — the main
 * branch's for the main location. So: main branch (or no branch) →
 * tenant doc; any other branch → that branch's own doc.
 */
async function resolveScope(restaurantId, branchId) {
    const rid = idOf(restaurantId);
    const mainId = idOf(await getMainBranchId({ restaurant: { _id: rid } }));
    const bid = idOf(branchId) || mainId;
    const scopeBranch = (!bid || bid === mainId) ? null : bid;
    return { rid, branchId: bid, scopeBranch };
}

async function resolvePrinters(restaurantId, branchId) {
    const scope = await resolveScope(restaurantId, branchId);
    const settings = await getSettings(scope.scopeBranch
        ? { restaurant: { _id: scope.rid }, branch: { _id: scope.scopeBranch } }
        : scope.rid);
    const printers = settings?.printers
        ? { ...DEFAULT_PRINTERS, ...settings.printers, autoPrint: { ...DEFAULT_PRINTERS.autoPrint, ...(settings.printers.autoPrint || {}) }, agent: { ...DEFAULT_PRINTERS.agent, ...(settings.printers.agent || {}) }, list: settings.printers.list || [] }
        : { ...DEFAULT_PRINTERS };
    return { ...scope, printers, general: settings?.general || {} };
}

function printerForStation(list, station) {
    return (list || []).find((p) => p && p.enabled !== false && p.station === station) || null;
}

function snapshot(p) {
    return {
        id: p.id, name: p.name, interface: p.interface || 'lan', host: p.host || '', port: p.port || 9100,
        devicePath: p.devicePath || '', paperWidth: p.paperWidth || '80', characterSet: p.characterSet || 'PC437_USA',
        copies: p.copies || 1,
    };
}

function toWire(job) {
    return {
        jobId: String(job._id),
        kind: job.kind,
        station: job.station,
        reason: job.reason,
        orderId: job.orderId || '',
        printer: job.printer && typeof job.printer.toObject === 'function' ? job.printer.toObject() : job.printer,
        document: job.document,
        copies: job.printer?.copies || 1,
        createdAt: job.createdAt,
    };
}

async function agentSockets(rid, branchId) {
    const room = printerRoom(rid, branchId);
    if (!room) return [];
    try { return await io().in(room).fetchSockets(); } catch { return []; }
}

function emitAdmin(branchId, rid, event, payload) {
    try {
        const { emitToAdmin } = require('../utils/socket');
        emitToAdmin(io(), branchId, event, { ...payload, restaurant: rid, branch: branchId });
    } catch { /* socket not critical */ }
}

/** Push a stored job to the agent room; mark `sent` only if someone is listening. */
async function dispatch(job) {
    const rid = String(job.restaurant);
    const bid = String(job.branch);
    let online = false;
    try {
        const room = printerRoom(rid, bid);
        const sockets = await agentSockets(rid, bid);
        online = sockets.length > 0;
        io().to(room).emit(EVENTS.PRINT_JOB, toWire(job));
    } catch (err) {
        logger.warn(`print: dispatch emit failed for ${job._id}: ${err.message}`);
    }
    if (online) {
        job.status = 'sent';
        job.sentAt = new Date();
        await PrintJob.updateOne({ _id: job._id, restaurant: job.restaurant }, { $set: { status: 'sent', sentAt: job.sentAt } });
    }
    emitAdmin(bid, rid, EVENTS.PRINT_JOB_UPDATED, { jobId: String(job._id), kind: job.kind, station: job.station, orderId: job.orderId, status: job.status, agentOnline: online });
    return online;
}

async function resolveNames(order, rid) {
    let tableLabel = null;
    let waiterName = null;
    try {
        const tableId = idOf(order.table);
        if (tableId) {
            const t = order.table && typeof order.table === 'object' && order.table.name
                ? order.table
                : await Table.findOne({ _id: tableId, restaurant: rid }).select('name').lean();
            tableLabel = t?.name || null;
            const names = await getMergeGroupNames(tableId, { restaurant: rid });
            if (names.length > 1) tableLabel = names.join(', ');
        }
    } catch { /* label is cosmetic */ }
    try {
        const waiterId = idOf(order.waiter);
        if (waiterId) {
            const u = order.waiter && typeof order.waiter === 'object' && order.waiter.name
                ? order.waiter
                : await User.findOne({ _id: waiterId, restaurant: rid }).select('name').lean();
            waiterName = u?.name || null;
        }
    } catch { /* ditto */ }
    return { tableLabel, waiterName };
}

async function createJob(fields) {
    const job = await PrintJob.create(fields);
    await dispatch(job);
    return job;
}

/**
 * One KOT per station present in `items` (kitchen / bar / counter), to
 * that station's printer. Skips silently when printing is disabled, the
 * auto-print flag for `reason` is off, or a station has no printer.
 * @returns {Promise<PrintJob[]>}
 */
async function enqueueKotJobs({ order, items, reason = 'create' }) {
    try {
        if (!order) return [];
        const cfg = await resolvePrinters(order.restaurant, order.branch);
        const p = cfg.printers;
        if (!p.enabled || !p.list.length) return [];
        if (reason === 'create' && !p.autoPrint.kotOnCreate) return [];
        if (reason === 'append' && !p.autoPrint.kotOnAppend) return [];
        const lines = (items && items.length ? items : order.items) || [];
        if (!lines.length) return [];

        const byStation = new Map();
        for (const it of lines) {
            const st = it.prepStation || 'kitchen';
            if (!byStation.has(st)) byStation.set(st, []);
            byStation.get(st).push(it);
        }
        const { tableLabel, waiterName } = await resolveNames(order, cfg.rid);
        const jobs = [];
        for (const [station, stationItems] of byStation) {
            const printer = printerForStation(p.list, station);
            if (!printer) {
                logger.info(`print: no ${station} printer at branch ${cfg.branchId}; KOT for ${order.orderId} not printed`);
                continue;
            }
            const document = renderKot({
                cafeName: cfg.general.cafeName, order, items: stationItems, station, tableLabel, reason,
                waiterName, paperWidth: printer.paperWidth, timezone: cfg.general.timezone,
            });
            jobs.push(await createJob({
                restaurant: cfg.rid, branch: cfg.branchId, order: order._id, orderId: order.orderId,
                kind: 'kot', station, reason, printer: snapshot(printer), document,
            }));
        }
        return jobs;
    } catch (err) {
        logger.warn(`print: enqueueKotJobs failed for ${order?.orderId}: ${err.message}`);
        return [];
    }
}

/**
 * Bill to the counter printer.
 * @returns {Promise<{job?: PrintJob, agentOnline?: boolean, skipped?: string}>}
 */
async function enqueueBillJob({ order, reason = 'manual', openDrawer = false }) {
    try {
        if (!order) return { skipped: 'NO_ORDER' };
        const cfg = await resolvePrinters(order.restaurant, order.branch);
        const p = cfg.printers;
        if (!p.enabled) return { skipped: 'PRINTING_DISABLED' };
        if (reason === 'paid' && !p.autoPrint.billOnPaid) return { skipped: 'AUTO_BILL_OFF' };
        const printer = printerForStation(p.list, 'counter');
        if (!printer) return { skipped: 'NO_COUNTER_PRINTER' };
        const { tableLabel } = await resolveNames(order, cfg.rid);
        const document = renderBill({ settings: { general: cfg.general }, order, tableLabel, paperWidth: printer.paperWidth, openDrawer });
        const job = await PrintJob.create({
            restaurant: cfg.rid, branch: cfg.branchId, order: order._id, orderId: order.orderId,
            kind: 'bill', station: 'counter', reason, printer: snapshot(printer), document,
        });
        const agentOnline = await dispatch(job);
        return { job, agentOnline };
    } catch (err) {
        logger.warn(`print: enqueueBillJob failed for ${order?.orderId}: ${err.message}`);
        return { skipped: 'ERROR', error: err.message };
    }
}

/** Test page for one configured printer. Throws on unknown printer. */
async function enqueueTestJob(restaurantId, branchId, printerId) {
    const cfg = await resolvePrinters(restaurantId, branchId);
    const printer = (cfg.printers.list || []).find((x) => x && x.id === printerId);
    if (!printer) {
        const err = new Error('Printer not found');
        err.code = 'PRINTER_NOT_FOUND';
        throw err;
    }
    const document = renderTest({ cafeName: cfg.general.cafeName, printer, timezone: cfg.general.timezone });
    const job = await PrintJob.create({
        restaurant: cfg.rid, branch: cfg.branchId, order: null, orderId: '',
        kind: 'test', station: printer.station, reason: 'test', printer: snapshot(printer), document,
    });
    const agentOnline = await dispatch(job);
    return { job, agentOnline };
}

/** Jobs the agent still has to print (oldest first). */
async function listPending(restaurantId, branchId, limit = 50) {
    const jobs = await PrintJob.find({
        restaurant: idOf(restaurantId), branch: idOf(branchId), status: { $in: ['queued', 'sent'] },
    }).sort({ createdAt: 1 }).limit(limit).lean();
    return jobs.map(toWire);
}

async function listRecent(restaurantId, branchId, limit = 20) {
    return PrintJob.find({ restaurant: idOf(restaurantId), branch: idOf(branchId) })
        .sort({ createdAt: -1 }).limit(limit).select('-document').lean();
}

/** Agent acknowledgement. Explicit tenant/branch filter — socket handlers have no request context. */
async function ackJob(restaurantId, branchId, jobId, status, error) {
    if (!['done', 'failed'].includes(status)) return null;
    const rid = idOf(restaurantId);
    const bid = idOf(branchId);
    const job = await PrintJob.findOneAndUpdate(
        { _id: jobId, restaurant: rid, branch: bid },
        { $set: { status, error: status === 'failed' ? String(error || 'Print failed').slice(0, 500) : '', ackedAt: new Date() }, $inc: { attempts: 1 } },
        { new: true },
    ).select('-document').lean();
    if (job) {
        emitAdmin(bid, rid, EVENTS.PRINT_JOB_UPDATED, { jobId: String(job._id), kind: job.kind, station: job.station, orderId: job.orderId, status: job.status, error: job.error });
    }
    return job;
}

async function agentPresence(restaurantId, branchId) {
    const cfg = await resolvePrinters(restaurantId, branchId);
    const sockets = await agentSockets(cfg.rid, cfg.branchId);
    return { online: sockets.length > 0, count: sockets.length, agentId: cfg.printers.agent.agentId || '', lastSeenAt: cfg.printers.agent.lastSeenAt || null, branch: cfg.branchId };
}

async function settingsDocForScope(scope) {
    const filter = { restaurant: scope.rid, branch: scope.scopeBranch };
    let doc = await Settings.findOne(filter);
    if (!doc) doc = await Settings.create(filter);
    return doc;
}

/** Mint a new agent token for the branch (invalidates any earlier one). */
async function issueAgentKey(restaurantId, branchId) {
    const scope = await resolveScope(restaurantId, branchId);
    if (!scope.branchId) {
        const err = new Error('No branch to bind the agent to');
        err.code = 'NO_BRANCH';
        throw err;
    }
    const doc = await settingsDocForScope(scope);
    const agentId = crypto.randomUUID();
    const keyVersion = (Number(doc.printers?.agent?.keyVersion) || 0) + 1;
    await Settings.updateOne({ _id: doc._id, restaurant: scope.rid }, {
        $set: { 'printers.agent.agentId': agentId, 'printers.agent.keyVersion': keyVersion, 'printers.agent.issuedAt': new Date() },
    });
    invalidateCache(scope.rid);
    const token = signTypedToken(TOKEN_TYPES.AGENT, { restaurant: scope.rid, branch: scope.branchId, agentId, kv: keyVersion }, { expiresIn: '365d' });
    return { token, agentId, keyVersion, branch: scope.branchId };
}

/** Invalidate the current agent token and drop its sockets. */
async function revokeAgentKey(restaurantId, branchId) {
    const scope = await resolveScope(restaurantId, branchId);
    const doc = await settingsDocForScope(scope);
    await Settings.updateOne({ _id: doc._id, restaurant: scope.rid }, {
        $inc: { 'printers.agent.keyVersion': 1 }, $set: { 'printers.agent.agentId': '' },
    });
    invalidateCache(scope.rid);
    try {
        const room = printerRoom(scope.rid, scope.branchId);
        if (room) io().in(room).disconnectSockets(true);
    } catch { /* ignore */ }
    emitAdmin(scope.branchId, scope.rid, EVENTS.PRINT_AGENT_STATUS, { online: false, agentId: '' });
    return { branch: scope.branchId };
}

/**
 * Socket handshake check for a decoded agent token: the branch's
 * current key version must match and printing must be switched on.
 */
async function verifyAgentClaims(decoded) {
    if (!decoded || !decoded.restaurant || !decoded.branch) return false;
    try {
        const cfg = await resolvePrinters(decoded.restaurant, decoded.branch);
        if (String(cfg.branchId) !== String(decoded.branch)) return false;
        return Number(decoded.kv) === Number(cfg.printers.agent.keyVersion) && cfg.printers.agent.keyVersion > 0;
    } catch (err) {
        logger.warn(`print: verifyAgentClaims failed: ${err.message}`);
        return false;
    }
}

async function markAgentSeen(restaurantId, branchId) {
    try {
        const scope = await resolveScope(restaurantId, branchId);
        await Settings.updateOne({ restaurant: scope.rid, branch: scope.scopeBranch }, { $set: { 'printers.agent.lastSeenAt': new Date() } });
    } catch { /* cosmetic */ }
}

module.exports = {
    resolveScope, resolvePrinters, printerForStation,
    enqueueKotJobs, enqueueBillJob, enqueueTestJob,
    listPending, listRecent, ackJob, agentPresence,
    issueAgentKey, revokeAgentKey, verifyAgentClaims, markAgentSeen,
    toWire, DEFAULT_PRINTERS,
};
