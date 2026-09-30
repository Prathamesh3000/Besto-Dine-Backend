const Order = require('../models/order');
const logger = require('../utils/logger');

const { tenantFilter, analyticsBranchFilter } = require('../utils/tenantScope');

/**
 * Canonicalize the `paymentMethod` stored on each Order. The DB has
 * accumulated a mix of casings and gateway-specific labels over time
 * (`online`, `Cash`, `cash`, `card`, `Card`, `mixed`, `Not selected`,
 * `razorpay`, `Online`, …) — the admin Payments table needs to render
 * one canonical label per row so the Method column is filterable and
 * styled correctly.
 *
 * Returns a display-ready label. Unknown / empty values render as "-".
 */
function normalizePaymentMethod(raw) {
    if (!raw) return '-';
    const v = String(raw).trim().toLowerCase();
    if (!v || v === 'not selected' || v === 'none') return '-';
    if (v === 'cash')                                return 'Cash';
    if (v === 'card' || v === 'credit card' || v === 'debit card') return 'Card';
    if (v === 'upi')                                 return 'UPI';
    if (v === 'net banking' || v === 'netbanking' || v === 'net-banking') return 'Net Banking';
    if (v === 'wallet')                              return 'Wallet';
    if (v === 'mixed' || v === 'split')              return 'Mixed';
    // Generic online — every gateway integration (razorpay, stripe,
    // etc.) historically stored "online" before we started recording
    // the underlying instrument. Surface it under one banner so the
    // operator isn't trying to filter by "razorpay" or "stripe".
    if (v === 'online' || v === 'razorpay' || v === 'stripe') return 'Online';
    // Fallback: Title-case whatever came in so a future gateway label
    // still renders readably instead of as raw lowercase.
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// @desc    Admin: Get all payment transactions from orders
// @route   GET /api/payments/admin/all
// @access  Admin
exports.getAllPayments = async (req, res) => {
    try {
        const tf = tenantFilter(req);
        const bf = analyticsBranchFilter(req);
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        // Step 1: Aggregation pipeline for stats — runs in the DB, not in memory
        const [statsResult] = await Order.aggregate([
            { $match: {
                $or: [
                    { paymentStatus: { $ne: 'Pending' } },
                    { paymentStatus: 'Pending', status: { $nin: ['cancelled'] } }
                ],
                ...tf,
                ...bf,
            }},
            { $facet: {
                counts: [{ $group: {
                    _id: null,
                    successful: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, 1, 0] } },
                    refunded: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Refunded'] }, 1, 0] } },
                    pending: { $sum: { $cond: [
                        { $and: [
                            { $in: ['$paymentStatus', ['Pending', 'Partially Paid']] },
                            { $ne: ['$status', 'cancelled'] }
                        ]}, 1, 0
                    ] } },
                    failed: { $sum: { $cond: [
                        { $and: [
                            { $eq: ['$paymentStatus', 'Pending'] },
                            { $eq: ['$status', 'cancelled'] }
                        ]}, 1, 0
                    ] } },
                    total: { $sum: 1 },
                }}],
                todayRevenue: [
                    { $match: { paymentStatus: 'Paid', createdAt: { $gte: todayStart } } },
                    { $group: { _id: null, revenue: { $sum: '$total' } } }
                ]
            }}
        ]);

        const counts = statsResult?.counts?.[0] || { successful: 0, pending: 0, failed: 0, refunded: 0, total: 0 };
        const todayRevenue = statsResult?.todayRevenue?.[0]?.revenue || 0;

        // Step 2: Paginated order list with populates (same filter, sorted)
        const allOrders = await Order.find({
            $or: [
                { paymentStatus: { $ne: 'Pending' } },
                { paymentStatus: 'Pending', status: { $nin: ['cancelled'] } }
            ],
            ...tf,
            ...bf,
        })
        .populate('user', 'name')
        .populate('table', 'name')
        .sort({ updatedAt: -1 })
        .lean();

        const payments = allOrders.map(order => {
            let tableName;
            if (order.source === 'kiosk') tableName = 'Kiosk';
            else if (order.table?.name) tableName = order.table.name;
            else if (order.type === 'takeaway') tableName = 'Takeaway';
            else tableName = 'Takeaway';

            let status = 'pending';
            if (order.paymentStatus === 'Paid') status = 'successful';
            else if (order.paymentStatus === 'Refunded') status = 'refunded';
            else if (order.paymentStatus === 'Partially Paid') status = 'pending';
            else if (order.status === 'cancelled') status = 'failed';

            const subtotal = (order.items || []).reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);
            const refundedAmount = order.refundedAmount || 0;
            const amountPaid = order.amountPaid || 0;

            // The Order schema stores `total` but not the per-component
            // breakdown (GST / service charge / additional charges) —
            // those are computed at cart time against the tenant's tax
            // settings and folded into `total`. To keep the admin Bill
            // Summary balanced, surface what IS persisted (tip, coupon,
            // wallet-points) and expose the remaining gap as a single
            // "Taxes & charges" line so subtotal ± adjustments + gap = total.
            const tipAmount = order.tipAmount || 0;
            const couponDiscount = order.couponDiscount || 0;
            const pointsRedeemed = order.pointsRedeemed || 0;
            const totalValue = order.total || 0;
            // total = subtotal + taxesAndCharges + tip - couponDiscount - pointsRedeemed
            // Solve for taxesAndCharges; clamp to 0 against rounding noise.
            const rawCharges = totalValue - subtotal - tipAmount + couponDiscount + pointsRedeemed;
            const taxesAndCharges = Math.round(Math.max(0, rawCharges) * 100) / 100;

            return {
                id: order.orderId,
                _orderId: order._id,
                table: tableName,
                customer: order.user?.name || order.customerName || 'Guest',
                phone: order.phone || '',
                method: normalizePaymentMethod(order.paymentMethod),
                billAmount: totalValue,
                status,
                orderStatus: order.status || '',
                date: new Date(order.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                time: new Date(order.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                createdAt: order.createdAt,
                paidAt: order.paidAt || null,
                items: (order.items || []).map(item => ({
                    name: `${item.name} x${item.quantity || 1}`,
                    variant: '',
                    price: item.price * (item.quantity || 1),
                    unitPrice: item.price,
                })),
                subtotal,
                // Per-component breakdown — 0 for legacy orders, populated
                // once the Cart/Takeaway flows start persisting these fields.
                serviceCharge: order.serviceCharge || 0,
                gst: order.gst || 0,
                discount: order.discount || 0,
                // Always-present residual so the card reconciles to `total`
                // even for orders without the component breakdown.
                taxesAndCharges,
                tipAmount,
                couponCode: order.couponCode || '',
                couponDiscount,
                pointsRedeemed,
                total: totalValue,
                amountPaid,
                refundedAmount,
                refundableBalance: Math.max(0, amountPaid - refundedAmount),
                razorpayOrderId: order.razorpayOrderId || '',
                razorpayPaymentId: order.razorpayPaymentId || '',
                refunds: (order.refunds || []).map(r => ({
                    amount: r.amount || 0,
                    reason: r.reason || '',
                    razorpayRefundId: r.razorpayRefundId || '',
                    actorName: r.actorName || '',
                    source: r.source || 'admin',
                    createdAt: r.createdAt,
                })),
            };
        });

        const stats = {
            todayRevenue,
            successful: counts.successful,
            pending: counts.pending,
            failed: counts.failed + counts.refunded
        };

        const filters = [
            { name: 'All', count: String(counts.total).padStart(2, '0') },
            { name: 'Successful', count: String(counts.successful).padStart(2, '0') },
            { name: 'Pending', count: String(counts.pending).padStart(2, '0') },
            { name: 'Failed', count: String(counts.failed).padStart(2, '0') },
            { name: 'Refunded', count: String(counts.refunded).padStart(2, '0') },
        ];

        res.status(200).json({ success: true, stats, filters, payments });
    } catch (error) {
        logger.error('Payments getAllPayments error:', { error: error.message });
        res.status(500).json({ success: false, message: 'Failed to fetch payments' });
    }
};
