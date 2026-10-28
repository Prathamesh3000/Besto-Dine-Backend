'use strict';
// Thermal printing — admin endpoints for the print agent and on-demand
// bills. Job creation itself lives in services/printService.js; order
// hooks (KOT on create / append / reprint) call it directly.
const mongoose = require('mongoose');
const Order = require('../models/order');
const Branch = require('../models/branch');
const printService = require('../services/printService');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { getMainBranchId } = require('../utils/mainBranch');
const logger = require('../utils/logger');

const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v) && /^[a-f0-9]{24}$/i.test(v);

// The branch whose printers / agent the caller is managing: a pinned
// sub-admin's own branch, an owner's currently selected branch, else the
// main branch (orders at the main location carry its id).
async function callerBranchId(req) {
    return pinnedBranchId(req) || (req.branch && req.branch._id) || (await getMainBranchId(req));
}

function publicOrigin(req) {
    if (process.env.PUBLIC_API_ORIGIN) return process.env.PUBLIC_API_ORIGIN;
    return `${req.protocol}://${req.get('host')}`;
}

// @route POST /api/v1/print/agent-key   (admin) — mint a new agent token; shown once
exports.issueAgentKey = async (req, res) => {
    try {
        const branchId = await callerBranchId(req);
        const { token, agentId, keyVersion, branch } = await printService.issueAgentKey(tenantId(req), branchId);
        logger.info(`print: agent key issued for tenant ${tenantId(req)} branch ${branch} by ${req.user?._id}`);
        res.json({ success: true, token, agentId, keyVersion, branch: String(branch), apiUrl: publicOrigin(req) });
    } catch (err) {
        if (err.code === 'NO_BRANCH') return res.status(400).json({ success: false, code: 'NO_BRANCH', message: 'Create a branch before pairing a print agent.' });
        logger.error('print: issueAgentKey failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not generate an agent key' });
    }
};

// @route DELETE /api/v1/print/agent-key   (admin) — revoke the current token, drop its sockets
exports.revokeAgentKey = async (req, res) => {
    try {
        const branchId = await callerBranchId(req);
        const { branch } = await printService.revokeAgentKey(tenantId(req), branchId);
        logger.info(`print: agent key revoked for tenant ${tenantId(req)} branch ${branch} by ${req.user?._id}`);
        res.json({ success: true, branch: String(branch) });
    } catch (err) {
        logger.error('print: revokeAgentKey failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not revoke the agent key' });
    }
};

// @route GET /api/v1/print/agent-status   (admin)
exports.agentStatus = async (req, res) => {
    try {
        const branchId = await callerBranchId(req);
        const presence = await printService.agentPresence(tenantId(req), branchId);
        res.json({ success: true, ...presence, branch: String(presence.branch) });
    } catch (err) {
        logger.error('print: agentStatus failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not read agent status' });
    }
};

// @route GET /api/v1/print/jobs?limit=20   (admin) — recent jobs, no documents
exports.listJobs = async (req, res) => {
    try {
        const branchId = await callerBranchId(req);
        const scope = await printService.resolveScope(tenantId(req), branchId);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const jobs = await printService.listRecent(scope.rid, scope.branchId, limit);
        res.json({ success: true, jobs, branch: String(scope.branchId) });
    } catch (err) {
        logger.error('print: listJobs failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not list print jobs' });
    }
};

// @route POST /api/v1/print/test { printerId }   (admin, rate-limited)
exports.testPrint = async (req, res) => {
    try {
        const printerId = typeof req.body?.printerId === 'string' ? req.body.printerId.trim() : '';
        if (!printerId) return res.status(400).json({ success: false, message: 'printerId is required' });
        const branchId = await callerBranchId(req);
        const presence = await printService.agentPresence(tenantId(req), branchId);
        if (!presence.online) {
            return res.status(409).json({ success: false, code: 'AGENT_OFFLINE', message: 'The print agent for this branch is not connected. Start it on the counter PC and try again.' });
        }
        const { job } = await printService.enqueueTestJob(tenantId(req), branchId, printerId);
        res.status(202).json({ success: true, jobId: String(job._id), station: job.station, printer: job.printer });
    } catch (err) {
        if (err.code === 'PRINTER_NOT_FOUND') return res.status(404).json({ success: false, code: 'PRINTER_NOT_FOUND', message: 'That printer is not configured for this branch.' });
        logger.error('print: testPrint failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not send the test page' });
    }
};

// @route POST /api/v1/print/orders/:id/bill   (waiter / captain / admin / manager)
exports.printBill = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isObjectId(id)) return res.status(404).json({ success: false, message: 'Order not found' });
        const order = await Order.findOne({ _id: id, ...tenantFilter(req) })
            .populate('table', 'name mergedWith status')
            .populate('waiter', 'name')
            .lean();
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
        const pinned = pinnedBranchId(req);
        if (pinned && order.branch && String(order.branch) !== String(pinned)) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        if (order.status === 'cancelled') {
            return res.status(400).json({ success: false, code: 'ORDER_TERMINAL', message: 'Cannot print a bill for a cancelled order.' });
        }
        const openDrawer = req.body?.openDrawer === true;
        // Optional 'Change printer': must be one of THIS branch's configured printers.
        const printerId = typeof req.body?.printerId === 'string' ? req.body.printerId.trim() : '';
        const result = await printService.enqueueBillJob({ order, reason: 'manual', openDrawer, printerId: printerId || null });
        if (result.skipped) {
            const messages = {
                PRINTING_DISABLED: 'Printing is switched off for this branch (Settings → Printers).',
                NO_COUNTER_PRINTER: 'No counter printer is configured for this branch (Settings → Printers).',
                PRINTER_NOT_FOUND: 'That printer is not configured for this branch.',
            };
            if (result.skipped === 'PRINTER_NOT_FOUND') return res.status(404).json({ success: false, code: 'PRINTER_NOT_FOUND', message: messages.PRINTER_NOT_FOUND });
            return res.status(409).json({ success: false, code: result.skipped, message: messages[result.skipped] || 'Bill could not be queued for printing.' });
        }
        res.status(202).json({
            success: true,
            jobId: String(result.job._id),
            status: result.job.status,
            printer: { name: result.job.printer?.name || '' },
            billNo: order.bill?.billNo ?? null,
            agentOnline: result.agentOnline,
            message: result.agentOnline ? 'Bill sent to the counter printer.' : 'Bill queued — it will print when the print agent connects.',
        });
    } catch (err) {
        logger.error('print: printBill failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not print the bill' });
    }
};

// @route GET /api/v1/print/status[?branchId=]   (waiter / captain / admin / manager)
// Staff-safe: agent online flag, printer names and the default counter
// printer. Branch-pinned staff always get their own branch; an unpinned
// admin may name any branch of the tenant with ?branchId=.
exports.staffStatus = async (req, res) => {
    try {
        let branchId;
        const requested = req.query?.branchId;
        if (requested !== undefined && !pinnedBranchId(req) && req.user?.role === 'admin') {
            if (!isObjectId(String(requested))) return res.status(404).json({ success: false, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
            const branch = await Branch.findOne({ _id: String(requested), ...tenantFilter(req) }).select('_id').lean();
            if (!branch) return res.status(404).json({ success: false, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
            branchId = branch._id;
        } else {
            branchId = await callerBranchId(req);
        }
        const { branch, ...status } = await printService.staffStatus(tenantId(req), branchId);
        res.json({ success: true, ...status, branch: String(branch) });
    } catch (err) {
        logger.error('print: staffStatus failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not read printer status' });
    }
};

// @route GET /api/v1/print/jobs/:id   (waiter / captain / admin / manager)
// Job read-back for "poll until done / failed". Own tenant only; branch-pinned
// staff only their branch's jobs. No document body.
exports.getJob = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isObjectId(id)) return res.status(404).json({ success: false, message: 'Print job not found' });
        // Non-admin staff (pinned or not) only see their own branch's jobs and
        // never the agent's raw error text (it can carry hosts / ports).
        const isAdmin = req.user?.role === 'admin';
        const job = await printService.getJobForStaff(tenantId(req), id, isAdmin ? pinnedBranchId(req) : await callerBranchId(req));
        if (!job) return res.status(404).json({ success: false, message: 'Print job not found' });
        res.json({
            success: true,
            job: {
                _id: String(job._id),
                kind: job.kind,
                status: job.status,
                ...(job.error ? { error: isAdmin ? job.error : 'Printer reported an error' } : {}),
                printer: { name: job.printer?.name || '' },
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                orderId: job.orderId || '',
                order: job.order ? String(job.order) : null,
            },
        });
    } catch (err) {
        logger.error('print: getJob failed', { error: err.message });
        res.status(500).json({ success: false, message: 'Could not read the print job' });
    }
};
