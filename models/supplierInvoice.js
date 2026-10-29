const mongoose = require('mongoose');

/**
 * Supplier (purchase) invoice - Plan 3B.3. `amountPaid` is maintained
 * atomically by the payment endpoint (conditional update), never client-set.
 * Optional `lines` carry billed quantities for the 3-way match report.
 */
const invoiceLineSchema = new mongoose.Schema({
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' },
    name: { type: String, default: '' },
    qty: { type: Number, required: true, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
}, { _id: false });

const supplierInvoiceSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null, index: true },
    invoiceNo: { type: String, required: true, trim: true, maxlength: 60 },
    invoiceDate: { type: Date, required: true },
    businessDate: { type: String, required: true },
    dueDate: { type: Date, required: true },
    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['unpaid', 'partial', 'paid'], default: 'unpaid', index: true },
    lines: { type: [invoiceLineSchema], default: undefined },
    attachments: [{ url: { type: String, maxlength: 500 }, name: { type: String, maxlength: 120 } }],
    notes: { type: String, default: '', maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

supplierInvoiceSchema.index({ restaurant: 1, supplier: 1, invoiceNo: 1 }, { unique: true });
supplierInvoiceSchema.index({ restaurant: 1, status: 1, dueDate: 1 });
supplierInvoiceSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('SupplierInvoice', supplierInvoiceSchema);
