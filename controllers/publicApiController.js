/**
 * Public API v1 handlers (read-only), mounted at /api/public/v1 by
 * routes/publicApiRoute.js behind apiKeyAuth(scope).
 *
 * Every query carries `restaurant: req.restaurant._id` (set from the API
 * key, never from the request) and responses go through the allow-list
 * serializers in utils/publicApiSerializers.js.
 *
 * Lists: `?page=1&limit=50` (limit max 100) ->
 *   { success, data: [...], pagination: { page, limit, total, has_more } }
 */
'use strict';

const mongoose = require('mongoose');
const Order = require('../models/order');
const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const Inventory = require('../models/inventory');
const AdvanceBooking = require('../models/advanceBooking');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { tenantId } = require('../utils/tenantScope');
const { serializeOrder, serializeMenuItem, serializeInventoryItem, serializeBooking } = require('../utils/publicApiSerializers');

const MAX_LIMIT = 100;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
// Same definition of "sold" as the admin analytics (analyticsController).
const NOT_SOLD_STATUSES = ['cancelled', 'awaiting-payment'];

const ORDER_STATUSES = ['awaiting-payment', 'new', 'preparing', 'ready', 'served', 'cancelled'];
const PAYMENT_STATUSES = ['Pending', 'Partially Paid', 'Paid', 'Refunded'];
const BOOKING_STATUSES = ['Pending', 'Confirmed', 'Completed', 'Cancelled'];

function paging(req) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));
    return { page, limit, skip: (page - 1) * limit };
}

function listBody(data, { page, limit }, total) {
    return { success: true, data, pagination: { page, limit, total, has_more: page * limit < total } };
}

function parseDate(value, name, { endOfDay = false } = {}) {
    if (value === undefined || value === '') return null;
    const s = String(value);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw AppError.badRequest(`"${name}" must be an ISO date (YYYY-MM-DD or full timestamp).`, 'INVALID_DATE');
    // A bare date for `to` means "through the end of that day" (UTC).
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setUTCHours(23, 59, 59, 999);
    return d;
}

function dateRange(req, field, { defaultDays = null } = {}) {
    let from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to', { endOfDay: true });
    if (!from && !to && defaultDays) {
        from = new Date(Date.now() - defaultDays * 86400000);
        from.setUTCHours(0, 0, 0, 0);
    }
    if (from && to && from > to) throw AppError.badRequest('"from" must not be after "to".', 'INVALID_RANGE');
    if (from && (to || new Date()) - from > MAX_RANGE_DAYS * 86400000) {
        throw AppError.badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`, 'RANGE_TOO_LARGE');
    }
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    return Object.keys(range).length ? { [field]: range } : {};
}

function branchClause(req) {
    const raw = req.query.branch_id;
    if (!raw) return {};
    if (!mongoose.isValidObjectId(raw)) throw AppError.badRequest('"branch_id" is not a valid id.', 'INVALID_BRANCH');
    return { branch: new mongoose.Types.ObjectId(String(raw)) };
}

function oneOf(value, allowed, name) {
    if (value === undefined || value === '') return null;
    if (!allowed.includes(value)) throw AppError.badRequest(`"${name}" must be one of: ${allowed.join(', ')}.`, 'INVALID_FILTER');
    return value;
}

// GET /orders
exports.listOrders = asyncHandler(async (req, res) => {
    const p = paging(req);
    const status = oneOf(req.query.status, ORDER_STATUSES, 'status');
    const payment = oneOf(req.query.payment_status, PAYMENT_STATUSES, 'payment_status');
    const filter = {
        restaurant: tenantId(req),
        ...dateRange(req, 'createdAt'),
        ...branchClause(req),
        ...(status ? { status } : {}),
        ...(payment ? { paymentStatus: payment } : {}),
    };
    const [rows, total] = await Promise.all([
        Order.find(filter).sort({ createdAt: -1, _id: -1 }).skip(p.skip).limit(p.limit).lean(),
        Order.countDocuments(filter),
    ]);
    res.json(listBody(rows.map(serializeOrder), p, total));
}, 'Failed to list orders');

// GET /orders/:id   (id = the order number, e.g. ORD-0001)
exports.getOrder = asyncHandler(async (req, res) => {
    const order = await Order.findOne({ orderId: String(req.params.id), restaurant: tenantId(req) }).lean();
    if (!order) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');
    res.json({ success: true, data: serializeOrder(order) });
}, 'Failed to load order');

// GET /menu
exports.listMenu = asyncHandler(async (req, res) => {
    const p = paging(req);
    const filter = { restaurant: tenantId(req), status: 'active', ...branchClause(req) };
    if (req.query.in_stock === 'true') filter.inStock = true;
    const [rows, total] = await Promise.all([
        MenuItem.find(filter).sort({ name: 1, _id: 1 }).skip(p.skip).limit(p.limit).lean(),
        MenuItem.countDocuments(filter),
    ]);
    const catIds = [...new Set(rows.map((r) => String(r.category)).filter(Boolean))];
    const cats = catIds.length
        ? await Category.find({ _id: { $in: catIds }, restaurant: tenantId(req) }).select('name').lean()
        : [];
    const names = new Map(cats.map((c) => [String(c._id), c.name]));
    res.json(listBody(rows.map((m) => serializeMenuItem(m, names.get(String(m.category)) || null)), p, total));
}, 'Failed to list menu');

// GET /sales/summary?from=&to=
exports.salesSummary = asyncHandler(async (req, res) => {
    const match = {
        restaurant: tenantId(req),
        status: { $nin: NOT_SOLD_STATUSES },
        paymentStatus: 'Paid',
        ...dateRange(req, 'createdAt', { defaultDays: DEFAULT_RANGE_DAYS }),
        ...branchClause(req),
    };
    const tz = reportTimezone(req.restaurant);
    const [totals, daily, topItems] = await Promise.all([
        Order.aggregate([
            { $match: match },
            { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 }, refunded: { $sum: '$refundedAmount' } } },
        ]),
        Order.aggregate([
            { $match: match },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
            { $sort: { _id: 1 } },
        ]),
        Order.aggregate([
            { $match: match },
            { $unwind: '$items' },
            { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } } } },
            { $sort: { quantity: -1 } },
            { $limit: 10 },
        ]),
    ]);
    const t = totals[0] || { revenue: 0, orders: 0, refunded: 0 };
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    res.json({
        success: true,
        data: {
            timezone: tz,
            from: match.createdAt?.$gte ? match.createdAt.$gte.toISOString() : null,
            to: match.createdAt?.$lte ? match.createdAt.$lte.toISOString() : null,
            revenue: round2(t.revenue),
            orders: t.orders,
            refunded: round2(t.refunded),
            average_order_value: t.orders ? round2(t.revenue / t.orders) : 0,
            daily: daily.map((d) => ({ date: d._id, revenue: round2(d.revenue), orders: d.orders })),
            top_items: topItems.map((i) => ({ name: i._id, quantity: i.quantity, revenue: round2(i.revenue) })),
        },
    });
}, 'Failed to build sales summary');

// Tenant timezone, falling back like analyticsController.reportTz.
function reportTimezone(restaurant) {
    const fallback = process.env.ANALYTICS_TIMEZONE || 'Asia/Kolkata';
    const tz = typeof restaurant?.timezone === 'string' ? restaurant.timezone.trim() : '';
    if (!tz) return fallback;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return fallback; }
}

// GET /inventory/low-stock
exports.lowStock = asyncHandler(async (req, res) => {
    const p = paging(req);
    const filter = {
        restaurant: tenantId(req),
        ...branchClause(req),
        $expr: { $lte: ['$currentStock', { $ifNull: ['$minStock', 0] }] },
    };
    const [rows, total] = await Promise.all([
        Inventory.find(filter).select('-adjustmentHistory').sort({ currentStock: 1, _id: 1 }).skip(p.skip).limit(p.limit).lean(),
        Inventory.countDocuments(filter),
    ]);
    res.json(listBody(rows.map(serializeInventoryItem), p, total));
}, 'Failed to list low-stock items');

// GET /bookings
exports.listBookings = asyncHandler(async (req, res) => {
    const p = paging(req);
    const status = oneOf(req.query.status, BOOKING_STATUSES, 'status');
    const type = oneOf(req.query.type, ['table', 'hall'], 'type');
    const filter = {
        restaurant: tenantId(req),
        ...dateRange(req, 'bookingDate'),
        ...branchClause(req),
        ...(status ? { status } : {}),
        ...(type ? { bookingType: type } : {}),
    };
    const [rows, total] = await Promise.all([
        AdvanceBooking.find(filter).sort({ bookingDate: -1, _id: -1 }).skip(p.skip).limit(p.limit).lean(),
        AdvanceBooking.countDocuments(filter),
    ]);
    res.json(listBody(rows.map(serializeBooking), p, total));
}, 'Failed to list bookings');

exports._internals = { dateRange, paging, parseDate };
