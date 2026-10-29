#!/usr/bin/env node
/**
 * generate-openapi.js - best-effort OpenAPI 3.1 inventory of the INTERNAL API.
 *
 *   node scripts/generate-openapi.js            -> docs/openapi/internal.json
 *   npm run docs:openapi
 *
 * It reads source text only. It never requires app.js, never connects to a
 * database and never starts a server:
 *   1. app.js: `v1.use('/prefix', require('./routes/xRoute'))` mounts (+ the
 *      top-level `app.get('/health')` style probes).
 *   2. routes/*.js: `router.get|post|put|patch|delete('/path', ...mw, handler)`
 *      and `router.route('/path').get(...).post(...)` chains, plus
 *      `router.use(...mw)` guards (applied to routes declared after them).
 *   3. Middleware names become x- extensions (x-auth, x-permissions,
 *      x-feature-gates, x-idempotency, x-validators, x-middleware).
 *   4. express-validator chains (body('f'), optionalText('f', ..) ...) found
 *      in the route's validators (validators/*.js, or declared in the route
 *      file) give request-body field names with simple types; query('f')
 *      becomes a query parameter.
 *
 * It is an inventory, not a contract: bodies are best-effort and responses
 * are generic. The public API has a hand-written spec (public-v1.json).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const OUT_FILE = path.join(BACKEND, 'docs', 'openapi', 'internal.json');
// Routes documented by the hand-written public spec instead.
const SKIP_ROUTE_FILES = new Set(['publicApiRoute']);

const AUTH_NAMES = new Set(['protect', 'optionalAuth', 'staffOnly', 'adminOnly', 'adminExclusive', 'superAdminOnly', 'restrictTo', 'attachTenant']);

// ── source helpers ────────────────────────────────────────────────────────

/** Replace comments with spaces (same length). Aware of strings, templates and simple regex literals. */
function stripComments(src) {
    let out = '';
    let i = 0;
    let prev = '';
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (c === '/' && d === '/') {
            while (i < n && src[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (c === '/' && d === '*') {
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
            out += '  '; i += 2;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            const q = c;
            out += c; i++;
            while (i < n && src[i] !== q) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
                out += src[i]; i++;
            }
            out += q; i++; prev = q;
            continue;
        }
        if (c === '/' && '(,=:[!&|?{};'.includes(prev)) {
            // regex literal
            out += c; i++;
            let inClass = false;
            while (i < n && (src[i] !== '/' || inClass) && src[i] !== '\n') {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
                if (src[i] === '[') inClass = true;
                if (src[i] === ']') inClass = false;
                out += src[i]; i++;
            }
            if (i < n && src[i] === '/') { out += '/'; i++; }
            prev = '/';
            continue;
        }
        out += c;
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return out;
}

/** Index of the bracket matching src[open], honouring strings. -1 if unbalanced. */
function matchClose(src, open) {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const stack = [pairs[src[open]]];
    let i = open + 1;
    while (i < src.length && stack.length) {
        const c = src[i];
        if (c === '\'' || c === '"' || c === '`') {
            const q = c; i++;
            while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
        } else if (c === '/' && !'/*'.includes(src[i + 1] || ' ') && '(,=:[!&|?{};'.includes(prevNonSpace(src, i))) {
            i++;
            let inClass = false;
            while (i < src.length && (src[i] !== '/' || inClass) && src[i] !== '\n') {
                if (src[i] === '\\') i++;
                else if (src[i] === '[') inClass = true;
                else if (src[i] === ']') inClass = false;
                i++;
            }
        } else if (pairs[c]) stack.push(pairs[c]);
        else if (c === stack[stack.length - 1]) stack.pop();
        i++;
    }
    return stack.length ? -1 : i - 1;
}
function prevNonSpace(src, i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    return j >= 0 ? src[j] : '';
}

/** Split `text` on top-level commas. */
function splitArgs(text) {
    const args = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\'' || c === '"' || c === '`') {
            const q = c; cur += c; i++;
            while (i < text.length && text[i] !== q) { if (text[i] === '\\') { cur += text[i]; i++; } cur += text[i]; i++; }
            cur += q; continue;
        }
        if ('([{'.includes(c)) depth++;
        if (')]}'.includes(c)) depth--;
        if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    return args;
}

function stringLiterals(arg) {
    const t = arg.trim();
    let m = /^(['"`])([^'"`]*)\1$/.exec(t);
    if (m) return [m[2]];
    if (t.startsWith('[')) {
        const items = splitArgs(t.slice(1, -1));
        const out = [];
        for (const it of items) { m = /^(['"`])([^'"`]*)\1$/.exec(it); if (!m) return null; out.push(m[2]); }
        return out;
    }
    return null;
}

// ── validators ────────────────────────────────────────────────────────────

const FIELD_FN = /^(body|query|lines|rule\w*|optional\w*|required\w*)$/;

function typeFromChain(fn, chain) {
    if (/Amount|Num|Int|Float/.test(fn) || /\.(isInt|isFloat|isNumeric)\(/.test(chain)) return /\.isInt\(/.test(chain) ? 'integer' : 'number';
    if (/Bool/.test(fn) || /\.isBoolean\(/.test(chain)) return 'boolean';
    if (/Array|Idlist|IdList|^lines$/.test(fn) || /\.isArray\(/.test(chain)) return 'array';
    if (/Date/.test(fn) || /\.isISO8601\(/.test(chain)) return 'date';
    return 'string';
}

/** Field descriptors found in a block of validator source. */
function fieldsFromBlock(block) {
    const out = [];
    const re = /\b([A-Za-z_]\w*)\(\s*(?:(['"`])(body|query|param)\2\s*,\s*)?(['"`])([A-Za-z_][\w.*[\]]*)\4/g;
    let m;
    const hits = [];
    while ((m = re.exec(block))) {
        if (!FIELD_FN.test(m[1])) continue;
        hits.push({ fn: m[1], location: m[3] || (m[1] === 'query' ? 'query' : 'body'), name: m[5], index: m.index });
    }
    hits.forEach((h, k) => {
        const end = k + 1 < hits.length ? hits[k + 1].index : block.length;
        const chain = block.slice(h.index, end);
        out.push({ ...h, type: typeFromChain(h.fn, chain), required: /\.(exists|notEmpty)\(/.test(chain) && !/\.optional\(/.test(chain) && !/^optional/.test(h.fn) });
    });
    return out;
}

const fileCache = new Map();
function readClean(file) {
    if (!fileCache.has(file)) fileCache.set(file, fs.existsSync(file) ? stripComments(fs.readFileSync(file, 'utf8')) : '');
    return fileCache.get(file);
}

/** Top-level `const NAME = <expr>` blocks of a file -> Map(name -> expression text). */
const declCache = new Map();
function declarations(file) {
    if (declCache.has(file)) return declCache.get(file);
    const src = readClean(file);
    const map = new Map();
    const re = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*/gm;
    let m;
    while ((m = re.exec(src))) {
        const start = m.index + m[0].length;
        // expression runs to the end of the statement: first `;` at depth 0
        let depth = 0; let i = start;
        for (; i < src.length; i++) {
            const c = src[i];
            if (c === '\'' || c === '"' || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
            if ('([{'.includes(c)) depth++;
            else if (')]}'.includes(c)) depth--;
            else if (c === ';' && depth <= 0) break;
        }
        map.set(m[1], src.slice(start, i));
    }
    declCache.set(file, map);
    return map;
}

/** `const ov = require('../validators/ops')` / `{ a, b } = require(...)` -> Map(localName -> {file, member|null}). */
function validatorImports(routeFile) {
    const src = readClean(routeFile);
    const map = new Map();
    const re = /const\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]\.\.\/validators\/([\w-]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
        const file = path.join(BACKEND, 'validators', `${m[2]}.js`);
        if (m[1].startsWith('{')) {
            for (const part of m[1].slice(1, -1).split(',')) {
                const [orig, alias] = part.split(':').map((s) => s.trim());
                if (orig) map.set(alias || orig, { file, member: orig });
            }
        } else map.set(m[1], { file, member: null });
    }
    return map;
}

/**
 * Collect validator fields for one route argument. Resolves `ns.name`,
 * imported names, same-file consts (arrays / validate([...])), and inline
 * `validate([...])`, following `...spread` / identifier references 3 deep.
 */
function fieldsForArg(arg, routeFile, imports, depth = 0) {
    if (depth > 3) return [];
    const t = arg.trim();
    const fields = [];
    const visitIdent = (ident, inFile) => {
        const decl = declarations(inFile).get(ident);
        if (decl) fields.push(...fieldsInExpr(decl, inFile, imports, depth + 1));
    };
    let m = /^([\w$]+)\.([\w$]+)$/.exec(t);
    if (m && imports.has(m[1]) && !imports.get(m[1]).member) { visitIdent(m[2], imports.get(m[1]).file); return fields; }
    m = /^[\w$]+$/.exec(t);
    if (m) {
        if (imports.has(t)) { const imp = imports.get(t); visitIdent(imp.member || t, imp.file); }
        else visitIdent(t, routeFile);
        return fields;
    }
    if (/^validate\s*\(/.test(t)) return fieldsInExpr(t, routeFile, imports, depth + 1);
    return fields;
}
function fieldsInExpr(expr, file, imports, depth) {
    const fields = fieldsFromBlock(expr);
    // follow bare identifiers and spreads inside the expression (rule arrays)
    const re = /(?:\.\.\.|[[(,]\s*)([A-Za-z_$][\w$]*)\s*(?=[,\])])/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(expr))) {
        const ident = m[1];
        if (seen.has(ident) || FIELD_FN.test(ident) || ['validate', 'true', 'false', 'null'].includes(ident)) continue;
        seen.add(ident);
        const decl = declarations(file).get(ident);
        if (decl && depth <= 3) fields.push(...fieldsInExpr(decl, file, imports, depth + 1));
    }
    return fields;
}

// ── route parsing ─────────────────────────────────────────────────────────

function callName(arg) {
    const m = /^((?:[\w$]+\.)*)([\w$]+)\s*(\(([\s\S]*)\))?$/.exec(arg.trim());
    return m ? { name: m[2], ns: m[1], args: m[4] != null ? splitArgs(m[4]) : null } : null;
}

function classify(argList, routeFile, imports) {
    const info = { auth: [], permissions: [], featureGates: [], idempotency: null, validators: [], middleware: [], fields: [] };
    for (const arg of argList) {
        const c = callName(arg);
        if (!c) { if (/^validate\s*\(/.test(arg)) info.validators.push('validate(inline)'); info.fields.push(...fieldsForArg(arg, routeFile, imports)); continue; }
        const { name, ns, args } = c;
        if (AUTH_NAMES.has(name)) {
            info.auth.push(args && args.length ? `${name}(${args.join(', ')})` : name);
        } else if (name === 'checkPermission') info.permissions.push(...(args || []).map((a) => a.replace(/['"`]/g, '')));
        else if (name === 'featureGate') info.featureGates.push(...(args || []).map((a) => a.replace(/['"`]/g, '')));
        else if (name === 'idempotency') info.idempotency = args && args.length ? args.join(', ') : true;
        else {
            const fields = fieldsForArg(arg, routeFile, imports);
            const isValidator = name === 'validate' || (ns && imports.has(ns.replace(/\.$/, '')) && imports.get(ns.replace(/\.$/, '')).file) || imports.has(name) || fields.length;
            if (isValidator) { info.validators.push(`${ns}${name}`); info.fields.push(...fields); } else info.middleware.push(`${ns}${name}`);
        }
    }
    return info;
}

function parseRouteFile(file, guardInfoSeed = null) {
    const src = readClean(file);
    const imports = validatorImports(file);
    const events = []; // { index, kind:'route'|'use', ... }

    const reCall = /\brouter\.(get|post|put|patch|delete|all|use|route)\s*\(/g;
    let m;
    while ((m = reCall.exec(src))) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(src, open);
        if (close < 0) continue;
        const args = splitArgs(src.slice(open + 1, close));
        const verb = m[1];
        if (verb === 'use') {
            // router.use('/x', ...) with a path is a sub-router mount; only bare middleware is a guard
            const first = args[0] && stringLiterals(args[0]);
            if (!first) events.push({ index: m.index, kind: 'use', args });
            continue;
        }
        if (verb === 'route') {
            const paths = args[0] && stringLiterals(args[0]);
            if (!paths) continue;
            let pos = close + 1;
            for (;;) {
                const chain = /^\s*\.\s*(get|post|put|patch|delete|all)\s*\(/.exec(src.slice(pos));
                if (!chain) break;
                const o = pos + chain[0].length - 1;
                const cl = matchClose(src, o);
                if (cl < 0) break;
                events.push({ index: m.index, kind: 'route', method: chain[1], paths, args: splitArgs(src.slice(o + 1, cl)), viaRoute: true });
                pos = cl + 1;
            }
            continue;
        }
        const paths = args.length ? stringLiterals(args[0]) : null;
        if (!paths) { events.push({ index: m.index, kind: 'skipped', method: verb, raw: (args[0] || '').slice(0, 60) }); continue; }
        events.push({ index: m.index, kind: 'route', method: verb, paths, args: args.slice(1) });
    }
    events.sort((a, b) => a.index - b.index);

    const guards = [];
    const routes = [];
    const skipped = [];
    for (const ev of events) {
        if (ev.kind === 'use') { guards.push(...ev.args); continue; }
        if (ev.kind === 'skipped') { skipped.push(ev); continue; }
        const args = ev.args.slice();
        const handler = args.length ? args.pop() : null;
        const mwArgs = [...guards, ...args];
        const info = classify(mwArgs, file, imports);
        for (const p of ev.paths) routes.push({ method: ev.method, path: p, handler, info });
    }
    return { routes, skipped, guardCount: guards.length };
}

// ── mounts ────────────────────────────────────────────────────────────────

function parseMounts(appFile) {
    const src = readClean(appFile);
    const mounts = [];
    const re = /\b(v1|app)\.use\(\s*(['"`])([^'"`]+)\2\s*,\s*require\(\s*['"]\.\/routes\/([\w-]+)['"]\s*\)\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
        const base = m[1] === 'v1' ? '/api/v1' : '';
        mounts.push({ prefix: (base + m[3]).replace(/\/+$/, ''), file: m[4] });
    }
    // global v1 middleware (informational)
    const globals = [];
    const reG = /\bv1\.use\(\s*((?:require\([^)]*\)\.)?[\w$.]+(?:\([^)]*\))?)\s*\)\s*;/g;
    while ((m = reG.exec(src))) globals.push(m[1].replace(/\s+/g, ' ').slice(0, 80));
    const probes = [];
    const reP = /\bapp\.(get|post)\(\s*(['"`])(\/[\w\-/]*)\2/g;
    while ((m = reP.exec(src))) probes.push({ method: m[1], path: m[3] });
    return { mounts, globals, probes };
}

// ── document building ─────────────────────────────────────────────────────

const camel = (s) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
const toOpenApiPath = (p) => p.replace(/:([A-Za-z_]\w*)(\([^)]*\))?\??/g, '{$1}').replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const SCHEMA_TYPE = { integer: { type: 'integer' }, number: { type: 'number' }, boolean: { type: 'boolean' }, array: { type: 'array', items: {} }, date: { type: 'string', format: 'date-time' }, string: { type: 'string' } };

function buildOperation(method, fullPath, tag, route, uniqueId) {
    const { info } = route;
    const op = {
        operationId: uniqueId,
        summary: `${method.toUpperCase()} ${fullPath}`,
        tags: [tag],
        parameters: [],
        responses: {
            200: { description: 'Success (response shape not inventoried).' },
            400: { description: 'Validation error.' },
            401: { description: 'Not authenticated (when auth applies).' },
            403: { description: 'Forbidden / feature locked / missing permission.' },
        },
    };
    for (const name of (fullPath.match(/\{(\w+)\}/g) || []).map((s) => s.slice(1, -1))) {
        op.parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
    const body = new Map();
    const query = new Map();
    for (const f of info.fields) {
        if (f.location === 'param') continue;
        const top = f.name.split(/[.[]/)[0];
        if (f.name.includes('*') || f.name.includes('.') || f.name.includes('[')) {
            if (!body.has(top) && f.location === 'body') body.set(top, { type: 'array', required: false });
            continue;
        }
        const target = f.location === 'query' ? query : body;
        const prev = target.get(top);
        target.set(top, { type: f.type, required: (prev && prev.required) || f.required });
    }
    for (const [name, f] of query) op.parameters.push({ name, in: 'query', required: false, schema: { ...SCHEMA_TYPE[f.type] } });
    if (!op.parameters.length) delete op.parameters;
    if (body.size && ['post', 'put', 'patch', 'delete'].includes(method)) {
        const props = {}; const required = [];
        for (const [name, f] of body) { props[name] = { ...SCHEMA_TYPE[f.type] }; if (f.required) required.push(name); }
        op.requestBody = {
            required: required.length > 0,
            content: { 'application/json': { schema: { type: 'object', properties: props, ...(required.length ? { required } : {}), additionalProperties: true } } },
        };
    }
    const authNames = info.auth.map((a) => a.split('(')[0]);
    const needsAuth = authNames.some((a) => ['protect', 'staffOnly', 'adminOnly', 'adminExclusive', 'superAdminOnly', 'restrictTo'].includes(a));
    const optional = authNames.includes('optionalAuth');
    if (needsAuth) op.security = [{ bearerAuth: [] }];
    else if (optional) op.security = [{ bearerAuth: [] }, {}];
    else op.security = [];
    if (info.auth.length) op['x-auth'] = info.auth;
    if (info.permissions.length) op['x-permissions'] = info.permissions;
    if (info.featureGates.length) op['x-feature-gates'] = info.featureGates;
    if (info.idempotency) op['x-idempotency'] = info.idempotency;
    if (info.validators.length) op['x-validators'] = [...new Set(info.validators)];
    if (info.middleware.length) op['x-middleware'] = info.middleware;
    if (route.handler) op['x-handler'] = route.handler.replace(/\s+/g, ' ').slice(0, 100);
    return op;
}

function buildSpec({ backendDir = BACKEND } = {}) {
    const appFile = path.join(backendDir, 'app.js');
    const { mounts, globals, probes } = parseMounts(appFile);
    const spec = {
        openapi: '3.1.0',
        info: {
            title: 'BestoDine Internal API (inventory)',
            version: '1.0.0',
            description: 'Best-effort static inventory of the staff/customer API, generated by scripts/generate-openapi.js from routes/*.js and app.js. Auth, feature gates and validators are x- extensions; request bodies list the fields express-validator chains declare (other fields may be accepted); responses are not inventoried. Not a stable contract. The public API is documented in public-v1.json.',
            'x-generated-by': 'scripts/generate-openapi.js',
            'x-global-v1-middleware': globals,
        },
        servers: [{ url: '/' }],
        paths: {},
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    };
    const usedIds = new Set();
    const stats = { routeFiles: 0, operations: 0, duplicatesMerged: 0, skipped: [], unmountedFiles: [] };
    const mountedFiles = new Set();

    const addOp = (method, fullPath, tag, route) => {
        const oaPath = toOpenApiPath(fullPath);
        const item = (spec.paths[oaPath] = spec.paths[oaPath] || {});
        if (item[method]) {
            // same method+path declared again (fall-through mounts): keep the first, record the rest
            const extra = (item[method]['x-also-declared-in'] = item[method]['x-also-declared-in'] || []);
            extra.push(`${tag}: ${route.handler ? route.handler.replace(/\s+/g, ' ').slice(0, 60) : '?'}`);
            stats.duplicatesMerged++;
            return;
        }
        let id = camel(`${method} ${oaPath.replace(/[{}]/g, ' ')}`) || method;
        let n = 2; const base = id;
        while (usedIds.has(id)) id = `${base}${n++}`;
        usedIds.add(id);
        item[method] = buildOperation(method, oaPath, tag, route, id);
        stats.operations++;
    };

    for (const mnt of mounts) {
        if (SKIP_ROUTE_FILES.has(mnt.file)) continue;
        const file = path.join(backendDir, 'routes', `${mnt.file}.js`);
        if (!fs.existsSync(file)) continue;
        mountedFiles.add(mnt.file);
        stats.routeFiles++;
        const { routes, skipped } = parseRouteFile(file);
        stats.skipped.push(...skipped.map((s) => `${mnt.file}: ${s.method} ${s.raw}`));
        for (const r of routes) {
            const sub = r.path === '/' ? '' : r.path;
            addOp(r.method === 'all' ? 'get' : r.method, `${mnt.prefix}${sub}` || '/', mnt.file.replace(/Route$/, ''), r);
        }
    }
    for (const p of probes) {
        addOp(p.method, p.path, 'app', { handler: 'inline handler in app.js', info: { auth: [], permissions: [], featureGates: [], idempotency: null, validators: [], middleware: [], fields: [] } });
    }
    const routeDir = path.join(backendDir, 'routes');
    for (const f of fs.readdirSync(routeDir)) {
        const base = f.replace(/\.js$/, '');
        if (f.endsWith('.js') && !mountedFiles.has(base) && !SKIP_ROUTE_FILES.has(base)) stats.unmountedFiles.push(base);
    }
    // sort paths for stable diffs
    spec.paths = Object.fromEntries(Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b)));
    return { spec, stats };
}

function main() {
    const { spec, stats } = buildSpec();
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(spec, null, 2)}\n`);
    const withBody = Object.values(spec.paths).flatMap((p) => Object.values(p)).filter((o) => o.requestBody).length;
    // eslint-disable-next-line no-console
    console.log(`openapi: ${stats.operations} operations on ${Object.keys(spec.paths).length} paths from ${stats.routeFiles} route files; ${withBody} with inferred request bodies; ${stats.duplicatesMerged} repeated method+path merged; ${stats.skipped.length} non-literal routes skipped; unmounted route files: ${stats.unmountedFiles.join(', ') || 'none'}`);
    // eslint-disable-next-line no-console
    console.log(`written ${path.relative(BACKEND, OUT_FILE)}`);
}

if (require.main === module) main();

module.exports = { buildSpec, stripComments, splitArgs, parseRouteFile };
