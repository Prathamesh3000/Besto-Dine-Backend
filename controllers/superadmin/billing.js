// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const SubscriptionInvoice = require('../../models/subscriptionInvoice');
const logger = require('../../utils/logger');

// Platform billing ledger (tenant → BestoDine). One row per successful
// Razorpay subscription charge, written by the razorpay webhook handler.
// Read-only, platform-wide (all tenants) — this is the Super Admin's
// "all subscription payments" view.
//
// GET /api/v1/superadmin/subscription-payments
//   ?status=all|paid|refunded|partially_refunded
//   ?search=<restaurant | invoice no | plan | razorpay id>
//   ?page=&limit=
exports.listSubscriptionPayments = async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        // Date-range filter (by charge date). Applies to BOTH the table and
        // the revenue summary so "total revenue" reflects the chosen period.
        const dateFilter = {};
        if (req.query.from) {
            const d = new Date(req.query.from);
            if (!isNaN(d.getTime())) dateFilter.$gte = d;
        }
        if (req.query.to) {
            const d = new Date(req.query.to);
            if (!isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); dateFilter.$lte = d; }
        }
        const hasDate = Object.keys(dateFilter).length > 0;

        const filter = {};
        if (hasDate) filter.createdAt = dateFilter;
        if (req.query.status && req.query.status !== 'all') {
            filter.status = req.query.status;
        }
        if (req.query.search && req.query.search.trim()) {
            const safe = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(safe, 'i');
            filter.$or = [
                { restaurantName: rx },
                { invoiceNumber: rx },
                { planName: rx },
                { razorpayPaymentId: rx },
                { razorpaySubscriptionId: rx },
            ];
        }

        // Summary respects the date range only (not status/search) so the
        // cards show the full paid/refunded breakdown for the period.
        const summaryMatch = hasDate ? { createdAt: dateFilter } : {};

        // AUDIT-EXEMPT: platform-wide billing ledger — SubscriptionInvoice is a
        // platform (tenant→BestoDine) record; the Super Admin sees all tenants.
        const [items, total, summaryAgg] = await Promise.all([
            SubscriptionInvoice.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            SubscriptionInvoice.countDocuments(filter),
            // Totals for the cards — scoped to the selected date range.
            SubscriptionInvoice.aggregate([
                { $match: summaryMatch },
                { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
            ]),
        ]);

        const summary = {
            totalCount: 0, paidCount: 0, refundedCount: 0,
            grossAmount: 0, refundedAmount: 0, currency: 'INR',
        };
        for (const g of summaryAgg) {
            summary.totalCount += g.count;
            if (g._id === 'paid') {
                summary.paidCount += g.count;
                summary.grossAmount += g.amount;
            } else if (g._id === 'partially_refunded') {
                summary.paidCount += g.count;
                summary.grossAmount += g.amount;
                summary.refundedCount += g.count;
            } else if (g._id === 'refunded') {
                summary.refundedCount += g.count;
                summary.refundedAmount += g.amount;
            }
        }

        return res.status(200).json({
            success: true,
            data: {
                payments: items.map(i => ({
                    _id: i._id,
                    restaurant: i.restaurant,
                    restaurantName: i.restaurantName,
                    invoiceNumber: i.invoiceNumber,
                    planName: i.planName,
                    planSlug: i.planSlug,
                    amount: i.amount,
                    currency: i.currency,
                    status: i.status,
                    periodStart: i.periodStart,
                    periodEnd: i.periodEnd,
                    paidAt: i.paidAt,
                    createdAt: i.createdAt,
                    razorpayPaymentId: i.razorpayPaymentId,
                    razorpaySubscriptionId: i.razorpaySubscriptionId,
                })),
                summary,
                pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
            },
        });
    } catch (err) {
        logger.error('listSubscriptionPayments error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load subscription payments' });
    }
};
