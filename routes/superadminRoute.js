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
    superAdminPanel,
    platformStaffGate,
    superAdminFull,
    superAdminOrModule,
} = require('../middlewares/authMiddleware');
const { platformStaffActivity } = require('../middlewares/platformStaffActivity');

const ctrl = require('../controllers/superadminController');
const opsCtrl = require('../controllers/operationsController');
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
    // TRIAL_SIGNUP_AND_LEADS_PLAN §2 — public card fields.
    optObject('trial'),
    optBool('trial.enabled'),
    body('trial.durationDays').optional({ values: 'null' })
        .custom((v) => v === '' || (isNumberish(v) && Number.isInteger(+v) && +v >= 0 && +v <= 3650))
        .withMessage('Trial length must be a whole number of days between 0 and 3650'),
    optText('badge', 40),
    body('highlights').optional({ values: 'null' })
        .isArray({ max: 8 }).withMessage('Highlights must be a list of at most 8 items'),
    body('highlights.*')
        .isString().withMessage('Each highlight must be text').bail()
        .isLength({ max: 120 }).withMessage('A highlight cannot exceed 120 characters'),
];

// Numeric rank (free 0, silver 10, gold 20, premium 25, enterprise 30).
// A non-numeric value ("standard") is a 400, never a silently dropped field;
// 0 is valid. `toInt()` hands the controller a real Number.
const TIER_MESSAGE = 'Tier must be a whole number >= 0 (e.g. 0 free, 10 silver, 20 gold, 25 premium, 30 enterprise)';
const tierRule = (required) => {
    const chain = required
        ? body('tier').exists({ values: 'null' }).withMessage('Tier is required').bail()
        : body('tier').optional({ values: 'null' });
    return chain
        .custom((v) => isNumberish(v) && Number.isInteger(+v) && +v >= 0).withMessage(TIER_MESSAGE)
        .toInt();
};

const createPlanRules = validate([
    requiredText('name', 'Plan name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a non-negative number'),
    optText('slug', 200),
    tierRule(true),
    ...planFieldChains(),
]);

const updatePlanRules = validate([
    planIdParam,
    body('name').optional()
        .custom((v) => typeof v === 'string' && v.trim() !== '').withMessage('Plan name is required'),
    body('price').optional()
        .custom((v) => isNumberish(v) && +v >= 0).withMessage('Price must be a non-negative number'),
    optBool('isActive'),
    tierRule(false),
    ...planFieldChains(),
]);

// All routes require an authenticated super admin. Mutating routes
// additionally require the `full` sub-level — `support` superadmins are
// limited to read-only.
// Delegated platform staff (role `platformstaff`) get in too, but `platformStaffGate`
// closes everything except the routes of their assigned modules
// (config/platformModules.js, PLATFORM_STAFF_PLAN.md) and `platformStaffActivity` logs what they do.
router.use(protect, superAdminPanel, platformStaffGate, platformStaffActivity);

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
// Free-trial extension (TRIAL_SIGNUP_AND_LEADS_PLAN §6): adds `days` to the
// trial end (from today if it already ended) and lifts the trial lock.
router.post(
    '/restaurants/:id/extend-trial',
    superAdminOrModule('trials'),
    validate([
        restaurantId,
        body('days')
            .exists({ values: 'null' }).withMessage('days is required').bail()
            .custom((v) => isNumberish(v) && Number.isInteger(+v) && +v >= 1 && +v <= 90)
            .withMessage('days must be a whole number between 1 and 90')
            .toInt(),
    ]),
    ctrl.extendTrial
);

// Paid add-ons — single modules sold on top of the tenant's plan.
router.get('/addon-catalog', ctrl.getAddonCatalog);
router.post('/restaurants/:id/addons', superAdminFull, validate([
    restaurantId,
    body('key').isString().notEmpty().withMessage('Add-on key is required'),
]), ctrl.addRestaurantAddon);
router.delete('/restaurants/:id/addons/:addonId', superAdminFull, validate([restaurantId]), ctrl.cancelRestaurantAddon);

// Operations profile — HOW the restaurant runs (OPERATIONS_CONTROL_PANEL_DESIGN.md §4).
// Reading is open to every super admin; preview and save need full access.
router.get('/operations/presets', opsCtrl.getPresets);
router.get('/restaurants/:id/operations', validate([restaurantId]), opsCtrl.getRestaurantOperations);
router.post('/restaurants/:id/operations/preview', superAdminFull, validate([restaurantId]), opsCtrl.previewRestaurantOperations);
router.put('/restaurants/:id/operations', superAdminFull, validate([restaurantId]), opsCtrl.updateRestaurantOperations);
// §12.1 — per-branch overrides: body { overrides, expectedUpdatedAt }; DELETE resets the branch to the tenant profile.
const opsBranchId = objectIdParam('branchId', 'Invalid branch id');
router.put('/restaurants/:id/operations/branches/:branchId', superAdminFull, validate([restaurantId, opsBranchId]), opsCtrl.updateBranchOperations);
router.delete('/restaurants/:id/operations/branches/:branchId', superAdminFull, validate([restaurantId, opsBranchId]), opsCtrl.deleteBranchOperations);

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
router.patch('/leads/:id',   superAdminOrModule('leads'), validate([leadId]), ctrl.updateLead);
router.delete('/leads/:id',  superAdminFull, validate([leadId]), ctrl.deleteLead);

// ═══════════════ SIGNUP LEADS (plan §8) ═════════════════════════════════
// Self-registered tenants as a follow-up list (the tenant record IS the
// lead). Reads for any superadmin; stage/follow-up/notes writes need `full`.
// Distinct from the marketing-site demo requests above.
// `/summary` and `/export.csv` are declared BEFORE `/:slug` so the slug
// route never swallows them.
const signupLeads = require('../controllers/superadmin/signupLeads');
const { param: slParam, query: slQuery } = require('../middlewares/validate');
const SIGNUP_LEAD_STAGES = signupLeads.SIGNUP_LEAD_STAGES;
const slugParam = slParam('slug').isString().isLength({ min: 1, max: 80 })
    .matches(/^[a-z0-9_-]+$/i).withMessage('Invalid restaurant slug');
const optIsoOrNull = (field) => body(field).optional({ values: 'null' })
    .custom((v) => v === '' || (typeof v === 'string' && !Number.isNaN(new Date(v).getTime())))
    .withMessage(`${field} must be an ISO date or null`);
const signupLeadListRules = validate([
    slQuery('segment').optional({ values: 'falsy' }).isIn(signupLeads.SIGNUP_LEAD_SEGMENTS).withMessage('Invalid segment'),
    slQuery('stage').optional({ values: 'falsy' }).isIn(SIGNUP_LEAD_STAGES).withMessage('Invalid stage'),
    slQuery('followUp').optional({ values: 'falsy' }).isIn(['due']).withMessage('followUp must be "due"'),
    slQuery('search').optional({ values: 'falsy' }).isString().isLength({ max: 120 }).withMessage('search is too long'),
    slQuery('page').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('page must be a positive integer'),
    slQuery('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).withMessage('limit must be 1–100'),
]);
router.get('/signup-leads',             signupLeadListRules, signupLeads.listSignupLeads);
router.get('/signup-leads/summary',     signupLeads.signupLeadsSummary);
router.get('/signup-leads/export.csv',  signupLeadListRules, signupLeads.exportSignupLeadsCsv);
router.patch('/signup-leads/:slug', superAdminOrModule('signupLeads'), validate([
    slugParam,
    body('stage').optional().isIn(SIGNUP_LEAD_STAGES).withMessage(`stage must be one of ${SIGNUP_LEAD_STAGES.join(', ')}`),
    optIsoOrNull('nextFollowUpAt'),
    optIsoOrNull('lastContactedAt'),
]), signupLeads.updateSignupLead);
router.post('/signup-leads/:slug/notes', superAdminOrModule('signupLeads'), validate([
    slugParam,
    body('text').custom((v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 1000)
        .withMessage('Note text must be 1–1000 characters'),
]), signupLeads.addSignupLeadNote);

// ═══════════════ MARKETING SITE CONTENT ═════════════════════════════════
// Editable text/link content for the standalone marketing site. Read by any
// superadmin; updates need `full`.
router.get('/marketing',  ctrl.getMarketingSettings);
router.put('/marketing',  superAdminOrModule('marketing'), ctrl.updateMarketingSettings);
router.post('/marketing/logo', superAdminOrModule('marketing'), upload.single('image'), ctrl.uploadMarketingLogo);
router.post('/marketing/screenshot', superAdminOrModule('marketing'), upload.single('image'), ctrl.uploadMarketingScreenshot);

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
    superAdminOrModule('blog'),
    validate([
        body('title').trim().notEmpty().withMessage('Title is required'),
        body('description').trim().notEmpty().withMessage('Meta description is required'),
        body('content').trim().notEmpty().withMessage('Content is required'),
    ]),
    blog.createBlogPost
);
router.patch('/blog/:id',   superAdminOrModule('blog'), validate([blogId]), blog.updateBlogPost);
router.delete('/blog/:id',  superAdminOrModule('blog'), validate([blogId]), blog.deleteBlogPost);
router.post('/blog/cover',  superAdminOrModule('blog'), upload.single('image'), blog.uploadBlogCover);

// ═══════════════ PLATFORM STAFF (delegated portal users) ════════════════
// Full super admin only. Platform staff are denied here by platformStaffGate
// (not in the module catalog). PLATFORM_STAFF_PLAN.md.
const platformStaff = require('../controllers/superadmin/platformStaff');
const staffId = objectIdParam('id', 'Invalid team member id');
router.get('/platform-staff/modules', superAdminFull, platformStaff.listModules);   // before /:id
router.get('/platform-staff',         superAdminFull, platformStaff.listStaff);
router.post('/platform-staff',        superAdminFull, platformStaff.createStaff);
router.get('/platform-staff/:id',                 superAdminFull, validate([staffId]), platformStaff.getStaff);
router.patch('/platform-staff/:id',               superAdminFull, validate([staffId]), platformStaff.updateStaff);
router.post('/platform-staff/:id/reset-password', superAdminFull, validate([staffId]), platformStaff.resetStaffPassword);
router.get('/platform-staff/:id/activity',        superAdminFull, validate([staffId]), platformStaff.staffActivity);

// Super admin accounts are created exclusively via the seed script at
// Backend/Seed/seedSuperAdmin.js — there is NO API surface to create or
// list them. Keeping the accounts out of the UI prevents a compromised
// full-level session from escalating by minting more full-level admins.
// The platform-staff endpoints above can only mint LIMITED `platformstaff`
// accounts (never a super admin), so that guarantee still holds.

module.exports = router;
