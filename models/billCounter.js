const mongoose = require('mongoose');

// Sequential bill numbers (Phase 3 "Save Bill"). One document per
// { restaurant, branch }; utils/billWorkspace.nextBillNo bumps `seq` with a
// single atomic findOneAndUpdate($inc, upsert) so two saves at the same
// instant never share a number. Unlike the KOT ticket / token counters this
// does NOT reset daily and never expires — a bill number is a running
// series per branch (branch null = tenant-level orders).
const billCounterSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    seq: { type: Number, default: 0 },
}, { collection: 'bill_counters', timestamps: false });

billCounterSchema.index({ restaurant: 1, branch: 1 }, { unique: true, name: 'bill_counter_per_branch' });

module.exports = mongoose.model('BillCounter', billCounterSchema);
