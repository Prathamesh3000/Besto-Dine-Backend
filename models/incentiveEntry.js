const mongoose = require('mongoose');

/**
 * IncentiveEntry — the incentive ledger. One row per (order item line,
 * campaign). Written by services/incentiveService.accrueForOrder.
 *
 *   pending   exactly one of "item served" / "order paid" has happened
 *   confirmed both have happened (D3: served AND paid)
 *   reversed  the order was cancelled / refunded / the line removed; kept for
 *             audit and never revived (terminal)
 *
 * The unique (order, itemKey, campaign) index makes accrual idempotent:
 * duplicate payment callbacks, retries and concurrent hooks cannot create a
 * second row for the same line + campaign. `itemKey` is the order item
 * subdocument _id as a string.
 *
 * `day` is the business day (tenant timezone, YYYY-MM-DD) the entry was
 * created on; reports, per-day caps and the "today" totals key off it.
 */
const incentiveEntrySchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'IncentiveCampaign', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderId: { type: String, default: '' },      // human reference, e.g. ORD-0001
    billNo: { type: String, default: '' },
    itemKey: { type: String, required: true },
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    itemName: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    staffRole: { type: String, enum: ['captain', 'waiter'], required: true },
    state: { type: String, enum: ['pending', 'confirmed', 'reversed'], default: 'pending' },
    day: { type: String, required: true },
    servedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    reversedAt: { type: Date, default: null },
    reverseReason: { type: String, default: '', maxlength: 300 },
}, { timestamps: true });

incentiveEntrySchema.index({ order: 1, itemKey: 1, campaign: 1 }, { unique: true, name: 'incentive_entry_once' });
incentiveEntrySchema.index({ restaurant: 1, staff: 1, day: 1 });
incentiveEntrySchema.index({ restaurant: 1, day: 1, branch: 1 });
incentiveEntrySchema.index({ restaurant: 1, campaign: 1, state: 1 });

incentiveEntrySchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('IncentiveEntry', incentiveEntrySchema);
