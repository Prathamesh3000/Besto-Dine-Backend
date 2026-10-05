const mongoose = require('mongoose');
const { verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const Invoice = require('../models/invoice');
const Order = require('../models/order');
const MenuItem = require('../models/menuItem');
const logger = require('../utils/logger');
const { lineItemsSubtotal } = require('../services/orderBillMath');

const { tenantFilter, tenantId } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const STAFF_ROLES = new Set(['admin', 'manager', 'captain', 'waiter', 'chef']);

// True when the caller may see the customer identity on this invoice.
// See getInvoice for the rules.
async function callerOwnsInvoice(req, invoice) {
    const caller = req.user || null;
    const invoiceTenant = invoice.restaurant ? String(invoice.restaurant) : null;

    if (caller && STAFF_ROLES.has(caller.role)) {
        const staffTenant = caller.restaurant?._id || caller.restaurant;
        return !!staffTenant && !!invoiceTenant && String(staffTenant) === invoiceTenant;
    }
    if (caller && invoice.customer && String(invoice.customer) === String(caller._id)) {
        return true;
    }

    const orderRef = invoice.order?._id || invoice.order;
    if (!orderRef) return false;
    const order = await Order.findById(orderRef).select('user scanSessionId restaurant').lean();
    if (!order) return false;

    if (caller && order.user && String(order.user) === String(caller._id)) return true;

    const scanToken = req.headers['x-scan-token'];
    if (scanToken && order.scanSessionId) {
        try {
            const decoded = verifyTypedToken(scanToken, TOKEN_TYPES.SCAN);
            const tenantOk = !decoded.restaurantId || !order.restaurant
                || String(decoded.restaurantId) === String(order.restaurant);
            if (tenantOk && decoded.sessionId && String(decoded.sessionId) === String(order.scanSessionId)) {
                return true;
            }
        } catch { /* invalid / expired scan token → not authorized */ }
    }
    return false;
}

// Build a description string from order item customizations
function buildItemDescription(item) {
    const parts = [];
    if (item.selectedSizes?.length) {
        parts.push(item.selectedSizes.map(s => s.name).join(', '));
    }
    if (item.selectedToppings?.length) {
        parts.push(item.selectedToppings.map(t => t.name).join(', '));
    }
    if (item.instructions) {
        parts.push(item.instructions);
    }
    return parts.join(' · ') || '';
}

// @desc    Generate Invoice from Order
// @route   POST /api/invoices/generate/:orderId
// @access  Private/Admin
exports.generateInvoice = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    if (!mongoose.isValidObjectId(orderId)) {
        return res.status(400).json({ success: false, message: 'Invalid order id' });
    }
    // Scope the order lookup to the current tenant so one restaurant's
    // admin can't generate invoices for another restaurant's orders.
    const order = await Order.findOne({ _id: orderId, ...tenantFilter(req) }).populate('user');

    if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // One invoice per order (unique { order, restaurant } index): a
    // re-generate (e.g. a re-print) returns the existing invoice.
    const existing = await Invoice.findOne({ order: order._id, restaurant: order.restaurant || tenantId(req) });
    if (existing) {
        return res.status(200).json({ success: true, invoice: existing, existing: true });
    }

    // Fetch menu item images for each order item — scope to the order's
    // tenant so we don't accidentally pick up an image from another
    // restaurant's menu item that happens to share the same name.
    const menuItemNames = order.items.map(i => i.name);
    const menuItems = await MenuItem.find({
        name: { $in: menuItemNames },
        ...(order.restaurant ? { restaurant: order.restaurant } : {}),
    }).select('name images');
    const imageMap = {};
    menuItems.forEach(mi => {
        if (mi.images?.length) imageMap[mi.name] = mi.images[0];
    });

    // Money breakdown from the fields the order actually stamps:
    // subtotal = line items (+ toppings), tax = GST + service charge +
    // additional charges, discount = coupon + manual (+ the rupee value
    // of redeemed points, which the order stores only as a point count —
    // recovered as the remainder so subtotal + tax − discount = total).
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const subtotal = round2(lineItemsSubtotal(order.items));
    const chargesTotal = Number(order.additionalChargesTotal)
        || (order.additionalCharges || []).reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
    const tax = round2((Number(order.gst) || 0) + (Number(order.serviceCharge) || 0) + chargesTotal);
    const explicitDiscount = round2((Number(order.couponDiscount) || 0) + (Number(order.manualDiscount) || 0));
    const remainder = round2(subtotal + tax - (Number(order.total) || 0));
    const discount = Math.max(explicitDiscount, remainder, 0);

    const invoice = new Invoice({
        invoiceNumber: `INV-${Date.now()}-${order.orderId || 'ORD'}`,
        order: order._id,
        customer: order.user?._id,
        customerName: order.user?.name || 'Walk-in Customer',
        customerEmail: order.user?.email || '',
        customerMobile: order.user?.mobile || '',
        items: order.items.map(item => ({
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            total: item.price * item.quantity,
            image: imageMap[item.name] || '',
            description: buildItemDescription(item),
            addons: item.addon ? [{ name: item.addon, price: item.addonPrice || 0 }] : []
        })),
        subtotal,
        tax,
        discount,
        gst: round2(order.gst),
        gstPercentage: Number(order.gstPercentage) || 0,
        serviceCharge: round2(order.serviceCharge),
        serviceChargePercentage: Number(order.serviceChargePercentage) || 0,
        additionalCharges: (order.additionalCharges || []).map((c) => ({
            name: c.name, type: c.type, value: Number(c.value) || 0, amount: round2(c.amount),
        })),
        total: order.total,
        paymentStatus: order.paymentStatus === 'Paid' ? 'paid' : 'unpaid',
        paymentMethod: order.paymentMethod || 'Cash',
        // Inherit tenant from the source order — the order is the
        // authoritative tenant holder, not req.restaurant, so cross-
        // tenant corruption is impossible even if the admin switches
        // tenant mid-flow.
        restaurant: order.restaurant || tenantId(req),
    });

    try {
        await invoice.save();
    } catch (err) {
        // Lost a race with a concurrent generate for the same order.
        if (err?.code === 11000) {
            const winner = await Invoice.findOne({ order: order._id, restaurant: invoice.restaurant });
            if (winner) return res.status(200).json({ success: true, invoice: winner, existing: true });
        }
        throw err;
    }
    res.status(201).json({ success: true, invoice });

}, 'Failed to generate invoice');

// @desc    Get all invoices for a user
// @route   GET /api/invoices/my-invoices
// @access  Private
exports.getMyInvoices = asyncHandler(async (req, res) => {
    // Filter by (customer AND current tenant) so a customer who has
    // orders at multiple tenants only sees this tenant's invoices.
    const invoices = await Invoice.find({
        customer: req.user.id,
        ...tenantFilter(req),
    })
        .populate('order', 'orderId')
        .sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: invoices.length, invoices });
}, 'Error fetching invoices');

// @desc    Get single invoice
// @route   GET /api/invoices/:id
// @access  Public (guests need to view their bill)
exports.getInvoice = asyncHandler(async (req, res) => {
    // This endpoint is intentionally public so guests who placed an
    // order via QR can view their bill without logging in. The
    // invoice id is a Mongo ObjectId — not guessable — so leaking
    // cross-tenant data requires knowing another tenant's invoice id.
    // When a tenant slug is present (e.g. customer app sends
    // X-Restaurant-Slug), we DO scope the lookup so a wrong slug
    // hides the bill. When no slug is present, we fall through so
    // legacy single-tenant guest flows keep working.
    const tenantScope = req.restaurant ? { restaurant: req.restaurant._id } : {};
    const rawId = req.params.id;

    // Callers (BillDetail / BillReceipt) pass whichever id their
    // cached order doc carried — sometimes the Mongo _id of the
    // Invoice, sometimes the friendly ORD-* orderId. Mongoose will
    // throw a CastError on the friendly form if we feed it to {_id},
    // so try each shape in turn and 404 only if every lookup misses.
    let invoice = null;

    if (mongoose.Types.ObjectId.isValid(rawId)) {
        invoice = await Invoice.findOne({ _id: rawId, ...tenantScope })
            .populate('order', 'orderId');
    }

    if (!invoice) {
        invoice = await Invoice.findOne({ invoiceNumber: rawId, ...tenantScope })
            .populate('order', 'orderId');
    }

    // ORD-* / ORT-* / KSK-* form: resolve the order first, then
    // look up the invoice attached to it. Scoped to tenant when a
    // slug is set so a wrong-tenant orderId can't surface another
    // restaurant's bill.
    if (!invoice && /^(ORD|ORT|KSK)-/i.test(rawId)) {
        const order = await Order.findOne({ orderId: rawId, ...tenantScope }).select('_id');
        if (order) {
            invoice = await Invoice.findOne({ order: order._id, ...tenantScope })
                .populate('order', 'orderId');
        }
    }

    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    // ── Caller authorization (bug #19) ─────────────────────────────
    // The route stays reachable without login so a QR guest can still
    // open their receipt, but the customer's identity (name / email /
    // mobile) is only returned to a caller who can prove the bill is
    // theirs:
    //   • staff of the invoice's restaurant
    //   • the logged-in customer the invoice / order belongs to
    //   • a guest whose X-Scan-Token session matches the order's
    //     scanSessionId (same rule as GET /orders/:id/detail)
    // Everyone else gets the bill with the PII fields blanked.
    const authorized = await callerOwnsInvoice(req, invoice);
    if (!authorized) {
        const redacted = invoice.toObject();
        redacted.customerName = 'Customer';
        redacted.customerEmail = '';
        redacted.customerMobile = '';
        delete redacted.customer;
        return res.status(200).json({ success: true, invoice: redacted, redacted: true });
    }

    res.status(200).json({ success: true, invoice });
}, 'Error fetching invoice');
