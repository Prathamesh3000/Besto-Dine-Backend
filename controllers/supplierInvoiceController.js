const mongoose = require('mongoose');
const SupplierInvoice = require('../models/supplierInvoice');
const SupplierPayment = require('../models/supplierPayment');
const Supplier = require('../models/supplier');
const PurchaseOrder = require('../models/purchaseOrder');
const LedgerEntry = require('../models/ledgerEntry');
const { recordTenantAudit } = require('../services/tenantAuditService');
const { tenantFilter, tenantId, strictBranchFilter } = require('../utils/tenantScope');
const { resolveBranchId, restaurantTz } = require('../utils/ledgerScope');
const { businessDateOf, isValidYmd } = require('../utils/businessDate');
const { agingBuckets, threeWayMatch, outstandingOf, round2 } = require('../utils/supplierMath');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const METHODS = ['cash', 'upi', 'bank-transfer', 'cheque', 'card', 'other'];
const DAY_MS = 24 * 60 * 60 * 1000;
const validId = (v) => mongoose.isValidObjectId(v);

const withOutstanding = (inv) => ({ ...inv, outstanding: outstandingOf(inv) });

// POST /supplier-invoices
exports.create = asyncHandler(async (req, res) => {
    const b = req.body || {};
    const tf = tenantFilter(req);
    if (!validId(b.supplier)) throw new AppError(400, 'INVALID_SUPPLIER', 'A valid supplier is required');
    const supplier = await Supplier.findOne({ _id: b.supplier, ...tf }).lean();
    if (!supplier) throw new AppError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
    const invoiceNo = String(b.invoiceNo || '').trim();
    if (!invoiceNo) throw new AppError(400, 'INVOICE_NO_REQUIRED', 'Invoice number is required');

    let po = null;
    if (b.purchaseOrder) {
        if (!validId(b.purchaseOrder)) throw new AppError(400, 'INVALID_PO', 'Invalid purchase order');
        po = await PurchaseOrder.findOne({ _id: b.purchaseOrder, ...tf }).select('supplier branch').lean();
        if (!po) throw new AppError(404, 'PO_NOT_FOUND', 'Purchase order not found');
        if (String(po.supplier) !== String(supplier._id)) throw new AppError(400, 'PO_SUPPLIER_MISMATCH', 'That purchase order belongs to a different supplier');
    }

    const subtotal = round2(b.subtotal);
    const tax = round2(b.tax || 0);
    if (!(subtotal >= 0) || b.subtotal === undefined || b.subtotal === '') throw new AppError(400, 'INVALID_AMOUNT', 'Subtotal is required');
    if (tax < 0) throw new AppError(400, 'INVALID_AMOUNT', 'Tax cannot be negative');
    const total = b.total === undefined || b.total === '' ? round2(subtotal + tax) : round2(b.total);
    if (Math.abs(total - (subtotal + tax)) > 0.01) throw new AppError(400, 'TOTAL_MISMATCH', 'Total must equal subtotal + tax');
    if (!(total > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'Invoice total must be greater than 0');

    const invoiceDate = b.invoiceDate ? new Date(b.invoiceDate) : new Date();
    if (Number.isNaN(invoiceDate.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid invoice date');
    const dueDate = b.dueDate ? new Date(b.dueDate) : new Date(invoiceDate.getTime() + (Number(supplier.paymentTermsDays) || 0) * DAY_MS);
    if (Number.isNaN(dueDate.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid due date');

    let lines;
    if (Array.isArray(b.lines) && b.lines.length) {
        lines = b.lines.map((l) => {
            if (!(Number(l.qty) >= 0)) throw new AppError(400, 'INVALID_LINE', 'Each invoice line needs a quantity');
            return {
                inventoryItem: validId(l.inventoryItem) ? l.inventoryItem : undefined,
                name: String(l.name || '').slice(0, 120), qty: Number(l.qty), rate: Number(l.rate) || 0,
            };
        });
    }

    try {
        const invoice = await SupplierInvoice.create({
            restaurant: tenantId(req),
            branch: resolveBranchId(req) || po?.branch || null,
            supplier: supplier._id,
            purchaseOrder: po ? po._id : null,
            invoiceNo, invoiceDate, dueDate,
            businessDate: businessDateOf(invoiceDate, restaurantTz(req)),
            subtotal, tax, total, status: 'unpaid', amountPaid: 0, lines,
            attachments: Array.isArray(b.attachments) ? b.attachments.slice(0, 5).map((a) => ({ url: String(a.url || '').slice(0, 500), name: String(a.name || '').slice(0, 120) })) : [],
            notes: String(b.notes || '').slice(0, 500),
            createdBy: req.user?._id,
        });
        res.status(201).json({ success: true, invoice: withOutstanding(invoice.toObject()) });
    } catch (err) {
        if (err?.code === 11000) throw new AppError(409, 'DUPLICATE_INVOICE', `Invoice ${invoiceNo} already exists for this supplier`);
        throw err;
    }
}, 'Failed to create supplier invoice');

// GET /supplier-invoices?supplier&status&from&to&overdue=true
exports.list = asyncHandler(async (req, res) => {
    const q = req.query;
    const filter = { ...tenantFilter(req), ...strictBranchFilter(req) };
    if (q.supplier && validId(q.supplier)) filter.supplier = q.supplier;
    if (['unpaid', 'partial', 'paid'].includes(q.status)) filter.status = q.status;
    if (q.from || q.to) {
        if ((q.from && !isValidYmd(String(q.from))) || (q.to && !isValidYmd(String(q.to)))) throw new AppError(400, 'INVALID_DATE', 'from / to must be YYYY-MM-DD');
        filter.businessDate = { ...(q.from ? { $gte: String(q.from) } : {}), ...(q.to ? { $lte: String(q.to) } : {}) };
    }
    if (q.overdue === 'true') { filter.status = { $in: ['unpaid', 'partial'] }; filter.dueDate = { $lt: new Date() }; }
    const invoices = await SupplierInvoice.find(filter).populate('supplier', 'name code').sort({ invoiceDate: -1 }).limit(300).lean();
    res.json({ success: true, invoices: invoices.map(withOutstanding) });
}, 'Failed to list supplier invoices');

// GET /supplier-invoices/:id (with its payments)
exports.getOne = asyncHandler(async (req, res) => {
    const tf = tenantFilter(req);
    if (!validId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
    const invoice = await SupplierInvoice.findOne({ _id: req.params.id, ...tf }).populate('supplier', 'name code').lean();
    if (!invoice) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
    const payments = await SupplierPayment.find({ invoice: invoice._id, ...tf }).sort({ date: -1 }).lean();
    // `locked`: the invoice is already in the ledger, so its amounts and date can no longer be edited.
    res.json({ success: true, invoice: withOutstanding(invoice), payments, locked: await isLedgerPosted(req, invoice._id) });
}, 'Failed to load supplier invoice');

// Ledger lines are append-only and never re-posted when a source changes, so an invoice that
// has been posted must not have its amounts or date edited (the books would silently disagree).
const isLedgerPosted = async (req, invoiceId) => !!(await LedgerEntry.exists({
    restaurant: tenantId(req), 'ref.type': 'supplier-invoice', 'ref.id': String(invoiceId),
}));

const sameDay = (a, b) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);

// PATCH /supplier-invoices/:id { invoiceNo?, dueDate?, notes?, invoiceDate?, subtotal?, tax? }
// invoiceNo / dueDate / notes are always editable. subtotal / tax / invoiceDate only while the invoice
// is not in the ledger, and the new total can never drop below what has already been paid.
exports.update = asyncHandler(async (req, res) => {
    const b = req.body || {};
    const tf = tenantFilter(req);
    if (!validId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
    const existing = await SupplierInvoice.findOne({ _id: req.params.id, ...tf }).lean();
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');

    const set = {};
    if (b.invoiceNo !== undefined) {
        const invoiceNo = String(b.invoiceNo || '').trim();
        if (!invoiceNo) throw new AppError(400, 'INVOICE_NO_REQUIRED', 'Invoice number is required');
        set.invoiceNo = invoiceNo.slice(0, 60);
    }
    if (b.dueDate !== undefined && b.dueDate !== '') {
        const dueDate = new Date(b.dueDate);
        if (Number.isNaN(dueDate.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid due date');
        set.dueDate = dueDate;
    }
    if (b.notes !== undefined) set.notes = String(b.notes || '').slice(0, 500);

    let invoiceDate = null;
    if (b.invoiceDate !== undefined && b.invoiceDate !== '') {
        invoiceDate = new Date(b.invoiceDate);
        if (Number.isNaN(invoiceDate.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid invoice date');
    }
    const subtotal = b.subtotal !== undefined && b.subtotal !== '' ? round2(b.subtotal) : existing.subtotal;
    const tax = b.tax !== undefined && b.tax !== '' ? round2(b.tax) : existing.tax;
    const dateChanged = invoiceDate && !sameDay(invoiceDate, existing.invoiceDate);
    const moneyChanged = subtotal !== existing.subtotal || tax !== existing.tax;

    if (dateChanged || moneyChanged) {
        if (await isLedgerPosted(req, existing._id)) {
            throw new AppError(409, 'LEDGER_POSTED', 'This invoice is already in the ledger, so its amounts and date can no longer be edited. You can still change the invoice number, due date and notes.');
        }
        if (!(subtotal >= 0) || !(tax >= 0)) throw new AppError(400, 'INVALID_AMOUNT', 'Amounts cannot be negative');
        const total = round2(subtotal + tax);
        if (!(total > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'Invoice total must be greater than 0');
        if (total < existing.amountPaid - 0.005) {
            throw new AppError(400, 'BELOW_PAID', `The total cannot be less than the ${existing.amountPaid} already paid`, { amountPaid: existing.amountPaid });
        }
        Object.assign(set, { subtotal, tax, total });
        set.status = existing.amountPaid >= total - 0.005 ? 'paid' : (existing.amountPaid > 0 ? 'partial' : 'unpaid');
        if (dateChanged) {
            set.invoiceDate = invoiceDate;
            set.businessDate = businessDateOf(invoiceDate, restaurantTz(req));
        }
    }
    if (!Object.keys(set).length) throw new AppError(400, 'NOTHING_TO_UPDATE', 'No changes to save');

    let saved;
    try {
        // Conditional on amountPaid still being what we validated against, so a payment that lands
        // in the meantime cannot leave the invoice with a total below its paid amount.
        saved = await SupplierInvoice.findOneAndUpdate(
            { _id: existing._id, ...tf, amountPaid: existing.amountPaid },
            { $set: set },
            { returnDocument: 'after' },
        ).populate('supplier', 'name code');
    } catch (err) {
        if (err?.code === 11000) throw new AppError(409, 'DUPLICATE_INVOICE', `Invoice ${set.invoiceNo} already exists for this supplier`);
        throw err;
    }
    if (!saved) throw new AppError(409, 'CONFLICT', 'The invoice changed while you were editing it. Reload and retry.');

    const pick = (o) => Object.fromEntries(Object.keys(set).map((k) => [k, o[k]]));
    try {
        recordTenantAudit(req, {
            action: 'other', entityType: 'SupplierInvoice', entityId: String(existing._id),
            summary: `Supplier invoice ${existing.invoiceNo} edited (${Object.keys(set).join(', ')})`,
            before: pick(existing), after: pick(saved.toObject()),
        });
    } catch { /* audit must never break the edit */ }
    res.json({ success: true, invoice: withOutstanding(saved.toObject()) });
}, 'Failed to update supplier invoice');

// POST /supplier-invoices/:id/payments { amount, method?, date?, reference? }
// The invoice's amountPaid is advanced by ONE conditional update that only matches while
// amountPaid + amount <= total, so two concurrent payments can never overpay.
exports.recordPayment = asyncHandler(async (req, res) => {
    const b = req.body || {};
    const tf = tenantFilter(req);
    if (!validId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
    const amount = round2(b.amount);
    if (!(amount > 0)) throw new AppError(400, 'INVALID_AMOUNT', 'Payment amount must be greater than 0');
    const date = b.date ? new Date(b.date) : new Date();
    if (Number.isNaN(date.getTime())) throw new AppError(400, 'INVALID_DATE', 'Invalid payment date');

    const paid = { $round: [{ $add: ['$amountPaid', amount] }, 2] };
    const invoice = await SupplierInvoice.findOneAndUpdate(
        {
            _id: req.params.id, ...tf,
            $expr: { $lte: [{ $add: ['$amountPaid', amount] }, { $add: ['$total', 0.005] }] },
        },
        [{ $set: { amountPaid: paid, status: { $cond: [{ $gte: [paid, { $subtract: ['$total', 0.005] }] }, 'paid', 'partial'] } } }],
        // Mongoose 9 rejects an aggregation-pipeline update unless it is declared.
        { returnDocument: 'after', updatePipeline: true },
    );
    if (!invoice) {
        const existing = await SupplierInvoice.findOne({ _id: req.params.id, ...tf }).lean();
        if (!existing) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
        throw new AppError(400, 'EXCEEDS_OUTSTANDING', `Payment exceeds the outstanding balance of ${outstandingOf(existing)}`, { outstanding: outstandingOf(existing) });
    }
    try {
        const payment = await SupplierPayment.create({
            restaurant: tenantId(req), branch: invoice.branch || null, invoice: invoice._id, supplier: invoice.supplier,
            amount, method: METHODS.includes(b.method) ? b.method : 'cash', date,
            businessDate: businessDateOf(date, restaurantTz(req)),
            reference: String(b.reference || '').slice(0, 80), recordedBy: req.user?._id,
        });
        try {
            recordTenantAudit(req, {
                action: 'other', entityType: 'SupplierInvoice', entityId: String(invoice._id),
                summary: `Payment of ${amount} (${payment.method}) recorded on supplier invoice ${invoice.invoiceNo}`,
                after: { amount, method: payment.method, reference: payment.reference, status: invoice.status },
            });
        } catch { /* audit must never break the payment */ }
        res.status(201).json({ success: true, payment, invoice: withOutstanding(invoice.toObject()) });
    } catch (err) {
        // Give the reserved amount back so the invoice never shows money that has no payment row.
        const back = { $max: [0, { $round: [{ $subtract: ['$amountPaid', amount] }, 2] }] };
        await SupplierInvoice.updateOne({ _id: invoice._id, ...tf }, [{
            $set: {
                amountPaid: back,
                status: { $cond: [{ $lte: [back, 0] }, 'unpaid', { $cond: [{ $gte: [back, { $subtract: ['$total', 0.005] }] }, 'paid', 'partial'] }] },
            },
        }], { updatePipeline: true });
        throw err;
    }
}, 'Failed to record supplier payment');

// GET /supplier-invoices/reports/outstanding?asOf=YYYY-MM-DD
exports.outstanding = asyncHandler(async (req, res) => {
    let asOf = new Date();
    if (req.query.asOf) {
        if (!isValidYmd(String(req.query.asOf))) throw new AppError(400, 'INVALID_DATE', 'asOf must be YYYY-MM-DD');
        asOf = new Date(`${req.query.asOf}T23:59:59Z`);
    }
    const invoices = await SupplierInvoice.find({
        ...tenantFilter(req), ...strictBranchFilter(req), status: { $in: ['unpaid', 'partial'] },
    }).populate('supplier', 'name code').limit(5000).lean();
    res.json({ success: true, ...agingBuckets(invoices, asOf) });
}, 'Failed to load outstanding report');

// GET /supplier-invoices/reports/three-way-match?purchaseOrder&supplier&issuesOnly=true&tolerance=1
exports.threeWay = asyncHandler(async (req, res) => {
    const q = req.query;
    const tf = tenantFilter(req);
    const poFilter = { ...tf, ...strictBranchFilter(req), status: { $in: ['ordered', 'partially-received', 'received'] } };
    if (q.purchaseOrder && validId(q.purchaseOrder)) poFilter._id = q.purchaseOrder;
    if (q.supplier && validId(q.supplier)) poFilter.supplier = q.supplier;
    const pos = await PurchaseOrder.find(poFilter).sort({ orderDate: -1 }).limit(100).lean();
    const invoices = pos.length
        ? await SupplierInvoice.find({ ...tf, purchaseOrder: { $in: pos.map((p) => p._id) } }).lean()
        : [];
    const byPo = new Map();
    for (const inv of invoices) {
        const k = String(inv.purchaseOrder);
        if (!byPo.has(k)) byPo.set(k, []);
        byPo.get(k).push(inv);
    }
    const tolerance = Number.isFinite(Number(q.tolerance)) && q.tolerance !== undefined ? Number(q.tolerance) : 1;
    let results = pos.map((po) => threeWayMatch(po, byPo.get(String(po._id)) || [], { tolerance }));
    if (q.issuesOnly === 'true') results = results.filter((r) => r.status === 'mismatch' || r.status === 'no-invoice');
    res.json({ success: true, results, summary: {
        total: results.length,
        matched: results.filter((r) => r.status === 'matched').length,
        mismatch: results.filter((r) => r.status === 'mismatch').length,
        noInvoice: results.filter((r) => r.status === 'no-invoice').length,
        pending: results.filter((r) => r.status === 'pending').length,
    } });
}, 'Failed to run 3-way match');
