#!/usr/bin/env node
/**
 * staging-traffic.js — synthetic order traffic against the STAGING API for the desktop
 * soak check (desktop/e2e check 43).
 *
 *   node scripts/with-env.js .env.staging node scripts/staging-traffic.js [--minutes 27] [--create-every 3] [--advance-every 5]
 *                                                                          [--advance-batch 3] [--api http://127.0.0.1:5001] [--accounts admin,waiter]
 *
 * Every --create-every seconds (default 3) it POSTs one takeaway order named SOAK-<ts>
 * (the AddTakeawayOrderModal payload: type takeaway, one seeded kitchen item, branchId,
 * pickupLocation) and every --advance-every seconds (default 5) it moves --advance-batch (default 3)
 * random OPEN SOAK-* orders one step along new → preparing → ready → served (PATCH /orders/:id/status).
 * Three steps per order at 10 creations/min need ~30 steps/min to keep the kitchen board bounded, hence
 * the batch of 3 per 5 s tick. Nothing is cancelled or deleted — the orders stay as historical data.
 *
 * Rate limits it respects: POST /orders is capped by the backend at 60/min per STAFF user (5/min for customers/kiosk)
 * (routes/orderRoute.js orderCreateLimiter), so the script rotates over the staging seed
 * staff accounts (admin + waiter by default) and backs off per account on a 429 (Retry-After).
 * The achieved rate is printed every minute and in the final summary. Login is done ONCE per
 * account and the tokens are cached (a 401 triggers one re-login); a 429 on login waits for
 * Retry-After. Stops cleanly on SIGINT / SIGTERM or when --minutes elapse (default 27).
 *
 * SAFETY: utils/stagingGuard.assertStagingDb(MONGO_URL) runs first, and GET <api>/health must
 * say appEnv === 'staging' before a single credentialed request is sent.
 */
const { assertStagingDb } = require('../utils/stagingGuard');
assertStagingDb(process.env.MONGO_URL, 'scripts/staging-traffic.js');

const argValue = (name, dflt) => {
    const eq = process.argv.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const MINUTES = Math.max(0.1, parseFloat(argValue('--minutes', '27')) || 27);
const CREATE_EVERY = Math.max(1, parseFloat(argValue('--create-every', '3')) || 3) * 1000;
const ADVANCE_EVERY = Math.max(1, parseFloat(argValue('--advance-every', '5')) || 5) * 1000;
const ADVANCE_BATCH = Math.max(1, parseInt(argValue('--advance-batch', '3'), 10) || 3);
/** /orders/live (formatLiveOrder) ships customerName as `user` and orderId as `id`; raw documents use the model names. */
const nameOf = (o) => String((o && (o.customerName || o.user || o.customer)) || '');
const API_BASE = (argValue('--api', process.env.STAGING_API_URL || `http://127.0.0.1:${process.env.PORT || 5001}`)).replace(/\/$/, '');
const SLUG = process.env.STAGING_TENANT_SLUG || 'staging-cafe';
const PASSWORD = process.env.STAGING_PASSWORD || 'Staging@123';
const ACCOUNT_EMAILS = { admin: 'admin@staging.bestodine.test', waiter: 'waiter@staging.bestodine.test' };
const ACCOUNTS = String(argValue('--accounts', 'admin,waiter')).split(',').map((s) => s.trim()).filter((s) => ACCOUNT_EMAILS[s]);
const TAG = '[traffic]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`${TAG} ${new Date().toISOString()}`, ...a);

const stats = { created: 0, createAttempts: 0, create429: 0, createErrors: 0, advanced: 0, advanceAttempts: 0, advanceErrors: 0, relogins: 0, lastOrder: null, lastOrderAt: null, startedAt: Date.now(), byStatus: {} };
const accounts = []; // { role, email, token, blockedUntil }
let stopping = false;

async function api(method, routePath, { token, body, timeout = 15000 } = {}) {
    const headers = { Accept: 'application/json', 'X-Restaurant-Slug': SLUG };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
        const res = await fetch(`${API_BASE}/api/v1${routePath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, json, text: text.slice(0, 200), retryAfter: Number(res.headers.get('retry-after')) || null };
    } catch (err) { return { status: 0, error: err.cause?.message || err.message }; }
}

async function assertStagingApi() {
    let res;
    try { res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) }); } catch (err) {
        throw new Error(`${API_BASE}/health unreachable: ${err.cause?.message || err.message}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.appEnv !== 'staging') throw new Error(`${API_BASE}/health → HTTP ${res.status} appEnv=${body ? body.appEnv : '(no json)'} — not staging, refusing to send credentials`);
    log(`guard ok: ${API_BASE}/health appEnv=${body.appEnv} dbName=${body.dbName}`);
}

/** One login per account; on 429 wait for Retry-After (header, else 60 s) and try again (max 3). */
async function login(acc) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await api('POST', '/auth/login', { body: { email: acc.email, password: PASSWORD } });
        if (r.status === 200 && r.json && (r.json.token || r.json.accessToken)) { acc.token = r.json.token || r.json.accessToken; return true; }
        if (r.status === 429) { const wait = (r.retryAfter || 60) * 1000; log(`login ${acc.role}: 429 — waiting ${wait / 1000} s (Retry-After)`); await sleep(wait); continue; }
        log(`login ${acc.role}: HTTP ${r.status} ${r.text || r.error}`);
        return false;
    }
    return false;
}

let branch = null;
let menuItems = [];
async function loadReferenceData(acc) {
    const b = await api('GET', '/branches', { token: acc.token });
    const list = (b.json && (b.json.branches || b.json.data || [])) || [];
    branch = list[0] || null;
    const m = await api('GET', '/menu?limit=1000&status=active', { token: acc.token });
    const items = (m.json && (m.json.items || m.json.menu || m.json.data || [])) || [];
    // Seeded kitchen items only (not the HEAVY-* bulk rows): the order then starts 'new' like a real takeaway.
    menuItems = items.filter((i) => i.inStock !== false && !(i.sizes && i.sizes.length) && Number(i.basePrice) > 0 && (i.status === undefined || i.status === 'active') && !/^HEAVY-/.test(i.name) && (i.prepStation || 'kitchen') === 'kitchen');
    if (!menuItems.length) menuItems = items.filter((i) => i.inStock !== false && Number(i.basePrice) > 0 && !/^HEAVY-/.test(i.name));
    if (!menuItems.length) throw new Error(`no usable menu item (GET /menu → ${m.status} ${m.text || m.error})`);
    log(`reference data: branch=${branch ? branch.name : '(none)'} items=${menuItems.length} (${menuItems.slice(0, 3).map((i) => i.name).join(', ')}…)`);
}

const pickAccount = () => {
    const now = Date.now();
    const free = accounts.filter((a) => a.token && a.blockedUntil <= now);
    if (!free.length) return null;
    // Round-robin over the accounts that are not backing off.
    pickAccount.i = (pickAccount.i || 0) + 1;
    return free[pickAccount.i % free.length];
};

async function createOne() {
    const acc = pickAccount();
    if (!acc) return; // every account is inside its per-user 5/min window
    const item = menuItems[Math.floor(Math.random() * menuItems.length)];
    const price = Number(item.finalPrice || item.basePrice);
    const name = `SOAK-${Date.now()}`;
    const payload = {
        type: 'takeaway', customerName: name, pickupLocation: (branch && branch.name) || 'Main',
        ...(branch && branch._id ? { branchId: branch._id } : {}),
        items: [{ menuItem: item._id, name: item.name, price, quantity: 1 }], total: price, note: 'soak traffic',
    };
    stats.createAttempts++;
    let r = await api('POST', '/orders', { token: acc.token, body: payload });
    if (r.status === 401) { stats.relogins++; if (await login(acc)) r = await api('POST', '/orders', { token: acc.token, body: payload }); }
    if (r.status === 201) { stats.created++; stats.lastOrder = name; stats.lastOrderAt = Date.now(); return; }
    if (r.status === 429) { stats.create429++; acc.blockedUntil = Date.now() + ((r.retryAfter || 60) * 1000); return; }
    stats.createErrors++;
    if (stats.createErrors <= 5) log(`create ${acc.role}: HTTP ${r.status} ${r.text || r.error}`);
}

const NEXT = { new: 'preparing', preparing: 'ready', ready: 'served' };
async function advanceOne() {
    const acc = accounts.find((a) => a.role === 'admin' && a.token) || accounts.find((a) => a.token);
    if (!acc) return;
    let live = await api('GET', '/orders/live', { token: acc.token });
    if (live.status === 401) { stats.relogins++; if (await login(acc)) live = await api('GET', '/orders/live', { token: acc.token }); }
    const orders = (live.json && (live.json.orders || live.json.data || [])) || [];
    const open = orders.filter((o) => /^SOAK-\d+$/.test(nameOf(o)) && NEXT[o.status]);
    stats.openSoak = open.length;
    if (!open.length) return;
    for (let k = 0; k < ADVANCE_BATCH && open.length; k++) {
        const o = open.splice(Math.floor(Math.random() * open.length), 1)[0];
        const id = o._id || (typeof o.id === 'string' && /^[0-9a-f]{24}$/i.test(o.id) ? o.id : null);
        if (!id) { stats.advanceErrors++; continue; }
        stats.advanceAttempts++;
        const r = await api('PATCH', `/orders/${id}/status`, { token: acc.token, body: { status: NEXT[o.status] } });
        if (r.status === 200) { stats.advanced++; stats.byStatus[NEXT[o.status]] = (stats.byStatus[NEXT[o.status]] || 0) + 1; continue; }
        stats.advanceErrors++;
        if (stats.advanceErrors <= 5) log(`advance ${nameOf(o)} ${o.status}→${NEXT[o.status]}: HTTP ${r.status} ${r.text || r.error}`);
    }
}

function summary(final) {
    const mins = Math.max(0.01, (Date.now() - stats.startedAt) / 60000);
    const s = { ...stats, minutes: Math.round(mins * 10) / 10, createdPerMin: Math.round((stats.created / mins) * 10) / 10, advancedPerMin: Math.round((stats.advanced / mins) * 10) / 10 };
    delete s.startedAt;
    console.log(`${TAG} ${final ? 'summary' : 'progress'} ${JSON.stringify(s)}`);
}

async function main() {
    await assertStagingApi();
    for (const role of ACCOUNTS) accounts.push({ role, email: ACCOUNT_EMAILS[role], token: null, blockedUntil: 0 });
    for (const acc of accounts) { if (!(await login(acc))) log(`account ${acc.role} unusable — continuing without it`); }
    if (!accounts.some((a) => a.token)) throw new Error('no account could log in');
    await loadReferenceData(accounts.find((a) => a.token));
    log(`running ${MINUTES} min: create every ${CREATE_EVERY / 1000} s (accounts ${accounts.filter((a) => a.token).map((a) => a.role).join('+')}; backend cap 5/min/user), advance ${ADVANCE_BATCH} every ${ADVANCE_EVERY / 1000} s`);

    let busyCreate = false, busyAdvance = false;
    const createTimer = setInterval(() => { if (busyCreate || stopping) return; busyCreate = true; createOne().catch(() => {}).finally(() => { busyCreate = false; }); }, CREATE_EVERY);
    const advanceTimer = setInterval(() => { if (busyAdvance || stopping) return; busyAdvance = true; advanceOne().catch(() => {}).finally(() => { busyAdvance = false; }); }, ADVANCE_EVERY);
    const progressTimer = setInterval(() => summary(false), 60000);
    const stop = (why) => {
        if (stopping) return;
        stopping = true;
        clearInterval(createTimer); clearInterval(advanceTimer); clearInterval(progressTimer);
        log(`stopping (${why}) — orders are left as historical data`);
        summary(true);
        setTimeout(() => process.exit(0), 200);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    setTimeout(() => stop(`${MINUTES} minutes elapsed`), MINUTES * 60000);
}

main().catch((err) => { console.error(`${TAG} FAILED: ${err.message}`); process.exit(2); });
