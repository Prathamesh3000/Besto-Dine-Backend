const mongoose = require('mongoose');
const PurchaseOrder = require('../models/purchaseOrder');
const Supplier = require('../models/supplier');
const Inventory = require('../models/inventory');
const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = (n) => Math.round((n || 0) * 100) / 100;
// Stock quantities use the inventory precision (3 decimals) — never
// round2, which silently moved existing 3-decimal stock (0.955 → 0.96).
const { roundQty } = Inventory;

// Branch + shared(null) scope — see supplierController.branchScopeFilter.
function branchFilter(req) {
    const pinned = pinnedBranchId(req);
    const raw = req?.query?.branch;
    let bid = null;
    if (pinned) bid = pinned._id || pinned;
    else if (raw && raw !== 'all' && mongoose.isValidObjectId(raw)) bid = raw;
    else if (req?.branch) bid = req.branch._id || req.branch;
    if (!bid) return {};
    return { branch: { $in: [new mongoose.Types.ObjectId(String(bid)), null] } };
}

// ── Per-tenant serial generators ───────────────────────────────────────
const generatePoNumber = async (req, retries = 3) => {
    const tf = tenantFilter(req);
    for (let i = 0; i < retries; i++) {
        const last = await PurchaseOrder.findOne(tf).sort({ poNumber: -1 });
        let next = 'PO-001';
        if (last && last.poNumber) {
            const num = parseInt(last.poNumber.split('-')[1], 10) + 1;
            next = `PO-${num.toString().padStart(3, '0')}`;
        }
        if (!(await PurchaseOrder.findOne({ poNumber: next, ...tf }))) return next;
    }
    return `PO-${Date.now().toString(36).toUpperCase()}`;
};

// ── Money + status recompute (single source of truth) ──────────────────
function computeTotals(po) {
    let subTotal = 0, taxTotal = 0;
    for (const l of po.lines) {
        const base = (Number(l.orderedQty) || 0) * (Number(l.rate) || 0);
        subTotal += base;
        taxTotal += base * (Number(l.taxPercent) || 0) / 100;
    }
    po.subTotal = round2(subTotal);
    po.taxTotal = round2(taxTotal);
    po.grandTotal = round2(subTotal + taxTotal);
}

function computeReceiveStatus(po) {
    if (po.status === 'cancelled' || po.status === 'draft') return po.status;
    const totalReceived = po.lines.reduce((s, l) => s + (l.receivedQty || 0), 0);
    if (totalReceived <= 0) return 'ordered';
    // 'received' only when EVERY line is fully in; over-delivery on one
    // line must not close a PO while another line is still outstanding.
    return po.lines.every(l => (l.receivedQty || 0) >= (l.orderedQty || 0)) ? 'received' : 'partially-received';
}

function computePaymentStatus(po) {
    po.amountPaid = round2(po.payments.reduce((s, p) => s + (p.amount || 0), 0));
    if (po.amountPaid <= 0) po.paymentStatus = 'unpaid';
    else if (po.amountPaid + 0.01 >= po.grandTotal) po.paymentStatus = 'paid';
    else po.paymentStatus = 'partial';
}

// ── List ────────────────────────────────────────────────────────────────
exports.list = asyncHandler(async (req, res) => {
    const { search, status, paymentStatus, supplier, page = 1, limit = 20 } = req.query;
    const filter = { ...tenantFilter(req), ...branchFilter(req) };
    if (status && status !== 'all') filter.status = status;
    if (paymentStatus && paymentStatus !== 'all') filter.paymentStatus = paymentStatus;
    if (supplier && mongoose.isValidObjectId(supplier)) filter.supplier = supplier;
    if (search) {
        const safe = escapeRegex(search.trim());
        filter.$or = [
            { poNumber: { $regex: safe, $options: 'i' } },
            { supplierName: { $regex: safe, $options: 'i' } },
            { invoiceNumber: { $regex: safe, $options: 'i' } },
        ];
    }
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const [orders, total] = await Promise.all([
        PurchaseOrder.find(filter).sort({ createdAt: -1 })
            .skip((pageNum - 1) * limitNum).limit(limitNum)
            .populate('branch', 'name').lean(),
        PurchaseOrder.countDocuments(filter),
    ]);
    res.json({ success: true, orders, pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) } });
}, 'Failed to fetch purchase orders');

exports.summary = asyncHandler(async (req, res) => {
    const match = { ...tenantFilter(req), ...branchFilter(req) };
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [agg] = await PurchaseOrder.aggregate([
        { $match: { ...match, status: { $ne: 'cancelled' } } },
        { $group: {
            _id: null,
            totalPOs: { $sum: 1 },
            pendingReceipt: { $sum: { $cond: [{ $in: ['$status', ['ordered', 'partially-received']] }, 1, 0] } },
            outstanding: { $sum: { $subtract: ['$grandTotal', '$amountPaid'] } },
            monthSpend: { $sum: { $cond: [{ $gte: ['$orderDate', monthStart] }, '$grandTotal', 0] } },
        } },
    ]);
    res.json({ success: true, summary: agg || { totalPOs: 0, pendingReceipt: 0, outstanding: 0, monthSpend: 0 } });
}, 'Failed to fetch summary');

exports.nextNumber = async (req, res) => {
    try { res.json({ success: true, poNumber: await generatePoNumber(req) }); }
    catch { res.status(500).json({ success: false, message: 'Failed to generate PO number' }); }
};

exports.getOne = asyncHandler(async (req, res) => {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, ...tenantFilter(req), ...branchFilter(req) })
        .populate('supplier', 'name code mobile email gstNumber paymentTermsDays')
        .populate('branch', 'name')
        .populate('receipts.receivedBy', 'name')
        .populate('payments.recordedBy', 'name')
        .lean();
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    res.json({ success: true, order: po });
}, 'Failed to fetch purchase order');

// ── Create ────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
    try {
        const { supplier, orderDate, expectedDate, lines, notes, invoiceNumber } = req.body;
        const tf = tenantFilter(req);

        if (!supplier || !mongoose.isValidObjectId(supplier)) {
            return res.status(400).json({ success: false, message: 'A valid supplier is required' });
        }
        if (!Array.isArray(lines) || lines.length === 0) {
            return res.status(400).json({ success: false, message: 'Add at least one item line' });
        }

        const supplierDoc = await Supplier.findOne({ _id: supplier, ...tf });
        if (!supplierDoc) return res.status(404).json({ success: false, message: 'Supplier not found' });

        // Validate + snapshot every line against real inventory items.
        const invIds = lines.map(l => l.inventoryItem).filter(mongoose.isValidObjectId);
        const invItems = await Inventory.find({ _id: { $in: invIds }, ...tf }).select('name unit').lean();
        const invMap = Object.fromEntries(invItems.map(i => [String(i._id), i]));

        const cleanLines = [];
        for (const l of lines) {
            const inv = invMap[String(l.inventoryItem)];
            if (!inv) return res.status(400).json({ success: false, message: 'One or more items are invalid for this tenant' });
            const orderedQty = Number(l.orderedQty);
            const rate = Number(l.rate);
            if (!(orderedQty > 0)) return res.status(400).json({ success: false, message: `Quantity for ${inv.name} must be greater than 0` });
            if (!(rate >= 0)) return res.status(400).json({ success: false, message: `Rate for ${inv.name} is invalid` });
            cleanLines.push({
                inventoryItem: l.inventoryItem,
                name: inv.name,
                unit: inv.unit,
                orderedQty,
                receivedQty: 0,
                rate,
                taxPercent: Math.min(100, Math.max(0, Number(l.taxPercent) || 0)),
            });
        }

        const branchId = pinnedBranchId(req) || supplierDoc.branch || (req.branch ? (req.branch._id || req.branch) : null);
        const po = new PurchaseOrder({
            restaurant: tenantId(req),
            branch: branchId,
            poNumber: await generatePoNumber(req),
            supplier: supplierDoc._id,
            supplierName: supplierDoc.name,
            orderDate: orderDate ? new Date(orderDate) : new Date(),
            expectedDate: expectedDate ? new Date(expectedDate) : undefined,
            lines: cleanLines,
            status: 'ordered',
            invoiceNumber: invoiceNumber || '',
            notes: notes || '',
            createdBy: req.user._id,
        });
        computeTotals(po);
        computePaymentStatus(po);
        await po.save();
        res.status(201).json({ success: true, order: po });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ success: false, message: 'Duplicate PO number — try again' });
        res.status(500).json({ success: false, message: 'Failed to create purchase order', ...devError(err) });
    }
};

// ── Update (only before any goods received) ────────────────────────────
exports.update = asyncHandler(async (req, res) => {
    const tf = tenantFilter(req);
    const po = await PurchaseOrder.findOne({ _id: req.params.id, ...tf });
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (po.receipts.length > 0 || po.status === 'received') {
        return res.status(400).json({ success: false, message: 'Cannot edit a PO that has goods received. Create a new PO instead.' });
    }
    if (po.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot edit a cancelled PO' });

    const { expectedDate, notes, invoiceNumber, lines } = req.body;
    if (expectedDate !== undefined) po.expectedDate = expectedDate ? new Date(expectedDate) : undefined;
    if (notes !== undefined) po.notes = notes;
    if (invoiceNumber !== undefined) po.invoiceNumber = invoiceNumber;

    if (Array.isArray(lines) && lines.length) {
        const invIds = lines.map(l => l.inventoryItem).filter(mongoose.isValidObjectId);
        const invItems = await Inventory.find({ _id: { $in: invIds }, ...tf }).select('name unit').lean();
        const invMap = Object.fromEntries(invItems.map(i => [String(i._id), i]));
        const cleanLines = [];
        for (const l of lines) {
            const inv = invMap[String(l.inventoryItem)];
            if (!inv) return res.status(400).json({ success: false, message: 'One or more items are invalid' });
            const orderedQty = Number(l.orderedQty);
            if (!(orderedQty > 0)) return res.status(400).json({ success: false, message: `Quantity for ${inv.name} must be > 0` });
            cleanLines.push({
                inventoryItem: l.inventoryItem, name: inv.name, unit: inv.unit,
                orderedQty, receivedQty: 0, rate: Number(l.rate) || 0,
                taxPercent: Math.min(100, Math.max(0, Number(l.taxPercent) || 0)),
            });
        }
        po.lines = cleanLines;
    }
    computeTotals(po);
    // Never edit below what has already been paid (would leave a negative
    // outstanding / silent supplier credit).
    if ((po.amountPaid || 0) > po.grandTotal + 0.01) {
        return res.status(400).json({ success: false, message: `PO total (₹${po.grandTotal}) cannot be less than the amount already paid (₹${po.amountPaid})` });
    }
    computePaymentStatus(po);
    await po.save();
    res.json({ success: true, order: po });
}, 'Failed to update purchase order');

// ── Receive goods (GRN) — increments inventory stock ───────────────────
exports.receive = asyncHandler(async (req, res) => {
    const tf = tenantFilter(req);
    const po = await PurchaseOrder.findOne({ _id: req.params.id, ...tf });
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (po.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot receive against a cancelled PO' });
    if (po.status === 'received') return res.status(400).json({ success: false, message: 'This PO is already fully received' });

    const { lines, note } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ success: false, message: 'Provide at least one received line' });
    }

    const grnLines = [];
    const stockOps = []; // {inventoryItem, qty, expiryDate}
    for (const rl of lines) {
        const qty = roundQty(Number(rl.qty));
        if (!(qty > 0)) continue; // skip zero rows
        const poLine = po.lines.find(l => String(l.inventoryItem) === String(rl.inventoryItem));
        if (!poLine) return res.status(400).json({ success: false, message: 'A received line does not match any PO line' });
        poLine.receivedQty = roundQty((poLine.receivedQty || 0) + qty);
        grnLines.push({
            inventoryItem: poLine.inventoryItem,
            name: poLine.name,
            qty,
            batchNumber: rl.batchNumber || '',
            expiryDate: rl.expiryDate ? new Date(rl.expiryDate) : undefined,
        });
        stockOps.push({ inventoryItem: poLine.inventoryItem, qty, expiryDate: rl.expiryDate ? new Date(rl.expiryDate) : null });
    }
    if (grnLines.length === 0) return res.status(400).json({ success: false, message: 'No positive quantities to receive' });

    // GRN serial is per-PO: GRN-001, GRN-002 …
    const grnNumber = `GRN-${(po.receipts.length + 1).toString().padStart(3, '0')}`;
    po.receipts.push({ grnNumber, lines: grnLines, receivedBy: req.user._id, receivedAt: new Date(), note: note || '' });
    po.status = computeReceiveStatus(po);
    await po.save();

    // Apply stock increments to inventory (with restock history + batch
    // expiry). Done after PO save so a stock failure doesn't leave a
    // half-written PO; best-effort per item.
    for (const op of stockOps) {
        try {
            // Relative, atomic increment rounded to the stock precision
            // (Inventory.incStock) — no read-modify-write of currentStock.
            const inc = await Inventory.incStock({ _id: op.inventoryItem, ...tf }, op.qty);
            if (!inc) continue;
            const { previousStock, newStock, doc } = inc;
            const status = newStock <= 0 ? 'out-of-stock' : newStock <= (doc.minStock || 0) ? 'low-stock' : 'in-stock';
            await Inventory.updateOne({ _id: op.inventoryItem, ...tf }, {
                $set: {
                    lastRestocked: new Date(),
                    status,
                    ...(op.expiryDate ? { expiryDate: op.expiryDate, expiryTracking: true } : {}),
                },
                $push: { adjustmentHistory: { $each: [{
                    type: 'restock', quantity: op.qty, previousStock, newStock,
                    reason: `GRN ${grnNumber} · PO ${po.poNumber}`, adjustedBy: req.user._id, date: new Date(),
                }], $slice: -200 } },
            });
        } catch { /* per-item best effort */ }
    }

    res.json({ success: true, order: po, grnNumber });
}, 'Failed to receive goods');

// ── Record a supplier payment (10.9) ───────────────────────────────────
exports.recordPayment = asyncHandler(async (req, res) => {
    const tf = tenantFilter(req);
    const po = await PurchaseOrder.findOne({ _id: req.params.id, ...tf });
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (po.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot pay a cancelled PO' });

    const amount = Number(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ success: false, message: 'Payment amount must be greater than 0' });
    const due = round2(po.grandTotal - po.amountPaid);
    if (amount > due + 0.01) {
        return res.status(400).json({ success: false, message: `Amount exceeds the outstanding due of ₹${due}` });
    }
    const VALID_MODES = ['cash', 'upi', 'bank-transfer', 'cheque', 'card', 'other'];
    po.payments.push({
        amount: round2(amount),
        mode: VALID_MODES.includes(req.body.mode) ? req.body.mode : 'cash',
        reference: req.body.reference || '',
        paidAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date(),
        recordedBy: req.user._id,
        note: req.body.note || '',
    });
    computePaymentStatus(po);
    await po.save();
    res.json({ success: true, order: po });
}, 'Failed to record payment');

// ── Cancel ────────────────────────────────────────────────────────────
exports.cancel = asyncHandler(async (req, res) => {
    const tf = tenantFilter(req);
    const po = await PurchaseOrder.findOne({ _id: req.params.id, ...tf });
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (po.receipts.length > 0) {
        return res.status(400).json({ success: false, message: 'Cannot cancel — goods already received. Reverse the stock manually if needed.' });
    }
    if (po.amountPaid > 0) {
        return res.status(400).json({ success: false, message: 'Cannot cancel — payments recorded against this PO.' });
    }
    po.status = 'cancelled';
    await po.save();
    res.json({ success: true, order: po });
}, 'Failed to cancel purchase order');

// ── Reports (10.8.3, 10.9) ─────────────────────────────────────────────
// Purchase report: spend by supplier over a window.
exports.purchaseReport = asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const match = { ...tenantFilter(req), ...branchFilter(req), status: { $ne: 'cancelled' }, orderDate: { $gte: since } };
    const bySupplier = await PurchaseOrder.aggregate([
        { $match: match },
        { $group: {
            _id: { supplier: '$supplier', name: '$supplierName' },
            poCount: { $sum: 1 },
            totalSpend: { $sum: '$grandTotal' },
            paid: { $sum: '$amountPaid' },
        } },
        { $project: {
            _id: 0, supplier: '$_id.supplier', supplierName: '$_id.name',
            poCount: 1,
            totalSpend: { $round: ['$totalSpend', 2] },
            paid: { $round: ['$paid', 2] },
            outstanding: { $round: [{ $subtract: ['$totalSpend', '$paid'] }, 2] },
        } },
        { $sort: { totalSpend: -1 } },
    ]);
    const totals = bySupplier.reduce((a, s) => ({
        totalSpend: a.totalSpend + s.totalSpend, paid: a.paid + s.paid, outstanding: a.outstanding + s.outstanding,
    }), { totalSpend: 0, paid: 0, outstanding: 0 });
    res.json({
        success: true,
        report: bySupplier,
        totals: { totalSpend: round2(totals.totalSpend), paid: round2(totals.paid), outstanding: round2(totals.outstanding) },
        period: { days, since },
    });
}, 'Failed to build purchase report');

// Supplier payment report: outstanding + ageing per supplier (10.9).
exports.paymentReport = asyncHandler(async (req, res) => {
    const match = { ...tenantFilter(req), ...branchFilter(req), status: { $ne: 'cancelled' } };
    const rows = await PurchaseOrder.aggregate([
        { $match: { ...match, $expr: { $gt: ['$grandTotal', '$amountPaid'] } } },
        { $group: {
            _id: { supplier: '$supplier', name: '$supplierName' },
            outstanding: { $sum: { $subtract: ['$grandTotal', '$amountPaid'] } },
            unpaidPOs: { $sum: 1 },
            oldest: { $min: '$orderDate' },
        } },
        { $project: {
            _id: 0, supplier: '$_id.supplier', supplierName: '$_id.name',
            outstanding: { $round: ['$outstanding', 2] }, unpaidPOs: 1, oldest: 1,
        } },
        { $sort: { outstanding: -1 } },
    ]);
    const totalOutstanding = round2(rows.reduce((s, r) => s + r.outstanding, 0));
    res.json({ success: true, report: rows, totalOutstanding });
}, 'Failed to build payment report');
