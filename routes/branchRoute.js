const express = require('express');
const router = express.Router();

const { protect, adminOnly, adminExclusive } = require('../middlewares/authMiddleware');
const { featureGate } = require('../middlewares/featureGate');
const {
    listBranches,
    getBranch,
    createBranch,
    updateBranch,
    deleteBranch,
    hardDeleteBranch,
    reactivateBranch,
    preDisableCheck,
    syncMenuToBranch,
    syncMenuToAllBranches,
    syncAreasToBranch,
    syncAreasToAllBranches,
    createBranchSubAdmin,
    updateSubAdmin,
    resetSubAdminPassword,
} = require('../controllers/branchController');
const { validate, body, objectIdParam } = require('../middlewares/validate');

/**
 * Branch routes (Phase 6 step 1).
 *
 * Read endpoints (list, get) use `adminOnly` — both admin and manager
 * can view branches. Write endpoints (create, update, delete) use
 * `adminExclusive` — structural business decisions are owner-only.
 *
 * All endpoints additionally require `featureGate('multiBranch')`.
 */
const readGuard  = [protect, adminOnly, featureGate('multiBranch')];
const writeGuard = [protect, adminExclusive, featureGate('multiBranch')];

// ─── Validation (BUGS_REPORT #33) ─────────────────────────────────────
// Mirrors what branchController already accepts. Required-field checks
// (name, managerName, managerEmail…) are left to the controller so its
// own 400 messages keep reaching the frontend; these chains only reject
// wrong types / malformed ids / out-of-range numbers that would
// otherwise crash (e.g. `managerEmail.toLowerCase()` on a non-string) or
// surface as a CastError 500 from findOneAndUpdate.
const branchId = objectIdParam('id', 'Invalid branch id');

// Optional plain string ('' / null allowed — controller maps to '').
const optStr = (field, max, label = field) =>
    body(field).optional({ values: 'null' })
        .isString().withMessage(`${label} must be text`).bail()
        .isLength({ max }).withMessage(`${label} cannot exceed ${max} characters`);

// Optional number that the controller coerces with `+v`. Blank / null
// → stored as null / default; a non-numeric string is also turned into
// null by the controller, so only a finite value is range-checked.
const optCoord = (field, limit) =>
    body(field).optional({ values: 'null' })
        .custom((v) => {
            if (v === '') return true;
            if (typeof v !== 'string' && typeof v !== 'number') return false;
            const n = +v;
            return !Number.isFinite(n) || (n >= -limit && n <= limit);
        })
        .withMessage(`${field} must be between -${limit} and ${limit}`);

const optObject = (field) =>
    body(field).optional({ values: 'null' })
        .custom((v) => typeof v === 'object' && !Array.isArray(v))
        .withMessage(`${field} must be an object`);

// Branch document fields shared by create + update. Length caps are
// deliberately looser than the Branch model (which trims first, then
// enforces its own maxlength) so the model's messages stay reachable.
const branchFieldChains = () => [
    optStr('name', 200, 'Branch name'),         // controller/model enforce 80 after trim
    optStr('slug', 200, 'Slug'),                // controller slugifies; model caps 60
    optStr('displayLabel', 500, 'Display label'), // controller slices to 60
    optStr('addressLine1', 500, 'Address line 1'),
    optStr('addressLine2', 500, 'Address line 2'),
    optStr('city', 200, 'City'),
    optStr('state', 200, 'State'),
    optStr('postalCode', 100, 'Postal code'),
    optStr('country', 200, 'Country'),
    optStr('contactPhone', 100, 'Contact phone'),
    optStr('contactEmail', 254, 'Contact email'),
    optCoord('latitude', 90),
    optCoord('longitude', 180),
    body('sortOrder').optional({ values: 'null' })
        .custom((v) => v === '' || ((typeof v === 'number' || typeof v === 'string') && Number.isFinite(+v)))
        .withMessage('sortOrder must be a number'),
    optObject('syncFromMain'),
];

const createBranchRules = validate([
    ...branchFieldChains(),
    optStr('managerName', 200, 'Branch Admin name'), // controller enforces required + 80
    optStr('managerEmail', 254, 'Branch Admin email'),
    body('managerPhone').optional({ values: 'null' })
        .custom((v) => typeof v === 'string' || typeof v === 'number')
        .withMessage('Branch Admin phone must be text'),
    optObject('managerPermissions'),
]);

const updateBranchRules = validate([
    branchId,
    ...branchFieldChains(),
    // Status changes have dedicated endpoints (DELETE /:id to disable,
    // PATCH /:id/reactivate — which enforces the plan's branch limit).
    body('isActive').not().exists()
        .withMessage('Branch status cannot be changed here. Use Disable / Reactivate instead.'),
]);

const createSubAdminRules = validate([
    branchId,
    optStr('name', 200, 'Branch Admin name'),
    optStr('email', 254, 'Branch Admin email'),
    body('phone').optional({ values: 'null' })
        .custom((v) => typeof v === 'string' || typeof v === 'number')
        .withMessage('Branch Admin phone must be text'),
    optObject('permissions'),
]);

const updateSubAdminRules = validate([
    branchId,
    optStr('name', 200, 'Name'),
    optStr('mobile', 100, 'Mobile'),
]);

const syncMenuRules = validate([
    branchId,
    body('resetPrices').optional().isBoolean().withMessage('resetPrices must be true or false'),
]);

const idOnly = validate([branchId]);

router.get('/',                  ...readGuard,  listBranches);
router.get('/:id',               ...readGuard,  getBranch);
router.get('/:id/disable-check', ...readGuard,  preDisableCheck);
router.post('/',                 ...writeGuard, createBranchRules, createBranch);
router.put('/:id',               ...writeGuard, updateBranchRules, updateBranch);
router.delete('/:id',            ...writeGuard, idOnly, deleteBranch);
router.delete('/:id/permanent',  ...writeGuard, idOnly, hardDeleteBranch);
router.patch('/:id/reactivate',  ...writeGuard, idOnly, reactivateBranch);

// Menu sync — push the restaurant's shared menu items into branch(es)
router.post('/sync-menu-all',    ...writeGuard, syncMenuToAllBranches);
router.post('/:id/sync-menu',    ...writeGuard, syncMenuRules, syncMenuToBranch);

// Area sync — copy the Main branch's areas into sub-branch(es). Same
// shape as menu sync; create-branch already runs this once on its own.
router.post('/sync-areas-all',   ...writeGuard, syncAreasToAllBranches);
router.post('/:id/sync-areas',   ...writeGuard, idOnly, syncAreasToBranch);

// Sub Admin management — attach a new one to an existing branch
// (when none exists), edit display fields, or reset temp password.
// Replacing the Sub Admin entirely is still done via the Staff tab.
router.post('/:id/subadmin',                  ...writeGuard, createSubAdminRules, createBranchSubAdmin);
router.patch('/:id/subadmin',                 ...writeGuard, updateSubAdminRules, updateSubAdmin);
router.post('/:id/subadmin/reset-password',   ...writeGuard, idOnly, resetSubAdminPassword);

module.exports = router;
