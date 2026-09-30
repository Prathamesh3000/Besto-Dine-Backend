const mongoose = require('mongoose');

/**
 * PlanChangeRequest — a Super Admin-recorded request to change an
 * existing tenant's subscription plan, awaiting offline payment
 * confirmation before the plan is actually swapped on the Restaurant.
 *
 * Workflow:
 *   1. Tenant calls/emails the operator and asks to change plan.
 *   2. Super Admin opens the tenant detail page and creates a
 *      PlanChangeRequest with the requested plan + price + note.
 *   3. Request lands in `status: 'pending'` and surfaces on the
 *      Pending Approvals page.
 *   4. When the operator receives payment (cash / online / bank
 *      transfer), they click "Approve" — the existing assignPlan
 *      flow runs and the request is marked `status: 'approved'`.
 *   5. If the tenant changes their mind, the operator clicks
 *      "Reject" with a reason and the request closes.
 *
 * The current plan snapshot at the time of creation is stored so
 * that any later admin viewing the request can see exactly what
 * the swap was from → to, even if the tenant's plan was reassigned
 * in some other way before the request was processed.
 */
const planChangeRequestSchema = new mongoose.Schema({
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },

    requestedPlan: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubscriptionPlan',
        required: true,
    },
    requestedPlanName: { type: String, default: '' },
    requestedPlanPrice: { type: Number, default: 0 },

    // Snapshot of the tenant's plan at the time the request was
    // created — useful for "from → to" rendering on the review UI.
    currentPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
    currentPlanName: { type: String, default: '' },

    // Free text from the operator: how/when payment will arrive,
    // any conditions (e.g. "wait until 1st of next month").
    note: { type: String, default: '', maxlength: 1000 },

    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'cancelled'],
        default: 'pending',
        index: true,
    },

    // Where the request originated from. Operator-created requests
    // come from the Super Admin tenant-detail UI (used when a tenant
    // calls / emails to switch plans). Tenant-created requests come
    // from the self-service /admin/subscription page (used for
    // downgrade requests — the upgrade flow goes through Razorpay
    // directly and never creates a PlanChangeRequest).
    requestSource: {
        type: String,
        enum: ['operator', 'tenant'],
        default: 'operator',
        index: true,
    },

    // User who created the request. For 'operator' requests this is
    // a Super Admin. For 'tenant' requests this is the tenant owner.
    requestedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requestedByEmail: { type: String, default: '' },

    // Reviewer fields — set once the request is approved or rejected.
    reviewedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByEmail:  { type: String, default: '' },
    reviewedAt:       { type: Date },
    rejectedReason:   { type: String, default: '', maxlength: 500 },
}, { timestamps: true });

// Pending requests by tenant — used by the Restaurant Detail page to
// surface "1 plan change pending" without scanning the whole table.
planChangeRequestSchema.index({ restaurant: 1, status: 1, createdAt: -1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
planChangeRequestSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('PlanChangeRequest', planChangeRequestSchema);
