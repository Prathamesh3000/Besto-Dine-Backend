const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/user');
const Order = require('../models/order');
const Branch = require('../models/branch');
const Shift = require('../models/shift');
const logger = require('../utils/logger');
const loginAttempts = require('../utils/loginAttempts');
const { revokeAllSessions } = require('./authController');

const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { generateTempPassword, getNextStaffIdForBranch, PASSWORD_REGEX } = require('../utils/staffUtils');
const { resolvePermissions } = require('../utils/staffDefaults');
const { parseCsv } = require('../utils/csvParser');
const { devError } = require('../utils/AppError');
const { permissionsChanged, cleanStaffUpdate, canManageStaffRole, staffRoleGate: roleGateFor, ROLE_ADMIN_ONLY_BODY } = require('../utils/bodyAllowlist');

// Role gate for acting on an EXISTING staff row (edit / status / delete /
// reset-password): a non-admin caller (Manager) may only act on floor
// staff. Resetting another Manager's password would be an account
// takeover. Runs before adminTargetGate so a Manager gets the same
// ROLE_ADMIN_ONLY code for Manager and Admin rows alike.
function staffRoleGate(req, target) {
  return roleGateFor(req.user?.role, target?.role);
}

/**
 * Branch-isolation gate for write operations against a specific staff row.
 *
 * Pinned callers (Sub Admin / branch-pinned Manager) may only mutate
 * rows whose `branch` matches their own pin. Tenant-level rows
 * (target.branch == null) are out of reach for pinned callers because
 * those records belong to the org, not to one branch.
 *
 * Returns `null` when the action is allowed, or an Express response-
 * descriptor `{ status, body }` the caller should send back unchanged.
 * Inlined as a tiny helper because four endpoints (update / status /
 * reset-password / delete) need exactly the same gate and copy-pasting
 * the check across them invites the kind of drift that lets a future
 * edit silently weaken the boundary on one of them.
 */
function staffBranchGate(req, target) {
  const callerBranch = pinnedBranchId(req);
  if (!callerBranch) return null;
  const targetBranch = target?.branch ? String(target.branch) : null;
  if (!targetBranch || targetBranch !== String(callerBranch)) {
    return {
      status: 403,
      body: {
        success: false,
        code: 'BRANCH_MISMATCH',
        message: 'You can only act on staff from your own branch.',
      },
    };
  }
  return null;
}

/**
 * Rank-based mutation gate — only the tenant owner may modify a row
 * with `role: 'admin'` (delete, update, status-toggle, password reset).
 *
 * Without this gate a Manager (who is admin-equivalent for day-to-day
 * staffing) could fire / deactivate / rename their own Branch Admin —
 * real-world bug found 2026-05-21 during E2E testing where a Manager
 * deleted the Branch Admin from their own branch. Symmetric to the
 * privilege guards in addStaff/updateStaff that already block
 * CREATING / PROMOTING-TO admin without owner rights.
 *
 * Returns null when allowed, or an Express response descriptor.
 */
function adminTargetGate(req, target) {
  if (target?.role !== 'admin') return null;
  if (req.user?.isTenantOwner === true) return null;
  return {
    status: 403,
    body: {
      success: false,
      code: 'OWNER_ONLY_TARGET',
      message: 'Only the restaurant owner can modify another Admin account.',
    },
  };
}

// Get next available staff ID for a (tenant, branch) scope.
// Frontend can pass ?branch=<id> to preview the next ID for that
// branch — omit / leave empty for tenant-level (branch=null) staff.
// Sub Admins are force-scoped to their pinned branch regardless of
// what the client asked for.
exports.getNextStaffId = async (req, res) => {
  try {
    const tf = tenantFilter(req);
    const pinned = pinnedBranchId(req);
    let branchScope = null;
    if (pinned) {
      branchScope = pinned;
    } else if (req.query.branch) {
      if (!mongoose.isValidObjectId(req.query.branch)) {
        return res.status(400).json({ success: false, message: 'Invalid branch id' });
      }
      branchScope = req.query.branch;
    }
    const scopeFilter = { ...tf, branch: branchScope };

    const lastStaff = await User.findOne({ staffId: /^EMP-/, ...scopeFilter }).sort({ staffId: -1 });
    let nextId = 'EMP-001';

    if (lastStaff && lastStaff.staffId) {
      const lastNum = parseInt(lastStaff.staffId.split('-')[1]);
      nextId = `EMP-${(lastNum + 1).toString().padStart(3, '0')}`;
    }

    res.status(200).json({ success: true, nextId });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate staff ID' });
  }
};

// Get all staff members (users with role !== 'customer'), scoped to tenant.
// Super admins are excluded since they're platform-level, not restaurant staff.
exports.getStaffList = async (req, res) => {
  try {
    const tf = tenantFilter(req);
    const filter = {
      role: { $nin: ['customer', 'superadmin'] },
      ...tf,
    };

    // Phase 6 — branch scope.
    //   Sub Admin (pinned): FORCED to see only their own branch's staff
    //                       (themselves and any other staff at that branch).
    //   Tenant owner: ?branch=<id> | none | (unset = everyone)
    //
    // When the tenant owner filters by a specific branch we ALSO surface
    // tenant-level operators (admin/manager with branch:null) alongside
    // the branch-pinned staff. Those people actually oversee every
    // branch, and hiding the tenant owner from "their own Main branch"
    // view was confusing (2026-05-20 user report: "admin Rohit Bansode
    // ka dist nahi list madhe" when viewing Main). Pinned sub-admins
    // stay strict — they're not allowed to see the tenant owner.
    const pinned = pinnedBranchId(req);
    if (pinned) {
      filter.branch = pinned;
    } else {
      const { branch: branchQ } = req.query;
      if (branchQ === 'none') {
        filter.branch = null;
      } else if (branchQ && mongoose.isValidObjectId(branchQ)) {
        filter.$or = [
          { branch: branchQ },
          { branch: null, role: { $in: ['admin', 'manager'] } },
        ];
      }
    }

    const staff = await User.find(filter)
      .select('-password')
      // Phase 6 step 4 — populate branch so the admin UI can render
      // each staff member's location assignment without a second query.
      .populate('branch', 'name slug city')
      // Area / table assignments — only meaningful for waiter / captain
      // but populating unconditionally is cheap and keeps the response
      // shape uniform.
      .populate('assignedAreas', 'name')
      .populate('assignedTables', 'name area')
      // .lean() skips Mongoose document hydration — staff objects here
      // are read-only for the response (the in-loop staffId assignment
      // below sets a property on the plain lean object, which is fine).
      // No virtuals, no .save() in this code path.
      .lean();

    // Auto-assign staffId to any staff members missing one (per-branch sequence).
    // Matches the { staffId, restaurant, branch } unique index so each
    // location starts at EMP-001. R-10: the update MUST include the
    // tenant filter — `member._id` came from a tenant-scoped query
    // above, so today this is a TOCTOU-level concern only, but a bare
    // `findByIdAndUpdate({_id})` is exactly the pattern the audit
    // flagged. Wrap in findOneAndUpdate with `...tf` so any future
    // caller that reuses this code can't accidentally cross tenants.
    for (const member of staff) {
      if (!member.staffId || !member.staffId.startsWith('EMP-')) {
        try {
          const memberBranch = member.branch?._id || member.branch || null;
          const newId = await getNextStaffIdForBranch(tf, memberBranch);
          await User.findOneAndUpdate(
            { _id: member._id, ...tf },
            { staffId: newId }
          );
          member.staffId = newId;
        } catch (e) {
          // Skip if duplicate key error (race condition)
        }
      }
    }

    // Compute on-duty flag from active shift records. One query covers
    // the whole list — far cheaper than per-row lookups in the loop
    // above. A staff is "On Duty" iff they have a Shift with status
    // 'active' inside this tenant.
    //
    // WAI-029 — also project the active shift's clockIn time + a
    // computed duration so the admin staff drawer can flag dangling
    // shifts (active > 12h means the waiter forgot to clock out).
    const staffIds = staff.map(s => s._id);
    const activeShifts = staffIds.length
      ? await Shift.find({
        staff: { $in: staffIds },
        status: 'active',
        ...tf,
      }).select('staff clockIn').lean()
      : [];
    const DANGLING_HOURS = 12; // shifts open longer than this are forgotten clock-outs
    const activeShiftByStaff = new Map();
    for (const s of activeShifts) {
      activeShiftByStaff.set(String(s.staff), s);
    }
    const now = Date.now();
    const staffWithDuty = staff.map(s => {
      const obj = s.toObject ? s.toObject() : s;
      const active = activeShiftByStaff.get(String(s._id));
      obj.isOnDuty = !!active;
      if (active) {
        const durationHours = (now - new Date(active.clockIn).getTime()) / 3600000;
        obj.activeShift = {
          _id: active._id,
          clockIn: active.clockIn,
          durationHours: Math.round(durationHours * 100) / 100,
          isDangling: durationHours > DANGLING_HOURS,
        };
      } else {
        obj.activeShift = null;
      }
      return obj;
    });

    res.status(200).json({ success: true, staff: staffWithDuty });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch staff list' });
  }
};

// ── Helpers ────────────────────────────────────────────────────────────
// Validate assignedAreas / assignedTables against the staff's tenant
// (and branch when pinned). Returns { ok: true, areaIds, tableIds } on
// success, or { ok: false, message } describing the first problem.
// Empty / missing input is allowed — that means "no filter" downstream.
async function resolveAreaTableAssignments(req, { role, branchId, rawAreas, rawTables }) {
  const Area = require('../models/area');
  const Table = require('../models/table');
  const tf = tenantFilter(req);

  const areaIds = Array.isArray(rawAreas)
    ? rawAreas.filter(id => mongoose.isValidObjectId(id)).map(String)
    : [];
  const tableIds = Array.isArray(rawTables)
    ? rawTables.filter(id => mongoose.isValidObjectId(id)).map(String)
    : [];

  // Assignment is only meaningful for waiter / captain. Silently drop
  // anything sent for other roles so the front-end can't accidentally
  // pollute the document.
  if (role !== 'waiter' && role !== 'captain') {
    return { ok: true, areaIds: [], tableIds: [] };
  }
  // Captains don't get table-level pins.
  if (role === 'captain' && tableIds.length > 0) {
    return { ok: true, areaIds, tableIds: [] };
  }

  if (areaIds.length > 0) {
    const areaFilter = { _id: { $in: areaIds }, ...tf };
    // When the staff is pinned to a branch, every selected area must
    // belong to that branch OR be tenant-level (branch=null). Tenant-
    // owner admins (no branch pin) can pick any tenant area.
    if (branchId) {
      areaFilter.$or = [{ branch: branchId }, { branch: null }];
    }
    const found = await Area.countDocuments(areaFilter);
    if (found !== areaIds.length) {
      return { ok: false, message: 'One or more selected areas are invalid for this staff member.' };
    }
  }

  if (tableIds.length > 0) {
    const tableFilter = { _id: { $in: tableIds }, ...tf };
    if (branchId) {
      tableFilter.$or = [{ branch: branchId }, { branch: null }];
    }
    // Tables must also belong to one of the selected areas — otherwise
    // the assignment makes no sense.
    if (areaIds.length > 0) {
      tableFilter.area = { $in: areaIds };
    }
    const found = await Table.countDocuments(tableFilter);
    if (found !== tableIds.length) {
      return { ok: false, message: 'One or more selected tables are invalid or not in the selected areas.' };
    }
  }

  return { ok: true, areaIds, tableIds };
}

// Add new staff member
exports.addStaff = async (req, res) => {
  try {
    const { name, email, mobile, role, staffId, kitchenResponsibility, branch: rawBranch, assignedAreas: rawAreas, assignedTables: rawTables } = req.body;

    // ── Validation ──────────────────────────────────────────────────────
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    // Mobile validation — kept IDENTICAL to the schema-level validator in
    // models/user.js (10 digits, must start 6-9). Any drift between this
    // check and the schema regex lets a bad value slip past here and
    // throw a Mongoose ValidationError at save() instead — which used to
    // surface as an opaque 500. Keep these two in sync if either changes.
    if (mobile && !/^[6-9]\d{9}$/.test(mobile.replace(/\s+/g, ''))) {
      return res.status(400).json({ success: false, message: 'Mobile number must be a valid 10-digit number starting with 6-9' });
    }

    // Email uniqueness check is layered:
    //   1. Reject if a customer or superadmin already owns this email
    //      (those identities are global — same email = same person).
    //   2. Reject if a staff member in THIS tenant already has it.
    //   3. Allow if a staff member in ANOTHER tenant has it — that's a
    //      different person at a different restaurant.
    const cleanEmail = email.toLowerCase().trim();
    const tenant = tenantId(req);

    // AUDIT-EXEMPT: platform-wide email uniqueness vs global customer/superadmin identities (User is not tenant-scoped)
    const globalConflict = await User.findOne({
      email: cleanEmail,
      role: { $in: ['customer', 'superadmin'] },
    });
    if (globalConflict) {
      return res.status(400).json({
        success: false,
        message: 'This email is already registered to a customer or platform account. Use a different email.',
      });
    }

    if (tenant) {
      const sameTenantConflict = await User.findOne({
        email: cleanEmail,
        restaurant: tenant,
        role: { $in: ['admin', 'manager', 'waiter', 'captain', 'chef'] },
      });
      if (sameTenantConflict) {
        return res.status(400).json({
          success: false,
          message: 'A staff member with this email already exists in this restaurant.',
        });
      }
    }

    if (!['chef', 'waiter', 'captain', 'admin', 'manager'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid staff role' });
    }
    if (!opsRoleInUse(req, role)) return res.status(400).json(roleNotInUseBody(role));

    // ── Privilege-escalation guard ───────────────────────────────────
    // Creating a `role: 'admin'` is a tenant-owner decision regardless
    // of whether the caller is branch-pinned. A tenant-wide Manager has
    // adminOnly access for day-to-day staffing (waiter/captain/chef/
    // manager) but must NOT be able to mint admins — that would let a
    // Manager spawn an account with full checkPermission bypass and
    // sidestep their own granular permission flags. The dedicated
    // /branches/:id/subadmin route stays the canonical path for hiring
    // a Branch Admin (it's already owner-exclusive).
    if (role === 'admin' && req.user?.isTenantOwner !== true) {
      return res.status(403).json({
        success: false,
        code: 'OWNER_ONLY_ROLE',
        message: 'Only the restaurant owner can hire another Admin. Use the Branches tab.',
      });
    }
    // A Manager may only hire floor staff (waiter / chef / captain).
    if (!canManageStaffRole(req.user?.role, role)) {
      return res.status(403).json(ROLE_ADMIN_ONLY_BODY);
    }

    // Permissions are Admin-only — same rule as updateStaff. A Manager
    // may submit the role defaults unchanged (the modal always echoes an
    // object) but cannot hire someone with keys beyond them.
    const permsSupplied = req.body.permissions;
    if (req.user?.role !== 'admin' && permsSupplied !== undefined && permsSupplied !== null
        && permissionsChanged(resolvePermissions(role, undefined), resolvePermissions(role, permsSupplied))) {
      return res.status(403).json({
        success: false,
        code: 'PERMISSIONS_ADMIN_ONLY',
        message: 'Only an Admin can change staff permissions.',
      });
    }

    // ── Phase A2: enforce plan's maxStaff limit ──────────────────────
    // Fast pre-check for a friendly early 403; the authoritative check is
    // re-run inside the insert transaction below (race-safe).
    const maxStaff = req.restaurant?.getLimit?.('maxStaff') || 5;
    const limitBody = (current) => ({
      success: false,
      code: 'STAFF_LIMIT_REACHED',
      message: `Your plan allows ${maxStaff} staff members. You currently have ${current} active. Upgrade your plan to add more.`,
      current,
      limit: maxStaff,
    });
    const countActiveStaff = (session) => User.countDocuments({
      ...tenantFilter(req),
      role: { $in: ['admin', 'manager', 'waiter', 'captain', 'chef'] },
      status: 'active',
    }).session(session || null);
    const activeStaffCount = await countActiveStaff();
    if (activeStaffCount >= maxStaff) {
      return res.status(403).json(limitBody(activeStaffCount));
    }

    // Phase 6 step 4 — branch assignment.
    //   Sub Admin (pinned): FORCED to add staff at their own branch.
    //                       body.branch is silently overridden.
    //   Tenant owner: '' / null = tenant-level staff (sees all branches);
    //                 ObjectId  = pinned to that branch (validated).
    let assignedBranchId = null;
    const pinned = pinnedBranchId(req);
    const Branch = require('../models/branch');
    if (pinned) {
      assignedBranchId = pinned;
    } else if (rawBranch) {
      if (!mongoose.isValidObjectId(rawBranch)) {
        return res.status(400).json({ success: false, message: 'Invalid branch id' });
      }
      const exists = await Branch.exists({
        _id: rawBranch,
        ...tenantFilter(req),
        isActive: true,
      });
      if (!exists) {
        return res.status(400).json({
          success: false,
          message: 'Branch not found or not part of your restaurant',
        });
      }
      assignedBranchId = rawBranch;
    } else if (role !== 'admin' && role !== 'manager') {
      // Floor staff (waiter / captain / chef) must be pinned to a
      // branch whenever the tenant has any. Otherwise they land in the
      // Staff Management "Unassigned" bucket forever — the user-
      // reported bug that backfillStaffToMainBranch.js exists to clean
      // up.
      //
      // Admin and Manager are exempt by design: both are tenant-level
      // supervisors expected to oversee every branch. The admin can
      // still optionally pin a manager to a single branch (e.g. a
      // Branch Manager who runs one location only) by selecting one
      // explicitly — but a blank pick is allowed and means "tenant-
      // wide".
      const hasBranches = await Branch.exists({
        ...tenantFilter(req),
        isActive: true,
      });
      if (hasBranches) {
        return res.status(400).json({
          success: false,
          code: 'BRANCH_REQUIRED',
          message: 'Please select a branch for this staff member.',
        });
      }
    }

    // ── Resolve area / table assignments (waiter / captain only) ────────
    const assign = await resolveAreaTableAssignments(req, {
      role,
      branchId: assignedBranchId,
      rawAreas,
      rawTables,
    });
    if (!assign.ok) {
      return res.status(400).json({ success: false, message: assign.message });
    }

    // ── Generate unique temp password ───────────────────────────────────
    const tempPassword = generateTempPassword();

    // ── Resolve staff ID per (tenant, branch) ───────────────────────────
    // The frontend modal shows a *preview* staffId fetched at mount time
    // (before the admin picks a branch). By the time submit fires, that
    // preview may collide with another staff member at the SELECTED
    // branch — either because the admin opened the modal again after
    // creating a previous staff member, or because the preview was
    // computed against the tenant-level (branch=null) bucket instead
    // of the chosen branch. To make the flow bullet-proof, we recompute
    // the next free ID for the resolved (tenant, branch) here and only
    // accept the client-supplied `staffId` if it is genuinely available
    // in that scope. Falling back to the auto-generated value eliminates
    // the "duplicate key on EMP-XXX" 500 the admin used to hit.
    const tf = tenantFilter(req);
    let finalStaffId = staffId;
    if (finalStaffId) {
      const conflict = await User.exists({
        staffId: finalStaffId,
        ...tf,
        branch: assignedBranchId || null,
      });
      if (conflict) finalStaffId = null;
    }
    if (!finalStaffId) {
      finalStaffId = await getNextStaffIdForBranch(tf, assignedBranchId);
    }

    const staffFields = {
      name: name.trim(),
      email: email.trim(),     // schema handles lowercase
      password: tempPassword,           // hashed by pre-save hook
      mobile,
      role,
      staffId: finalStaffId,
      restaurant: tenantId(req),        // link to current tenant
      branch: assignedBranchId,         // Phase 6 step 4 — per-branch assignment (null = tenant-level)
      kitchenResponsibility: role === 'chef' ? (kitchenResponsibility || 'both') : '',
      assignedAreas: assign.areaIds,
      assignedTables: assign.tableIds,
      // Takeaway handler flag — only meaningful for waiter/captain.
      handlesTakeaway: (role === 'waiter' || role === 'captain') ? req.body.handlesTakeaway === true : false,
      avatar: req.body.avatar || '',    // empty string = frontend generates initials locally
      // Apply role defaults when the caller omits permissions (seed
      // scripts, direct API clients). The modal always sends an
      // explicit object so its "Reset to None" affordance still works.
      // Non-admins were held to the role defaults above.
      permissions: req.user?.role === 'admin' ? resolvePermissions(role, req.body.permissions) : resolvePermissions(role, undefined),
      status: 'active',
      mustChangePassword: true          // force password change on first login
    };

    // Race-safe maxStaff: re-count and insert inside one transaction that
    // also writes a per-tenant lock row. Concurrent hires (even into
    // different branches, where the staffId index doesn't collide) hit a
    // WriteConflict on the lock row; the driver retries the loser, whose
    // fresh count now sees the winner and is refused.
    let staffMember;
    let limitHit = null;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        limitHit = null;
        const current = await countActiveStaff(session);
        if (current >= maxStaff) { limitHit = current; return; }
        await mongoose.connection.collection('staff_limit_locks').updateOne(
          { _id: tenantId(req) },
          { $inc: { seq: 1 } },
          { upsert: true, session },
        );
        // Fresh document per attempt so a retried transaction never
        // re-hashes an already hashed password.
        staffMember = new User(staffFields);
        await staffMember.save({ session });
      });
    } finally {
      await session.endSession();
    }
    if (limitHit !== null) {
      return res.status(403).json(limitBody(limitHit));
    }

    // Return the plain-text temp password so the admin can share it with
    // the staff member.  This is the ONLY time it is ever available — the
    // database only stores the bcrypt hash.
    res.status(201).json({
      success: true,
      staffMember,
      tempPassword                      // shown once in the admin UI
    });
  } catch (error) {
    // ── Mongoose schema validation failure ──────────────────────────
    // Happens when a value passes this controller's own checks above
    // but violates a stricter rule in the User schema (custom regex
    // validators, enum, maxlength, etc). Previously fell through to the
    // generic 500 below with no useful message for the admin — now
    // surfaces the exact field + reason as a proper 400.
    if (error.name === 'ValidationError') {
      const firstField = Object.keys(error.errors)[0];
      const firstMessage = error.errors[firstField]?.message || 'Validation failed';
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        field: firstField,
        message: firstMessage,
      });
    }

    // ── Duplicate key (E11000) ──────────────────────────────────────
    // Can still happen despite the pre-checks above under a race
    // condition (two admins submitting the same email/staffId at the
    // same instant) since the pre-checks and the save() aren't atomic.
    // The unique indexes are the real guarantee; this just turns the
    // resulting Mongo error into a clean, specific 409 instead of a 500.
    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern || {})[0] || 'field';
      const friendlyField = { email: 'Email', staffId: 'Staff ID', mobile: 'Mobile number' }[duplicateField] || duplicateField;
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_KEY',
        field: duplicateField,
        message: `${friendlyField} is already in use.`,
      });
    }

    // ── Malformed ObjectId thrown outside an explicit isValidObjectId
    // check (e.g. inside a nested helper like resolveAreaTableAssignments) ──
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        code: 'INVALID_ID',
        message: `Invalid value provided for ${error.path}.`,
      });
    }

    // ── Genuinely unexpected failure — log full detail server-side,
    // return a generic message to the client ────────────────────────
    logger.error('addStaff failed: ' + error.message, { stack: error.stack });
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Failed to create staff member. Please try again or contact support.',
    });
  }
};

// Update staff status
exports.updateStaffStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    // Look up the row first so the branch gate can inspect it BEFORE
    // we mutate. findOneAndUpdate-then-check would leak the toggle in
    // the cross-branch case.
    const target = await User.findOne({ _id: id, ...tenantFilter(req) });
    if (!target) return res.status(404).json({ success: false, message: 'Staff member not found' });

    // Same safety rails as deleteStaff: nobody deactivates their own
    // account (it revokes every session) and the tenant owner — the only
    // account that manages billing / branches — can't be deactivated here.
    if (status === 'inactive') {
      if (req.user && String(target._id) === String(req.user._id || req.user.id)) {
        return res.status(400).json({
          success: false,
          code: 'CANNOT_DEACTIVATE_SELF',
          message: 'You cannot deactivate your own account.',
        });
      }
      if (target.isTenantOwner === true) {
        return res.status(403).json({
          success: false,
          code: 'CANNOT_DEACTIVATE_OWNER',
          message: 'The restaurant owner account cannot be deactivated.',
        });
      }
    }

    const gate = staffBranchGate(req, target);
    if (gate) return res.status(gate.status).json(gate.body);

    const roleGate = staffRoleGate(req, target);
    if (roleGate) return res.status(roleGate.status).json(roleGate.body);

    const rankGate = adminTargetGate(req, target);
    if (rankGate) return res.status(rankGate.status).json(rankGate.body);

    target.status = status;
    await target.save();
    // Deactivation logs the staff member out everywhere.
    if (status === 'inactive') await revokeAllSessions(target._id);

    res.status(200).json({ success: true, staff: target });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
};

// Update staff member
exports.updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, mobile, role, staffId, avatar, permissions, kitchenResponsibility, branch: rawBranch, assignedAreas: rawAreas, assignedTables: rawTables } = req.body;

    // ── Branch isolation — Sub Admin / Branch Manager can only edit
    //    rows from their own branch. Look up the existing record once
    //    before doing any validation so the gate fires BEFORE we surface
    //    "this email is already in use" style errors against a target
    //    the caller can't actually see anyway.
    const tfPre = tenantFilter(req);
    const existing = await User.findOne({ _id: id, ...tfPre });
    if (!existing) return res.status(404).json({ success: false, message: 'Staff member not found' });

    const gate = staffBranchGate(req, existing);
    if (gate) return res.status(gate.status).json(gate.body);

    const roleGate = staffRoleGate(req, existing);
    if (roleGate) return res.status(roleGate.status).json(roleGate.body);

    const rankGate = adminTargetGate(req, existing);
    if (rankGate) return res.status(rankGate.status).json(rankGate.body);

    // Only the tenant owner can promote any staff to `role: 'admin'` —
    // same privilege-escalation rule as addStaff. A tenant-wide Manager
    // cannot upgrade a row to admin (which would gain checkPermission
    // bypass) and a Branch Admin obviously cannot mint another admin.
    if (role === 'admin' && existing.role !== 'admin' && req.user?.isTenantOwner !== true) {
      return res.status(403).json({
        success: false,
        code: 'OWNER_ONLY_ROLE',
        message: 'Only the restaurant owner can promote a staff member to Admin.',
      });
    }

    // A Manager may only edit floor staff (waiter / chef / captain) and
    // may only assign one of those roles — no editing other Managers and
    // no promoting anyone to Manager.
    if (!canManageStaffRole(req.user?.role, role)) {
      return res.status(403).json(ROLE_ADMIN_ONLY_BODY);
    }

    // Permissions are Admin-only. A Manager (who reaches this endpoint via
    // the manageStaff permission) may not grant or revoke permission flags
    // — otherwise they could hand out keys they don't hold themselves
    // (e.g. `refund`) or escalate their own account. The edit form always
    // echoes the permissions object back, so an UNCHANGED object is
    // accepted and simply not written.
    let permissionsToWrite = permissions;
    if (req.user?.role !== 'admin' && permissions !== undefined && permissions !== null) {
      const baseline = resolvePermissions(existing.role, existing.permissions);
      if (permissionsChanged(baseline, permissions)) {
        return res.status(403).json({
          success: false,
          code: 'PERMISSIONS_ADMIN_ONLY',
          message: 'Only an Admin can change staff permissions.',
        });
      }
      permissionsToWrite = undefined;
    }

    // Validate email format if provided
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ success: false, message: 'Invalid email format' });
      }
      // R-10: layered duplicate check mirrors addStaff:
      //   (a) Global customers/superadmins own their email uniquely —
      //       staff cannot collide with them.
      //   (b) Same-tenant staff email must be unique per tenant.
      //   (c) A staff member at ANOTHER tenant with this email is a
      //       different real person at a different restaurant — allowed.
      //
      // The old one-liner `findOne({ email, _id:{$ne:id} })` was both
      // too strict (rejected legitimate cross-tenant reuse) AND an info
      // leak (admin-A could confirm whether any email existed anywhere
      // in the platform by trying to update staff to it).
      const cleanEmail = email.toLowerCase().trim();
      // AUDIT-EXEMPT: platform-wide email uniqueness vs global customer/superadmin identities (User is not tenant-scoped)
      const globalConflict = await User.findOne({
        email: cleanEmail,
        role: { $in: ['customer', 'superadmin'] },
        _id: { $ne: id },
      });
      if (globalConflict) {
        return res.status(400).json({
          success: false,
          message: 'This email is already registered to a customer or platform account. Use a different email.',
        });
      }
      const sameTenantConflict = await User.findOne({
        email: cleanEmail,
        _id: { $ne: id },
        role: { $in: ['admin', 'manager', 'waiter', 'captain', 'chef'] },
        ...tenantFilter(req),
      });
      if (sameTenantConflict) {
        return res.status(400).json({
          success: false,
          message: 'A staff member with this email already exists in this restaurant.',
        });
      }
    }

    // Validate mobile if provided
    if (mobile && !/^\d{10}$/.test(mobile.replace(/\s+/g, ''))) {
      return res.status(400).json({ success: false, message: 'Mobile number must be exactly 10 digits' });
    }

    // Reject unknown roles early so we don't silently persist garbage
    // when an updated client sends a typo.
    if (role !== undefined && !['chef', 'waiter', 'captain', 'admin', 'manager'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid staff role' });
    }
    // Moving someone INTO a role the restaurant doesn't use is refused;
    // editing an existing waiter's name etc. (role unchanged) still works.
    if (role !== undefined && role !== existing.role && !opsRoleInUse(req, role)) {
      return res.status(400).json(roleNotInUseBody(role));
    }

    const updateData = { name, email, mobile, role, staffId, avatar, permissions: permissionsToWrite, kitchenResponsibility };

    // ── Area / table assignments ─────────────────────────────────────
    // Only touch the fields when the client actually sent them — that
    // way a partial update (e.g. just renaming the staff) doesn't wipe
    // a previously-saved assignment. Validation needs the staff's
    // effective role + branch — we already pulled the full record up
    // top for the branch-isolation gate, so reuse `existing` instead
    // of doing a second round trip.
    if (
      Object.prototype.hasOwnProperty.call(req.body, 'assignedAreas') ||
      Object.prototype.hasOwnProperty.call(req.body, 'assignedTables')
    ) {
      const effectiveRole = role || existing?.role;
      // Branch in updateData may not be set yet — re-evaluate from the
      // body explicitly so we don't validate against the OLD branch
      // when the admin changes both at once.
      let effectiveBranch = existing?.branch || null;
      if (Object.prototype.hasOwnProperty.call(req.body, 'branch')) {
        effectiveBranch = (rawBranch === null || rawBranch === '' || rawBranch === undefined) ? null : rawBranch;
      }
      const assign = await resolveAreaTableAssignments(req, {
        role: effectiveRole,
        branchId: effectiveBranch,
        rawAreas,
        rawTables,
      });
      if (!assign.ok) {
        return res.status(400).json({ success: false, message: assign.message });
      }
      updateData.assignedAreas = assign.areaIds;
      updateData.assignedTables = assign.tableIds;
    }

    // Takeaway handler flag — accept when supplied (waiter/captain only).
    if (Object.prototype.hasOwnProperty.call(req.body, 'handlesTakeaway')) {
      const effectiveRole = role || existing?.role;
      updateData.handlesTakeaway =
        (effectiveRole === 'waiter' || effectiveRole === 'captain') && req.body.handlesTakeaway === true;
    }

    // When role changes away from waiter/captain, wipe any stale
    // assignments — they're meaningless for chef/manager/admin.
    if (role && role !== 'waiter' && role !== 'captain') {
      updateData.assignedAreas = [];
      updateData.assignedTables = [];
      updateData.handlesTakeaway = false;
    }

    // Phase 6 step 4 — accept optional branch change. Explicit null /
    // empty string clears the assignment (staff becomes tenant-level).
    // Absent key = existing assignment preserved.
    if (Object.prototype.hasOwnProperty.call(req.body, 'branch')) {
      const Branch = require('../models/branch');
      const callerBranchForUpdate = pinnedBranchId(req);

      // Pinned callers (Branch Admin / branch-pinned Manager) cannot
      // re-pin a staff member to a different branch — that would let
      // a Branch Admin at A "donate" a waiter to Branch B (or pull
      // a staff member from B to A). We allow the no-op (rawBranch
      // equals their own pin); anything else is rejected.
      if (callerBranchForUpdate && rawBranch && String(rawBranch) !== String(callerBranchForUpdate)) {
        return res.status(403).json({
          success: false,
          code: 'BRANCH_LOCKED',
          message: 'You can only assign staff to your own branch.',
        });
      }
      // Pinned callers also can't blank the branch — clearing pins
      // means "make this a tenant-level supervisor", which only the
      // owner should be able to do.
      if (callerBranchForUpdate && (rawBranch === null || rawBranch === '' || rawBranch === undefined)) {
        return res.status(403).json({
          success: false,
          code: 'BRANCH_LOCKED',
          message: 'Only the restaurant owner can move a staff member to tenant-level.',
        });
      }

      if (rawBranch === null || rawBranch === '' || rawBranch === undefined) {
        // Clearing the branch is allowed for admin (tenant owner) and
        // manager (tenant-level supervisor) — both oversee every branch
        // by design. Floor staff (waiter / captain / chef) must stay
        // pinned to avoid the "Unassigned" bucket, unless the tenant
        // has no branches at all. Reuse `existing` from the top of this
        // function instead of issuing a second findOne.
        const effectiveRole = role || existing?.role;
        if (effectiveRole && effectiveRole !== 'admin' && effectiveRole !== 'manager') {
          const hasBranches = await Branch.exists({
            ...tenantFilter(req),
            isActive: true,
          });
          if (hasBranches) {
            return res.status(400).json({
              success: false,
              code: 'BRANCH_REQUIRED',
              message: 'Please select a branch for this staff member.',
            });
          }
        }
        updateData.branch = null;
      } else if (!mongoose.isValidObjectId(rawBranch)) {
        return res.status(400).json({ success: false, message: 'Invalid branch id' });
      } else {
        const exists = await Branch.exists({
          _id: rawBranch,
          ...tenantFilter(req),
          isActive: true,
        });
        if (!exists) {
          return res.status(400).json({
            success: false,
            message: 'Branch not found or not part of your restaurant',
          });
        }
        updateData.branch = rawBranch;
      }
    }

    // Clear kitchenResponsibility when role changes away from chef
    if (role && role !== 'chef') {
      updateData.kitchenResponsibility = '';
    }

    // Drop undefined fields, and never let an explicit null / blank wipe a
    // required value (name, email, role, staffId, permissions); mobile /
    // kitchenResponsibility null means "clear" → ''. updateData is built
    // from named fields only, so restaurant etc. can't ride along.
    const cleanUpdate = cleanStaffUpdate(updateData);

    const staff = await User.findOneAndUpdate(
      { _id: id, ...tenantFilter(req) },
      cleanUpdate,
      { returnDocument: 'after', runValidators: true }
    ).select('-password');
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });

    res.status(200).json({ success: true, staff });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update staff member' });
  }
};

// Delete staff member
exports.deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const tf = tenantFilter(req);

    // Look up the target first (don't delete yet) so we can enforce
    // branch isolation + a few common-sense safety rails BEFORE the
    // row is gone.
    const target = await User.findOne({ _id: id, ...tf });
    if (!target) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    // Self-delete guard — a Branch Manager hitting "delete" on their own
    // row would lock themselves out of the system. The UI hides the
    // delete button on the caller's own row, but a hand-crafted request
    // could still try.
    if (req.user && String(target._id) === String(req.user._id || req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account.',
      });
    }

    // Never let anyone delete the tenant owner — that wipes the only
    // account that can manage subscription, branches, billing, etc.
    if (target.isTenantOwner === true) {
      return res.status(403).json({
        success: false,
        code: 'CANNOT_DELETE_OWNER',
        message: 'The restaurant owner account cannot be deleted from this screen.',
      });
    }

    // ── Branch isolation — Sub Admin / branch-pinned Manager can only
    // delete staff who actually belong to their own branch. Without this
    // gate a pinned caller at Branch A could DELETE /staff/<id-from-Branch-B>
    // and wipe a staff record they have no business touching. We allow
    // tenant-level staff (target.branch == null) to be deleted only by
    // unpinned (tenant-owner / tenant-level manager) callers — pinned
    // callers can't reach tenant-level rows either, because those rows
    // belong to the org, not to one branch.
    const callerBranch = pinnedBranchId(req);
    if (callerBranch) {
      const targetBranch = target.branch ? String(target.branch) : null;
      if (!targetBranch || targetBranch !== String(callerBranch)) {
        return res.status(403).json({
          success: false,
          code: 'BRANCH_MISMATCH',
          message: 'You can only delete staff from your own branch.',
        });
      }
    }

    // ── Rank gate — a Manager (or anyone non-owner) cannot fire an
    // Admin row, even within their own branch. Mirrors addStaff /
    // updateStaff which already prevent CREATING / PROMOTING-TO admin
    // without owner rights.
    const roleGate = staffRoleGate(req, target);
    if (roleGate) return res.status(roleGate.status).json(roleGate.body);

    const rankGate = adminTargetGate(req, target);
    if (rankGate) return res.status(rankGate.status).json(rankGate.body);

    await revokeAllSessions(target._id);
    await User.deleteOne({ _id: target._id });
    res.status(200).json({ success: true, message: 'Staff member removed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete staff member' });
  }
};

// Get staff performance metrics
exports.getStaffPerformance = async (req, res) => {
  try {
    const { id } = req.params;
    const tf = tenantFilter(req);
    const staff = await User.findOne({ _id: id, ...tf }).select('-password');
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });

    // Branch isolation — a pinned caller only sees their own branch's
    // staff metrics (same gate as update / status / delete / reset).
    const gate = staffBranchGate(req, staff);
    if (gate) return res.status(gate.status).json(gate.body);

    const role = staff.role;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // "This Week" = current calendar week (Sunday → today), matching the
    // semantics used in shiftController.getMyShifts. Previously this was
    // "last 7 days" which made the modal's "This Week" disagree with
    // every other dashboard.
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

    if (role === 'chef') {
      // Chef performance — based on orders assigned to this chef (per-tenant)
      const [totalOrders, todayOrders, weekOrders, delayedOrders, allCompletedOrders] = await Promise.all([
        Order.countDocuments({ chef: id, status: { $in: ['ready', 'served'] }, ...tf }),
        Order.countDocuments({ chef: id, status: { $in: ['ready', 'served'] }, createdAt: { $gte: todayStart }, ...tf }),
        Order.countDocuments({ chef: id, status: { $in: ['ready', 'served'] }, createdAt: { $gte: weekStart }, ...tf }),
        // Delayed = preparation took more than 20 minutes
        Order.countDocuments({
          ...tf,
          chef: id,
          preparationStartedAt: { $exists: true },
          preparationCompletedAt: { $exists: true },
          $expr: {
            $gt: [
              { $subtract: ['$preparationCompletedAt', '$preparationStartedAt'] },
              20 * 60 * 1000 // 20 minutes in ms
            ]
          },
        }),
        // All completed orders with prep times for avg calculation
        Order.find({
          chef: id,
          preparationStartedAt: { $exists: true },
          preparationCompletedAt: { $exists: true },
          ...tf,
        }).select('preparationStartedAt preparationCompletedAt').lean()
      ]);

      // Calculate average preparation time in minutes
      let avgPrepTime = 0;
      if (allCompletedOrders.length > 0) {
        const totalMs = allCompletedOrders.reduce((sum, o) => {
          return sum + (new Date(o.preparationCompletedAt) - new Date(o.preparationStartedAt));
        }, 0);
        avgPrepTime = Math.round(totalMs / allCompletedOrders.length / 60000); // ms → minutes
      }

      return res.status(200).json({
        success: true,
        performance: {
          role: 'chef',
          kotCompleted: totalOrders,
          todayKot: todayOrders,
          weekKot: weekOrders,
          delayedOrders,
          avgPrepTime,
        }
      });
    }

    if (role === 'waiter' || role === 'captain') {
      // Waiter/Captain performance — based on orders assigned to this user (per-tenant).
      //
      // Two metrics, not one:
      //   "ordersHandled" — every non-cancelled order this user took (any status).
      //                     This is the activity volume — pending + preparing
      //                     + ready + served all count, because the captain
      //                     did real work to place each one.
      //   "ordersServed" — subset that reached 'served'. The completed handover.
      //                    Revenue only counts these, because pending/cancelled
      //                    orders haven't actually earned money yet.
      //
      // Previously this endpoint only returned 'served' counts, which made
      // a captain who placed many in-flight orders look idle. Captains in
      // particular tend to place orders and hand off the table to a waiter
      // for serving, so 'served' alone undercounted them severely.
      const waiterObjectId = new (require('mongoose').Types.ObjectId)(id);
      // A pay-first order held until paid ('awaiting-payment') isn't
      // handled work yet — it only counts once it is released.
      const handledStatuses = { $nin: ['cancelled', 'awaiting-payment'] };

      const [
        totalHandled, todayHandled, weekHandled,
        totalServed, todayServed, weekServed,
        revenueAgg,
      ] = await Promise.all([
        Order.countDocuments({ waiter: id, status: handledStatuses, ...tf }),
        Order.countDocuments({ waiter: id, status: handledStatuses, createdAt: { $gte: todayStart }, ...tf }),
        Order.countDocuments({ waiter: id, status: handledStatuses, createdAt: { $gte: weekStart }, ...tf }),
        Order.countDocuments({ waiter: id, status: 'served', ...tf }),
        Order.countDocuments({ waiter: id, status: 'served', createdAt: { $gte: todayStart }, ...tf }),
        Order.countDocuments({ waiter: id, status: 'served', createdAt: { $gte: weekStart }, ...tf }),
        // Revenue from served orders only — pending/cancelled orders
        // haven't earned anything yet. Single aggregate buckets revenue
        // into lifetime / today / week.
        Order.aggregate([
          { $match: { waiter: waiterObjectId, status: 'served', ...tf } },
          {
            $group: {
              _id: null,
              total: { $sum: '$total' },
              today: {
                $sum: { $cond: [{ $gte: ['$createdAt', todayStart] }, '$total', 0] },
              },
              week: {
                $sum: { $cond: [{ $gte: ['$createdAt', weekStart] }, '$total', 0] },
              },
            },
          },
        ]),
      ]);

      const round2 = (n) => Math.round((n || 0) * 100) / 100;
      const totalRevenue = round2(revenueAgg[0]?.total);
      const todayRevenue = round2(revenueAgg[0]?.today);
      const weekRevenue = round2(revenueAgg[0]?.week);

      return res.status(200).json({
        success: true,
        performance: {
          role,
          ordersHandled: totalHandled,
          todayHandled,
          weekHandled,
          ordersServed: totalServed,
          todayServed,
          weekServed,
          totalRevenue,
          todayRevenue,
          weekRevenue,
        }
      });
    }

    // Manager or other roles — general stats
    return res.status(200).json({
      success: true,
      performance: { role, message: 'No performance metrics for this role' }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch performance', ...devError(error) });
  }
};

// Reset staff member's password.
// Branch Admins / Managers can reset for their OWN branch only.
// Tenant-level callers can reset for anyone in the tenant.
exports.resetStaffPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const tf = tenantFilter(req);
    const staff = await User.findOne({ _id: id, ...tf });
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });

    // Self-reset is fine in principle, but the dedicated /auth/me
    // change-password route is the documented path. Forcing the user
    // to use that route keeps the audit trail clean and avoids the
    // surprising "I reset my own password and now I have to look up
    // the temp value" UX.
    if (req.user && String(staff._id) === String(req.user._id || req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'Use the change-password screen to reset your own password.',
      });
    }

    // Never let anyone reset the tenant owner from here — the owner's
    // password recovery goes through the Super Admin / email-reset
    // flows, not the per-tenant staff console.
    if (staff.isTenantOwner === true) {
      return res.status(403).json({
        success: false,
        code: 'CANNOT_RESET_OWNER',
        message: 'The restaurant owner password cannot be reset from this screen.',
      });
    }

    // ── Branch isolation — pinned callers (Sub Admin / branch-pinned
    //    Manager) can only reset passwords for staff who actually
    //    belong to their own branch. Without this gate, a Branch Admin
    //    at A could rotate the password of a staff at Branch B and
    //    silently lock them out.
    const callerBranch = pinnedBranchId(req);
    if (callerBranch) {
      const targetBranch = staff.branch ? String(staff.branch) : null;
      if (!targetBranch || targetBranch !== String(callerBranch)) {
        return res.status(403).json({
          success: false,
          code: 'BRANCH_MISMATCH',
          message: 'You can only reset passwords for staff in your own branch.',
        });
      }
    }

    // ── Rank gate — a Manager cannot rotate an Admin's password
    // (which would functionally lock the Admin out until the temp is
    // shared). Owner-only, same rule as delete / update / status.
    const roleGate = staffRoleGate(req, staff);
    if (roleGate) return res.status(roleGate.status).json(roleGate.body);

    const rankGate = adminTargetGate(req, staff);
    if (rankGate) return res.status(rankGate.status).json(rankGate.body);

    const tempPassword = generateTempPassword();
    staff.password = tempPassword;        // hashed by pre-save hook
    staff.mustChangePassword = true;
    await staff.save();
    // Kill every existing session so the old password's logins die now.
    await revokeAllSessions(staff._id);
    // A fresh password must be usable at once — drop any login lockout
    // the old (forgotten) password accumulated.
    await clearLoginLock(req, staff, 'reset-password');

    res.status(200).json({ success: true, tempPassword });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
};

/**
 * Clear the per-account login lockout for `staff` (utils/loginAttempts.js)
 * and log who did it. Best-effort: never throws out of the caller.
 * Returns true when a counter / lock row actually existed.
 */
async function clearLoginLock(req, staff, via) {
  const key = loginAttempts.accountKey({ user: staff });
  try {
    const existed = await loginAttempts.clear(key);
    logger.info('auth.account.unlocked', {
      accountKey: loginAttempts.maskKey(key),
      staffId: String(staff._id),
      actorId: String(req.user?._id || req.user?.id || ''),
      actorRole: req.user?.role || '',
      via,
      hadLock: existed,
      ip: req.ip,
    });
    return existed;
  } catch (err) {
    logger.error('auth.account.unlock-failed', { staffId: String(staff._id), error: err.message });
    return false;
  }
}

// POST /api/staff/:id/unlock-login — clear a staff member's login lockout
// (10 failed passwords in 15 min, utils/loginAttempts.js) before it
// expires on its own. Tenant-scoped (404 for another tenant's staff);
// pinned callers may only unlock staff in their own branch.
exports.unlockStaffLogin = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await User.findOne({ _id: id, ...tenantFilter(req) }).select('email role restaurant branch');
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });

    const branchGate = staffBranchGate(req, staff);
    if (branchGate) return res.status(branchGate.status).json(branchGate.body);

    const hadLock = await clearLoginLock(req, staff, 'unlock-login');
    res.status(200).json({
      success: true,
      unlocked: hadLock,
      message: hadLock ? 'Login unlocked. The staff member can sign in again now.' : 'This account was not locked.',
    });
  } catch (error) {
    logger.error('unlockStaffLogin error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to unlock login' });
  }
};

// ── BULK ONBOARDING ──────────────────────────────────────────────────────────
// Mirror of the Tables bulk-import flow. Lets an owner roster their entire
// team in one upload: download a starter CSV with sample rows → edit in
// Excel → upload → backend auto-creates user accounts, generates temp
// passwords (one per staff), returns them all in the response so the admin
// can hand them out.

// Path to the curated starter CSV shipped with the backend.
const STAFF_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'staff-master-template.csv');

// GET /api/staff/template — stream the starter sheet as an attachment.
exports.downloadStaffTemplate = (req, res) => {
  try {
    if (!fs.existsSync(STAFF_TEMPLATE_PATH)) {
      logger.error('Staff template missing on disk', { path: STAFF_TEMPLATE_PATH });
      return res.status(500).json({ success: false, message: 'Starter template not available' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="staff-master-template.csv"');
    // No-store mirrors the tables-template route — template updates should
    // surface to existing admins immediately, not wait for a cache TTL.
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(STAFF_TEMPLATE_PATH).pipe(res);
  } catch (error) {
    logger.error('downloadStaffTemplate error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to serve template' });
  }
};

// Roles a bulk-uploaded staff member is allowed to take. `customer` and
// `superadmin` are deliberately excluded — those identities are global /
// platform-level and have no business being created from a per-tenant
// admin CSV.
const BULK_STAFF_ROLES = new Set(['admin', 'manager', 'captain', 'chef', 'waiter']);

// ── Operations profile: roles the restaurant doesn't use ─────────────
// A self-service restaurant (no waiters / captain / kitchen screen) can't
// hire into those roles. Profile-only (utils/operationsProfile.profileFlow),
// NOT plan-intersected: a plan without the waiter app could always create
// waiter accounts, and a tenant that never set a profile must not change.
function opsRoleInUse(req, role) {
  if (!['waiter', 'captain', 'chef'].includes(role) || !req.restaurant) return true;
  const { profileFlow } = require('../utils/operationsProfile');
  return profileFlow(req.restaurant).roles[role] !== false;
}
function roleNotInUseBody(role) {
  const label = { waiter: 'waiters', captain: 'captains', chef: 'a kitchen screen (chef)' }[role] || role;
  return {
    success: false,
    code: 'ROLE_NOT_IN_USE',
    role,
    message: `Your restaurant is set up without ${label}. Contact BestoDine support to change how your restaurant operates.`,
  };
}

// POST /api/staff/import
// Body: multipart/form-data with:
//   file   = .csv (header: name,email,role,mobile — `mobile` is optional)
//   branch = optional ObjectId. The whole batch goes to this branch.
//            Sub Admins: ignored (force-pinned to their own branch).
//            Tenant owner: derived from the admin UI's current branch
//            switcher value; blank/empty = tenant-level staff.
//
// - Per-row CSV branch overrides were dropped: the admin is already in a
//   specific branch context when they hit "Bulk Add", so per-row picks
//   in the CSV add noise without value and were a frequent source of typos.
// - Pre-flight plan-limit check: if the CSV would push the active staff
//   count past the plan's maxStaff, the WHOLE batch is rejected.
// - Returns { success, created, skipped, errors, tempPasswords:[{email, tempPassword}] }.
exports.importStaffCsv = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'CSV file is required (form field: file)' });
    }

    const rows = parseCsv(req.file.buffer.toString('utf8'));
    if (rows.length < 2) {
      return res.status(400).json({ success: false, message: 'CSV must contain a header row and at least one data row' });
    }

    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = {
      name: header.indexOf('name'),
      email: header.indexOf('email'),
      role: header.indexOf('role'),
      mobile: header.indexOf('mobile'),   // optional
    };
    const missing = ['name', 'email', 'role'].filter(col => idx[col] === -1);
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `CSV missing required columns: ${missing.join(', ')}`,
      });
    }

    const tenant = tenantId(req);
    if (!tenant) {
      return res.status(400).json({ success: false, message: 'Tenant context required for bulk import' });
    }
    const tf = tenantFilter(req);
    const pinned = pinnedBranchId(req);

    // ── Resolve the SINGLE target branch for this whole upload ────────
    // Priority:
    //   1. Sub Admin uploader → forced to their own pinned branch.
    //   2. Tenant owner + `branch` form field set → that branch (validated).
    //   3. Tenant owner + no field → tenant-level (null). Floor staff
    //      will then fail the branch-required gate, which is fine — the
    //      admin gets a clear row-level error telling them to switch
    //      branches in the UI before re-uploading.
    let targetBranchId = null;
    if (pinned) {
      targetBranchId = pinned;
    } else if (req.body?.branch) {
      const raw = String(req.body.branch).trim();
      if (raw && raw !== 'null' && raw !== 'tenant-only') {
        if (!mongoose.isValidObjectId(raw)) {
          return res.status(400).json({ success: false, message: 'Invalid branch id in upload' });
        }
        const exists = await Branch.exists({ _id: raw, ...tf, isActive: true });
        if (!exists) {
          return res.status(400).json({
            success: false,
            message: 'Selected branch not found or not part of your restaurant.',
          });
        }
        targetBranchId = new mongoose.Types.ObjectId(raw);
      }
    }

    // Does the tenant have any active branches at all? Used to decide
    // whether floor staff (waiter/captain/chef) MUST be pinned to a
    // branch. Mirrors the same gate in `exports.addStaff`.
    const hasAnyBranch = !!(await Branch.exists({ ...tf, isActive: true }));

    // ── Plan limit pre-flight ─────────────────────────────────────────
    // We need to know if the WHOLE batch fits BEFORE we start creating
    // anyone — partial creation in the middle of a plan-cap rejection
    // would leave half the team in and half out, which is worse than no
    // import at all. So count active staff once, parse all rows, then
    // reject up-front if the would-be total breaches the cap.
    const activeStaffCount = await User.countDocuments({
      ...tf,
      role: { $in: ['admin', 'manager', 'waiter', 'captain', 'chef'] },
      status: 'active',
    });
    const maxStaff = req.restaurant?.getLimit?.('maxStaff') || 5;

    // ── First pass: validate every row, collect prospects ─────────────
    // We don't write anything yet; we just figure out how many GOOD rows
    // we have so the plan check below knows whether to reject the batch.
    const errors = [];
    const skipped = [];
    const prospects = [];                    // { rowNum, row data... }
    const seenEmails = new Set();            // dedup within the CSV itself

    // Pre-fetch every staff email in this tenant once so per-row
    // uniqueness checks don't hit the DB N times for an N-row CSV.
    const existingStaffEmails = new Set(
      (await User.find({
        ...tf,
        role: { $in: ['admin', 'manager', 'waiter', 'captain', 'chef'] },
      }).select('email').lean()).map(u => String(u.email).toLowerCase())
    );

    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    for (let i = 1; i < rows.length; i++) {
      // 1-based row numbers with the header as row 1 → first data row = 2.
      const rowNum = i + 1;
      const cells = rows[i];
      const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

      const name = get('name');
      const emailRaw = get('email');
      const roleRaw = get('role').toLowerCase();
      const mobileRaw = get('mobile').replace(/\s+/g, '');
      const email = emailRaw.toLowerCase();

      // Skip completely blank rows silently — admins often leave a few
      // trailing empty lines in Excel exports and we shouldn't surface
      // them as errors.
      if (!name && !emailRaw && !roleRaw && !mobileRaw) {
        continue;
      }

      try {
        if (!name) throw new Error('name is required');
        if (name.length > 100) throw new Error('name must be 100 characters or fewer');
        if (!emailRaw) throw new Error('email is required');
        if (!EMAIL_REGEX.test(emailRaw)) throw new Error('email format is invalid');
        if (!roleRaw) throw new Error('role is required');
        if (!BULK_STAFF_ROLES.has(roleRaw)) {
          throw new Error(`role must be one of: ${[...BULK_STAFF_ROLES].join(', ')}`);
        }
        if (!opsRoleInUse(req, roleRaw)) throw new Error(roleNotInUseBody(roleRaw).message);
        if (roleRaw === 'admin' && req.user?.isTenantOwner !== true) {
          throw new Error('Only tenant owners can import Admin accounts');
        }
        if (!canManageStaffRole(req.user?.role, roleRaw)) {
          throw new Error('Only an Admin can import Manager accounts');
        }
        // Same rule as the User schema / addStaff (10 digits, starts 6-9)
        // so a row can't pass here and then be dropped by insertMany.
        if (mobileRaw && !/^[6-9]\d{9}$/.test(mobileRaw)) {
          throw new Error('mobile must be a valid 10-digit number starting with 6-9');
        }

        // Branch assignment is now batch-wide (targetBranchId resolved
        // above). The CSV no longer carries a per-row branch column —
        // the admin picks a branch from the UI switcher before uploading,
        // and every row in this file goes there.
        //
        // Same floor-staff gate as the single-add controller: waiter /
        // captain / chef MUST land in a real branch once the tenant has
        // any. If the admin uploaded without a branch context selected,
        // floor-staff rows fail individually and admin/manager rows
        // still land at tenant-level, which is intentional.
        let branchId = targetBranchId;
        if (!branchId && roleRaw !== 'admin' && roleRaw !== 'manager' && hasAnyBranch) {
          throw new Error('Switch to a specific branch in the admin sidebar before bulk-adding floor staff (waiter / captain / chef).');
        }

        // Duplicates: already in DB OR repeated in this same CSV.
        // Either way we treat it as "skipped" (informational) rather
        // than a hard error — same UX as the tables import.
        if (existingStaffEmails.has(email)) {
          skipped.push({ row: rowNum, name, email: emailRaw, reason: 'staff with this email already exists' });
          continue;
        }
        if (seenEmails.has(email)) {
          skipped.push({ row: rowNum, name, email: emailRaw, reason: 'duplicate email in this file' });
          continue;
        }
        seenEmails.add(email);

        prospects.push({
          rowNum,
          name,
          email: emailRaw,
          role: roleRaw,
          mobile: mobileRaw,
          branchId,
        });
      } catch (err) {
        errors.push({ row: rowNum, message: err.message });
      }
    }

    // ── Global identity conflicts (customer / superadmin emails) ───────
    // Same rule as addStaff / validateStaffEmail: those identities are
    // platform-wide, a staff row must not share their email.
    if (prospects.length > 0) {
      // AUDIT-EXEMPT: platform-wide email uniqueness vs global customer/superadmin identities (User is not tenant-scoped)
      const globalTaken = new Set((await User.find({
        email: { $in: prospects.map(p => p.email.toLowerCase()) },
        role: { $in: ['customer', 'superadmin'] },
      }).select('email').lean()).map(u => String(u.email).toLowerCase()));
      for (let i = prospects.length - 1; i >= 0; i--) {
        if (globalTaken.has(prospects[i].email.toLowerCase())) {
          errors.push({ row: prospects[i].rowNum, message: 'This email is already registered to a customer or platform account.' });
          prospects.splice(i, 1);
        }
      }
      errors.sort((a, b) => a.row - b.row);
    }

    // ── Plan limit gate ──────────────────────────────────────────────
    if (activeStaffCount + prospects.length > maxStaff) {
      return res.status(403).json({
        success: false,
        code: 'STAFF_LIMIT_REACHED',
        message: `Your plan allows ${maxStaff} active staff. You have ${activeStaffCount} now; this CSV would add ${prospects.length} more (total ${activeStaffCount + prospects.length}). Upgrade your plan or shrink the CSV.`,
        current: activeStaffCount,
        limit: maxStaff,
        wouldAdd: prospects.length,
      });
    }

    if (prospects.length === 0) {
      // Nothing to create — but the request was well-formed. Tell the
      // admin what we did (errors / skipped) so they can fix the file.
      return res.status(200).json({
        success: true,
        created: 0,
        skippedCount: skipped.length,
        skipped,
        errorCount: errors.length,
        errors,
        tempPasswords: [],
      });
    }

    // ── Allocate staffIds in-memory, per-branch ──────────────────────
    // `getNextStaffIdForBranch` reads the current max from the DB; if we
    // called it once per prospect they'd all get the same ID (since
    // nothing has been inserted yet). So we seed one counter per branch
    // bucket and increment locally — same shape (EMP-NNN, zero-padded).
    //
    // Per-branch keeps each branch's sequence independent, matching the
    // { staffId, restaurant, branch } unique index. A CSV that lands
    // both tenant-level (admin/manager, branch=null) and branch-pinned
    // rows produces two parallel sequences without colliding.
    const branchSeeds = new Map();           // branchKey → next int
    const branchKey = (b) => (b ? String(b) : '__null__');
    for (const p of prospects) {
      const key = branchKey(p.branchId);
      if (!branchSeeds.has(key)) {
        const seedId = await getNextStaffIdForBranch(tf, p.branchId || null);
        branchSeeds.set(key, parseInt(seedId.split('-')[1], 10) || 1);
      }
    }
    const allocStaffId = (b) => {
      const key = branchKey(b);
      const n = branchSeeds.get(key);
      branchSeeds.set(key, n + 1);
      return `EMP-${n.toString().padStart(3, '0')}`;
    };

    // ── Build user docs (hash passwords manually so insertMany works) ─
    // The user schema's pre('save') hook hashes the password, but
    // insertMany bypasses save hooks. We hash here so the bulk write is
    // a single round-trip without losing the encryption.
    const tempPasswords = [];                // returned to admin
    const docs = await Promise.all(prospects.map(async (p) => {
      const tempPassword = generateTempPassword();
      const hashed = await bcrypt.hash(tempPassword, 12);
      tempPasswords.push({ email: p.email, name: p.name, tempPassword });
      return {
        // Pre-assigned so we can tell afterwards exactly which rows landed.
        _id: new mongoose.Types.ObjectId(),
        name: p.name,
        email: p.email.toLowerCase(),      // schema lowercases via setter, but be explicit
        password: hashed,
        mobile: p.mobile || '',
        role: p.role,
        staffId: allocStaffId(p.branchId),
        restaurant: tenant,
        branch: p.branchId,
        kitchenResponsibility: p.role === 'chef' ? 'both' : '',
        assignedAreas: [],
        assignedTables: [],
        // Apply role-default permissions instead of an empty object.
        // The single-create path uses resolvePermissions(role, …) so
        // a freshly created chef can hit updateOrderStatus, a waiter
        // can adjustStock, etc. The bulk-import path was hardcoding
        // {} which left every bulk-created floor staff member unable
        // to do their core duties on day one. Mirrors the rule from
        // [[feedback_permission_defaults_server_side]].
        permissions: resolvePermissions(p.role, {}),
        status: 'active',
        mustChangePassword: true,
        avatar: '',
      };
    }));

    // ordered: false → race-condition duplicates (someone created the
    // same email between the pre-flight check and now) get reported as
    // write errors and we move them into `skipped` instead of failing
    // the whole batch.
    let created = 0;
    let writeErrors = [];
    try {
      const inserted = await User.insertMany(docs, { ordered: false });
      created = inserted.length;
    } catch (err) {
      // insertMany throws with a `writeErrors` array when ordered:false;
      // anything that DID get inserted is on err.insertedDocs / err.result.
      created = err?.result?.nInserted || err?.insertedDocs?.length || 0;
      writeErrors = err?.writeErrors || [];
    }

    // Map any write errors back to prospect rows so the response stays
    // explicit. Duplicate-key (11000) → "skipped" (race condition or
    // a pre-flight cache miss); anything else → real error.
    for (const we of writeErrors) {
      const docIdx = we.index ?? we.err?.index;
      const failing = typeof docIdx === 'number' ? docs[docIdx] : null;
      const prospect = typeof docIdx === 'number' ? prospects[docIdx] : null;
      const isDup = we.code === 11000 || we.err?.code === 11000;
      const row = prospect?.rowNum ?? '—';
      if (isDup) {
        skipped.push({
          row,
          name: failing?.name || '—',
          email: failing?.email || '—',
          reason: 'staff with this email already exists',
        });
      } else {
        errors.push({
          row,
          message: we.errmsg || we.err?.errmsg || 'database write failed',
        });
      }
    }

    // Only return tempPasswords for staff that ACTUALLY got created.
    // insertMany(ordered:false) silently drops docs that fail schema
    // validation (they are not in writeErrors), so ask the DB which of
    // our pre-assigned ids landed instead of inferring from writeErrors.
    const landed = new Set((await User.find({ _id: { $in: docs.map(d => d._id) } }).select('_id').lean())
      .map(u => String(u._id)));
    created = landed.size;
    const failedIndices = new Set(writeErrors.map(we => we.index ?? we.err?.index).filter(n => typeof n === 'number'));
    const insertedEmails = new Set();
    docs.forEach((d, i) => {
      if (landed.has(String(d._id))) {
        insertedEmails.add(d.email);
      } else if (!failedIndices.has(i)) {
        errors.push({ row: prospects[i]?.rowNum ?? '—', message: 'row failed validation and was not created' });
      }
    });
    const visibleTempPasswords = tempPasswords.filter(tp => insertedEmails.has(tp.email.toLowerCase()));

    return res.status(200).json({
      success: true,
      created,
      skippedCount: skipped.length,
      skipped,
      errorCount: errors.length,
      errors,
      tempPasswords: visibleTempPasswords,
    });
  } catch (error) {
    logger.error('importStaffCsv error', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Failed to import staff CSV' });
  }
};
