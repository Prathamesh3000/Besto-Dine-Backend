/**
 * staffUtils — shared helpers for staff account creation.
 *
 * Extracted from staffController so that branchController can also
 * create Sub Admin accounts during branch creation without duplicating
 * the password-generation and staffId-sequence logic.
 */

const crypto = require('crypto');
const User = require('../models/user');

// ─── Password helpers ────────────────────────────────────────────────────────

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=<>?]).{8,}$/;

/**
 * Generate a cryptographically random temporary password that satisfies
 * PASSWORD_REGEX (uppercase + lowercase + digit + special, min 8 chars).
 *
 * Ambiguous glyphs are excluded so the admin can transcribe the
 * password into WhatsApp/SMS and the staff member can re-type it
 * without guessing:
 *   - I, l, 1  →  look identical in many sans-serif fonts
 *   - O, 0     →  same
 *   - < >      →  often mangled by chat apps / paste filters
 * Dropping these still leaves >10^21 combinations at length 12, so
 * brute-force resistance is unchanged in practice.
 */
function generateTempPassword(length = 12) {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I, O
    const lower = 'abcdefghijkmnopqrstuvwxyz';   // no l
    const digits = '23456789';                    // no 0, 1
    const specials = '!@#$%^&*_-+=?';             // no <, >
    const all = upper + lower + digits + specials;

    const mandatory = [
        upper[crypto.randomInt(upper.length)],
        lower[crypto.randomInt(lower.length)],
        digits[crypto.randomInt(digits.length)],
        specials[crypto.randomInt(specials.length)],
    ];

    const remaining = Array.from({ length: length - mandatory.length }, () =>
        all[crypto.randomInt(all.length)]
    );

    const chars = [...mandatory, ...remaining];
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

// ─── Staff ID sequence ───────────────────────────────────────────────────────

/**
 * Generate the next available staff ID (EMP-XXX) inside a given
 * (tenant, branch) scope. Each branch restarts at EMP-001 so each
 * location's roster feels self-contained — FC Road's EMP-007 and
 * Main's EMP-007 are different people. Tenant-level staff (branch=null,
 * e.g. an unpinned Manager) form their own sequence under the null-
 * branch bucket.
 *
 * Per-branch scoping matches the unique index on
 * { staffId, restaurant, branch } in models/user.js. Querying
 * tenant-wide here (the pre-fix behaviour) made every new branch
 * jump straight to "EMP-008" instead of starting at EMP-001, and
 * masked a real same-branch duplicate-ID bug because the in-app
 * check was looking in the wrong scope.
 *
 * Uses a retry loop to handle concurrent requests.
 *
 * @param {Object} tf — tenant filter object from `tenantFilter(req)`
 * @param {ObjectId|string|null} branchId — branch this staff belongs to.
 *                                          Pass null for tenant-level
 *                                          (unpinned) staff.
 * @returns {Promise<string>}
 */
async function getNextStaffIdForBranch(tf, branchId) {
    const branchClause = { branch: branchId || null };
    for (let attempt = 0; attempt < 5; attempt++) {
        const lastStaff = await User.findOne({
            staffId: /^EMP-/,
            ...tf,
            ...branchClause,
        }).sort({ staffId: -1 });
        let nextNum = 1;
        if (lastStaff && lastStaff.staffId) {
            nextNum = parseInt(lastStaff.staffId.split('-')[1]) + 1;
        }
        const candidateId = `EMP-${nextNum.toString().padStart(3, '0')}`;
        const exists = await User.findOne({
            staffId: candidateId,
            ...tf,
            ...branchClause,
        });
        if (!exists) return candidateId;
    }
    return `EMP-${Date.now().toString().slice(-6)}`;
}

/**
 * @deprecated Use `getNextStaffIdForBranch(tf, branchId)` instead.
 * Kept as a thin wrapper for any straggling caller that still treats
 * the sequence as tenant-wide. Passes branchId=null, which puts the
 * caller into the tenant-level (unpinned) sequence — usually NOT
 * what you want for branch-scoped staff.
 */
async function getNextStaffIdForTenant(tf) {
    return getNextStaffIdForBranch(tf, null);
}

/**
 * Validate that a staff email doesn't conflict with:
 *   1. Global identities (customer or superadmin)
 *   2. Same-tenant staff members
 *
 * Returns { ok: true } or { ok: false, message: '...' }.
 *
 * @param {string} email — lowercase trimmed
 * @param {ObjectId|null} tenantObjId — tenant _id
 */
async function validateStaffEmail(email, tenantObjId) {
    const globalConflict = await User.findOne({
        email,
        role: { $in: ['customer', 'superadmin'] },
    });
    if (globalConflict) {
        return { ok: false, message: 'This email is already registered to a customer or platform account. Use a different email.' };
    }

    if (tenantObjId) {
        // Must mirror the partial unique index on User
        // ({email, restaurant} where role ∈ all staff roles incl. manager).
        // Missing 'manager' here let a Manager-email collision sneak past
        // the friendly preflight and surface as a raw 500 duplicate-key
        // from MongoDB instead.
        const sameTenantConflict = await User.findOne({
            email,
            restaurant: tenantObjId,
            role: { $in: ['admin', 'manager', 'waiter', 'captain', 'chef'] },
        });
        if (sameTenantConflict) {
            return { ok: false, message: 'A staff member with this email already exists in this restaurant.' };
        }
    }

    return { ok: true };
}

module.exports = {
    PASSWORD_REGEX,
    generateTempPassword,
    getNextStaffIdForBranch,
    getNextStaffIdForTenant,
    validateStaffEmail,
};
