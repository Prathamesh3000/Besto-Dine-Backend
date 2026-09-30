const mongoose = require('mongoose');

/**
 * Purchase Order + Goods Receipt + Supplier Payment (Inventory spec
 * 10.4 & 10.9). One document tracks the whole procurement lifecycle for
 * a single order to a supplier:
 *
 *   draft → ordered → (partially-received) → received          [GRN]
 *                                          → paymentStatus      [payments]
 *
 * GRNs (goods receipts) are embedded as `receipts[]`. Each receipt
 * records what physically arrived against the ordered lines and, on
 * save, increments the linked Inventory item's stock (handled in the
 * controller, not here — the model stays a dumb data holder).
 *
 * Payments are embedded as `payments[]`. `paymentStatus` is derived from
 * amountPaid vs grandTotal.
 */

const poLineSchema = new mongoose.Schema({
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
    name: { type: String, required: true },       // snapshot at PO time
    unit: { type: String, required: true },
    orderedQty: { type: Number, required: true, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 }, // running total across GRNs
    rate: { type: Number, required: true, min: 0 },    // purchase rate per unit
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },
}, { _id: true });

const grnLineSchema = new mongoose.Schema({
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
    name: { type: String, default: '' },
    qty: { type: Number, required: true, min: 0 },     // received now
    batchNumber: { type: String, default: '' },
    expiryDate: { type: Date },
}, { _id: false });

const receiptSchema = new mongoose.Schema({
    grnNumber: { type: String, required: true },       // GRN-001 per PO
    lines: [grnLineSchema],
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedAt: { type: Date, default: Date.now },
    note: { type: String, default: '' },
}, { _id: true });

const paymentSchema = new mongoose.Schema({
    amount: { type: Number, required: true, min: 0 },
    mode: { type: String, enum: ['cash', 'upi', 'bank-transfer', 'cheque', 'card', 'other'], default: 'cash' },
    reference: { type: String, default: '' },          // txn id / cheque no
    paidAt: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, default: '' },
}, { _id: true });

const purchaseOrderSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    poNumber: { type: String, required: true },        // PO-001 per tenant
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    supplierName: { type: String, default: '' },       // snapshot for fast lists
    orderDate: { type: Date, default: Date.now },
    expectedDate: { type: Date },
    lines: [poLineSchema],
    // Money — computed in the controller on every save from lines.
    subTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['draft', 'ordered', 'partially-received', 'received', 'cancelled'],
        default: 'ordered',
        index: true,
    },
    receipts: [receiptSchema],
    payments: [paymentSchema],
    amountPaid: { type: Number, default: 0 },
    paymentStatus: {
        type: String,
        enum: ['unpaid', 'partial', 'paid'],
        default: 'unpaid',
        index: true,
    },
    // Optional supplier invoice reference / upload (10.9).
    invoiceNumber: { type: String, default: '' },
    invoiceUrl: { type: String, default: '' },
    notes: { type: String, default: '', maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

purchaseOrderSchema.index({ restaurant: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ restaurant: 1, status: 1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
purchaseOrderSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
