const mongoose = require('mongoose');

// Per-branch, per-day counter behind the customer-facing token numbers
// of token-number mode (OPERATIONS_CONTROL_PANEL_DESIGN.md §12.2 —
// operations profile `tables.useTables:false`). A dine-in order placed
// without a table gets "T-001", "T-002", … for the day; the sequence
// starts again the next (server-local) day.
//
// One document per { restaurant, branch, day }. utils/orderToken.js
// bumps `seq` with a single atomic findOneAndUpdate($inc, upsert), so
// concurrent orders can never share a token. Rows expire three days
// after they were created (TTL index) — the counter for a past day is
// never read again.
const orderTokenCounterSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    // null = tenant-level (an order with no branch).
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    // 'YYYY-MM-DD' in the server's local time (same day boundary the
    // live-orders / kitchen "today" windows use).
    day: { type: String, required: true },
    seq: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
}, { collection: 'order_token_counters', timestamps: false });

orderTokenCounterSchema.index({ restaurant: 1, branch: 1, day: 1 }, { unique: true, name: 'token_counter_per_branch_day' });
orderTokenCounterSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60, name: 'token_counter_ttl' });

module.exports = mongoose.model('OrderTokenCounter', orderTokenCounterSchema);
