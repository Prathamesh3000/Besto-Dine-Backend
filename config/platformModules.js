/**
 * Platform-staff module catalog (PLATFORM_STAFF_PLAN.md).
 *
 * A `platformstaff` user (a delegated super-admin user) may only call the
 * super-admin routes listed here, and only for modules the owner assigned.
 * This file is the single source of truth: the route gate, the create/update
 * validation and the UI picker all read it.
 *
 * Access levels:  'view' < 'manage'  ('manage' includes 'view').
 * A route not matched by any rule below is closed to platform staff.
 *
 * `path` is matched against req.path inside the /superadmin router, i.e.
 * without the /api/v1/superadmin prefix and without a trailing slash.
 */

const ACCESS_LEVELS = ['view', 'manage'];

const MODULES = {
    signupLeads: { label: 'Trial signups', description: 'Follow up restaurants that signed up for a free trial (stage, follow-up date, notes).' },
    trials:      { label: 'Free trials', description: 'See restaurants and their trial status; extend a trial.' },
    leads:       { label: 'Marketing leads', description: 'Demo requests from the marketing site (status and notes).' },
    marketing:   { label: 'Marketing content', description: 'Text and links of the marketing site.' },
    blog:        { label: 'Blog', description: 'Blog posts of the marketing site.' },
    payments:    { label: 'Payments', description: 'Subscription payments (read only).' },
    plans:       { label: 'Plans', description: 'Subscription plans (read only).' },
    dashboard:   { label: 'Overview', description: 'Platform analytics (read only).' },
};

const MODULE_KEYS = Object.keys(MODULES);

// [module, access, method, path regex]
const RULES = [
    // Trial signups
    ['signupLeads', 'view',   'GET',    /^\/signup-leads$/],
    ['signupLeads', 'view',   'GET',    /^\/signup-leads\/summary$/],
    ['signupLeads', 'view',   'GET',    /^\/signup-leads\/export\.csv$/],
    ['signupLeads', 'manage', 'PATCH',  /^\/signup-leads\/[^/]+$/],
    ['signupLeads', 'manage', 'POST',   /^\/signup-leads\/[^/]+\/notes$/],
    // Free trials (restaurant list/detail is read only; the one write is extend-trial)
    ['trials',      'view',   'GET',    /^\/restaurants$/],
    ['trials',      'view',   'GET',    /^\/restaurants\/[^/]+$/],
    ['trials',      'manage', 'POST',   /^\/restaurants\/[^/]+\/extend-trial$/],
    // Marketing leads (delete stays full-only)
    ['leads',       'view',   'GET',    /^\/leads$/],
    ['leads',       'view',   'GET',    /^\/leads\/[^/]+$/],
    ['leads',       'manage', 'PATCH',  /^\/leads\/[^/]+$/],
    // Marketing site content
    ['marketing',   'view',   'GET',    /^\/marketing$/],
    ['marketing',   'manage', 'PUT',    /^\/marketing$/],
    ['marketing',   'manage', 'POST',   /^\/marketing\/(logo|screenshot)$/],
    // Blog
    ['blog',        'view',   'GET',    /^\/blog$/],
    ['blog',        'view',   'GET',    /^\/blog\/[^/]+$/],
    ['blog',        'manage', 'POST',   /^\/blog$/],
    ['blog',        'manage', 'POST',   /^\/blog\/cover$/],
    ['blog',        'manage', 'PATCH',  /^\/blog\/[^/]+$/],
    ['blog',        'manage', 'DELETE', /^\/blog\/[^/]+$/],
    // Read-only modules
    ['payments',    'view',   'GET',    /^\/subscription-payments$/],
    ['plans',       'view',   'GET',    /^\/plans$/],
    ['dashboard',   'view',   'GET',    /^\/analytics$/],
];

const rank = (a) => ACCESS_LEVELS.indexOf(a);

/** { module, access } the request needs, or null when platform staff may not call it at all. */
function resolveRequest(method, rawPath) {
    const path = String(rawPath || '').replace(/\/+$/, '') || '/';
    const m = String(method || '').toUpperCase();
    // HEAD behaves like GET
    const verb = m === 'HEAD' ? 'GET' : m;
    for (const [module, access, rm, re] of RULES) {
        if (rm === verb && re.test(path)) return { module, access };
    }
    return null;
}

/** Does this `platformAccess` map give at least `needed` on `module`? */
function allows(platformAccess, module, needed) {
    const have = platformAccess && typeof platformAccess === 'object' ? platformAccess[module] : null;
    return rank(have) >= 0 && rank(needed) >= 0 && rank(have) >= rank(needed);
}

/**
 * Validate + normalise an access map from a request body. Returns
 * `{ value }` or `{ error }`. Unknown keys and unknown levels are rejected
 * (never silently dropped) so a typo cannot leave a user with less or more
 * access than the owner intended.
 */
function parseAccess(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'modules must be an object like { signupLeads: "manage" }' };
    }
    const value = {};
    for (const [k, v] of Object.entries(input)) {
        if (!MODULE_KEYS.includes(k)) return { error: `Unknown module "${k}"` };
        if (v === null || v === false || v === '' || v === 'none') continue;   // "no access" = leave it out
        if (!ACCESS_LEVELS.includes(v)) return { error: `Access for "${k}" must be one of: ${ACCESS_LEVELS.join(', ')}` };
        value[k] = v;
    }
    if (Object.keys(value).length === 0) return { error: 'Give at least one module' };
    return { value };
}

/** Catalog for the UI: modules with the actions each level unlocks. */
function describeCatalog() {
    return MODULE_KEYS.map((key) => ({
        key,
        ...MODULES[key],
        levels: ACCESS_LEVELS.filter((lvl) => RULES.some(([m, a]) => m === key && a === lvl)),
    }));
}

module.exports = { ACCESS_LEVELS, MODULES, MODULE_KEYS, RULES, resolveRequest, allows, parseAccess, describeCatalog };
