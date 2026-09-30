const mongoose = require('mongoose');

/**
 * Supplier / Vendor master (Inventory spec 10.3.2).
 *
 * A dedicated vendor record so purchase orders, GRNs and supplier
 * payments can reference a real entity instead of the loose
 * `{ name, contact }` blob embedded on each inventory item. Tenant- and
 * branch-scoped exactly like Inventory.
 *
 * Outstanding balance is NOT stored here — it is derived on read from
 * the supplier's purchase orders (sum of unpaid/partial PO totals) so it
 * can never drift from the source of truth.
 */
const supplierSchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // null = tenant-level (shared); set = owned by a specific branch.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
    // Human-readable per-tenant serial: SUP-001, SUP-002, …
    code: { type: String, required: true },
    name: {
        type: String,
        required: [true, 'Please provide supplier name'],
        trim: true,
    },
    contactPerson: { type: String, default: '', trim: true },
    mobile: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    gstNumber: { type: String, default: '', trim: true, uppercase: true },
    address: { type: String, default: '', trim: true, maxlength: 500 },
    // Credit period in days (0 = cash / pay-on-delivery).
    paymentTermsDays: { type: Number, default: 0, min: 0 },
    // What this supplier typically provides — free-text tags for filtering.
    categories: [{ type: String, trim: true }],
    notes: { type: String, default: '', maxlength: 1000 },
    isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

// Tenant-scoped uniqueness on the serial + a case-insensitive name guard
// handled in the controller (so two branches can share a vendor name).
supplierSchema.index({ restaurant: 1, code: 1 }, { unique: true });
supplierSchema.index({ name: 'text', contactPerson: 'text' });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
supplierSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Supplier', supplierSchema);
