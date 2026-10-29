const mongoose = require('mongoose');

// Sequential bill numbers (Phase 3 "Save Bill"). One document per
// { restaurant, branch, financialYear }; utils/billWorkspace.nextBillNo bumps
// `seq` with a single atomic findOneAndUpdate($inc, upsert) so two saves at
// the same instant never share a number. The series restarts every Indian
// financial year (1 April - 31 March, e.g. '2026-27') per branch; unlike the
// KOT ticket / token counters it does NOT reset daily and never expires
// (branch null = tenant-level orders).
//
// Pre-FY documents have no `financialYear`; nextBillNo adopts them (once) as
// the series of the first FY it sees, so already-issued numbers are untouched.
const billCounterSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    financialYear: { type: String, default: null },
    seq: { type: Number, default: 0 },
}, { collection: 'bill_counters', timestamps: false });

// The legacy unique index was { restaurant, branch } ('bill_counter_per_branch');
// it must be dropped or a second FY could never be inserted (nextBillNo does
// this best-effort).
billCounterSchema.index(
    { restaurant: 1, branch: 1, financialYear: 1 },
    { unique: true, name: 'bill_counter_per_branch_fy' },
);

module.exports = mongoose.model('BillCounter', billCounterSchema);
