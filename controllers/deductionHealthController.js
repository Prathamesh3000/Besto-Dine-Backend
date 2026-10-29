// Inventory deduction reconciliation (plan 2.4).
//   GET  /api/inventory/reports/deduction-health        failed/pending jobs + orders missing the marker
//   POST /api/inventory/reports/deduction-health/retry  { jobId } or { orderId } - retry now
const mongoose = require('mongoose');
const Order = require('../models/order');
const InventoryDeductionJob = require('../models/inventoryDeductionJob');
const { tenantFilter, tenantId, strictBranchFilter } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const svc = require('../services/inventoryDeductionService');

const ORDER_STATES = ['preparing', 'ready', 'served'];

exports.getDeductionHealth = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = strictBranchFilter(req);
        const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

        const jobFilter = { ...tf, ...bf, state: { $in: ['failed', 'pending'] } };
        const orderFilter = {
            ...tf, ...bf,
            status: { $in: ORDER_STATES },
            inventoryDeducted: { $ne: true },
            createdAt: { $gte: since },
        };

        const [jobs, jobCounts, orders, missingCount] = await Promise.all([
            InventoryDeductionJob.find(jobFilter).sort({ updatedAt: -1 }).limit(limit).lean(),
            InventoryDeductionJob.aggregate([
                { $match: jobFilter },
                { $group: { _id: '$state', n: { $sum: 1 } } },
            ]),
            Order.find(orderFilter).sort({ createdAt: -1 }).limit(limit)
                .select('orderId status type branch createdAt total').lean(),
            Order.countDocuments(orderFilter),
        ]);

        const byState = Object.fromEntries(jobCounts.map((c) => [c._id, c.n]));
        const jobOrderIds = new Set(jobs.map((j) => String(j.order)));
        res.json({
            success: true,
            windowDays: days,
            counts: {
                failedJobs: byState.failed || 0,
                pendingJobs: byState.pending || 0,
                ordersWithoutMarker: missingCount,
            },
            jobs,
            ordersWithoutMarker: orders.map((o) => ({ ...o, hasJob: jobOrderIds.has(String(o._id)) })),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to load deduction health', ...devError(error) });
    }
};

exports.retryDeduction = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const restaurantId = tenantId(req);
        const { jobId, orderId } = req.body || {};
        const userId = req.user?._id || null;

        if (jobId) {
            if (!mongoose.isValidObjectId(jobId)) return res.status(400).json({ success: false, message: 'Invalid jobId' });
            const job = await InventoryDeductionJob.findOne({ _id: jobId, ...tf }).lean();
            if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
            if (job.state === 'done') return res.json({ success: true, outcome: 'done', message: 'Already done' });
            if (!job.retryable) {
                // Capped jobs with nothing taken may be re-armed by hand; partial / data errors may not.
                const order = await Order.findOne({ _id: job.order, ...tf });
                if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
                if (order.inventoryDeducted || await svc.hasDeductionRows(order, job.restaurant)) {
                    return res.status(409).json({
                        success: false,
                        message: 'Stock was already (partly) deducted for this order - a retry would deduct twice. Fix the stock with a manual adjustment.',
                    });
                }
                await InventoryDeductionJob.updateOne(
                    { _id: job._id, ...tf },
                    { $set: { state: 'pending', retryable: true, attempts: 0, nextAttemptAt: new Date() } }
                );
            }
            const r = await svc.retryJob(job, { force: true, userId });
            return res.json({ success: true, ...r });
        }

        if (orderId) {
            if (!mongoose.isValidObjectId(orderId)) return res.status(400).json({ success: false, message: 'Invalid orderId' });
            const order = await Order.findOne({ _id: orderId, ...tf });
            if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
            if (!ORDER_STATES.includes(order.status)) {
                return res.status(409).json({ success: false, message: `Order is ${order.status}; nothing to deduct` });
            }
            if (order.inventoryDeducted) return res.json({ success: true, outcome: 'done', message: 'Already deducted' });
            const result = await svc.runDeductionWithRecovery(order, restaurantId, userId);
            return res.json({
                success: true,
                outcome: (result.errors || []).length ? 'failed' : 'done',
                deducted: result.deducted,
                errors: result.errors,
            });
        }

        return res.status(400).json({ success: false, message: 'jobId or orderId is required' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Retry failed', ...devError(error) });
    }
};
