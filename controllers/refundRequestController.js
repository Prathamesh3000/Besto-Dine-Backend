// ADM-049 — refund-request workflow controller.
//
// Endpoints:
//   POST   /api/v1/refund-requests           — customer creates a new request
//   GET    /api/v1/refund-requests           — admin lists requests (filter by status)
//   POST   /api/v1/refund-requests/:id/approve — admin approves → calls processOrderRefund
//   POST   /api/v1/refund-requests/:id/reject  — admin rejects
//   GET    /api/v1/refund-requests/mine      — customer lists own requests
//
// The cancellation flow in orderController.cancelOrder also creates a
// request directly (source: 'customer-cancel') — see ADM-049 fix there.

const mongoose = require('mongoose');
const RefundRequest = require('../models/refundRequest');
const Order = require('../models/order');
const logger = require('../utils/logger');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');
const { getSettings } = require('../utils/settingsCache');
const { tenantFilter, tenantId, strictBranchFilter } = require('../utils/tenantScope');
const { processOrderRefund, roundPaise } = require('../utils/orderRefund');

// ─── Customer creates a refund request (explicit, separate from cancel) ───
exports.createRefundRequest = async (req, res) => {
    try {
        const { orderId, reason, amount: requestedAmount } = req.body;
        if (!orderId) {
            return res.status(400).json({ success: false, message: 'orderId is required' });
        }

        const tf = tenantFilter(req);
        let order = mongoose.Types.ObjectId.isValid(orderId)
            ? await Order.findOne({ _id: orderId, ...tf })
            : null;
        if (!order) order = await Order.findOne({ orderId, ...tf });
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        // Owner check — customers can only request refunds on their own
        // orders. An ownerless (guest) order belongs to nobody logged in,
        // so a customer can never claim it.
        if (req.user?.role === 'customer'
            && (!order.user || order.user.toString() !== String(req.user.id || req.user._id))) {
            return res.status(403).json({ success: false, message: 'Not authorized for this order' });
        }

        if (order.paymentStatus !== 'Paid') {
            return res.status(400).json({ success: false, message: 'Only paid orders can be refunded' });
        }

        const balance = roundPaise(Number(order.amountPaid || 0) - Number(order.refundedAmount || 0));
        if (balance <= 0) {
            return res.status(400).json({ success: false, message: 'Nothing to refund — this order is already fully refunded' });
        }

        // Omitted amount → full refundable balance (the intended UX).
        // A supplied amount must be a finite positive number — NaN, 0 or a
        // negative value is a client bug and must NOT silently widen into
        // a full-balance request.
        let amount;
        if (requestedAmount === undefined || requestedAmount === null || requestedAmount === '') {
            amount = balance;
        } else {
            amount = Number(requestedAmount);
            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({ success: false, message: 'Refund amount must be a positive number' });
            }
            amount = roundPaise(amount);
        }
        if (amount > balance + 0.001) {
            return res.status(400).json({ success: false, message: `Refund amount cannot exceed refundable balance (₹${balance.toFixed(2)})` });
        }

        // Block a duplicate pending request — the unique partial index
        // would 11000 anyway, but a friendlier message is better.
        const existing = await RefundRequest.findOne({ order: order._id, status: 'pending' });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'A refund request is already pending for this order',
                refundRequest: { id: existing._id, status: existing.status, amount: existing.amount },
            });
        }

        const rr = await RefundRequest.create({
            restaurant: order.restaurant,
            branch: order.branch || null,
            order: order._id,
            orderIdRef: order.orderId,
            user: order.user || null,
            customerName: order.customerName || '',
            customerPhone: order.phone || '',
            amount,
            reason: String(reason || '').trim(),
            source: 'customer-request',
            status: 'pending',
        });

        // Admin notification — same shape as the cancel-triggered one.
        // Live-push to any open admin dashboards (refund-request:new).
        await notify({
            restaurant: order.restaurant,
            branch: order.branch || null,
            audience: 'admin',
            event: EVENTS.REFUND_REQUEST_NEW,
            notification: {
                title: 'Refund Request — Action Needed',
                description: `Order ${order.orderId} (₹${amount} ${order.paymentMethod || ''}) — customer requested refund. Reason: ${reason || 'Not provided'}`,
                category: 'Payment',
                recipientRole: 'admin',
                priority: 'high',
                meta: { orderId: order.orderId, amount, refundRequestId: rr._id },
            },
            payload: { id: rr._id, orderId: order.orderId, amount },
        });

        return res.status(201).json({ success: true, refundRequest: rr });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A refund request is already pending for this order' });
        }
        logger.error('createRefundRequest error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to create refund request' });
    }
};

// ─── Customer lists their own refund requests ─────────────────────────────
exports.listMyRefundRequests = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const rows = await RefundRequest.find({ ...tf, user: req.user.id })
            .sort({ createdAt: -1 })
            .lean();
        return res.status(200).json({ success: true, data: rows });
    } catch (err) {
        logger.error('listMyRefundRequests error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to load refund requests' });
    }
};

// ─── Admin lists refund requests (filterable) ─────────────────────────────
exports.listRefundRequests = async (req, res) => {
    try {
        const { status } = req.query;
        // Bug #18 — bound paging, force string inputs and escape the
        // search text before it becomes a $regex.
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
        const search = rawSearch ? rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
        // Branch-pinned admin (Branch Admin) sees ONLY their branch's
        // refund requests — refunds against orders at other branches
        // are hidden. strictBranchFilter returns `{ branch: pinned }`
        // for pinned staff and `{}` for tenant owners.
        const q = { ...tenantFilter(req), ...strictBranchFilter(req) };
        if (typeof status === 'string' && status && status !== 'all') q.status = status;
        if (search) {
            q.$or = [
                { orderIdRef: { $regex: search, $options: 'i' } },
                { customerName: { $regex: search, $options: 'i' } },
                { customerPhone: { $regex: search, $options: 'i' } },
            ];
        }

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const [total, items] = await Promise.all([
            RefundRequest.countDocuments(q),
            RefundRequest.find(q)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .lean(),
        ]);

        return res.status(200).json({
            success: true,
            data: items,
            totalItems: total,
            totalPages: Math.max(1, Math.ceil(total / parseInt(limit, 10))),
            currentPage: parseInt(page, 10),
        });
    } catch (err) {
        logger.error('listRefundRequests error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to load refund requests' });
    }
};

// ─── Admin approves a refund request → calls processOrderRefund ───────────
exports.approveRefundRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { note } = req.body || {};
        const tf = tenantFilter(req);

        let rr = await RefundRequest.findOne({ _id: id, ...tf, ...strictBranchFilter(req) });
        if (!rr) return res.status(404).json({ success: false, message: 'Refund request not found' });
        if (rr.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Refund request is already ${rr.status}` });
        }

        const orderExists = await Order.exists({ _id: rr.order, ...tf });
        if (!orderExists) return res.status(404).json({ success: false, message: 'Order not found' });

        // Atomically claim the request (pending → approved) BEFORE any money
        // moves, so two admins approving at once can't both refund. The
        // claim is returned to 'pending' if the refund does not go through.
        const decidedBy = req.user?._id || req.user?.id || null;
        const claimed = await RefundRequest.findOneAndUpdate(
            { _id: rr._id, status: 'pending' },
            { $set: { status: 'approved', decidedBy, decidedAt: new Date(), decisionNote: String(note || '').trim() } },
            { returnDocument: 'after' }
        );
        if (!claimed) {
            const current = await RefundRequest.findById(rr._id).select('status').lean();
            return res.status(400).json({ success: false, message: `Refund request is already ${current?.status || 'decided'}` });
        }
        const unclaim = async () => {
            try {
                await RefundRequest.updateOne(
                    { _id: rr._id, status: 'approved' },
                    { $set: { status: 'pending', decisionNote: '' }, $unset: { decidedBy: 1, decidedAt: 1 } }
                );
            } catch (unclaimErr) {
                logger.error('approveRefundRequest: could not return request to pending', {
                    refundRequestId: String(rr._id), error: unclaimErr.message,
                });
            }
        };

        let amount;
        let result;
        try {
            // Read the order AFTER the claim so the balance is current.
            const order = await Order.findOne({ _id: rr.order, ...tf });
            if (!order) {
                await unclaim();
                return res.status(404).json({ success: false, message: 'Order not found' });
            }

            // Re-validate the refundable balance — guards against the case
            // where someone else partially refunded the order in another
            // window between request creation and approval.
            const balance = roundPaise(Number(order.amountPaid || 0) - Number(order.refundedAmount || 0));
            amount = roundPaise(Math.min(Number(rr.amount || 0), balance));
            if (amount <= 0) {
                await unclaim();
                return res.status(400).json({ success: false, message: 'Order has no refundable balance left' });
            }

            const settings = await getSettings(req);
            result = await processOrderRefund(order, {
                amount,
                reason: `Approved refund request: ${rr.reason || 'No reason'}`,
                settings,
                tenantId: tenantId(req),
            });
        } catch (refundErr) {
            await unclaim();
            throw refundErr;
        }

        if (!result.success) {
            // Back to 'pending' so the admin can retry after resolving
            // whatever the gateway/data issue was.
            await unclaim();
            return res.status(400).json({ success: false, message: result.error || 'Refund processing failed' });
        }

        claimed.refundMode = result.mode || '';
        claimed.razorpayRefundId = result.razorpayRefundId || '';
        await claimed.save();
        rr = claimed;

        // Customer notification — they're waiting for this status flip.
        if (rr.user) {
            await notify({
                restaurant: rr.restaurant,
                recipients: rr.user,
                event: EVENTS.REFUND_REQUEST_DECIDED,
                notification: {
                    title: 'Refund Approved',
                    description: result.mode === 'wallet'
                        ? `₹${amount} has been credited to your wallet for order ${rr.orderIdRef}.`
                        : result.mode === 'original'
                            ? `₹${amount} is being refunded to your original payment method for order ${rr.orderIdRef}. It may take 5–7 business days.`
                            : `₹${amount} will be refunded at the counter for order ${rr.orderIdRef}.`,
                    category: 'Wallet',
                    recipientRole: 'customer',
                    priority: 'medium',
                    meta: { orderId: rr.orderIdRef, amount, refundRequestId: rr._id, refundMode: result.mode },
                },
                payload: { id: rr._id, status: 'approved' },
            });
        }

        return res.status(200).json({ success: true, refundRequest: rr, refund: result });
    } catch (err) {
        logger.error('approveRefundRequest error:', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to approve refund request' });
    }
};

// ─── Admin rejects a refund request (no money moves) ──────────────────────
exports.rejectRefundRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { note } = req.body || {};
        const tf = tenantFilter(req);

        let rr = await RefundRequest.findOne({ _id: id, ...tf, ...strictBranchFilter(req) });
        if (!rr) return res.status(404).json({ success: false, message: 'Refund request not found' });
        if (rr.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Refund request is already ${rr.status}` });
        }

        // Atomic pending → rejected so a concurrent approve can't also win.
        const decided = await RefundRequest.findOneAndUpdate(
            { _id: rr._id, status: 'pending' },
            { $set: {
                status: 'rejected',
                decidedBy: req.user?._id || req.user?.id || null,
                decidedAt: new Date(),
                decisionNote: String(note || '').trim(),
            } },
            { returnDocument: 'after' }
        );
        if (!decided) {
            const current = await RefundRequest.findById(rr._id).select('status').lean();
            return res.status(400).json({ success: false, message: `Refund request is already ${current?.status || 'decided'}` });
        }
        rr = decided;

        if (rr.user) {
            await notify({
                restaurant: rr.restaurant,
                recipients: rr.user,
                event: EVENTS.REFUND_REQUEST_DECIDED,
                notification: {
                    title: 'Refund Request Declined',
                    description: `Your refund request for order ${rr.orderIdRef} was declined. ${rr.decisionNote ? `Note: ${rr.decisionNote}` : ''}`.trim(),
                    category: 'Wallet',
                    recipientRole: 'customer',
                    priority: 'medium',
                    meta: { orderId: rr.orderIdRef, refundRequestId: rr._id },
                },
                payload: { id: rr._id, status: 'rejected' },
            });
        }

        return res.status(200).json({ success: true, refundRequest: rr });
    } catch (err) {
        logger.error('rejectRefundRequest error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to reject refund request' });
    }
};
