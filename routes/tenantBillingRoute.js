const express = require('express');
const router = express.Router();

const { protect, adminExclusive } = require('../middlewares/authMiddleware');
const {
    getCurrentSubscription,
    getAvailablePlans,
    upgradePlan,
    verifyUpgradePayment,
    syncFromRazorpay,
    listInvoices,
    downloadInvoicePdf,
    requestDowngrade,
    getDowngradeRequest,
    cancelDowngradeRequest,
    cancelScheduledDowngrade,
    cancelPendingUpgrade,
} = require('../controllers/tenantBillingController');

/**
 * Tenant self-service billing routes (Phase 5 step 4).
 *
 * All endpoints require:
 *   1. `protect`  — valid JWT for a staff user
 *   2. `adminOnly` — only the tenant's admin role can trigger a plan
 *                    change. Captains / waiters / chefs never see this.
 *   3. The globally-mounted `attachTenant` middleware (server.js)
 *      populates req.restaurant from req.user.restaurant.
 *
 * Controllers scope every query to req.restaurant._id so a tenant
 * admin can only ever touch their OWN tenant, regardless of what
 * they put in the request body.
 */
router.get('/current',         protect, adminExclusive, getCurrentSubscription);
router.get('/plans',           protect, adminExclusive, getAvailablePlans);
router.post('/upgrade',        protect, adminExclusive, upgradePlan);
// ADM-106 — frontend-driven confirmation for Orders-API fallback
// upgrades. Calls applyPaidPlanUpgrade so the invoice is created even
// when Razorpay's payment.captured webhook can't reach the server
// (local dev, missing webhook secret, etc.). Idempotent: the webhook
// remains the safety net for tab-close-after-pay cases.
router.post('/upgrade/verify', protect, adminExclusive, verifyUpgradePayment);

// Abandon an unpaid upgrade (declined card, closed checkout). Clears the
// stash and cancels the Razorpay subscription; the live plan is untouched.
router.delete('/upgrade/pending', protect, adminExclusive, cancelPendingUpgrade);
// Recovery path when the Razorpay webhook can't reach the server.
// Pulls subscription state + payments directly from Razorpay's API
// and materialises any missing SubscriptionInvoice rows.
router.post('/sync',           protect, adminExclusive, syncFromRazorpay);

// Tenant-initiated downgrade requests — Super Admin approves /
// rejects via the existing /superadmin/plan-change-requests/*
// endpoints, which apply the plan automatically on approval.
router.post('/downgrade-request',       protect, adminExclusive, requestDowngrade);
router.get('/downgrade-request',        protect, adminExclusive, getDowngradeRequest);
router.delete('/downgrade-request/:id', protect, adminExclusive, cancelDowngradeRequest);

// Cancel an already-APPROVED scheduled downgrade (tenant changed
// mind before cycle-end). Razorpay cancellation can't be undone, so
// this only clears the local schedule — the old sub still closes
// on the original cycle end date.
router.post('/scheduled-downgrade/cancel', protect, adminExclusive, cancelScheduledDowngrade);

// Phase 5 step 5 — subscription invoice list + PDF download.
// Populated automatically by the Razorpay subscription.charged
// webhook. adminExclusive: only the restaurant owner manages billing.
router.get('/invoices',               protect, adminExclusive, listInvoices);
router.get('/invoices/:id/download',  protect, adminExclusive, downloadInvoicePdf);

module.exports = router;
