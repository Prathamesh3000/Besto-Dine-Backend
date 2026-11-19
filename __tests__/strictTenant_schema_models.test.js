/**
 * STRICT tenant campaign / data-model level + static analysis (no database).
 *
 *  - every Mongoose model is classified: tenant-owned (required, indexed
 *    `restaurant` ref + scope plugin) / documented exception / platform-global;
 *  - the static audit scanner is clean and every AUDIT-EXEMPT / skipTenantScope
 *    site is a reviewed one (a NEW exemption must be reviewed and added here).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');

const BACKEND = path.join(__dirname, '..');

function loadModels() {
    const dir = path.join(BACKEND, 'models');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    files.forEach((f) => require(path.join(dir, f)));
    return { files, models: mongoose.models };
}

const { files: MODEL_FILES, models } = loadModels();

// ── Classification (reviewed) ────────────────────────────────────────────
// Tenant-owned but `restaurant` is optional: global identities that also carry a tenant.
const OPTIONAL_RESTAURANT = {
    User: 'customers + superadmins are global, staff carry a restaurant',
    IdempotencyRecord: 'key already hashes the tenant; also used on public routes',
    PaymentClaim: 'gateway payment id is the identity (webhooks arrive without tenant context)',
    PasswordResetToken: 'keyed by a random token hash; belongs to a global user',
};
// Tenant-owned and required but NOT registered with the scope plugin.
// (User is registered in nullable mode - see models/user.js - so it is not an exception.)
const { User: _userNullable, ...OPTIONAL_NO_PLUGIN } = OPTIONAL_RESTAURANT;
const NO_PLUGIN = {
    ...OPTIONAL_NO_PLUGIN,
    BillCounter: 'only touched by utils/billWorkspace.js with an explicit restaurant',
    KotTicketCounter: 'only touched by utils/kotRounds.js with an explicit restaurant',
    OrderTokenCounter: 'only touched by utils/orderToken.js with an explicit restaurant',
};
// Platform-global: no tenant data.
const GLOBAL_MODELS = [
    'AuditLog', 'BlogPost', 'JobLock', 'Lead', 'LoginAttempt', 'MarketingSetting', 'Otp', 'OtpSendCounter',
    'RefreshSession', 'Restaurant', 'SubscriptionPlan',
];

const hasPlugin = (model) => {
    const pres = model.schema.s.hooks._pres.get('aggregate') || [];
    return pres.some((h) => h.fn && h.fn.name === 'aggregateHook');
};

const restaurantIndexed = (model) => {
    const p = model.schema.path('restaurant');
    if (p && p.options && p.options.index) return true;
    return model.schema.indexes().some(([fields]) => Object.keys(fields)[0] === 'restaurant');
};

const tenantModels = Object.entries(models).filter(([, m]) => m.schema.path('restaurant'));
const otherModels = Object.entries(models).filter(([, m]) => !m.schema.path('restaurant'));

describe('model registry', () => {
    test('every model file registers a model', () => {
        expect(Object.keys(models).length).toBeGreaterThanOrEqual(MODEL_FILES.length - 2);
    });

    test('the set of models WITHOUT a restaurant field is exactly the reviewed platform-global set', () => {
        expect(otherModels.map(([n]) => n).sort()).toEqual([...GLOBAL_MODELS].sort());
    });

    test('platform-global models hold no tenant data: no ref to a tenant-owned model, no tenant-like field name', () => {
        const tenantNames = new Set(tenantModels.map(([n]) => n));
        const offenders = [];
        for (const [name, m] of otherModels) {
            m.schema.eachPath((p, t) => {
                const ref = t.options && (t.options.ref || (t.caster && t.caster.options && t.caster.options.ref));
                if (ref && tenantNames.has(ref) && ref !== 'User' && name !== 'Restaurant') offenders.push(`${name}.${p} -> ${ref}`);
                if (/^(tenant|restaurantId|tenantId)$/i.test(p)) offenders.push(`${name}.${p}`);
            });
        }
        expect(offenders).toEqual([]);
    });
});

describe('tenant-owned models', () => {
    test('there are tenant-owned models', () => {
        expect(tenantModels.length).toBeGreaterThan(55);
    });

    test('`restaurant` is an ObjectId ref to Restaurant everywhere', () => {
        const bad = tenantModels
            .filter(([, m]) => {
                const p = m.schema.path('restaurant');
                return !(p.instance === 'ObjectId' || p.instance === 'ObjectID') || p.options.ref !== 'Restaurant';
            })
            .map(([n]) => n);
        expect(bad).toEqual([]);
    });

    test('`restaurant` is required except for the documented global identities', () => {
        const notRequired = tenantModels.filter(([, m]) => !m.schema.path('restaurant').isRequired).map(([n]) => n).sort();
        expect(notRequired).toEqual(Object.keys(OPTIONAL_RESTAURANT).sort());
    });

    test('`restaurant` is indexed (own index or leading key of a compound index)', () => {
        const bad = tenantModels.filter(([n, m]) => !(n in OPTIONAL_RESTAURANT) && !restaurantIndexed(m)).map(([n]) => n);
        expect(bad).toEqual([]);
    });

    test('every required-restaurant model has the scope plugin, except the explicitly reviewed counters', () => {
        const missing = tenantModels.filter(([n, m]) => !hasPlugin(m)).map(([n]) => n).sort();
        expect(missing).toEqual(Object.keys(NO_PLUGIN).sort());
    });

    test('the exceptions list has no stale entries', () => {
        const names = new Set(tenantModels.map(([n]) => n));
        for (const n of Object.keys(NO_PLUGIN)) expect(names.has(n)).toBe(true);
    });

    // models/user.js registers the plugin in nullable mode (fixed 2026-11): staff rows are
    // tenant data, customers / superadmins have restaurant=null, so reads inside a tenant
    // context are limited to restaurant in [tenant, null].
    test('Regression (fixed 2026-11): staff User rows are protected by the tenant scope plugin', () => {
        expect(hasPlugin(models.User)).toBe(true);
    });

    test('no tenant-owned model declares a GLOBAL unique field-level index (schema level)', () => {
        const allowed = new Set(['Order.orderId', 'Table.qrToken', 'ApiKey.prefix', 'SubscriptionInvoice.razorpayPaymentId', 'PaymentClaim.paymentId', 'IdempotencyRecord.key']);
        const bad = [];
        for (const [name, m] of tenantModels) {
            m.schema.eachPath((p, t) => {
                if (t.options && t.options.unique && !allowed.has(`${name}.${p}`)) bad.push(`${name}.${p}`);
            });
        }
        expect(bad).toEqual([]);
    });
});

// ── Static analysis ──────────────────────────────────────────────────────
describe('static tenant-scope audit', () => {
    test('node scripts/audit-tenant-scope.js exits 0 with zero offenders', () => {
        const r = spawnSync(process.execPath, [path.join(BACKEND, 'scripts', 'audit-tenant-scope.js'), '--json'], { encoding: 'utf8', cwd: BACKEND });
        expect(r.status).toBe(0);
        const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
        const offenders = json.offenders || json.violations || [];
        expect(offenders).toHaveLength(0);
    });

    const SCAN_DIRS = ['controllers', 'services', 'utils', 'middlewares', 'realtime', 'routes'];
    function walk(dir, out = []) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
        }
        return out;
    }
    const sources = SCAN_DIRS.flatMap((d) => walk(path.join(BACKEND, d)));
    const rel = (f) => path.relative(BACKEND, f).replace(/\\/g, '/');

    // Every file that carries an AUDIT-EXEMPT, reviewed 2026-11-10 (see reasons in the report).
    const REVIEWED_EXEMPT_FILES = [
        'controllers/blogController.js', 'controllers/campaignController.js', 'controllers/crmController.js',
        'controllers/incentiveController.js', 'controllers/menuController.js', 'controllers/promotionController.js',
        'controllers/publicController.js', 'controllers/publicLandingController.js', 'controllers/staffController.js',
        'controllers/superadmin/billing.js', 'controllers/superadmin/leads.js', 'controllers/superadmin/marketing.js',
        'controllers/tableController.js', 'controllers/telemetryController.js', 'controllers/twoFactorController.js',
        'controllers/walletController.js', 'services/incentiveService.js', 'services/inventoryDeductionService.js',
        'services/notificationService.js', 'services/orderHoldService.js', 'services/reportScheduleService.js',
        'utils/ledgerPostJob.js', 'utils/publicPlans.js', 'utils/socket.js',
        // reviewed 2026-11 (skipScope fixes): global payment-id / key-prefix / webhook lookups
        'controllers/tenantBillingController.js', 'utils/planPaymentApply.js', 'utils/webhookService.js', 'middlewares/apiKeyAuth.js',
        // reviewed 2026-11-11 (trial signup + signup leads): global razorpay payment-id reuse check,
        // platform-owner lead listing across tenants
        'controllers/publicSignupShared.js', 'controllers/superadmin/signupLeads.js',
    ];

    test('every AUDIT-EXEMPT carries a real reason, and only reviewed files have one', () => {
        const withExempt = {};
        const noReason = [];
        for (const f of sources) {
            const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
            lines.forEach((l, i) => {
                const m = l.match(/AUDIT-EXEMPT:?\s*(.*)$/);
                if (!m) return;
                withExempt[rel(f)] = (withExempt[rel(f)] || 0) + 1;
                if (m[1].replace(/[^a-z]/gi, '').length < 12) noReason.push(`${rel(f)}:${i + 1}`);
            });
        }
        expect(noReason).toEqual([]);
        const unreviewed = Object.keys(withExempt).filter((f) => !REVIEWED_EXEMPT_FILES.includes(f));
        expect(unreviewed).toEqual([]);
    });

    // Every runtime opt-out of the plugin. A new one must be reviewed.
    const REVIEWED_SKIP_FILES = [
        'controllers/tableController.js',          // QR token resolves the tenant
        'controllers/tenantBillingController.js',  // global razorpay payment id idempotency
        'services/incentiveService.js',            // system reconcile job
        'utils/planPaymentApply.js',               // global razorpay payment id idempotency
        'utils/webhookService.js',                 // delivery worker sweep
        'middlewares/apiKeyAuth.js',               // API key prefix resolves the tenant
        'utils/tenantSafe.js', 'utils/tenantScopePlugin.js',
    ];
    test('skipTenantScope is only used in reviewed places', () => {
        const users = sources.filter((f) => /skipTenantScope/.test(fs.readFileSync(f, 'utf8'))).map(rel);
        expect(users.filter((f) => !REVIEWED_SKIP_FILES.includes(f))).toEqual([]);
    });

    test('runAsSystem is only used by reviewed cross-tenant sweeps (scheduler, socket join, QR token, incentive/webhook sweeps)', () => {
        const users = sources
            .filter((f) => /runAsSystem\(/.test(fs.readFileSync(f, 'utf8')))
            .map(rel)
            .filter((f) => !['utils/tenantSafe.js', 'utils/tenantScopePlugin.js'].includes(f));
        expect(users.sort()).toEqual([
            'controllers/tableController.js', 'services/incentiveService.js', 'utils/scheduler.js',
            'utils/socket.js', 'utils/webhookService.js',
        ]);
    });

    // Triage of exemptions that lean on "checked afterwards": the check must still be there.
    test('exemptions that rely on a later tenant check still have that check', () => {
        const read = (f) => fs.readFileSync(path.join(BACKEND, f), 'utf8');
        // CRM customer detail: 404 unless the customer has activity in this tenant.
        expect(read('controllers/crmController.js')).toMatch(/walletFootprint[\s\S]{0,400}404/);
        // promotion customer stats: user only revealed after a tenant-scoped wallet/order hit.
        expect(read('controllers/promotionController.js')).toMatch(/wallet \|\| orders\.length/);
        // wallet customer search: candidates are filtered to tenant wallets / orders.
        expect(read('controllers/walletController.js')).toMatch(/walletByUser\.has\(String\(u\._id\)\) \|\| orderSet\.has/);
    });

    // Fixed 2026-11: walletController customer search used to take `.limit(200)` BEFORE the
    // tenant filter, so a tenant customer could be missed behind 200 other tenants' matches.
    // It now collects the tenant's wallet/order user ids first.
    test('Regression (fixed 2026-11): customer search applies the tenant filter before the 200-row cap', () => {
        const src = fs.readFileSync(path.join(BACKEND, 'controllers/walletController.js'), 'utf8');
        const block = src.slice(src.indexOf('customers are platform-global; filtered to tenant activity below'));
        const limitAt = block.indexOf('.limit(200)');
        const tenantAt = block.indexOf('tenantFilter(req)');
        expect(tenantAt).toBeGreaterThan(-1);
        expect(tenantAt).toBeLessThan(limitAt);
    });
});
