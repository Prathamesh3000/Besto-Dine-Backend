const mongoose = require('mongoose');

/** Payment against a SupplierInvoice (Plan 3B.3). Append-only. */
const supplierPaymentSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierInvoice', required: true, index: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ['cash', 'upi', 'bank-transfer', 'cheque', 'card', 'other'], default: 'cash' },
    date: { type: Date, default: Date.now },
    businessDate: { type: String, required: true },
    reference: { type: String, default: '', maxlength: 80 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

supplierPaymentSchema.index({ restaurant: 1, businessDate: 1 });
supplierPaymentSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('SupplierPayment', supplierPaymentSchema);
