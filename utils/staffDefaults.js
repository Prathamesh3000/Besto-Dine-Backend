/**
 * staffDefaults — server-side source of truth for role-based default
 * permissions. Mirrors DEFAULT_PERMISSIONS_BY_ROLE in
 * Frontend/src/Pages/Admin/components/AddStaffModal.jsx and PERMISSION_CATALOG
 * keys live next to it there.
 *
 * Why server-side: the Add Staff modal auto-applies role defaults, but
 * any non-UI flow (seed scripts, direct API clients, bulk CSV import,
 * partner integrations) that omits the `permissions` field would land
 * a Manager with `permissions: {}`. Because `checkPermission` only
 * auto-bypasses for `role === 'admin'` (intentional — Managers must
 * be revocable per-key), a permissions-empty Manager lands on a
 * dashboard with only the unguarded tabs (Dashboard / Wallet / Offers /
 * Inventory). Real-world bug reported 2026-05-21 against seeded data.
 *
 * Roles are stored lowercase on the User model; the modal uses titlecase
 * (`Manager`, `Captain`) in its form state. `defaultPermissionsForRole`
 * accepts either and returns a fresh object so callers can mutate
 * freely without poisoning the template.
 */

const PERMISSION_KEYS = [
    // Floor & tables
    'tables', 'viewTableDetails', 'mergeTables',
    // Orders & kitchen
    'viewOrders', 'addOrders', 'updateOrderStatus', 'accessKitchen',
    // Service & guests
    'viewCustomerRequests', 'reservation', 'crm',
    // Money
    'viewTips', 'viewPayments', 'refund',
    // Admin tools
    'editMenu', 'manageStaff', 'manageRecipe', 'manageStock',
];

// Internal helper — builds `{ tables: false, ... }` for every catalog key.
const noPermissions = () => PERMISSION_KEYS.reduce((acc, k) => { acc[k] = false; return acc; }, {});

// Role names are normalised to lowercase to match the User.role enum.
const DEFAULT_PERMISSIONS_BY_ROLE = {
    manager: {
        tables: true, viewTableDetails: true, mergeTables: true,
        viewOrders: true, addOrders: true, updateOrderStatus: true, accessKitchen: false,
        viewCustomerRequests: true, reservation: true, crm: true,
        viewTips: true, viewPayments: true, refund: true,
        editMenu: true, manageStaff: true, manageRecipe: true, manageStock: true,
    },
    captain: {
        tables: true, viewTableDetails: true, mergeTables: true,
        viewOrders: true, addOrders: true, updateOrderStatus: true, accessKitchen: false,
        viewCustomerRequests: true, reservation: true, crm: false,
        viewTips: true, viewPayments: true, refund: false,
        editMenu: false, manageStaff: false, manageRecipe: false, manageStock: false,
    },
    chef: {
        tables: false, viewTableDetails: false, mergeTables: false,
        viewOrders: true, addOrders: false, updateOrderStatus: true, accessKitchen: true,
        viewCustomerRequests: false, reservation: false, crm: false,
        viewTips: false, viewPayments: false, refund: false,
        editMenu: false, manageStaff: false, manageRecipe: true, manageStock: true,
    },
    waiter: {
        tables: true, viewTableDetails: true, mergeTables: true,
        viewOrders: true, addOrders: true, updateOrderStatus: false, accessKitchen: false,
        viewCustomerRequests: true, reservation: false, crm: false,
        viewTips: true, viewPayments: false, refund: false,
        editMenu: false, manageStaff: false, manageRecipe: false, manageStock: false,
    },
    // role 'admin' deliberately omitted — checkPermission auto-bypasses
    // admins, so any default here would be dead code. Sub Admins inherit
    // the same bypass; the Sub-Admin-creation flow in branchController
    // already leaves permissions empty for that reason.
};

/**
 * Return a fresh defaults object for the given role. Unknown roles
 * (or `admin`) return an empty permissions object — `checkPermission`
 * already auto-bypasses admin, and unknown roles shouldn't reach this
 * helper in normal operation.
 */
function defaultPermissionsForRole(role) {
    const key = String(role || '').toLowerCase();
    const tpl = DEFAULT_PERMISSIONS_BY_ROLE[key];
    if (!tpl) return {};
    return { ...tpl };
}

/**
 * Merge caller-supplied permissions with role defaults.
 *
 * - If `supplied` is missing / null / empty object → return defaults
 *   for the role. Covers seed scripts and API clients that omit the
 *   field entirely.
 * - If `supplied` has any keys → return `supplied` verbatim. Treats
 *   "all toggles off" as an explicit admin choice, NOT a missing field.
 *   This preserves the "Reset to None" affordance in the modal.
 */
function resolvePermissions(role, supplied) {
    if (supplied && typeof supplied === 'object' && Object.keys(supplied).length > 0) {
        return supplied;
    }
    return defaultPermissionsForRole(role);
}

module.exports = {
    PERMISSION_KEYS,
    DEFAULT_PERMISSIONS_BY_ROLE,
    defaultPermissionsForRole,
    resolvePermissions,
    noPermissions,
};
