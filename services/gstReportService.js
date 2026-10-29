'use strict';
/**
 * DB-facing loader for the GST / Tally exports and scheduled reports.
 * Pure maths lives in utils/gstReport.js and utils/tallyExport.js.
 * Export aid only, not a tax filing tool.
 */
const mongoose = require('mongoose');
const Order = require('../models/order');
const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const Settings = require('../models/settings');
const Restaurant = require('../models/restaurant');
const { buildGstReport, DEFAULT_HSN } = require('../utils/gstReport');

const MAX_ORDERS = 50000;

const ORDER_FIELDS = 'orderId status paymentStatus paymentMethod payment payments amountPaid walletAmountPaid items '
    + 'total gst gstPercentage serviceCharge additionalCharges additionalChargesTotal delivery.fee tipAmount '
    + 'pointsRedeemed manualDiscount couponDiscount refundedAmount bill paidAt createdAt customerGstin gstin';

/** Orders whose bill date (paidAt, else createdAt) falls in [start, end). */
async function loadOrders({ restaurantId, branchClause = {}, start, end }) {
    const rows = await Order.find({
        restaurant: restaurantId,
        ...branchClause,
        paymentStatus: { $in: ['Paid', 'Refunded'] },
        $or: [
            { paidAt: { $gte: start, $lt: end } },
            { paidAt: null, createdAt: { $gte: start, $lt: end } },
        ],
    }).select(ORDER_FIELDS).sort({ createdAt: 1 }).limit(MAX_ORDERS + 1).lean();
    const truncated = rows.length > MAX_ORDERS;
    return { orders: truncated ? rows.slice(0, MAX_ORDERS) : rows, truncated };
}

async function loadHsnContext({ restaurantId, orders }) {
    const ids = new Set();
    for (const o of orders) for (const it of o.items || []) {
        if (it?.menuItem && mongoose.isValidObjectId(String(it.menuItem))) ids.add(String(it.menuItem));
    }
    const itemHsn = {};
    if (ids.size) {
        const items = await MenuItem.find({ restaurant: restaurantId, _id: { $in: [...ids] }, hsnCode: { $ne: '' } })
            .select('hsnCode').lean();
        for (const m of items) if (m.hsnCode) itemHsn[String(m._id)] = m.hsnCode;
    }
    const categoryHsn = {};
    const cats = await Category.find({ restaurant: restaurantId, hsnCode: { $ne: '' } }).select('name hsnCode').lean();
    for (const c of cats) if (c.hsnCode) categoryHsn[String(c.name).trim().toLowerCase()] = c.hsnCode;
    return { itemHsn, categoryHsn };
}

async function loadTenantTaxContext(restaurantId) {
    const [restaurant, settings] = await Promise.all([
        Restaurant.findById(restaurantId).select('name timezone legal').lean(),
        Settings.findOne({ restaurant: restaurantId, branch: null }).select('taxExport general.legal').lean(),
    ]);
    const taxExport = settings?.taxExport || {};
    const legal = restaurant?.legal || settings?.general?.legal || {};
    return {
        tz: restaurant?.timezone || undefined,
        taxpayer: { name: legal.legalBusinessName || restaurant?.name || '', gstin: legal.gstin || settings?.general?.legal?.gstin || '' },
        defaultHsn: taxExport.defaultHsn || DEFAULT_HSN,
        ledgers: taxExport.ledgers || {},
        partyMode: taxExport.partyMode === 'debtors' ? 'debtors' : 'cash',
        company: legal.legalBusinessName || restaurant?.name || '',
    };
}

/**
 * @param {object} p
 * @param {*}      p.restaurantId
 * @param {object} [p.branchClause]   analyticsBranchFilter(req) clause, {} = all branches
 * @param {{from,to,start,end,tz}} p.range   from utils/reportDates.resolveRange
 * @param {object} [p.tenant]         pre-loaded loadTenantTaxContext result
 */
async function generateGstReport({ restaurantId, branchClause = {}, range, tenant }) {
    const t = tenant || await loadTenantTaxContext(restaurantId);
    const { orders, truncated } = await loadOrders({ restaurantId, branchClause, start: range.start, end: range.end });
    const hsnCtx = await loadHsnContext({ restaurantId, orders });
    const report = buildGstReport({
        orders, ...hsnCtx, defaultHsn: t.defaultHsn, tz: range.tz,
        range: { from: range.from, to: range.to }, taxpayer: t.taxpayer, truncated,
    });
    return { report, orders, hsnCtx: { ...hsnCtx, defaultHsn: t.defaultHsn }, tenant: t };
}

module.exports = { MAX_ORDERS, loadOrders, loadHsnContext, loadTenantTaxContext, generateGstReport };
