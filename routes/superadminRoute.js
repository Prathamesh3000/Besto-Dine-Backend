const express = require('express');
const router = express.Router();
const {
    validate,
    body,
    objectIdParam,
    isObjectIdLike,
} = require('../middlewares/validate');

const {
    protect,
    superAdminOnly,
    superAdminFull,
} = require('../middlewares/authMiddleware');

const ctrl = require('../controllers/superadminController');
const blog = require('../controllers/blogController');
// getTenantFallbackStats removed — strict mode is default since Phase 3
// step 5 and the counter is always zero in normal operation.
const { checkDormantTenants } = require('../utils/alerts');
const backup = require('../controllers/tenantBackupController');
const upload = require('../middlewares/uploadMiddleware');

// ─── Validation (BUGS_REPORT #33) ─────────────────────────────────────
// Shared `validate([chains])` from middlewares/validate.js — responds
// 400 { success:false, message, errors } on the first failing rule.
// New chains mirror what superadminController already accepts and never
// mutate req (the controller does its own trimming). The pre-existing
// reject/blog chains keep their `.trim()` so behaviour is unchanged.
const restaurantId = objectIdParam('id', 'Invalid restaurant id');
const planIdParam  = objectIdParam('id', 'Invalid plan id');
const leadId       = objectIdParam('id', 'Invalid lead id');
const requestId    = objectIdParam('requestId', 'Invalid request id');
const blogId       = objectIdParam('id', 'Invalid post id');

// Non-empty string (checked on the trimmed value, without trimming req).
const requiredText = (field, message) =>
    body(field).custom((v) => typeof v === 'string' && v.trim() !== '').withMessage(message);

// Optional string: undefined / null / '' pass (controller treats falsy
// as absent); anything else must be a string within a generous cap.
// The controller keeps its own tighter, field-specific length messages.
const optText = (field, max = 1000) =>
    body(field).optional({ values: 'falsy' })
        .isString().withMessage(`${field} must be text`).bail()
        .isLength({ max }).withMessage(`${field} cannot exceed ${max} characters`);

const isNumberish = (v) =>
    (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(+v);

// Optional number: undefined / null / '' pass (the controller falls
// back to a default for those); otherwise must be finite and in range.
const optNumber = (field, { min, max } = {}, message) =>
    body(field).optional({ values: 'null' })
        .custom((v) => v === '' || (isNumberish(v)
            && (min === undefined || +v >= min)
            && (max === undefined || +v <= max)))
        .withMessage(message || `${field} must be a number`);

const optObject = (field) =>
    body(field).optional({ values: 'null' })
        .custom((v) => typeof v === 'object' && !Array.isArray(v))
        .withMessage(`${field} must be an object`);

const optBool = (field) =>
    body(field).optional({ values: 'null' }).isBoolean().withMessage(`${field} must be true or false`);

const BILLING_CYCLES  = ['monthly', 'quarterly', 'yearly'];                             // SubscriptionPlan enum
// Same pattern as superadminController's EMAIL_REGEX (checked on the
// trimmed value, which is what the controller stores).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'];     // createRestaurant

const createRestaurantRules = validate([
    requiredText('name', 'Restaurant name is required'),
    body('contactEmail')
        .custom((v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim()))
        .withMessage('A valid contact email is required'),
    requiredText('ownerName', 'Owner name is required'),
    body('planId')
        .exists({ values: 'falsy' }).withMessage('Plan id is required').bail()
        .custom(isObjectIdLike).withMessage('A valid subscription plan is required'),
    // Required-ness / format of these stays in the controller (its
    // field-specific messages are shown inline in CreateRestaurantModal);
    // here we only guarantee they are strings so `.trim()` can't 500.
    optText('contactPhone', 100),
    optText('addressLine1', 1000),
    optText('addressLine2', 1000),
    optText('city', 500),
    optText('state', 500),
    body('pincode').optional({ values: 'falsy' })
        .custom((v) => typeof v === 'string' || typeof v === 'number')
        .withMessage('Pincode must be a 6-digit number'),
    optText('country', 500),
    optText('legalBusinessName', 500),
    optText('fssaiLicense', 100),
    optText('gstin', 100),
    optText('pan', 100),
    optText('timezone', 100),
    optNumber('trialDays', { min: 0, max: 3650 }, 'Trial days must be between 0 and 3650'),
    optNumber('priceOverride', { min: 0 }, 'Price must be a non-negative number'),
    optBool('paymentReceived'),
    body('paymentMethod').optional({ values: 'falsy' }).isIn(PAYMENT_METHODS)
        .withMessage('Invalid payment method'),
    optText('paymentNote', 5000),
]);

// Fields common to plan create + update (types / enums / ranges from
// the SubscriptionPlan model). A bad value here used to reach
// plan.save() and come back as a generic 500 "Failed to update plan".
const planFieldChains = () => [
    optText('description', 500),
    body('billingCycle').optional({ values: 'falsy' }).isIn(BILLING_CYCLES)
        .withMessage(`Billing cycle must be one of: ${BILLING_CYCLES.join(', ')}`),
    optNumber('trialDays', { min: 0, max: 3650 }, 'Trial days must be between 0 and 3650'),
    optNumber('sortOrder', {}, 'Sort order must be a number'),
    optObject('limits'),
    optObject('features'),
    optBool('isPublic'),
    optBool('highlight'),
];

const createPlanRules = validate([
    requiredText('name', 'Plan name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a non-negative number'),
    optText('slug', 200),
    ...planFieldChains(),
]);

const updatePlanRules = validate([
    planIdParam,
    body('name').optional()
        .custom((v) => typeof v === 'string' && v.trim() !== '').withMessage('Plan name is required'),
    body('price').optional()
        .custom((v) => isNumberish(v) && +v >= 0).withMessage('Price must be a non-negative number'),
    optBool('isActive'),
    ...planFieldChains(),
]);

// All routes require an authenticated super admin. Mutating routes
// additionally require the `full` sub-level — `support` superadmins are
// limited to read-only.
router.use(protect, superAdminOnly);

// ═══════════════ ANALYTICS & AUDIT (read-only) ═══════════════════════════
router.get('/analytics',  ctrl.getPlatformAnalytics);
router.get('/audit-logs', ctrl.listAuditLogs);
// Phase 4 step 3 — CSV export of audit entries. Route is registered
// BEFORE any /audit-logs/:id style route (there isn't one right now,
// but spelling out the order prevents a future regression).
router.get('/audit-logs/export', ctrl.exportAuditLogs);
// Phase 7.5 — purge expired audit entries based on per-plan
// retention windows. Supports { dryRun: true } for previewing
// counts without deleting. superAdminFull required for the real
// delete; read-only superadmins can only dry-run.
router.post('/audit-logs/purge', superAdminFull, ctrl.purgeExpiredAuditLogs);

// Phase 4 step 4 — manual trigger for the dormancy scan. Meant for
// multi-instance production setups where the in-process setInterval
// is disabled (DORMANCY_SCAN_DISABLED=true) and an external cron
// pings this endpoint instead. Returns the scan summary so the
// scheduler can surface "alerted N tenants" in its own logs.
// Mutating (sends tenant emails, writes alert audit rows) → full only.
router.post('/internal/run-dormancy-check', superAdminFull, async (_req, res) => {
    const summary = await checkDormantTenants();
    res.json({ success: true, summary });
});

// ═══════════════ RESTAURANTS ═════════════════════════════════════════════
router.get('/restaurants',     ctrl.listRestaurants);
router.get('/restaurants/:id', ctrl.getRestaurant);

router.post(
    '/restaurants',
    superAdminFull,
    createRestaurantRules,
    ctrl.createRestaurant
);

router.patch('/restaurants/:id', superAdminFull, validate([restaurantId]), ctrl.updateRestaurant);

router.post(
    '/restaurants/:id/assign-plan',
    superAdminFull,
    validate([
        objectIdParam('id', 'Invalid restaurant or plan id'),
        body('planId').notEmpty().withMessage('Plan id is required'),
    ]),
    ctrl.assignPlan
);

router.post('/restaurants/:id/suspend',    superAdminFull, validate([restaurantId]), ctrl.suspendRestaurant);

// Paid add-ons — single modules sold on top of the tenant's plan.
router.get('/addon-catalog', ctrl.getAddonCatalog);
router.post('/restaurants/:id/addons', superAdminFull, validate([
    restaurantId,
    body('key').isString().notEmpty().withMessage('Add-on key is required'),
]), ctrl.addRestaurantAddon);
router.delete('/restaurants/:id/addons/:addonId', superAdminFull, validate([restaurantId]), ctrl.cancelRestaurantAddon);

// Phase 7.2 — tenant backups (create / list / download / delete)
router.post('/restaurants/:id/backup',              superAdminFull, validate([restaurantId]), backup.createBackup);
router.get('/restaurants/:id/backups',               backup.listBackups);
router.get('/restaurants/:id/backups/:filename',     backup.downloadBackup);
router.delete('/restaurants/:id/backups/:filename',  superAdminFull, validate([restaurantId]), backup.deleteBackup);
router.post('/restaurants/:id/reactivate', superAdminFull, validate([restaurantId]), ctrl.reactivateRestaurant);
router.post('/restaurants/:id/resend-invitation', superAdminFull, validate([restaurantId]), ctrl.resendRestaurantInvitation);
router.post('/restaurants/:id/cancel-subscription', superAdminFull, validate([restaurantId]), ctrl.cancelSubscription);

// ═══════════════ MARKETING LEADS ════════════════════════════════════════
// Leads from the standalone marketing site. Reads + status/note updates are
// allowed for any superadmin; deletion (spam cleanup) needs `full`.
router.get('/leads',         ctrl.listLeads);
router.get('/leads/:id',     ctrl.getLead);
router.patch('/leads/:id',   superAdminFull, validate([leadId]), ctrl.updateLead);
router.delete('/leads/:id',  superAdminFull, validate([leadId]), ctrl.deleteLead);

// ═══════════════ MARKETING SITE CONTENT ═════════════════════════════════
// Editable text/link content for the standalone marketing site. Read by any
// superadmin; updates need `full`.
router.get('/marketing',  ctrl.getMarketingSettings);
router.put('/marketing',  superAdminFull, ctrl.updateMarketingSettings);
router.post('/marketing/logo', superAdminFull, upload.single('image'), ctrl.uploadMarketingLogo);
router.post('/marketing/screenshot', superAdminFull, upload.single('image'), ctrl.uploadMarketingScreenshot);

// ═══════════════ SUBSCRIPTION PAYMENTS ══════════════════════════════════
// Platform-wide billing ledger (all tenants' successful subscription charges).
// Read-only for any superadmin.
router.get('/subscription-payments', ctrl.listSubscriptionPayments);

// ═══════════════ PENDING APPROVALS ══════════════════════════════════════
router.get('/pending-approvals', ctrl.listPendingApprovals);

router.post('/restaurants/:id/approve-signup', superAdminFull, validate([restaurantId]), ctrl.approveSignup);
router.post(
    '/restaurants/:id/reject-signup',
    superAdminFull,
    validate([
        restaurantId,
        body('reason').trim().notEmpty().withMessage('Rejection reason is required'),
    ]),
    ctrl.rejectSignup
);
router.post('/restaurants/:id/confirm-payment', superAdminFull, validate([restaurantId]), ctrl.confirmPayment);

// Detail pages behind each Pending Approvals row. Reads are open to any
// superadmin (support included); the internal review note is a write
// and needs `full`.
router.get('/approvals/signups/:id',              validate([restaurantId]), ctrl.getSignupApplication);
router.patch(
    '/approvals/signups/:id/note',
    superAdminFull,
    validate([
        restaurantId,
        body('reviewNote').optional({ values: 'null' })
            .isString().withMessage('Review note must be text').bail()
            .isLength({ max: 1000 }).withMessage('Review note cannot exceed 1000 characters'),
    ]),
    ctrl.updateSignupReviewNote
);
router.get('/approvals/plan-changes/:requestId',  validate([requestId]),    ctrl.getPlanChangeDetail);
router.get('/approvals/payments/:id',             validate([restaurantId]), ctrl.getPaymentApprovalDetail);

router.post(
    '/restaurants/:id/plan-change-request',
    superAdminFull,
    validate([
        restaurantId,
        body('planId').notEmpty().withMessage('Plan id is required'),
    ]),
    ctrl.createPlanChangeRequest
);
router.post('/plan-change-requests/:requestId/approve', superAdminFull, validate([requestId]), ctrl.approvePlanChangeRequest);
router.post(
    '/plan-change-requests/:requestId/reject',
    superAdminFull,
    validate([
        requestId,
        body('reason').trim().notEmpty().withMessage('Rejection reason is required'),
    ]),
    ctrl.rejectPlanChangeRequest
);

// ═══════════════ SUBSCRIPTION PLANS ═════════════════════════════════════
router.get('/plans', ctrl.listPlans);

router.post(
    '/plans',
    superAdminFull,
    createPlanRules,
    ctrl.createPlan
);

router.put('/plans/:id',            superAdminFull, updatePlanRules, ctrl.updatePlan);
router.patch('/plans/:id/archive',  superAdminFull, validate([planIdParam]), ctrl.archivePlan);
router.delete('/plans/:id',         superAdminFull, validate([planIdParam]), ctrl.deletePlan);
// Editing a plan never changes existing tenants on its own. These two let
// the Super Admin see who'd be affected and then push the plan's current
// modules + limits to them (agreed price is left alone).
router.get('/plans/:id/tenant-impact', validate([planIdParam]), ctrl.getPlanTenantImpact);
router.post('/plans/:id/push',         superAdminFull, validate([planIdParam]), ctrl.pushPlanToTenants);

// ═══════════════ BLOG (marketing content) ═══════════════════════════════
// Posts for the standalone marketing site's /blog. Reads allowed for any
// superadmin; create/update/delete + cover upload need `full`. Publishing or
// deleting a post triggers a marketing-site rebuild (utils/deployHook.js).
router.get('/blog',         blog.listBlogPosts);
router.get('/blog/:id',     blog.getBlogPost);
router.post(
    '/blog',
    superAdminFull,
    validate([
        body('title').trim().notEmpty().withMessage('Title is required'),
        body('description').trim().notEmpty().withMessage('Meta description is required'),
        body('content').trim().notEmpty().withMessage('Content is required'),
    ]),
    blog.createBlogPost
);
router.patch('/blog/:id',   superAdminFull, validate([blogId]), blog.updateBlogPost);
router.delete('/blog/:id',  superAdminFull, validate([blogId]), blog.deleteBlogPost);
router.post('/blog/cover',  superAdminFull, upload.single('image'), blog.uploadBlogCover);

// Super admin accounts are created exclusively via the seed script at
// Backend/Seed/seedSuperAdmin.js — there is NO API surface to create or
// list them. Keeping the accounts out of the UI prevents a compromised
// full-level session from escalating by minting more full-level admins.

module.exports = router;
