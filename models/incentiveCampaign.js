const mongoose = require('mongoose');

/**
 * IncentiveCampaign — "earn ₹X for every <item> you serve" (CAPTAIN_FLOW §8-9,
 * CAPTAIN_FLOW_UPDATE_PLAN Phase 5).
 *
 * Only the flat per-item rule exists today (`rule.type: 'per_item'`); the
 * `rule` sub-document is the extension point for tiers / bundles later.
 *
 * Status is DERIVED, never stored: `paused` is the one manual switch, the
 * rest comes from the dates (see utils/incentiveStatus / service).
 *   paused flag            → 'paused'
 *   now < startDate        → 'upcoming'
 *   now > endDate          → 'ended'
 *   otherwise              → 'active'
 *
 * Semantics (documented decisions):
 *   - branch null  = the campaign runs in every branch of the tenant.
 *   - maxPerStaffPerDay = max ITEM QUANTITY one staff member can earn on per
 *     business day (tenant timezone). 0 = no limit.
 *   - budgetCap = max total ₹ the campaign may pay (pending + confirmed
 *     entries; reversed entries free their budget again). 0 = no limit.
 *   - stacking 'stack' (default, the safe one: nobody loses money by a
 *     second campaign being created) lets several campaigns pay on the same
 *     item line. 'exclusive' makes this campaign win: when an exclusive
 *     campaign matches a line, only the exclusive campaign with the highest
 *     rate pays on it.
 */
const incentiveCampaignSchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    items: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }], default: [] },
    rule: {
        type: { type: String, enum: ['per_item'], default: 'per_item' },
        ratePerItem: { type: Number, required: true, min: 0 },
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    paused: { type: Boolean, default: false },
    staffRoles: {
        type: [{ type: String, enum: ['captain', 'waiter'] }],
        default: ['captain', 'waiter'],
    },
    maxPerStaffPerDay: { type: Number, default: 0, min: 0 },
    budgetCap: { type: Number, default: 0, min: 0 },
    stacking: { type: String, enum: ['stack', 'exclusive'], default: 'stack' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

incentiveCampaignSchema.index({ restaurant: 1, endDate: -1 });

incentiveCampaignSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('IncentiveCampaign', incentiveCampaignSchema);
