const Order = require('../models/order');
const MenuItem = require('../models/menuItem');
const User = require('../models/user');

const { tenantFilter, analyticsBranchFilter } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// @desc    Get 30-Day Sales Data (Chart-ready)
// @route   GET /api/analytics/sales-history
// @access  Private/Admin
//
// Phase 6 step 6: every analytics endpoint accepts an optional
// `?branch=<id>` query param that filters the aggregation to a
// single branch. `?branch=all` is the explicit "every branch"
// override. Omitted = fall back to the logged-in staff's pinned
// branch (req.branch from Phase 6 step 5), so a per-branch manager
// always lands on their own dashboard by default.
exports.getSalesHistory = asyncHandler(async (req, res) => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const sales = await Order.aggregate([
        {
            $match: {
                createdAt: { $gte: thirtyDaysAgo },
                status: { $ne: 'cancelled' },
                paymentStatus: 'Paid',
                ...tenantFilter(req),
                ...analyticsBranchFilter(req),
            }
        },
        {
            $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                total: { $sum: "$total" },
                count: { $sum: 1 }
            }
        },
        { $sort: { "_id": 1 } }
    ]);

    res.status(200).json({ success: true, sales });
}, 'Error fetching sales history');

// @desc    Get Peak Hours Analysis
// @route   GET /api/analytics/peak-hours
// @access  Private/Admin
exports.getPeakHours = asyncHandler(async (req, res) => {
    const peakHours = await Order.aggregate([
        { $match: { status: { $ne: 'cancelled' }, ...tenantFilter(req), ...analyticsBranchFilter(req) } },
        {
            $group: {
                _id: { $hour: "$createdAt" },
                count: { $sum: 1 }
            }
        },
        { $sort: { "_id": 1 } }
    ]);

    res.status(200).json({ success: true, peakHours });
}, 'Error fetching peak hours');

// @desc    Get Top Items (Extended)
// @route   GET /api/analytics/top-items
// @access  Private/Admin
exports.getTopItems = asyncHandler(async (req, res) => {
    const topItems = await Order.aggregate([
        { $match: { status: { $ne: 'cancelled' }, ...tenantFilter(req), ...analyticsBranchFilter(req) } },
        { $unwind: "$items" },
        {
            $group: {
                _id: "$items.name",
                totalQuantity: { $sum: "$items.quantity" },
                totalRevenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } }
            }
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 }
    ]);

    res.status(200).json({ success: true, topItems });
}, 'Error fetching top items');

// @desc    Summary Report (Revenue, Orders, Customers)
// @route   GET /api/analytics/summary
// @access  Private/Admin
exports.getSummaryReport = asyncHandler(async (req, res) => {
    // Phase 6 step 6 — fold the branch filter into the same scope
    // object so every aggregation uses identical match criteria.
    const scope = { ...tenantFilter(req), ...analyticsBranchFilter(req) };
    const totalRevenue = await Order.aggregate([
        { $match: { paymentStatus: 'Paid', status: { $ne: 'cancelled' }, ...scope } },
        { $group: { _id: null, total: { $sum: "$total" } } }
    ]);

    const totalOrders = await Order.countDocuments({ status: { $ne: 'cancelled' }, ...scope });

    // Customer count = number of unique customers who have ordered
    // from THIS restaurant, not the global customer count.
    const customerIds = await Order.distinct('user', { ...scope, user: { $ne: null } });
    const totalCustomers = customerIds.length;

    res.status(200).json({
        success: true,
        summary: {
            revenue: totalRevenue[0]?.total || 0,
            orders: totalOrders,
            customers: totalCustomers
        }
    });
}, 'Error fetching summary');
