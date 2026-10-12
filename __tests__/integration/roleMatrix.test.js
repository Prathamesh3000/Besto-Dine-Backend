/**
 * Role × route access matrix (checklist 4.3).
 *
 * 1. The route inventory is built by walking the REAL express routers
 *    (every routes/*.js module, mounted at the prefix app.js gives it) and
 *    recording each (method, path, guard chain) — router-level
 *    `router.use(protect, …)` guards are inherited by the routes declared
 *    after them, exactly as express applies them.
 * 2. EXPECTED is a hand-maintained table derived from reading the guards
 *    (protect / adminOnly / adminExclusive / captainOrAdmin / staffOnly /
 *    restrictTo / checkPermission / superAdminOnly / superAdminFull and the
 *    inline `allow(...)` gate in inventoryRoute). Every route × role pair
 *    is one test that sends a harmless request (empty body, random
 *    ObjectIds for params so nothing real is touched) and asserts ONLY the
 *    authorization outcome:
 *      - denied roles  → 401/403, never 2xx, never 5xx
 *        (anonymous callers without a tenant may also be refused one step
 *        earlier by attachTenant with 400 TENANT_REQUIRED — fail closed);
 *      - allowed roles → anything but 401/403 (400/404 validation is fine).
 * 3. Meta-tests: every guarded route has an EXPECTED row, every EXPECTED
 *    row still exists, and every route with NO auth guard is in the
 *    documented PUBLIC allowlist.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant, createCustomer, createUser, setWallet } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const { defaultPermissionsForRole, PERMISSION_KEYS } = require(path.join(BACKEND, 'utils/staffDefaults'));

const ctx = useIntegrationApp();
let A;
const U = {};

// ─── Roles ─────────────────────────────────────────────────────────────────
const ROLES = [
    'superadmin', 'superadminSupport', 'admin', 'subadmin', 'manager', 'managerNoPerms',
    'captain', 'waiter', 'chef', 'customer', 'guest', 'anon',
];

beforeAll(async () => {
    A = await seedTenant({ label: 'rbac' });
    const tag = A.slug;
    U.superadmin = await createUser({ name: 'SA full', email: `sa.full.${tag}@platform.test`, role: 'superadmin', superadminLevel: 'full' });
    U.superadminSupport = await createUser({ name: 'SA support', email: `sa.support.${tag}@platform.test`, role: 'superadmin', superadminLevel: 'support' });
    U.admin = A.users.admin;
    U.captain = A.users.captain;
    U.waiter = A.users.waiter;
    U.chef = A.users.chef;
    const staff = (role, label, extra) => createUser({
        name: `${label} ${tag}`, email: `${label}.${tag}@staff.test`, role,
        restaurant: A.restaurant._id, branch: A.branch._id, ...extra,
    });
    // Sub-admin: role admin pinned to a branch, NOT the tenant owner.
    U.subadmin = await staff('admin', 'subadmin', { isTenantOwner: false, permissions: {} });
    U.manager = await staff('manager', 'manager', { permissions: defaultPermissionsForRole('manager') });
    U.managerNoPerms = await staff('manager', 'manager-noperms', {
        permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])),
    });
    U.customer = await createCustomer('rbac');
});

function client(role) {
    if (role === 'guest') return ctx.api.guest(A);
    if (role === 'anon') return ctx.api.anon();
    if (role === 'customer') return ctx.api.as(U.customer, A);
    return ctx.api.as(U[role]);
}

// ─── Role sets (derived from the guards) ───────────────────────────────────
const has = (role, key) => defaultPermissionsForRole(role)[key] === true;
const SA_ANY = ['superadmin', 'superadminSupport'];            // superAdminOnly
const SA_FULL = ['superadmin'];                                 // superAdminFull
const OWNER = ['admin'];                                        // adminExclusive (isTenantOwner)
const ADMIN = ['admin', 'subadmin', 'manager', 'managerNoPerms']; // adminOnly
const CAP_ADMIN = [...ADMIN, 'captain'];                        // captainOrAdmin
const STAFF = [...ADMIN, 'captain', 'waiter', 'chef'];          // staffOnly
const AUTHED = ROLES.filter((r) => !['guest', 'anon'].includes(r)); // protect only
const CUSTOMER = ['customer'];
const FLOOR = ['waiter', 'captain', ...ADMIN];                  // restrictTo('waiter','captain','admin','manager')
const SUPERVISOR = ['captain', ...ADMIN];                       // restrictTo('captain','admin','manager')
const STAFF_WALLET = ['waiter', 'captain'];                     // restrictTo('waiter','captain')
/** adminOnly + checkPermission(k): admins bypass, managers need the flag. */
const adminPerm = (k) => ['admin', 'subadmin', ...(has('manager', k) ? ['manager'] : [])];
/** staffOnly + checkPermission(k): admins bypass, other staff need the flag. */
const staffPerm = (k) => ['admin', 'subadmin', ...['manager', 'captain', 'waiter', 'chef'].filter((r) => has(r, k))];
/** inventoryRoute allow(...keys): admin/manager always, other staff with ANY flag. */
const invAllow = (...ks) => [...ADMIN, ...['captain', 'waiter', 'chef'].filter((r) => ks.some((k) => has(r, k)))];

// ─── EXPECTED: [method, path (as declared), allowed roles, opts] ───────────
// opts.denyOnly — only the deny side is exercised (an allowed call would
// have a side effect that breaks the rest of the suite).
// opts.params   — { name: () => value } overrides for path params.
// opts.biz403   — 403 codes that are business rules (plan limits), not authz.
const EXPECTED = [
    ['GET', '/admin/bootstrap', STAFF],
    // advance bookings
    ['POST', '/advance-booking/create', AUTHED],
    ['GET', '/advance-booking/my-bookings', AUTHED],
    ['POST', '/advance-booking/:id/create-remaining-payment', AUTHED],
    ['POST', '/advance-booking/:id/verify-remaining-payment', AUTHED],
    ['GET', '/advance-booking/:id/cancel-preview', AUTHED],
    ['POST', '/advance-booking/:id/cancel', AUTHED],
    ['GET', '/advance-booking/all', ADMIN],
    ['GET', '/advance-booking/:id', ADMIN],
    ['PATCH', '/advance-booking/:id/status', ADMIN],
    ['DELETE', '/advance-booking/:id', ADMIN],
    ['PATCH', '/advance-booking/:id/details', ADMIN],
    // analytics
    ['GET', '/analytics/sales-history', ADMIN],
    ['GET', '/analytics/peak-hours', ADMIN],
    ['GET', '/analytics/top-items', ADMIN],
    ['GET', '/analytics/summary', ADMIN],
    // areas
    ['POST', '/areas', ADMIN],
    ['PUT', '/areas/:id', ADMIN],
    ['DELETE', '/areas/:id', ADMIN],
    // auth (self-service)
    ['POST', '/auth/logout-all', AUTHED, { denyOnly: true }],   // would revoke the role's token
    ['GET', '/auth/me', AUTHED],
    ['PUT', '/auth/profile', AUTHED],
    ['POST', '/auth/avatar', AUTHED],
    ['PUT', '/auth/change-password', AUTHED],
    // booking-info admin
    ['GET', '/booking-info/event-types/template', ADMIN],
    ['POST', '/booking-info/event-types/import', ADMIN],
    ['POST', '/booking-info/event-types', ADMIN],
    ['PUT', '/booking-info/event-types/:id', ADMIN],
    ['DELETE', '/booking-info/event-types/:id', ADMIN],
    ['GET', '/booking-info/packages/template', ADMIN],
    ['POST', '/booking-info/packages/import', ADMIN],
    ['POST', '/booking-info/packages', ADMIN],
    ['PUT', '/booking-info/packages/:id', ADMIN],
    ['DELETE', '/booking-info/packages/:id', ADMIN],
    ['GET', '/booking-info/addons/slugs', ADMIN],
    ['GET', '/booking-info/addons/admin', ADMIN],
    ['POST', '/booking-info/addons', ADMIN],
    ['PUT', '/booking-info/addons/:id', ADMIN],
    ['DELETE', '/booking-info/addons/:id', ADMIN],
    // branches — reads adminOnly, writes owner-only
    ['GET', '/branches', ADMIN],
    // Pinned callers may only read their own branch (BRANCH_SCOPE_VIOLATION otherwise).
    ['GET', '/branches/:id', ADMIN, { params: { id: () => A.branch._id } }],
    ['GET', '/branches/:id/disable-check', ADMIN],
    ['POST', '/branches', OWNER],
    ['PUT', '/branches/:id', OWNER],
    ['DELETE', '/branches/:id', OWNER],
    ['DELETE', '/branches/:id/permanent', OWNER],
    // The plan's branch limit is checked before the id lookup: a business 403, not authz.
    ['PATCH', '/branches/:id/reactivate', OWNER, { biz403: ['BRANCH_LIMIT_REACHED'] }],
    ['POST', '/branches/sync-menu-all', OWNER],
    ['POST', '/branches/:id/sync-menu', OWNER],
    ['POST', '/branches/sync-areas-all', OWNER],
    ['POST', '/branches/:id/sync-areas', OWNER],
    ['POST', '/branches/:id/subadmin', OWNER],
    ['PATCH', '/branches/:id/subadmin', OWNER],
    ['POST', '/branches/:id/subadmin/reset-password', OWNER],
    // campaigns
    ['GET', '/campaigns', ADMIN],
    ['GET', '/campaigns/stats', ADMIN],
    ['POST', '/campaigns', ADMIN],
    ['PATCH', '/campaigns/:id/toggle', ADMIN],
    ['PUT', '/campaigns/:id', ADMIN],
    ['DELETE', '/campaigns/:id', ADMIN],
    // captain console
    ['GET', '/captain/floor-overview', CAP_ADMIN],
    ['GET', '/captain/waiters', CAP_ADMIN],
    ['POST', '/captain/escalate', CAP_ADMIN],
    // menu catalogue (editMenu)
    ['POST', '/categories', adminPerm('editMenu')],
    ['PUT', '/categories/reorder', adminPerm('editMenu')],
    ['PUT', '/categories/:id', adminPerm('editMenu')],
    ['DELETE', '/categories/:id', adminPerm('editMenu')],
    ['GET', '/combos/template', adminPerm('editMenu')],
    ['POST', '/combos/import', adminPerm('editMenu')],
    ['POST', '/combos', adminPerm('editMenu')],
    ['PUT', '/combos/:id', adminPerm('editMenu')],
    ['DELETE', '/combos/:id', adminPerm('editMenu')],
    ['GET', '/menu/template', adminPerm('editMenu')],
    ['POST', '/menu', adminPerm('editMenu')],
    ['POST', '/menu/import', adminPerm('editMenu')],
    ['PUT', '/menu/:id', adminPerm('editMenu')],
    ['DELETE', '/menu/:id', adminPerm('editMenu')],
    ['GET', '/menu/:id/branch-prices', ADMIN],
    ['PUT', '/menu/:id/branch-prices', OWNER],
    // CRM
    ['GET', '/crm/customers', adminPerm('crm')],
    ['GET', '/crm/customers/:id', adminPerm('crm')],
    // decoration packages / halls
    ['GET', '/decoration-packages/template', ADMIN],
    ['POST', '/decoration-packages/import', ADMIN],
    ['POST', '/decoration-packages', ADMIN],
    ['PUT', '/decoration-packages/:id', ADMIN],
    ['DELETE', '/decoration-packages/:id', ADMIN],
    ['PATCH', '/decoration-packages/:id/status', ADMIN],
    ['GET', '/halls/template', ADMIN],
    ['POST', '/halls/import', ADMIN],
    ['POST', '/halls', ADMIN],
    ['POST', '/halls/admin', ADMIN],
    ['PUT', '/halls/:id', ADMIN],
    ['DELETE', '/halls/:id', ADMIN],
    // inventory — chef may READ stock / build recipes, never adjust stock
    ['GET', '/inventory', invAllow('manageRecipe', 'manageStock')],
    ['GET', '/inventory/summary', invAllow('manageStock')],
    ['GET', '/inventory/alerts', invAllow('manageStock')],
    ['GET', '/inventory/next-id', ADMIN],
    ['GET', '/inventory/recipes/template', ADMIN],
    ['POST', '/inventory/recipes/import', ADMIN],
    ['GET', '/inventory/recipes', invAllow('manageRecipe')],
    ['GET', '/inventory/recipes/:menuItemId', invAllow('manageRecipe')],
    ['POST', '/inventory/recipes', invAllow('manageRecipe')],
    ['DELETE', '/inventory/recipes/:menuItemId', ADMIN],
    ['GET', '/inventory/food-cost', ADMIN],
    ['GET', '/inventory/actual-vs-theoretical', ADMIN],
    ['GET', '/inventory/reports/stock', ADMIN],
    ['GET', '/inventory/reports/consumption', ADMIN],
    ['GET', '/inventory/menu-issues', ADMIN],
    ['GET', '/inventory/template', ADMIN],
    ['POST', '/inventory/import', ADMIN],
    ['GET', '/inventory/:id', ADMIN],
    ['POST', '/inventory', ADMIN],
    ['PUT', '/inventory/:id', ADMIN],
    ['PATCH', '/inventory/:id/adjust', ADMIN],
    ['DELETE', '/inventory/:id', ADMIN],
    // invoices
    ['GET', '/invoices/my-invoices', AUTHED],
    ['POST', '/invoices/generate/:orderId', ADMIN],
    // notifications
    ['GET', '/notifications', AUTHED],
    ['POST', '/notifications', STAFF],
    ['PUT', '/notifications/all/read', AUTHED],
    ['PUT', '/notifications/:id/read', AUTHED],
    ['DELETE', '/notifications/clear', AUTHED],
    ['DELETE', '/notifications/:id', AUTHED],
    // orders — staff surfaces + kitchen
    ['GET', '/orders/live', STAFF],
    ['GET', '/orders/past', STAFF],
    ['GET', '/orders/refunds', STAFF],
    ['GET', '/orders/kitchen', staffPerm('accessKitchen')],
    ['GET', '/orders/kitchen/completed', staffPerm('accessKitchen')],
    ['PATCH', '/orders/:id/status', staffPerm('updateOrderStatus')],  // {} is not a pure cancel
    ['PATCH', '/orders/:id/pickup', FLOOR],
    ['PATCH', '/orders/:id/delivery', SUPERVISOR],
    ['POST', '/orders/admin/cleanup-stale', ADMIN],
    ['POST', '/orders/admin/cleanup-empty', ADMIN],
    ['POST', '/orders/:id/append', FLOOR],
    ['PATCH', '/orders/:id/coupon', FLOOR],
    ['POST', '/orders/:id/reprint-kot', FLOOR],
    ['GET', '/orders/my-orders', AUTHED],
    // payments / razorpay / refunds
    ['GET', '/payments/admin/all', adminPerm('viewPayments')],
    ['POST', '/razorpay/refund', adminPerm('refund')],
    ['POST', '/razorpay/create-wallet-recharge', AUTHED],
    ['POST', '/razorpay/verify-wallet-recharge', AUTHED],
    ['GET', '/razorpay/reconcile', ADMIN],
    ['POST', '/refund-requests', CUSTOMER],
    ['GET', '/refund-requests/mine', CUSTOMER],
    ['GET', '/refund-requests', ADMIN],
    // Deciding a refund request needs the 'refund' permission (fixed 2026-10; was adminOnly only).
    ['POST', '/refund-requests/:id/approve', adminPerm('refund')],
    ['POST', '/refund-requests/:id/reject', adminPerm('refund')],
    // production / purchase / suppliers
    ['GET', '/production/summary', ADMIN],
    ['GET', '/production', ADMIN],
    ['POST', '/production', ADMIN],
    ['GET', '/purchase-orders/summary', ADMIN],
    ['GET', '/purchase-orders/next-number', ADMIN],
    ['GET', '/purchase-orders/reports/purchase', ADMIN],
    ['GET', '/purchase-orders/reports/payments', ADMIN],
    ['GET', '/purchase-orders', ADMIN],
    ['POST', '/purchase-orders', ADMIN],
    ['GET', '/purchase-orders/:id', ADMIN],
    ['PUT', '/purchase-orders/:id', ADMIN],
    ['POST', '/purchase-orders/:id/receive', ADMIN],
    ['POST', '/purchase-orders/:id/payment', ADMIN],
    ['PATCH', '/purchase-orders/:id/cancel', ADMIN],
    ['GET', '/suppliers/next-code', ADMIN],
    ['GET', '/suppliers', ADMIN],
    ['GET', '/suppliers/:id', ADMIN],
    ['POST', '/suppliers', ADMIN],
    ['PUT', '/suppliers/:id', ADMIN],
    ['DELETE', '/suppliers/:id', ADMIN],
    // promotions
    ['POST', '/promotions/apply-coupon', AUTHED],
    // Was protect-only (IDOR) — now adminOnly + checkPermission('crm'); see the regression test below.
    ['GET', '/promotions/customer/:userId', adminPerm('crm')],
    ['GET', '/promotions/coupons/redemptions', ADMIN],
    ['GET', '/promotions/coupons/performance', ADMIN],
    ['POST', '/promotions/coupons', ADMIN],
    ['GET', '/promotions/coupons', ADMIN],
    ['PUT', '/promotions/coupons/:id', ADMIN],
    ['DELETE', '/promotions/coupons/:id', ADMIN],
    ['POST', '/promotions', ADMIN],
    // customer requests / reservations
    ['GET', '/requests', staffPerm('viewCustomerRequests')],
    ['PUT', '/requests/:id/status', staffPerm('viewCustomerRequests')],
    ['GET', '/reservations', AUTHED],
    ['POST', '/reservations/customer', AUTHED],
    ['POST', '/reservations', staffPerm('reservation')],
    ['PUT', '/reservations/:id/status', staffPerm('reservation')],
    ['PUT', '/reservations/:id/cancel', staffPerm('reservation')],
    ['PATCH', '/reservations/:id/late-deduction', ADMIN],
    // settings
    ['PUT', '/settings', ADMIN],
    ['PATCH', '/settings/:section', ADMIN],
    ['GET', '/settings/operations', ADMIN],
    // thermal printing (routes/printRoute.js)
    ['POST', '/print/agent-key', ADMIN],
    ['DELETE', '/print/agent-key', ADMIN],
    ['GET', '/print/agent-status', ADMIN],
    ['GET', '/print/jobs', ADMIN],
    ['POST', '/print/test', ADMIN],
    ['POST', '/print/orders/:id/bill', FLOOR],
    // shifts
    ['GET', '/shifts/my', AUTHED],
    // protect + staffOnly (was protect-only; see the regression test below).
    ['POST', '/shifts/clock-in', STAFF],
    ['POST', '/shifts/clock-out', STAFF],
    ['POST', '/shifts/admin/run-autoclose', ADMIN],
    ['POST', '/shifts/:id/force-clockout', ADMIN],
    ['GET', '/shifts/staff/:userId', ADMIN],
    // staff management
    ['GET', '/staff/template', adminPerm('manageStaff')],
    ['POST', '/staff/import', adminPerm('manageStaff')],
    ['GET', '/staff', ADMIN],
    ['GET', '/staff/next-id', adminPerm('manageStaff')],
    ['POST', '/staff', adminPerm('manageStaff')],
    ['PATCH', '/staff/:id/status', adminPerm('manageStaff')],
    ['PUT', '/staff/:id', adminPerm('manageStaff')],
    ['GET', '/staff/:id/performance', ADMIN],
    ['POST', '/staff/:id/reset-password', adminPerm('manageStaff')],
    ['DELETE', '/staff/:id', adminPerm('manageStaff')],
    // staff wallet + tips (settlements)
    ['GET', '/staff-wallet/me', STAFF_WALLET],
    ['POST', '/staff-wallet/withdraw', STAFF_WALLET],
    ['GET', '/staff-wallet/withdrawals', ADMIN],
    ['POST', '/staff-wallet/withdrawals/:id/approve', ADMIN],
    ['POST', '/staff-wallet/withdrawals/:id/reject', ADMIN],
    ['GET', '/tips/my', AUTHED],
    ['GET', '/tips/pending', ADMIN],
    ['POST', '/tips/settle', ADMIN],
    ['GET', '/tips/history', ADMIN],
    // superadmin
    ['GET', '/superadmin/analytics', SA_ANY],
    ['GET', '/superadmin/audit-logs', SA_ANY],
    ['GET', '/superadmin/audit-logs/export', SA_ANY],
    ['POST', '/superadmin/audit-logs/purge', SA_FULL],
    // Was SA_ANY (pinned buggy behaviour); full-only since 2026-10 — it emails tenants.
    ['POST', '/superadmin/internal/run-dormancy-check', SA_FULL],
    ['GET', '/superadmin/restaurants', SA_ANY],
    ['GET', '/superadmin/restaurants/:id', SA_ANY],
    ['POST', '/superadmin/restaurants', SA_FULL],
    ['PATCH', '/superadmin/restaurants/:id', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/assign-plan', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/suspend', SA_FULL],
    ['GET', '/superadmin/addon-catalog', SA_ANY],
    ['POST', '/superadmin/restaurants/:id/addons', SA_FULL],
    ['DELETE', '/superadmin/restaurants/:id/addons/:addonId', SA_FULL],
    ['GET', '/superadmin/operations/presets', SA_ANY],
    ['GET', '/superadmin/restaurants/:id/operations', SA_ANY],
    ['POST', '/superadmin/restaurants/:id/operations/preview', SA_FULL],
    ['PUT', '/superadmin/restaurants/:id/operations', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/backup', SA_FULL],
    ['GET', '/superadmin/restaurants/:id/backups', SA_ANY],
    ['GET', '/superadmin/restaurants/:id/backups/:filename', SA_ANY],
    ['DELETE', '/superadmin/restaurants/:id/backups/:filename', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/reactivate', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/resend-invitation', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/cancel-subscription', SA_FULL],
    ['GET', '/superadmin/leads', SA_ANY],
    ['GET', '/superadmin/leads/:id', SA_ANY],
    ['PATCH', '/superadmin/leads/:id', SA_FULL],
    ['DELETE', '/superadmin/leads/:id', SA_FULL],
    ['GET', '/superadmin/marketing', SA_ANY],
    ['PUT', '/superadmin/marketing', SA_FULL],
    ['POST', '/superadmin/marketing/logo', SA_FULL],
    ['POST', '/superadmin/marketing/screenshot', SA_FULL],
    ['GET', '/superadmin/subscription-payments', SA_ANY],
    ['GET', '/superadmin/pending-approvals', SA_ANY],
    ['POST', '/superadmin/restaurants/:id/approve-signup', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/reject-signup', SA_FULL],
    ['POST', '/superadmin/restaurants/:id/confirm-payment', SA_FULL],
    ['GET', '/superadmin/approvals/signups/:id', SA_ANY],
    ['PATCH', '/superadmin/approvals/signups/:id/note', SA_FULL],
    ['GET', '/superadmin/approvals/plan-changes/:requestId', SA_ANY],
    ['GET', '/superadmin/approvals/payments/:id', SA_ANY],
    ['POST', '/superadmin/restaurants/:id/plan-change-request', SA_FULL],
    ['POST', '/superadmin/plan-change-requests/:requestId/approve', SA_FULL],
    ['POST', '/superadmin/plan-change-requests/:requestId/reject', SA_FULL],
    ['GET', '/superadmin/plans', SA_ANY],
    ['POST', '/superadmin/plans', SA_FULL],
    ['PUT', '/superadmin/plans/:id', SA_FULL],
    ['PATCH', '/superadmin/plans/:id/archive', SA_FULL],
    ['DELETE', '/superadmin/plans/:id', SA_FULL],
    ['GET', '/superadmin/plans/:id/tenant-impact', SA_ANY],
    ['POST', '/superadmin/plans/:id/push', SA_FULL],
    ['GET', '/superadmin/blog', SA_ANY],
    ['GET', '/superadmin/blog/:id', SA_ANY],
    ['POST', '/superadmin/blog', SA_FULL],
    ['PATCH', '/superadmin/blog/:id', SA_FULL],
    ['DELETE', '/superadmin/blog/:id', SA_FULL],
    ['POST', '/superadmin/blog/cover', SA_FULL],
    // tables
    ['GET', '/tables/bookable', AUTHED],
    ['GET', '/tables', STAFF],
    // Guard is protect-only; tableController.js:1183 refuses every non-customer with 403.
    ['POST', '/tables/:id/claim', CUSTOMER],
    ['GET', '/tables/template', ADMIN],
    ['POST', '/tables/import', ADMIN],
    ['POST', '/tables/merge', staffPerm('tables')],
    ['POST', '/tables/unmerge', staffPerm('tables')],
    ['PUT', '/tables/:id/assign', CAP_ADMIN],
    ['POST', '/tables', ADMIN],
    ['PUT', '/tables/:id', CAP_ADMIN],
    ['POST', '/tables/:id/free', CAP_ADMIN],
    ['DELETE', '/tables/:id', ADMIN],
    ['POST', '/tables/:id/qr-token', ADMIN],
    // telemetry
    ['GET', '/telemetry/stats', ADMIN],
    ['GET', '/telemetry/reports', ADMIN],
    ['GET', '/telemetry/forecast', ADMIN],
    // tenant billing + export — owner only
    ['GET', '/tenant/billing/current', OWNER],
    ['GET', '/tenant/billing/plans', OWNER],
    ['POST', '/tenant/billing/upgrade', OWNER],
    ['POST', '/tenant/billing/upgrade/verify', OWNER],
    ['POST', '/tenant/billing/sync', OWNER],
    ['POST', '/tenant/billing/downgrade-request', OWNER],
    ['GET', '/tenant/billing/downgrade-request', OWNER],
    ['DELETE', '/tenant/billing/downgrade-request/:id', OWNER],
    ['POST', '/tenant/billing/scheduled-downgrade/cancel', OWNER],
    ['GET', '/tenant/billing/invoices', OWNER],
    ['GET', '/tenant/billing/invoices/:id/download', OWNER],
    ['GET', '/tenant/export', OWNER],
    // upload / wallet
    ['POST', '/upload', ADMIN],
    ['GET', '/wallet', AUTHED],
    ['POST', '/wallet/points/add', ADMIN],
    ['POST', '/wallet/points/redeem', AUTHED],
    ['POST', '/wallet/pay', AUTHED],
    ['GET', '/wallet/admin/stats', ADMIN],
    ['GET', '/wallet/admin/customers', ADMIN],
    ['GET', '/wallet/admin/manual-history', ADMIN],
    ['GET', '/wallet/admin/reports', ADMIN],
    ['POST', '/wallet/admin/adjust', ADMIN],
    ['POST', '/wallet/admin/set-status', ADMIN],
];

// ─── PUBLIC allowlist: routes with NO auth guard, and why ─────────────────
const QR = 'guest QR / customer-app flow; ownership enforced in the controller via scan token or order/user match';
const PUBLIC = {
    'GET /areas': 'floor areas shown to diners when picking a table',
    'POST /auth/register': 'account creation',
    'POST /auth/login': 'login',
    'POST /auth/forgot-password': 'password-reset request (no session yet)',
    'POST /auth/reset-password': 'reset with emailed token',
    'POST /auth/google': 'Google sign-in (verifies the Google ID token)',
    'POST /auth/send-otp': 'OTP login step 1',
    'POST /auth/verify-otp': 'OTP login step 2',
    'POST /auth/refresh': 'refresh-token rotation (refresh token is the credential)',
    'POST /auth/logout': 'logout must work with an expired access token',
    'GET /booking-info/resources': 'customer booking wizard catalogue (feature-gated)',
    'GET /booking-info/cakes': 'customer booking wizard catalogue',
    'GET /booking-info/decorations': 'customer booking wizard catalogue',
    'GET /booking-info/packages': 'customer booking wizard catalogue',
    'GET /booking-info/event-types': 'customer booking wizard catalogue',
    'GET /booking-info/addons': 'customer booking wizard catalogue',
    'GET /booking-info/parking': 'customer booking wizard parking rates',
    'GET /categories': 'public menu',
    'GET /categories/:id': 'public menu',
    'GET /combos': 'public menu',
    'GET /combos/:id': 'public menu',
    'GET /decoration-packages': 'customer hall-booking catalogue',
    'GET /decoration-packages/:id': 'customer hall-booking catalogue',
    'GET /halls': 'customer hall-booking catalogue',
    'GET /invoices/:id': 'guest bill view after QR order (tenant-scoped when a slug is sent)',
    'GET /menu/search': 'public menu',
    'GET /menu/trending': 'public menu',
    'GET /menu': 'public menu',
    'GET /menu/:id': 'public menu',
    'GET /menu/:id/customizations': 'public menu',
    'POST /orders': `order placement — ${QR}`,
    'POST /orders/delivery-quote': 'delivery fee quote before checkout',
    'GET /orders/track/:orderId': 'kiosk/takeaway order tracking by order number',
    'GET /orders/:id/detail': QR,
    'GET /orders/active/table/:tableId': QR,
    'GET /orders/active-list/table/:tableId': QR,
    'PATCH /orders/:id/payment': QR,
    'POST /orders/:id/request-counter-payment': QR,
    'PATCH /orders/:id/cancel': QR,
    'PATCH /orders/:id/rating': QR,
    'POST /orders/:orderId/repeat/:itemId': QR,
    'POST /orders/:id/repeat-all': QR,
    'GET /promotions': 'customer-facing active promotions (feature-gated)',
    'GET /promotions/coupons/active': 'customer-facing active coupons (feature-gated)',
    'GET /public/restaurants': 'landing pages',
    'GET /public/restaurants/:slug': 'landing pages',
    'GET /public/restaurants/:slug/branches': 'landing pages',
    'GET /public/restaurants/:slug/landing': 'landing pages',
    'GET /public/menu-bootstrap': 'landing pages',
    'POST /public/register-restaurant': 'self-signup (rate limited)',
    'GET /public/slug-availability': 'self-signup',
    'GET /public/plans': 'pricing page',
    'POST /public/lead': 'marketing lead form (rate limited)',
    'GET /public/site-config': 'marketing site config',
    'GET /public/blog': 'marketing blog',
    'GET /public/blog/:slug': 'marketing blog',
    'POST /razorpay/create-order': `online payment for an order — ${QR}`,
    'POST /razorpay/verify-payment': 'payment verification (Razorpay signature is the credential)',
    'POST /razorpay/webhook': 'Razorpay server-to-server webhook (HMAC signature is the credential)',
    'POST /razorpay/orphan-refund': 'refund of a captured payment with no order (signature-verified)',
    'POST /requests': 'diner "call waiter / water / bill" from the QR table page',
    'GET /requests/active/table/:tableId': 'diner sees their own open table requests',
    'GET /settings': 'public tenant settings (taxes, hours) for the customer app',
    'GET /tables/scan/:qrToken': 'QR scan — tenant discovery; qrToken is the credential',
    'GET /tables/:id/availability': 'customer reservation availability check',
};

// ─── Route inventory from the real routers ─────────────────────────────────
const AUTH_GUARDS = ['protect', 'adminOnly', 'adminExclusive', 'captainOrAdmin', 'staffOnly', 'superAdminOnly', 'superAdminFull'];

function buildInventory() {
    const auth = require(path.join(BACKEND, 'middlewares/authMiddleware'));
    const appSrc = fs.readFileSync(path.join(BACKEND, 'app.js'), 'utf8');
    const mounts = {};
    for (const m of appSrc.matchAll(/v1\.use\('([^']+)',\s*require\('\.\/routes\/(\w+)'\)\)/g)) mounts[m[2]] = m[1];
    const named = new Map([...AUTH_GUARDS, 'optionalAuth'].map((k) => [auth[k], k]));
    const label = (fn) => named.get(fn)
        || (/roles\.includes\(req\.user\.role\)/.test(String(fn)) ? 'restrictTo'
            : /permissionKey/.test(String(fn)) ? 'checkPermission' : null);

    const routes = new Map();
    const unmounted = [];
    for (const file of fs.readdirSync(path.join(BACKEND, 'routes')).filter((f) => f.endsWith('.js'))) {
        const name = file.replace(/\.js$/, '');
        if (!mounts[name]) { unmounted.push(name); continue; }
        const router = require(path.join(BACKEND, 'routes', file));
        const inherited = [];
        for (const layer of router.stack) {
            if (!layer.route) { inherited.push(layer.handle); continue; }
            const methods = [...new Set(layer.route.stack.map((l) => l.method))];
            for (const method of methods) {
                const chain = [...inherited, ...layer.route.stack.filter((l) => l.method === method).map((l) => l.handle)];
                const key = `${method.toUpperCase()} ${mounts[name]}${layer.route.path === '/' ? '' : layer.route.path}`;
                if (!routes.has(key)) routes.set(key, { key, file, guards: chain.map(label).filter(Boolean) });
            }
        }
    }
    return { routes: [...routes.values()], unmounted };
}

// ─── Meta-tests ────────────────────────────────────────────────────────────
describe('route inventory meta-tests', () => {
    let inv;
    beforeAll(() => { inv = buildInventory(); });

    test('every routes/*.js module is mounted in app.js', () => {
        expect(inv.unmounted).toEqual([]);
        expect(inv.routes.length).toBeGreaterThan(300);
    });

    test('every route without an auth guard is in the documented PUBLIC allowlist', () => {
        const unguarded = inv.routes
            .filter((r) => !r.guards.some((g) => AUTH_GUARDS.includes(g)))
            .map((r) => r.key).sort();
        expect(unguarded).toEqual(Object.keys(PUBLIC).sort());
    });

    test('every guarded route has a row in EXPECTED (no route escapes the matrix)', () => {
        const covered = new Set(EXPECTED.map(([m, p]) => `${m} ${p}`));
        const missing = inv.routes
            .filter((r) => r.guards.some((g) => AUTH_GUARDS.includes(g)))
            .map((r) => r.key).filter((k) => !covered.has(k));
        expect(missing).toEqual([]);
    });

    test('every EXPECTED row still exists in the routers (no stale rows)', () => {
        const live = new Set(inv.routes.map((r) => r.key));
        expect(EXPECTED.map(([m, p]) => `${m} ${p}`).filter((k) => !live.has(k))).toEqual([]);
        expect(new Set(EXPECTED.map(([m, p]) => `${m} ${p}`)).size).toBe(EXPECTED.length);
    });
});

// ─── The matrix ────────────────────────────────────────────────────────────
const oid = () => new mongoose.Types.ObjectId().toString();
const PARAM_VALUES = { filename: 'no-such-backup.json.gz', section: 'general' };
const concrete = (p, over = {}) => p.replace(/:(\w+)/g, (_, name) => String(over[name]?.() || PARAM_VALUES[name] || oid()));

const CASES = [];
for (const [method, route, allowed, opts = {}] of EXPECTED) {
    for (const role of ROLES) {
        const allow = allowed.includes(role);
        if (allow && opts.denyOnly) continue;
        CASES.push([`${method} ${route} as ${role} → ${allow ? 'allowed' : 'denied'}`, method, route, role, allow, opts]);
    }
}

const allowed5xx = [];

function isDenied(role, res) {
    if (res.status === 401 || res.status === 403) return true;
    // attachTenant refuses tenant-less anonymous calls before `protect`.
    return role === 'anon' && res.status === 400 && res.body?.code === 'TENANT_REQUIRED';
}

describe('role × route access matrix', () => {
    afterAll(() => {
        if (allowed5xx.length) {
            // Informational: allowed callers that crashed on a harmless body.
            console.warn(`allowed-role 5xx responses:\n${allowed5xx.join('\n')}`);
        }
    });

    test.each(CASES)('%s', async (_label, method, route, role, allow, opts) => {
        const url = concrete(route, opts.params);
        let req = client(role)[method.toLowerCase()](url);
        if (method !== 'GET') req = req.send({});
        const res = await req;
        const seen = `${res.status} ${JSON.stringify(res.body || {}).slice(0, 160)}`;
        if (allow) {
            if (res.status >= 500) allowed5xx.push(`${method} ${route} as ${role} → ${seen}`);
            const authzDenied = [401, 403].includes(res.status) && !(opts.biz403 || []).includes(res.body?.code);
            expect(authzDenied ? seen : 'not 401/403').toBe('not 401/403');
        } else {
            expect(isDenied(role, res) ? 'denied (401/403)' : seen).toBe('denied (401/403)');
        }
    });
});

// ─── Guard gaps proven with real data ──────────────────────────────────────
describe('guard gaps on protect-only routes', () => {
    test('GET /promotions/customer/:userId refuses a customer reading another customer\'s CRM profile', async () => {
        // Regression (fixed 2026-10): route is adminOnly + checkPermission('crm'); controller only reveals customers active in the caller's tenant.
        const victim = await createCustomer('crm-victim');
        await setWallet(A, victim, { balance: 777, loyaltyPoints: 42 });
        const attacker = await createCustomer('crm-attacker');

        const res = await ctx.api.as(attacker, A).get(`/promotions/customer/${victim._id}`);
        expect(res.body?.customer?.email).toBeUndefined();
        expect([401, 403]).toContain(res.status);
    });

    test('POST /shifts/clock-in refuses a customer (no staff shift is created)', async () => {
        // Regression (fixed 2026-10): routes/shiftRoute.js now guards clock-in/out with staffOnly (+ role re-check in shiftController).
        const cust = await createCustomer('shift');
        const res = await ctx.api.as(cust, A).post('/shifts/clock-in').send({});
        expect([401, 403]).toContain(res.status);
    });
});
