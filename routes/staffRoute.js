const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const staffController = require('../controllers/staffController');
const { protect, adminOnly, adminExclusive, checkPermission } = require('../middlewares/authMiddleware');
const { validate, body, objectIdParam, optionalObjectId } = require('../middlewares/validate');
const { featureGate } = require('../middlewares/featureGate');

// ── Request validation (BUGS_REPORT #33) ────────────────────────────────
// Type/shape checks only — staffController keeps its own business rules
// and messages (Name/Email required, email format, mobile format, role,
// branch rules). StaffDashboard sends { name, email, mobile, role,
// staffId, avatar, permissions, branch:id|'', assignedAreas:[], assignedTables:[],
// handlesTakeaway:bool }; on edit several of those can be null/undefined
// when the stored record never had them.
const STAFF_ROLES = ['chef', 'waiter', 'captain', 'admin', 'manager'];
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const staffIdParam = objectIdParam('id', 'Invalid staff id');

function staffBodyRules({ allowNull }) {
    // addStaff: missing name/email → controller's "X is required".
    // updateStaff: fields are optional; null is tolerated as "not provided".
    const opt = allowNull ? { values: 'null' } : undefined;
    return [
        body('name').optional(opt).isString().withMessage('Name must be text').bail()
            .isLength({ max: 200 }).withMessage('Name is too long'),
        body('email').optional(opt).isString().withMessage('Email must be text').bail()
            .isLength({ max: 254 }).withMessage('Email is too long'),
        body('mobile').optional({ values: 'falsy' }).isString().withMessage('Mobile number must be text').bail()
            .isLength({ max: 20 }).withMessage('Mobile number is too long'),
        body('role').optional().isIn(STAFF_ROLES).withMessage('Invalid staff role'),
        body('staffId').optional({ values: 'null' })
            .custom((v) => (typeof v === 'string' && v.length <= 50) || (typeof v === 'number' && Number.isFinite(v)))
            .withMessage('Invalid staff ID'),
        body('avatar').optional({ values: 'null' }).isString().withMessage('Invalid avatar').bail()
            .isLength({ max: 2048 }).withMessage('Avatar URL is too long'),
        body('permissions').optional({ values: 'null' }).custom(isPlainObject).withMessage('permissions must be an object'),
        body('kitchenResponsibility').optional({ values: 'null' }).isIn(['veg', 'nonveg', 'both', ''])
            .withMessage('Invalid kitchen responsibility'),
        optionalObjectId('body', 'branch', 'Invalid branch id'),
        // Elements are filtered (invalid ids dropped) by the controller.
        body('assignedAreas').optional({ values: 'null' }).isArray({ max: 500 }).withMessage('assignedAreas must be a list'),
        body('assignedTables').optional({ values: 'null' }).isArray({ max: 1000 }).withMessage('assignedTables must be a list'),
        body('handlesTakeaway').optional({ values: 'null' }).isBoolean().withMessage('handlesTakeaway must be true or false'),
    ];
}

// Staff management guard — admin or manager with manageStaff permission
const staffGuard = [protect, adminOnly, checkPermission('manageStaff')];
// Owner-only guard — hiring, firing, and credential resets are admin-exclusive
const ownerStaffGuard = [protect, adminExclusive, checkPermission('manageStaff')];

// CSV upload for bulk-add. Same config as the Tables bulk-import route:
// memory storage (no disk writes), 1 MB cap, .csv extension OR a CSV mime
// type. Staff rows are tiny — even a 500-person roster comes well under
// the cap — so the limit also doubles as a sanity gate against accidental
// huge-file uploads.
const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const okExt = path.extname(file.originalname).toLowerCase() === '.csv';
        const okMime = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv']
            .includes(file.mimetype);
        if (okExt || okMime) return cb(null, true);
        const err = new Error('Only .csv files are allowed');
        err.status = 400;
        err.expose = true;
        cb(err, false);
    },
});

// IMPORTANT — keep /template, /import, and /next-id BEFORE the /:id routes
// below so Express doesn't try to interpret "template" / "import" as an
// ObjectId param. Same ordering rule as tableRoute.
//
// Bulk add uses `staffGuard` (admin or manager + manageStaff perm), NOT
// the owner-exclusive guard. A Branch Admin hiring their own waiters
// is a legitimate flow, and branch isolation is already enforced inside
// `importStaffCsv` — pinned callers can ONLY land staff in their own
// branch regardless of what the form body says. Mirrors the Tables
// Bulk Add (`tableRoute.js`) which has used `adminOnly` since launch.
// GET /api/staff/template — download the starter CSV
router.get('/template', ...staffGuard, staffController.downloadStaffTemplate);
// POST /api/staff/import — bulk-create staff from uploaded CSV
router.post('/import', ...staffGuard, csvUpload.single('file'), staffController.importStaffCsv);

// GET /api/staff - List all staff (admin + manager)
router.get('/', protect, adminOnly, staffController.getStaffList);
// GET /api/staff/next-id - Get next available staffId.
// Branch Admins / branch-pinned Managers preview ids for their own branch only.
router.get('/next-id', ...staffGuard, staffController.getNextStaffId);
// POST /api/staff - Hire a new staff member.
// Admin + Manager can hire floor staff (waiter/captain/chef/manager) for
// their scope (controller force-pins new staff to caller's branch when
// pinned). Creating role:'admin' is owner-only regardless of branch pin
// — that path goes through /branches/:id/subadmin.
router.post('/', ...staffGuard, validate(staffBodyRules({ allowNull: false })), staffController.addStaff);
// PATCH /api/staff/:id/status - Toggle active/inactive (admin + manager with permission)
router.patch('/:id/status', ...staffGuard, validate([
    staffIdParam,
    body('status').isIn(['active', 'inactive']).withMessage('Invalid status'),
]), staffController.updateStaffStatus);
// PUT /api/staff/:id - Update staff details (admin + manager with permission)
router.put('/:id', ...staffGuard, validate([staffIdParam, ...staffBodyRules({ allowNull: true })]), staffController.updateStaff);
// GET /api/staff/:id/performance - Staff performance metrics (admin + manager)
router.get('/:id/performance', protect, adminOnly, featureGate('staffPerformance'), validate([staffIdParam]), staffController.getStaffPerformance);
// POST /api/staff/:id/reset-password - Issue a new temp password.
// Branch Admins / branch-pinned Managers can reset passwords for staff
// in their own branch only — controller enforces self-guard,
// owner-guard, and branch isolation before the bcrypt rotate.
router.post('/:id/reset-password', ...staffGuard, validate([staffIdParam]), staffController.resetStaffPassword);
// POST /api/staff/:id/unlock-login - Clear the per-account login lockout
// (10 wrong passwords in 15 min) so the staff member can sign in before
// the 15-minute lock expires on its own. Admin + manager with manageStaff;
// tenant-scoped (404 for another tenant's staff), branch-pinned callers
// can only unlock staff in their own branch.
router.post('/:id/unlock-login', ...staffGuard, validate([staffIdParam]), staffController.unlockStaffLogin);
// DELETE /api/staff/:id - Delete staff member.
// Branch Admins / branch-pinned Managers can delete staff from their own
// branch. The controller (`deleteStaff`) enforces:
//   - cannot delete yourself
//   - cannot delete the tenant owner
//   - pinned callers (Sub Admin / branch-pinned Manager) can only
//     touch rows that belong to their own branch
router.delete('/:id', ...staffGuard, validate([staffIdParam]), staffController.deleteStaff);

module.exports = router;
