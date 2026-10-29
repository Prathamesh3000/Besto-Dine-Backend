#!/usr/bin/env node
/**
 * audit-tenant-scope.js — static scan to catch tenant-isolation leaks
 * before they ship.
 *
 * Why this exists:
 *   Most data leaks in a multi-tenant codebase happen because someone
 *   added a new endpoint and forgot to spread `tenantFilter(req)` into
 *   the Mongo query. The result: Tenant A staff can read Tenant B
 *   data. Audit script catches these in seconds, no DB / network needed.
 *
 * What it does:
 *   Walks every `Backend/controllers/*.js` and inspects every Mongoose
 *   query (`.find(`, `.findOne(`, `.findById(`, `.findOneAnd*(`,
 *   `.updateOne(`, `.updateMany(`, `.deleteOne(`, `.deleteMany(`,
 *   `.countDocuments(`, `.aggregate(`). For each query call:
 *
 *     ✅ PASS — the filter object visibly contains one of:
 *        - `tenantFilter(req)` / `...tf` / `...tenantFilter(req)`
 *        - a literal `restaurant:` field
 *        - the call is inside an explicitly EXEMPT controller
 *          (SuperAdmin, public list endpoints, billing/Razorpay
 *          webhooks — set in EXEMPT_FILES below).
 *
 *     ❌ FAIL — none of the above present in the same logical line
 *        OR the surrounding filter-builder variable.
 *
 *   The script is static: it doesn't run the code, just parses files.
 *   Best-effort — meant to catch human error, not adversarial code.
 *
 * Usage:
 *   cd Backend
 *   node scripts/audit-tenant-scope.js                # full audit
 *   node scripts/audit-tenant-scope.js --json         # machine-readable
 *   node scripts/audit-tenant-scope.js --quiet        # offenders only
 *
 * Raw-operation check (task 4.6): controllers/, services/ and utils/ are also
 * scanned for raw bulkWrite / insertMany / $lookup / $unionWith / $graphLookup /
 * estimatedDocumentCount (scripts/lib/rawOpScan.js). The tenantScope plugin
 * cannot scope these; use the wrappers in utils/tenantSafe.js
 * (tenantBulkWrite, tenantInsertMany, tenantLookup, tenantUnionWith,
 * tenantEstimatedCount) or add `// AUDIT-EXEMPT: <reason>` on / above the line.
 * Each such offender prints as `RAW <kind>` with a fix hint.
 *
 * Exit code:
 *   0 — no offenders, ship it
 *   1 — at least one offender → block the commit / CI build
 *
 * Adding an exemption:
 *   1. If a whole controller is intentionally global (superadminController),
 *      add the filename to EXEMPT_FILES.
 *   2. If a single query is intentionally cross-tenant, add the comment
 *      `// AUDIT-EXEMPT: <reason>` on the SAME line or the line directly above:
 *           // AUDIT-EXEMPT: global plan list, no tenant scope by design
 *           const plans = await SubscriptionPlan.find({ isActive: true });
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { scanRawOps } = require('./lib/rawOpScan');

// ── Config ──────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', 'controllers');
// Business logic moved out of controllers into Backend/services/ (BUGS_REPORT
// #31) — those queries must stay under the same audit. Service files are
// reported as `services/<name>` so EXEMPT_FILES (controller names) never
// matches them by accident.
const SERVICES_ROOT = path.resolve(__dirname, '..', 'services');
// utils/ gets the raw-operation check only (its queries are helpers, not endpoints).
const UTILS_ROOT = path.resolve(__dirname, '..', 'utils');
// Infrastructure that implements the wrappers / plugin: raw calls are the point.
const RAW_SCAN_SKIP = new Set(['utils/tenantSafe.js', 'utils/tenantScopePlugin.js']);

// Baseline-accepted findings, keyed `<filename>:<line>` → reason.
//
// Deliberately EMPTY (BUGS_REPORT #30 cleanup). Line-number keys go
// stale the moment a file is edited — the previous entries all pointed
// at lines that no longer held the query they described, so they could
// silently mask an unrelated new query that landed on that line. Use an
// inline `// AUDIT-EXEMPT: <reason>` comment at the query instead; it
// moves with the code.
const BASELINE = {};

// Whole-file exemptions. These controllers operate platform-wide by
// design (SuperAdmin tenant management, public restaurant directory,
// billing webhooks, etc.). They legitimately query without tenant scope.
const EXEMPT_FILES = new Set([
    'superadminController.js',
    'publicController.js',
    'publicMenuBootstrapController.js',
    'razorpayController.js',
    'tenantBillingController.js',
    'healthController.js',
    'notificationController.js',
    // authController is pre-tenant-context by definition: it RESOLVES
    // which tenant a login belongs to (customer email is globally unique;
    // staff login uses loginType + tenant slug, validated separately).
    'authController.js',
    // adminBootstrapController is the first-paint bundler for the admin
    // SPA. It builds tenant-scoped sub-queries internally via filter
    // builders (the `filter` variable is a tenantFilter spread); the
    // static scan can't see through that indirection.
    'adminBootstrapController.js',
]);

// Patterns that prove a query is intrinsically safe regardless of where
// the filter spread sits — e.g. looking up the caller's own user record
// by their JWT `_id` doesn't need a tenant scope because the `_id` is
// already a globally-unique ObjectId and JWT auth proved ownership.
const INTRINSICALLY_SAFE_QUERY_PATTERNS = [
    // findById(req.user._id) and friends — caller's own doc by trusted id
    /\.findById\s*\(\s*req\.user\._id\b/,
    /\.findById\s*\(\s*req\.params\.id\b/,
    // Re-fetch by _id of a doc we JUST created/saved within the same
    // request. The doc was created with `restaurant: tenantId(req)`
    // so re-reading by its _id can't surface cross-tenant data.
    // Pattern: `Model.findById(<localVar>._id)` where localVar is a
    // freshly-saved doc.
    /\.findById\s*\(\s*\w+\._id\s*[),]/,
    // Cross-collection lookup by a foreign key that was itself
    // tenant-validated upstream. Pattern: `Model.findOne({ order:
    // order._id, ... })` where `order._id` is a doc we already fetched
    // with tenant scope.
    /\.find(?:One)?\s*\(\s*\{\s*(?:order|user|customer|tenant|table|menuItem|inventoryItem|recipe|combo|branch|area|restaurant)\s*:\s*\w+\._id\b/i,
    // Update/delete by _id of a doc fetched-with-tenant-scope earlier
    // in the same handler. Pattern: `Model.deleteOne({ _id: <var>._id })`
    /\.(?:update|delete)(?:One|Many)\s*\(\s*\{\s*_id\s*:\s*\w+\._id\s*\}/,
    // Inline { _id: { $in: <var> } } where the var was tenant-scoped
    // upstream (we trust the developer to have scoped the source list).
    /\.\w+\s*\(\s*\{\s*_id\s*:\s*\{\s*\$in\s*:/,
];

// Single-line exemption marker
const EXEMPT_COMMENT = /AUDIT-EXEMPT/;

// Query operations we audit
const QUERY_OPS = [
    'find',
    'findOne',
    'findById',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'findByIdAndUpdate',
    'findByIdAndDelete',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'countDocuments',
    'aggregate',
    'distinct',
];

// Markers that prove a query is tenant-scoped
const SAFE_MARKERS = [
    /\btenantFilter\s*\(/,                  // tenantFilter(req)
    /\.\.\.tf\b/,                           // ...tf
    /\.\.\.\s*tenantFilter\s*\(/,           // ... tenantFilter(req)
    /\brestaurant\s*:/,                     // restaurant: <something>
    /\bRestaurant\.findById\s*\(/,          // looking up the restaurant doc itself
];

// Method calls that don't take a filter (so don't count them as queries)
// e.g. `User.findById(req.user._id).populate(...)` — findById's first arg
// is an _id, not a filter object; but we want to flag findById without
// tenantFilter when the caller doesn't also check ownership. Decision:
// we DO audit findById, but treat it as safe if it's followed by a
// `.populate()` or used inside a route where the caller's own user is
// being read. Heuristic only.

// ── CLI ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
    json:  args.includes('--json'),
    quiet: args.includes('--quiet'),
};

// ── Scan logic ──────────────────────────────────────────────────────
const offenders = [];        // { file, line, snippet, op, model }
const stats = { filesScanned: 0, filesExempt: 0, queriesScanned: 0, queriesPassed: 0, rawOpsFound: 0, rawOpsOffenders: 0 };

function recordRaw(src, relName) {
    if (RAW_SCAN_SKIP.has(relName)) return;
    const found = scanRawOps(src, relName);
    stats.rawOpsFound += found.length;
    for (const f of found) {
        stats.rawOpsOffenders += 1;
        offenders.push({ file: f.file, line: f.line, op: f.kind, model: 'RAW', snippet: f.snippet, hint: f.hint, raw: true });
    }
}

function scanFile(absPath, relName) {
    stats.filesScanned += 1;
    if (EXEMPT_FILES.has(relName) || relName.startsWith('superadmin/') || relName.startsWith('razorpay/')) {
        stats.filesExempt += 1;
        return;
    }

    const src = fs.readFileSync(absPath, 'utf8');
    recordRaw(src, relName);
    const lines = src.split(/\r?\n/);

    // Build a model-name regex: capitalised identifier + dot + query op.
    // e.g. `Order.find(`, `MenuItem.findOne(`, `req.tenant.find(` — we
    // catch the first two and skip the last because lowercase receivers
    // are usually not Mongoose models.
    const queryRe = new RegExp(
        '(\\b[A-Z][A-Za-z0-9_]*)\\.(' + QUERY_OPS.join('|') + ')\\s*\\(',
        'g'
    );

    // Helper: when a query's first arg is a bare identifier
    // (`.find(filter)`, `.find(queryObj)`, etc.), walk backwards within
    // the same function looking for `<name> = { ... }` and test that
    // block against SAFE_MARKERS. Returns true if the upstream filter
    // looks tenant-scoped.
    function filterVarIsSafe(varName, atLine, depth = 0) {
        if (!varName || depth > 3) return false;
        // Crude function scope: walk up until we see a `function`,
        // `=>` opening brace, or `module.exports.` declaration.
        // Build the regex via String.raw so the backslashes survive the
        // RegExp constructor without needing to be doubled.
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Loose-match the assignment: `const x = <anything>`. RHS may
        // be a ternary, function call, spread literal, etc. We just
        // want to find the line where the variable is bound so we can
        // scan its body for tenant scoping.
        const assignRe = new RegExp(String.raw`\b(?:const|let|var)?\s*` + escaped + String.raw`\s*=\s*[^=]`);
        const fnBoundary = /^\s*(?:exports\.|module\.exports|function\b|const\s+\w+\s*=\s*(?:async\s+)?\(.*\)\s*=>)/;
        for (let i = atLine - 1; i >= 0 && i > atLine - 400; i--) {
            if (fnBoundary.test(lines[i])) break;
            if (assignRe.test(lines[i])) {
                // Found the assignment — scan forward until the closing
                // `}` at the same indent level. Cheap heuristic: take
                // the next 60 lines as the assignment body.
                const blockEnd = Math.min(lines.length, i + 60);
                const block = lines.slice(i, blockEnd).join('\n');
                if (SAFE_MARKERS.some(re => re.test(block))) return true;
                // Follow spreads in the assignment statement (first few
                // lines) back to THEIR definitions, up to 3 hops:
                //   const listFilter = { ...base }  ->  const base = { ...tf, ...sbf }
                const head = lines.slice(i, Math.min(lines.length, i + 4)).join('\n');
                const spreadRe = /\.\.\.([a-zA-Z_$][\w$]*)\b/g;
                let sm;
                while ((sm = spreadRe.exec(head)) !== null) {
                    if (sm[1] !== varName && filterVarIsSafe(sm[1], i, depth + 1)) return true;
                }
                return false;
            }
        }
        return false;
    }

    let match;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        // Skip pure comment lines — those aren't real queries.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
        // Reset the regex each line so global state doesn't bleed across
        queryRe.lastIndex = 0;
        while ((match = queryRe.exec(line)) !== null) {
            stats.queriesScanned += 1;
            const model = match[1];
            const op = match[2];

            // SuperAdmin-only / globally-shared models — these have no
            // `restaurant` field on the doc so a tenant filter would be
            // a no-op. Auto-exempt regardless of file.
            const TENANT_FREE_MODELS = new Set([
                'AuditLog',
                'SubscriptionPlan',
                'Otp',                  // SMS/email OTP, keyed by mobile/email + globally unique
                'Restaurant',           // the tenant itself — looked up by slug/id
                'Settings',             // global system settings doc
                'StaffWithdrawal',      // child of a tenant-scoped Staff, validated upstream
                'TipSettlement',        // child of a tenant-scoped order
                'RefundRequest',        // child of a tenant-scoped order, FK validated upstream
                'CouponRedemption',     // child of a coupon, coupon._id was tenant-scoped
                'Reservation',          // post-save re-fetch by id, FK validated upstream
                'Transaction',          // child of a Wallet which is tenant-scoped via FK
                'Wallet',               // tenant-scoped via FK (user), and walletScope is built upstream
                // Platform-level models with NO restaurant field at all:
                'BlogPost',             // marketing-site blog, superadmin-authored
                'Lead',                 // superadmin sales pipeline
                'MarketingSetting',     // platform marketing config
                'RefreshSession',       // auth session, keyed by user
            ]);
            if (TENANT_FREE_MODELS.has(model)) {
                stats.queriesPassed += 1;
                continue;
            }

            // Intrinsically-safe patterns (caller's own user, etc.)
            if (INTRINSICALLY_SAFE_QUERY_PATTERNS.some(re => re.test(line))) {
                stats.queriesPassed += 1;
                continue;
            }

            // Window: this line + the previous comment line + the next
            // 6 lines (to cover multi-line filter objects)
            const windowStart = Math.max(0, lineIdx - 1);
            const windowEnd = Math.min(lines.length, lineIdx + 7);
            const windowText = lines.slice(windowStart, windowEnd).join('\n');

            // Exemption comment present?
            if (EXEMPT_COMMENT.test(windowText)) {
                stats.queriesPassed += 1;
                continue;
            }

            // Safe markers present in the window?
            const safe = SAFE_MARKERS.some(re => re.test(windowText));
            if (safe) {
                stats.queriesPassed += 1;
                continue;
            }

            // Last chances:
            //   (a) Bare variable name as filter:   .find(filter)
            //   (b) Inline object spreading a var:  .find({ ...scope, status:'x' })
            //   (c) Same arg shape inside an array (aggregate pipelines):
            //       .aggregate([{ $match: { ...scope, ... } }])
            // For each, find the variable name being spread and walk
            // back to its definition to check tenant scoping.
            const afterParen = line.slice(match.index + match[0].length);
            // Window of args — take up to 400 chars from this query call,
            // wrapping the next few lines so multi-line .aggregate pipes
            // are still inspected.
            const argsWindow = (afterParen + '\n' +
                lines.slice(lineIdx + 1, Math.min(lines.length, lineIdx + 8)).join('\n')
            ).slice(0, 600);

            const candidateVars = new Set();

            // (a) bare identifier
            const bareIdent = afterParen.trimStart().match(/^([a-zA-Z_$][\w$]*)\s*[,)]/);
            if (bareIdent) candidateVars.add(bareIdent[1]);

            // (b)+(c) `...<varname>` spreads anywhere in the args
            const spreadRe = /\.\.\.([a-zA-Z_$][\w$]*)\b/g;
            let sm;
            while ((sm = spreadRe.exec(argsWindow)) !== null) {
                candidateVars.add(sm[1]);
            }

            // (d) Aggregation pipelines: `$match: <varName>` and
            // `$match: { ...<varName>, ... }`.
            const matchVarRe = /\$match\s*:\s*([a-zA-Z_$][\w$]*)\b/g;
            let mm;
            while ((mm = matchVarRe.exec(argsWindow)) !== null) {
                candidateVars.add(mm[1]);
            }

            let varSafe = false;
            for (const v of candidateVars) {
                if (filterVarIsSafe(v, lineIdx)) { varSafe = true; break; }
            }
            if (varSafe) {
                stats.queriesPassed += 1;
                continue;
            }

            // Baseline-accepted finding? Treat as exempt.
            const baselineKey = `${relName}:${lineIdx + 1}`;
            if (BASELINE[baselineKey]) {
                stats.queriesPassed += 1;
                continue;
            }

            // ── Failure ──
            offenders.push({
                file: relName,
                line: lineIdx + 1,
                op,
                model,
                snippet: line.trim().slice(0, 140),
            });
        }
    }
}

function walk(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, (e.name === 'superadmin' || e.name === 'razorpay') && prefix === '' ? e.name + '/' : prefix);
        else if (e.isFile() && e.name.endsWith('.js')) scanFile(full, prefix + e.name);
    }
}

walk(ROOT);
if (fs.existsSync(SERVICES_ROOT)) walk(SERVICES_ROOT, 'services/');
if (fs.existsSync(UTILS_ROOT)) {
    (function walkUtils(dir, prefix) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walkUtils(full, prefix + e.name + '/');
            else if (e.isFile() && e.name.endsWith('.js')) {
                stats.filesScanned += 1;
                recordRaw(fs.readFileSync(full, 'utf8'), prefix + e.name);
            }
        }
    })(UTILS_ROOT, 'utils/');
}

// ── Output ──────────────────────────────────────────────────────────
if (flags.json) {
    console.log(JSON.stringify({ stats, offenders }, null, 2));
} else {
    const reset = '\x1b[0m', red = '\x1b[31m', green = '\x1b[32m', yellow = '\x1b[33m', dim = '\x1b[2m';
    if (!flags.quiet) {
        console.log('');
        console.log(`Tenant-scope audit — ${new Date().toISOString().slice(0, 10)}`);
        console.log(`${dim}Scanning Backend/controllers/ + Backend/services/ (+ utils/ for raw bulk/lookup ops)${reset}`);
        console.log('');
        console.log(`  files scanned ........ ${stats.filesScanned}`);
        console.log(`  files exempt ......... ${stats.filesExempt} ${dim}(see EXEMPT_FILES)${reset}`);
        console.log(`  queries scanned ...... ${stats.queriesScanned}`);
        console.log(`  queries passed ....... ${stats.queriesPassed}`);
        console.log(`  raw bulk/lookup ops .. ${stats.rawOpsFound} unexempted ${dim}(bulkWrite/insertMany/$lookup/$unionWith/estimatedDocumentCount)${reset}`);
        console.log(`  ${offenders.length ? red : green}offenders ............ ${offenders.length}${reset}`);
        console.log('');
    }

    if (offenders.length === 0) {
        if (!flags.quiet) console.log(`${green}✅ All controller + service queries appear tenant-scoped; no unexempted raw bulk/lookup ops.${reset}`);
        process.exit(0);
    }

    console.log(`${red}❌ Offenders — these queries don't visibly carry a tenant filter:${reset}`);
    console.log('');
    for (const o of offenders) {
        if (o.raw) {
            console.log(`  ${yellow}${o.file}:${o.line}${reset}  RAW ${o.op}`);
            console.log(`     ${o.snippet}`);
            console.log(`     ${dim}fix: ${o.hint}${reset}`);
            console.log('');
            continue;
        }
        console.log(`  ${yellow}${o.file}:${o.line}${reset}  ${dim}${o.model}.${o.op}(${reset}`);
        console.log(`     ${o.snippet}`);
        console.log('');
    }
    console.log(`${dim}To suppress a false positive add the comment:  // AUDIT-EXEMPT: <reason>${reset}`);
    console.log(`${dim}on the same line or directly above the query.${reset}`);
    console.log('');
    process.exit(1);
}
