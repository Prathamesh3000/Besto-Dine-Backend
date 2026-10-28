const mongoose = require('mongoose');

// Per-branch, per-day counter behind the KOT ticket number printed on
// kitchen slips ("KOT #12"). One document per { restaurant, branch, day };
// utils/kotRounds.nextTicketNo bumps `seq` with a single atomic
// findOneAndUpdate($inc, upsert), so two sends at the same instant never
// share a ticket. Same pattern as models/orderTokenCounter.js; rows expire
// after three days (the past day's counter is never read again).
const kotTicketCounterSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    day: { type: String, required: true }, // 'YYYY-MM-DD'
    seq: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
}, { collection: 'kot_ticket_counters', timestamps: false });

kotTicketCounterSchema.index({ restaurant: 1, branch: 1, day: 1 }, { unique: true, name: 'kot_counter_per_branch_day' });
kotTicketCounterSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60, name: 'kot_counter_ttl' });

module.exports = mongoose.model('KotTicketCounter', kotTicketCounterSchema);
