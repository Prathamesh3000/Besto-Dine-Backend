#!/usr/bin/env node
/**
 * smoke-captain-flow.js - end-to-end HTTP smoke test of the captain flow
 * against the STAGING stack (the jest suite uses in-memory Mongo; this one
 * goes through the real server + real MongoDB).
 *
 * Prereqs (see Backend/STAGING.md):  npm run db:staging  ->  npm run seed:staging
 *                                    ->  npm run start:staging   (port 5001)
 * Run:   node scripts/smoke-captain-flow.js
 *
 * SAFETY: refuses to run unless the API base is http://localhost:5001/api/v1
 * AND GET /health reports appEnv "staging" + dbName "bestodine_staging".
 * Override only the port/host via SMOKE_API (still must pass the /health check
 * and must be a localhost URL).
 *
 * Output: one line per check, PASS / FAIL / WARN / SKIP. Exit code 1 on any FAIL.
 * Needs Node 18+ (built-in fetch). No dependencies. Re-runnable: uses unique
 * idempotency keys and picks whichever tables are currently free.
 */
'use strict';

const API = (process.env.SMOKE_API || 'http://localhost:5001/api/v1').replace(/\/$/, '');
const SLUG = 'staging-cafe';
const PASSWORD = 'Staging@123';
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const results = [];
function rec(step, status, msg, extra) {
    results.push({ step, status, msg });
    const tag = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' }[status];
    console.log(`[${tag}] ${String(step).padEnd(4)} ${msg}${extra ? `  ${extra}` : ''}`);
}
const pass = (s, m, e) => rec(s, 'PASS', m, e);
const fail = (s, m, e) => rec(s, 'FAIL', m, e);
const warn = (s, m, e) => rec(s, 'WARN', m, e);
const skip = (s, m, e) => rec(s, 'SKIP', m, e);
const brief = (r) => `-> ${r.status} ${JSON.stringify(r.body || {}).slice(0, 300)}`;

/** check(step, label, cond, res): PASS/FAIL with status + trimmed body on failure. */
function check(step, label, cond, res, okInfo) {
    if (cond) pass(step, `${label} (${res.status})`, okInfo);
    else fail(step, `${label} (${res.status})`, brief(res));
    return !!cond;
}

async function http(method, path, { token, body, headers = {}, slug = true } = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    if (slug) h['X-Restaurant-Slug'] = SLUG;
    let res;
    try {
        res = await fetch(`${API}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
        return { status: 0, body: { error: e.message }, raw: '' };
    }
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* non-JSON */ }
    return { status: res.status, body: json, raw };
}
const as = (token) => ({
    get: (p, o = {}) => http('GET', p, { token, ...o }),
    post: (p, body = {}, o = {}) => http('POST', p, { token, body, ...o }),
    put: (p, body = {}, o = {}) => http('PUT', p, { token, body, ...o }),
    patch: (p, body = {}, o = {}) => http('PATCH', p, { token, body, ...o }),
});
const idem = () => ({ 'Idempotency-Key': `smoke-${rid()}` });

/** Depth-first search for a key anywhere in a JSON value. */
function hasKeyDeep(v, key) {
    if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, key));
    if (v && typeof v === 'object') {
        if (Object.prototype.hasOwnProperty.call(v, key)) return true;
        return Object.values(v).some((x) => hasKeyDeep(x, key));
    }
    return false;
}
function findDeep(v, pred) {
    if (Array.isArray(v)) { for (const x of v) { const r = findDeep(x, pred); if (r) return r; } return null; }
    if (v && typeof v === 'object') {
        if (pred(v)) return v;
        for (const x of Object.values(v)) { const r = findDeep(x, pred); if (r) return r; }
    }
    return null;
}
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
    // ---- 0. hard safety gate -------------------------------------------------
    if (!/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/api\/v1$/.test(API)) {
        console.error(`ABORT: API base ${API} is not a localhost URL.`); process.exit(2);
    }
    const root = API.replace(/\/api\/v1$/, '');
    const health = await http('GET', '/health', { slug: false }).catch(() => null);
    const hres = health && health.status ? health : await (async () => {
        try { const r = await fetch(`${root}/health`); return { status: r.status, body: await r.json() }; } catch (e) { return { status: 0, body: { error: e.message } }; }
    })();
    let hb = hres.body;
    if (!hb || hb.appEnv === undefined) {
        try { const r = await fetch(`${root}/health`); hb = await r.json(); } catch (e) { hb = { error: e.message }; }
    }
    if (!hb || hb.appEnv !== 'staging' || hb.dbName !== 'bestodine_staging') {
        console.error(`ABORT: /health is not the staging stack: ${JSON.stringify(hb)}`); process.exit(2);
    }
    console.log(`Target confirmed: ${API}  appEnv=${hb.appEnv} dbName=${hb.dbName}\n`);

    // ---- 1. logins -----------------------------------------------------------
    const tok = {};
    const users = {};
    for (const role of ['captain', 'waiter', 'admin']) {
        const r = await http('POST', '/auth/login', { body: { email: `${role}@staging.bestodine.test`, password: PASSWORD } });
        if (!check(1, `login ${role}`, r.status === 200 && r.body?.token, r, `role=${r.body?.role}`)) {
            console.log('Cannot continue without all three logins (run npm run seed:staging).'); return summary();
        }
        tok[role] = r.body.token; users[role] = r.body;
    }
    const cap = as(tok.captain), wai = as(tok.waiter), adm = as(tok.admin);

    // ---- 2. tables + menu ----------------------------------------------------
    const tr = await cap.get('/tables');
    const allTables = tr.body?.tables || [];
    const freeTables = allTables.filter((t) => t.status === 'free');
    const mr = await cap.get('/menu');
    const menu = (mr.body?.data || []).filter((m) => m.status === 'active' && m.inStock !== false
        && !(m.sizes && m.sizes.length) && !(m.toppings && m.toppings.length));
    check(2, `GET /tables (${allTables.length} total, ${freeTables.length} free) + GET /menu (${menu.length} simple items)`,
        tr.status === 200 && mr.status === 200 && freeTables.length >= 2 && menu.length >= 3, tr);
    if (freeTables.length < 2 || menu.length < 3) {
        fail(2, 'need >=2 free tables and >=3 simple menu items; free tables via POST /tables/:id/free or re-seed (npm run seed:staging)');
        return summary();
    }
    const [T1, T2] = freeTables;
    // Later steps re-pick whichever table is free at that moment (tables are freed as we go).
    const pickFree = async (exclude = []) => {
        const r = await cap.get('/tables');
        return (r.body?.tables || []).find((t) => t.status === 'free' && !exclude.includes(String(t._id)));
    };
    const [m1, m2, m3] = menu;
    const line = (m, q) => ({ menuItem: String(m._id), quantity: q });
    const priceOf = (m) => Number(m.finalPrice ?? m.basePrice);
    const mkTotal = (lines) => Math.ceil(lines.reduce((s, [m, q]) => s + priceOf(m) * q, 0) * 1.05 * 100) / 100;
    async function placeOrder(client, table, lines) {
        return client.post('/orders', {
            type: 'dine-in', tableId: String(table._id),
            items: lines.map(([m, q]) => line(m, q)), total: mkTotal(lines),
            clientIdempotencyKey: `smoke_${rid()}${rid()}`,
        }, { headers: idem() });
    }
    const orderDetail = async (client, id) => (await client.get(`/orders/${id}/detail`));
    const payableOf = (o) => round2((o.total || 0) - (o.manualDiscount || 0));

    // ---- 15 (setup) incentive campaign BEFORE the orders so accrual happens ---
    let incOn = false; let campaignId = null;
    const probe = await adm.get('/incentives/campaigns');
    if (probe.status === 200) {
        incOn = true;
        const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
        const cr = await adm.post('/incentives/campaigns', {
            name: `smoke ${rid()}`.slice(0, 40), items: [String(m1._id)],
            rule: { type: 'per_item', ratePerItem: 7 }, startDate: day(-1), endDate: day(1), staffRoles: ['captain', 'waiter'],
        });
        if (cr.status === 201) campaignId = cr.body.campaign?._id;
        else { fail(15, 'create incentive campaign', brief(cr)); incOn = false; }
    } else if (probe.status === 403 && probe.body?.code === 'FEATURE_LOCKED') {
        skip(15, 'incentives module locked for staging-cafe (no documented staging switch; super-admin add-on endpoint needs super-admin creds not seeded in STAGING.md)');
    } else fail(15, 'probe /incentives/campaigns', brief(probe));

    // ---- 3. create order (captain) -> kotNo 1 + ticketNo ---------------------
    const c1 = await placeOrder(cap, T1, [[m1, 2], [m2, 1]]);
    if (!check(3, 'POST /orders as captain', c1.status === 201 && c1.body?.kotNo === 1 && c1.body?.ticketNo >= 1, c1,
        `kotNo=${c1.body?.kotNo} ticketNo=${c1.body?.ticketNo} orderId=${c1.body?.order?.orderId}`)) return summary();
    const O1 = c1.body.order._id;

    // ---- 4. append -> kotNo 2 -------------------------------------------------
    const a2 = await cap.post(`/orders/${O1}/append`, { items: [line(m3, 1)] }, { headers: idem() });
    check(4, 'POST /orders/:id/append', a2.status === 200 && a2.body?.kotNo === 2, a2, `kotNo=${a2.body?.kotNo} ticketNo=${a2.body?.ticketNo}`);

    // ---- 5. kots --------------------------------------------------------------
    const k = await cap.get(`/orders/${O1}/kots`);
    const rounds = k.body?.kots || k.body?.rounds || (Array.isArray(k.body) ? k.body : []);
    check(5, 'GET /orders/:id/kots has two rounds', k.status === 200 && rounds.length === 2, k,
        `rounds=${rounds.map((r) => r.kotNo).join(',')}`);

    // ---- 6. reprint ----------------------------------------------------------
    const rp = await cap.post(`/orders/${O1}/reprint-kot`, { kotNo: 2 });
    check(6, 'POST /orders/:id/reprint-kot {kotNo:2}', rp.status === 200, rp, JSON.stringify(rp.body || {}).slice(0, 120));

    // ---- 7. printing ---------------------------------------------------------
    const ps = await cap.get('/print/status');
    check(7, 'GET /print/status', ps.status === 200, ps, `enabled=${ps.body?.enabled ?? ps.body?.printingEnabled} agentOnline=${ps.body?.agentOnline}`);
    const pb = await cap.post(`/print/orders/${O1}/bill`, {});
    if (pb.status === 202) pass(7, 'POST /print/orders/:id/bill queued (202)', `jobId=${pb.body?.jobId}`);
    else if (pb.status === 409 && ['NO_COUNTER_PRINTER', 'PRINTING_DISABLED', 'AGENT_OFFLINE'].includes(pb.body?.code))
        warn(7, `POST /print/orders/:id/bill -> 409 ${pb.body.code} (expected: no printer agent on staging)`);
    else fail(7, `POST /print/orders/:id/bill (${pb.status})`, brief(pb));

    // ---- 8. bill workspace ---------------------------------------------------
    const s1 = await cap.post(`/orders/${O1}/bill/save`, { final: false });
    check(8, 'bill/save {final:false}', s1.status === 200 && s1.body?.bill?.status === 'draft', s1, `billNo=${s1.body?.bill?.billNo}`);
    const pv = await cap.get(`/orders/${O1}/bill/preview`);
    const pvText = pv.body?.text ?? findDeep(pv.body, (o) => typeof o.text === 'string')?.text ?? '';
    check(8, 'bill/preview has non-empty text', pv.status === 200 && typeof pvText === 'string' && pvText.trim().length > 20, pv, `chars=${String(pvText).length}`);
    const s2 = await cap.post(`/orders/${O1}/bill/save`, { final: true });
    check(8, 'bill/save {final:true}', s2.status === 200 && s2.body?.bill?.status === 'final', s2, `billNo=${s2.body?.bill?.billNo}`);
    const ap = await cap.post(`/orders/${O1}/append`, { items: [line(m3, 1)] }, { headers: idem() });
    check(8, 'append on finalized bill -> 409 BILL_FINALIZED', ap.status === 409 && ap.body?.code === 'BILL_FINALIZED', ap);
    const rw = await wai.post(`/orders/${O1}/bill/reopen`, { reason: 'smoke waiter attempt' });
    check(8, 'waiter reopen -> 403', rw.status === 403, rw);
    const rc = await cap.post(`/orders/${O1}/bill/reopen`, { reason: 'smoke: guest added an item' });
    check(8, 'captain reopen with reason', rc.status === 200 && rc.body?.bill?.status === 'draft', rc);

    // ---- 9. billingState -----------------------------------------------------
    const t2r = await cap.get('/tables');
    const tRow = (t2r.body?.tables || []).find((t) => String(t._id) === String(T1._id));
    check(9, 'GET /tables row has billingState', t2r.status === 200 && tRow && tRow.billingState != null, t2r, `billingState=${JSON.stringify(tRow?.billingState)}`);
    const fo = await cap.get('/captain/floor-overview');
    const foRow = findDeep(fo.body, (o) => (String(o._id) === String(T1._id) || String(o.tableId) === String(T1._id)) && 'billingState' in o);
    check(9, 'GET /captain/floor-overview has billingState for the table', fo.status === 200 && foRow && foRow.billingState != null, fo, `billingState=${JSON.stringify(foRow?.billingState)}`);

    // ---- 10. cash settle -----------------------------------------------------
    const d1 = await orderDetail(cap, O1);
    const o1 = d1.body?.order || d1.body;
    const due1 = payableOf(o1);
    const cash1 = Math.ceil(due1 / 100) * 100 + 100;
    const pay1 = await cap.patch(`/orders/${O1}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: cash1, cashReceived: cash1 });
    const d1b = await orderDetail(cap, O1);
    const o1b = d1b.body?.order || d1b.body;
    check(10, `cash settle, due ${due1}, tendered ${cash1}`, pay1.status === 200 && o1b?.payment?.state === 'paid'
        && Math.abs((o1b.payment.changeDue ?? -1) - round2(cash1 - due1)) < 0.011, pay1,
        `payment.state=${o1b?.payment?.state} changeDue=${o1b?.payment?.changeDue} expected=${round2(cash1 - due1)}`);

    const c2 = await placeOrder(cap, T2, [[m2, 1]]);
    if (c2.status !== 201) fail(10, 'create second order', brief(c2));
    else {
        const O2 = c2.body.order._id;
        const d2 = await orderDetail(cap, O2);
        const due2 = payableOf(d2.body?.order || d2.body);
        const short = await cap.patch(`/orders/${O2}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: due2, cashReceived: Math.max(1, Math.floor(due2 / 2)) });
        check(10, 'cash short -> 400 CASH_SHORT', short.status === 400 && short.body?.code === 'CASH_SHORT', short);
        // 12 reuse: T2 is occupied with an unpaid order. Settle it later; do the force-free tests on T3.
        var O2id = O2; var T2row = T2; // eslint-disable-line no-var
    }

    // ---- 11. table freed -----------------------------------------------------
    const t3r = await cap.get('/tables');
    const t1after = (t3r.body?.tables || []).find((t) => String(t._id) === String(T1._id));
    check(11, 'table freed after full payment', t1after && t1after.status === 'free', t3r, `status=${t1after?.status}`);

    // ---- 12. force free ------------------------------------------------------
    const T3 = await pickFree([String(T2._id)]);
    const c3 = await placeOrder(cap, T3, [[m2, 1]]);
    if (c3.status !== 201) fail(12, 'create order for force-free test', brief(c3));
    else {
        const f1 = await cap.post(`/tables/${T3._id}/free`, { force: true, reason: 'smoke captain attempt' });
        check(12, 'captain force-free -> 403 FORCE_REQUIRES_PRIVILEGE', f1.status === 403 && f1.body?.code === 'FORCE_REQUIRES_PRIVILEGE', f1);
        const f2 = await adm.post(`/tables/${T3._id}/free`, { force: true });
        check(12, 'admin force-free without reason -> 400', f2.status === 400, f2);
        const f3 = await adm.post(`/tables/${T3._id}/free`, { force: true, reason: 'smoke test cleanup' });
        check(12, 'admin force-free with reason -> ok', f3.status === 200, f3, `closedOrderCount=${f3.body?.closedOrderCount}`);
    }

    // ---- 13. assignment ------------------------------------------------------
    const T4 = await pickFree();
    const asg = await cap.put(`/tables/${T4._id}/assign`, { waiterId: users.waiter._id });
    check(13, 'PUT /tables/:id/assign as captain', asg.status === 200, asg);
    const hist = await cap.get(`/tables/${T4._id}/assignments`);
    const hList = hist.body?.assignments || hist.body?.history || (Array.isArray(hist.body) ? hist.body : []);
    check(13, 'GET /tables/:id/assignments lists the change', hist.status === 200 && hList.length >= 1, hist, `entries=${hList.length}`);
    await cap.put(`/tables/${T4._id}/assign`, { waiterId: null });

    // ---- 14. shift handover --------------------------------------------------
    const ci = await cap.post('/shifts/clock-in', {});
    if (ci.status === 201) pass(14, 'captain clock-in (201)');
    else if (ci.status === 409 || ci.status === 400) pass(14, `captain already clocked in (${ci.status})`);
    else fail(14, `clock-in (${ci.status})`, brief(ci));
    const ho = await cap.get('/shifts/handover');
    check(14, 'GET /shifts/handover', ho.status === 200 && ho.body?.shift && ho.body?.cash, ho, `cash.expected=${ho.body?.cash?.expected} openTables=${ho.body?.openTables?.length}`);
    const hc = await cap.post('/shifts/handover', { note: 'smoke handover', cashCounted: ho.body?.cash?.expected ?? 0 });
    check(14, 'POST /shifts/handover', hc.status === 200, hc);

    // ---- 15. incentives ------------------------------------------------------
    if (incOn) {
        // Order for the captain on T5: serve then pay -> entry confirmed.
        const T5 = await pickFree([String(T2._id)]);
        const c5 = await placeOrder(cap, T5, [[m1, 2]]);
        if (c5.status !== 201) fail(15, 'create incentive order', brief(c5));
        else {
            const O5 = c5.body.order._id;
            let served = await cap.patch(`/orders/${O5}/status`, { status: 'served' });
            if (served.status !== 200) {
                for (const st of ['preparing', 'ready', 'served']) served = await adm.patch(`/orders/${O5}/status`, { status: st });
            }
            if (served.status !== 200) fail(15, 'mark order served', brief(served));
            const d5 = await orderDetail(cap, O5);
            const due5 = payableOf(d5.body?.order || d5.body);
            const p5 = await cap.patch(`/orders/${O5}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: due5, cashReceived: due5 });
            check(15, 'serve + pay incentive order', served.status === 200 && p5.status === 200, p5);
            await new Promise((r) => setTimeout(r, 1500)); // accrual is post-response
            const me = await cap.get('/incentives/me');
            const confirmed = me.body?.totals?.confirmed ?? me.body?.totals?.confirmedAmount ?? 0;
            const ent = await cap.get('/incentives/entries');
            const entries = ent.body?.entries || [];
            const mine = entries.find((e) => String(e.order?._id || e.order || e.orderId) !== '' && e.state === 'confirmed');
            check(15, 'captain GET /incentives/me shows a confirmed entry', me.status === 200 && (Number(confirmed) > 0 || !!mine), me,
                `totals=${JSON.stringify(me.body?.totals)}`);
            const wme = await wai.get('/incentives/me');
            const went = await wai.get('/incentives/entries');
            const capIds = new Set(entries.map((e) => String(e._id)));
            const leak = (went.body?.entries || []).some((e) => capIds.has(String(e._id)));
            check(15, "waiter cannot see captain's entries", wme.status === 200 && went.status === 200 && !leak
                && !(Number(wme.body?.totals?.confirmed ?? 0) >= Number(confirmed) && Number(confirmed) > 0 && (went.body?.entries || []).length === entries.length && entries.length > 0), went,
                `waiterTotals=${JSON.stringify(wme.body?.totals)}`);
        }
        if (campaignId) await adm.put(`/incentives/campaigns/${campaignId}`, { status: 'paused' }); // stop accruing on later runs
    } else if (!results.some((r) => r.step === 15)) skip(15, 'incentives not available');

    // ---- 16. guest read strips staff internals --------------------------------
    // Use a free table, guest scans it, places an order, staff append + save bill + pay, guest reads it back.
    const tr16 = await cap.get('/tables');
    const T6 = (tr16.body?.tables || []).find((t) => t.status === 'free' && t.qrToken && String(t._id) !== String(T2._id));
    if (!T6) skip(16, 'no free table with qrToken available');
    else {
        const sc = await http('GET', `/tables/scan/${T6.qrToken}`);
        const scanToken = sc.body?.scanToken;
        if (!scanToken) fail(16, 'guest table scan', brief(sc));
        else {
            const gh = { 'X-Scan-Token': scanToken };
            const gl = [[m2, 1]];
            const g = await http('POST', '/orders', {
                headers: { ...gh, ...idem() },
                body: { type: 'dine-in', tableId: String(T6._id), items: gl.map(([m, q]) => line(m, q)), total: round2(mkTotal(gl) + 15), tipAmount: 15, clientIdempotencyKey: `smoke_${rid()}${rid()}` },
            });
            if (g.status !== 201) fail(16, 'guest creates dine-in order', brief(g));
            else {
                const GO = g.body.order._id;
                await cap.post(`/orders/${GO}/append`, { items: [line(m3, 1)] }, { headers: idem() });
                await cap.post(`/orders/${GO}/bill/save`, { final: true });
                const staffSees = await cap.get(`/orders/active-list/table/${T6._id}`); // staff control view (unpaid, so still listed)
                const sd = await orderDetail(cap, GO);
                const sdo = sd.body?.order || sd.body;
                const gdue = payableOf(sdo);
                const gpay = await cap.patch(`/orders/${GO}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: gdue, cashReceived: gdue + 50 });
                const sd2 = await orderDetail(cap, GO);
                const sdo2 = sd2.body?.order || sd2.body;
                check('17C', 'staff side of guest order (stored tip 15): cash settled, changeDue == 50',
                    gpay.status === 200 && Number(sdo2?.tipAmount) === 15 && Math.abs((sdo2?.payment?.changeDue ?? -1) - 50) < 0.011, gpay,
                    `tipAmount=${sdo2?.tipAmount} changeDue=${sdo2?.payment?.changeDue}`);
                const gd = await http('GET', `/orders/${GO}/detail`, { headers: gh });
                const leaks = ['reference', 'history', 'sentBy', 'cashReceived', 'changeDue', 'savedBy', 'updatedBy'].filter((key) => hasKeyDeep(gd.body, key));
                                const staffKeys = ['reference', 'history', 'sentBy'].filter((key) => hasKeyDeep(staffSees.body, key));
                if (!staffKeys.length) warn(16, 'control: staff view showed none of the staff-only keys (leak check may be vacuous; order may already be closed)');
                check(16, 'guest GET /orders/:id/detail has no payment.reference / bill.history / kots[].sentBy',
                    gd.status === 200 && leaks.length === 0, gd, `leaked=[${leaks}] staffStillSees=[${staffKeys}]`);
            }
        }
    }

    // ---- 17A. cash settle with a tip STORED on the order (set at create via tipAmount) ----
    // Staff have no separate tip endpoint; tipAmount is accepted on POST /orders (folded into total)
    // and on PATCH /orders/:id/status. A stored tip is already inside total, so change = cash - total.
    const itemsOf = (o) => (o?.items || o?.lineItems || []);
    const TA = await pickFree([String(T2._id)]);
    if (!TA) skip('17A', 'no free table');
    else {
        const tipA = 20;
        const lA = [[m2, 1]];
        const cA = await cap.post('/orders', {
            type: 'dine-in', tableId: String(TA._id), items: lA.map(([m, q]) => line(m, q)),
            total: round2(mkTotal(lA) + tipA), tipAmount: tipA, clientIdempotencyKey: `smoke_${rid()}${rid()}`,
        }, { headers: idem() });
        if (cA.status !== 201) fail('17A', 'create order with tipAmount', brief(cA));
        else {
            const OA = cA.body.order._id;
            const dA = await orderDetail(cap, OA);
            const oA = dA.body?.order || dA.body;
            const totA = payableOf(oA);
            check('17A', `order stores tipAmount=${tipA} and total includes it (total ${oA?.total}, base ${mkTotal(lA)})`,
                dA.status === 200 && Number(oA.tipAmount) === tipA && Math.abs(Number(oA.total) - round2(mkTotal(lA) + tipA)) < 1.01, dA,
                `tipAmount=${oA?.tipAmount} total=${oA?.total}`);
            const shortA = await cap.patch(`/orders/${OA}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: totA, cashReceived: round2(totA - 5) });
            check('17A', `cash ${round2(totA - 5)} < total ${totA} -> 400 CASH_SHORT`, shortA.status === 400 && shortA.body?.code === 'CASH_SHORT', shortA);
            const cashA = Math.ceil(totA / 100) * 100 + 100;
            const payA = await cap.patch(`/orders/${OA}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: cashA, cashReceived: cashA });
            const dA2 = await orderDetail(cap, OA);
            const oA2 = dA2.body?.order || dA2.body;
            const expA = round2(cashA - totA);
            check('17A', `cash ${cashA} on tip-inclusive total ${totA}: changeDue == ${expA} (not minus tip again)`,
                payA.status === 200 && oA2?.payment?.state === 'paid' && Math.abs((oA2.payment.changeDue ?? -1) - expA) < 0.011, payA,
                `changeDue=${oA2?.payment?.changeDue} expected=${expA} (wrong-if-tip-subtracted-twice=${round2(expA + tipA)})`);
        }
    }

    // ---- 17B. cash settle where the request RAISES the tip ------------------------
    const TB = await pickFree([String(T2._id)]);
    if (!TB) skip('17B', 'no free table');
    else {
        const cB = await placeOrder(cap, TB, [[m2, 1]]);
        if (cB.status !== 201) fail('17B', 'create order', brief(cB));
        else {
            const OB = cB.body.order._id;
            const dB = await orderDetail(cap, OB);
            const baseB = payableOf(dB.body?.order || dB.body);
            const raise = 30;
            const shortB = await cap.patch(`/orders/${OB}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', tipAmount: raise, amountPaid: baseB, cashReceived: round2(baseB + 10) });
            if (shortB.status === 400 && shortB.body?.code === 'CASH_SHORT')
                pass('17B', `cash ${round2(baseB + 10)} covers base ${baseB} but not raised tip ${raise} -> CASH_SHORT (400)`);
            else fail('17B', `cash not covering raised tip should be 400 CASH_SHORT (${shortB.status})`, brief(shortB));
            const cashB = round2(baseB + raise + 50);
            const payB = await cap.patch(`/orders/${OB}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', tipAmount: raise, amountPaid: cashB, cashReceived: cashB });
            const dB2 = await orderDetail(cap, OB);
            const oB2 = dB2.body?.order || dB2.body;
            check('17B', `cash ${cashB} with raised tip ${raise}: changeDue == 50`,
                payB.status === 200 && oB2?.payment?.state === 'paid' && Math.abs((oB2.payment.changeDue ?? -1) - 50) < 0.011, payB,
                `changeDue=${oB2?.payment?.changeDue} tipAmount=${oB2?.tipAmount} total=${oB2?.total}`);
        }
    }

    // ---- 17D. append idempotency ---------------------------------------------------
    const TD = await pickFree([String(T2._id)]);
    if (!TD) skip('17D', 'no free table');
    else {
        const cD = await placeOrder(cap, TD, [[m1, 1]]);
        if (cD.status !== 201) fail('17D', 'create order', brief(cD));
        else {
            const OD = cD.body.order._id;
            const key = `smoke-idem-${rid()}`;
            const countItems = async () => {
                const d = await orderDetail(cap, OD); const o = d.body?.order || d.body;
                return { n: itemsOf(o).reduce((s, i) => s + (Number(i.quantity) || 0), 0), total: o?.total };
            };
            const a1 = await cap.post(`/orders/${OD}/append`, { items: [line(m3, 1)] }, { headers: { 'Idempotency-Key': key } });
            const after1 = await countItems();
            const a2x = await cap.post(`/orders/${OD}/append`, { items: [line(m3, 1)] }, { headers: { 'Idempotency-Key': key } });
            const after2 = await countItems();
            check('17D', 'first append ok', a1.status === 200 && a1.body?.kotNo === 2, a1, `kotNo=${a1.body?.kotNo} qty=${after1.n}`);
            check('17D', 'replay with SAME Idempotency-Key returns same kotNo', a2x.status === 200 && a2x.body?.kotNo === a1.body?.kotNo, a2x, `kotNo=${a2x.body?.kotNo}`);
            check('17D', 'replay did not add items again', after2.n === after1.n && after2.total === after1.total, a2x, `qty ${after1.n}->${after2.n} total ${after1.total}->${after2.total}`);
            const a3 = await cap.post(`/orders/${OD}/append`, { items: [line(m3, 1)] }, { headers: { 'Idempotency-Key': `smoke-idem-${rid()}` } });
            const after3 = await countItems();
            check('17D', 'DIFFERENT key creates a new kotNo', a3.status === 200 && a3.body?.kotNo === 3 && after3.n === after1.n + 1, a3, `kotNo=${a3.body?.kotNo} qty=${after3.n}`);
            await adm.post(`/tables/${TD._id}/free`, { force: true, reason: 'smoke cleanup' });
        }
    }

    // ---- G. billing guard: waiter blocked from bill/print/settle/upi-qr ----------
    const guardCode = (r) => r.status === 403 && r.body?.code === 'BILLING_CAPTAIN_ONLY';
    const TG = await pickFree([String(T2._id)]);
    const TGW = TG ? await pickFree([String(T2._id), String(TG._id)]) : null;
    if (!TG || !TGW) skip('G', 'need 2 free tables');
    else {
        const cG = await placeOrder(cap, TG, [[m2, 1]]);
        if (cG.status !== 201) fail('G', 'create order as captain', brief(cG));
        else {
            const OG = cG.body.order._id;
            const wb = [
                ['POST bill/save', await wai.post(`/orders/${OG}/bill/save`, { final: false })],
                ['GET bill/preview', await wai.get(`/orders/${OG}/bill/preview`)],
                ['POST /print/orders/:id/bill', await wai.post(`/print/orders/${OG}/bill`, {})],
                ['GET /print/status', await wai.get('/print/status')],
                ['PATCH coupon', await wai.patch(`/orders/${OG}/coupon`, { code: 'STAGING10' })],
                ['PATCH status Paid Cash', await wai.patch(`/orders/${OG}/status`, { paymentStatus: 'Paid', paymentMethod: 'Cash', amountPaid: 1 })],
                ['GET upi-qr', await wai.get(`/orders/${OG}/upi-qr`)],
            ];
            for (const [label, r] of wb) check('G', `waiter ${label} -> 403 BILLING_CAPTAIN_ONLY`, guardCode(r), r);
            const dG = await orderDetail(cap, OG);
            check('G', 'blocked waiter calls did not settle the order', (dG.body?.order || dG.body)?.paymentStatus !== 'Paid', dG);
            // waiter may still create / append / reprint KOT
            const cW = await placeOrder(wai, TGW, [[m1, 1]]);
            if (cW.status !== 201) fail('G', 'waiter POST /orders (create)', brief(cW));
            else {
                pass('G', 'waiter POST /orders (create) (201)');
                const OW = cW.body.order._id;
                const wa = await wai.post(`/orders/${OW}/append`, { items: [line(m3, 1)] }, { headers: idem() });
                check('G', 'waiter POST /orders/:id/append', wa.status === 200, wa);
                const wr = await wai.post(`/orders/${OW}/reprint-kot`, { kotNo: 1 });
                check('G', 'waiter POST /orders/:id/reprint-kot', wr.status === 200, wr);
            }
            // captain still works on the same routes
            const cs = await cap.post(`/orders/${OG}/bill/save`, { final: false });
            check('G', 'captain bill/save still works', cs.status === 200, cs);
            const cp = await cap.get(`/orders/${OG}/bill/preview`);
            check('G', 'captain bill/preview still works', cp.status === 200, cp);
            const cps = await cap.get('/print/status');
            check('G', 'captain /print/status still works', cps.status === 200, cps);
            const cpb = await cap.post(`/print/orders/${OG}/bill`, {});
            if (cpb.status === 202 || (cpb.status === 409 && ['NO_COUNTER_PRINTER', 'PRINTING_DISABLED', 'AGENT_OFFLINE'].includes(cpb.body?.code)))
                pass('G', `captain print bill not blocked (${cpb.status} ${cpb.body?.code || ''})`);
            else fail('G', 'captain print bill', brief(cpb));
            const cc = await cap.patch(`/orders/${OG}/coupon`, { code: 'STAGING10' });
            check('G', 'captain PATCH coupon not blocked by guard (not 403 BILLING_CAPTAIN_ONLY)', !guardCode(cc), cc, `status=${cc.status}`);
            await adm.post(`/tables/${TG._id}/free`, { force: true, reason: 'smoke cleanup' });
            await adm.post(`/tables/${TGW._id}/free`, { force: true, reason: 'smoke cleanup' });
        }
    }

    // ---- H. UPI QR settings -------------------------------------------------------
    const prevSet = await adm.get('/settings');
    const prevUpi = prevSet.body?.payments?.upiId || '';
    const prevPayee = prevSet.body?.payments?.upiPayeeName || '';
    const UPI = 'staging.cafe@okaxis';
    const bad = await adm.patch('/settings/payments', { upiId: 'abc' });
    check('H', 'admin PATCH /settings/payments invalid upiId -> 400 with errors', bad.status === 400 && !!bad.body?.errors, bad);
    const good = await adm.patch('/settings/payments', { upiId: 'Staging.Cafe@okaxis', upiPayeeName: 'Staging Cafe' });
    check('H', 'admin PATCH valid upiId -> 200, normalised lowercase', good.status === 200 && good.body?.payments?.upiId === UPI, good, `upiId=${good.body?.payments?.upiId}`);
    for (const [role, client] of [['captain', cap], ['waiter', wai]]) {
        const s = await client.get('/settings');
        const p = s.body?.payments;
        check('H', `${role} GET /settings: upiConfigured true, masked id, no raw id`,
            s.status === 200 && p?.upiConfigured === true && String(p?.upiIdMasked || '').includes('***') && !JSON.stringify(s.body).includes(UPI), s,
            `payments=${JSON.stringify(p)}`);
    }
    const pub = await http('GET', '/settings');
    if (pub.status !== 200) skip('H', `unauthenticated public GET /settings returned ${pub.status}; no public bootstrap to check`);
    else check('H', 'unauthenticated public GET /settings has no payments/upi key', pub.body?.payments === undefined
        && !hasKeyDeep(pub.body, 'upiId') && !/okaxis|upiUri/.test(pub.raw), pub);

    // ---- I. UPI QR flow ------------------------------------------------------------
    const money = (n) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    const TI = await pickFree([String(T2._id)]);
    if (!TI) skip('I', 'no free table');
    else {
        const cI = await placeOrder(cap, TI, [[m2, 1], [m3, 1]]);
        if (cI.status !== 201) fail('I', 'create order as captain', brief(cI));
        else {
            const OI = cI.body.order._id;
            const dI = await orderDetail(cap, OI);
            const amt = payableOf(dI.body?.order || dI.body);
            const q = await cap.get(`/orders/${OI}/upi-qr`);
            const uri = q.body?.upiUri || '';
            check('I', `captain GET upi-qr: amount ${amt}, uri/qr shape`,
                q.status === 200 && Math.abs(Number(q.body.amount) - amt) < 0.011
                && uri.startsWith(`upi://pay?pa=${UPI}`) && uri.includes(`am=${Number(amt).toFixed(2)}`) && uri.includes('cu=INR')
                && String(q.body.qrDataUrl || '').startsWith('data:image/png;base64,'), q, `amount=${q.body?.amount} uri=${uri.slice(0, 90)}`);
            const qw = await wai.get(`/orders/${OI}/upi-qr`);
            check('I', 'waiter GET upi-qr -> 403 BILLING_CAPTAIN_ONLY', guardCode(qw), qw);
            const fs = await cap.post(`/orders/${OI}/bill/save`, { final: true });
            check('I', 'bill/save final', fs.status === 200 && fs.body?.bill?.status === 'final', fs);
            const pbI = await cap.post(`/print/orders/${OI}/bill`, {});
            if (pbI.status === 202) pass('I', 'print bill queued (202)');
            else if (pbI.status === 409 && pbI.body?.code === 'PRINTING_DISABLED') warn('I', 'POST /print/orders/:id/bill -> 409 PRINTING_DISABLED (expected on staging)');
            else fail('I', `print bill (${pbI.status})`, brief(pbI));
            const pvI = await cap.get(`/orders/${OI}/bill/preview`);
            const txt = pvI.body?.text || '';
            check('I', `bill/preview contains [UPI QR: Rs ${money(amt)}] and not the raw UPI id`,
                pvI.status === 200 && txt.includes(`[UPI QR: Rs ${money(amt)}]`) && !txt.includes(UPI), pvI);
            // guest scan token captured before settling
            let gScan = null;
            const tI = (await cap.get('/tables')).body?.tables?.find((t) => String(t._id) === String(TI._id));
            if (tI?.qrToken) gScan = (await http('GET', `/tables/scan/${tI.qrToken}`)).body?.scanToken || null;

            const upi = await cap.patch(`/orders/${OI}/status`, { paymentStatus: 'Paid', paymentMethod: 'UPI', manualConfirm: true, upiRef: '1234' });
            check('I', 'captain manual UPI confirm -> 200', upi.status === 200, upi);
            const dI2 = await orderDetail(cap, OI);
            const oI2 = dI2.body?.order || dI2.body;
            check('I', 'order Paid, payment.state paid, method upi-qr-manual',
                oI2?.paymentStatus === 'Paid' && oI2?.payment?.state === 'paid' && oI2?.payment?.method === 'upi-qr-manual', dI2,
                `paymentStatus=${oI2?.paymentStatus} payment=${JSON.stringify(oI2?.payment)}`);
            const tI2 = (await cap.get('/tables')).body?.tables?.find((t) => String(t._id) === String(TI._id));
            check('I', 'table freed after UPI confirm', tI2 && tI2.status === 'free', { status: 200, body: tI2 }, `status=${tI2?.status}`);
            const q2 = await cap.get(`/orders/${OI}/upi-qr`);
            check('I', 'upi-qr after paid -> 409 ORDER_ALREADY_PAID', q2.status === 409 && q2.body?.code === 'ORDER_ALREADY_PAID', q2);
            if (!gScan) skip('I', 'guest read of paid order: no scan token for table');
            else {
                const gr = await http('GET', `/orders/${OI}/detail`, { headers: { 'X-Scan-Token': gScan } });
                if (gr.status !== 200) skip('I', `guest read of paid order not permitted (${gr.status}); nothing to leak`);
                else check('I', 'guest read of UPI-paid order has no upi fields', !/upiUri|upiId|okaxis|upi-qr-manual|qrDataUrl/.test(gr.raw), gr);
            }

            // tip-bearing order: QR amount includes tip
            const TT = await pickFree([String(T2._id)]);
            if (!TT) skip('I', 'no free table for tip order');
            else {
                const tipI = 20; const lT = [[m2, 1]];
                const cT = await cap.post('/orders', { type: 'dine-in', tableId: String(TT._id), items: lT.map(([m, n]) => line(m, n)),
                    total: round2(mkTotal(lT) + tipI), tipAmount: tipI, clientIdempotencyKey: `smoke_${rid()}${rid()}` }, { headers: idem() });
                if (cT.status !== 201) fail('I', 'create tip order', brief(cT));
                else {
                    const OT = cT.body.order._id;
                    const dT = await orderDetail(cap, OT);
                    const totT = payableOf(dT.body?.order || dT.body);
                    const qT = await cap.get(`/orders/${OT}/upi-qr`);
                    check('I', `tip order QR amount == total incl. tip (${totT})`, qT.status === 200 && Math.abs(Number(qT.body.amount) - totT) < 0.011
                        && String(qT.body.upiUri).includes(`am=${totT.toFixed(2)}`), qT, `amount=${qT.body?.amount}`);
                    await adm.post(`/tables/${TT._id}/free`, { force: true, reason: 'smoke cleanup' });
                }
            }
            // partial manual confirm on second order
            const TP = await pickFree([String(T2._id)]);
            if (!TP) skip('I', 'no free table for partial confirm');
            else {
                const cP = await placeOrder(cap, TP, [[m2, 1]]);
                if (cP.status !== 201) fail('I', 'create second order', brief(cP));
                else {
                    const OP = cP.body.order._id;
                    const part = await cap.patch(`/orders/${OP}/status`, { paymentStatus: 'Paid', paymentMethod: 'UPI', manualConfirm: true, amountPaid: 1 });
                    check('I', 'partial manual confirm -> 400 AMOUNT_TOO_LOW', part.status === 400 && part.body?.code === 'AMOUNT_TOO_LOW', part);
                    await adm.post(`/tables/${TP._id}/free`, { force: true, reason: 'smoke cleanup' });
                }
            }
        }
    }
    // restore UPI settings (clear, or previous value)
    const rest = await adm.patch('/settings/payments', { upiId: prevUpi, upiPayeeName: prevPayee });
    check('I', `restore UPI settings (${prevUpi ? 'previous value' : 'cleared'})`, rest.status === 200 && (rest.body?.payments?.upiId || '') === prevUpi, rest);

    // ---- cleanup: settle the leftover unpaid order from step 10 so T2 is free ----
    if (typeof O2id !== 'undefined') {
        await adm.post(`/tables/${T2row._id}/free`, { force: true, reason: 'smoke cleanup' });
    }
    summary();
}

function summary() {
    const count = (s) => results.filter((r) => r.status === s).length;
    console.log(`\nSummary: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('WARN')} WARN, ${count('SKIP')} SKIP`);
    process.exit(count('FAIL') ? 1 : 0);
}

main().catch((e) => { console.error('Unhandled error:', e); process.exit(1); });
