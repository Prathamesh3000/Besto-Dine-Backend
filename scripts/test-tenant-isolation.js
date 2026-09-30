#!/usr/bin/env node
/**
 * test-tenant-isolation.js — runtime cross-tenant leak test.
 *
 * Static analysis (scripts/audit-tenant-scope.js) catches "I forgot to
 * spread tenantFilter()" at commit time. This script proves the same
 * thing at runtime by hammering the live API as Tenant A with a JWT
 * that tries to read/mutate Tenant B's data.
 *
 * Why both layers:
 *   - The audit is a sieve: cheap, fast, but can be fooled by indirect
 *     filter builders.
 *   - This runtime test makes the actual HTTP request and inspects the
 *     response. If the audit lies and a query is unscoped, we see the
 *     leak here.
 *
 * Pre-conditions:
 *   - Backend running at process.env.E2E_API or http://localhost:5000
 *   - At least two tenants exist in the DB. The script picks them
 *     automatically (slug = 'hotel-tip-top' and 'e2e-test-cafe-816138'
 *     by default; override via env).
 *
 * Usage:
 *   cd Backend
 *   node scripts/test-tenant-isolation.js
 *
 * Exit code:
 *   0 — no leaks found
 *   1 — at least one cross-tenant read or mutation succeeded
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const API = process.env.E2E_API || 'http://localhost:5000/api/v1';

// Defaults: tenant A = "victim" (we'll try to steal from it), tenant B = "attacker".
const TENANT_A_SLUG = process.env.E2E_VICTIM_SLUG  || 'hotel-tip-top';
const TENANT_B_SLUG = process.env.E2E_ATTACK_SLUG  || 'e2e-test-cafe-816138';
const TENANT_B_EMAIL = process.env.E2E_ATTACK_EMAIL || 'e2e-test-816138@example.com';
const TENANT_B_PASSWORD = process.env.E2E_ATTACK_PASSWORD || 'Admin@123';

const reset = '\x1b[0m', red = '\x1b[31m', green = '\x1b[32m', yellow = '\x1b[33m', dim = '\x1b[2m';

const results = []; // { name, ok, detail }

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    const tag = ok ? `${green}PASS${reset}` : `${red}FAIL${reset}`;
    console.log(`  ${tag}  ${name}${detail ? `\n        ${dim}${detail}${reset}` : ''}`);
}

async function loginAttacker() {
    const r = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Restaurant-Slug': TENANT_B_SLUG },
        body: JSON.stringify({ email: TENANT_B_EMAIL, password: TENANT_B_PASSWORD, loginType: 'staff' }),
    });
    if (!r.ok) {
        console.error(`${red}FATAL — could not log in attacker tenant.${reset}`);
        console.error(`Set E2E_ATTACK_EMAIL / E2E_ATTACK_PASSWORD env vars or seed the test tenant first.`);
        console.error(`Login response: ${r.status} ${await r.text()}`);
        process.exit(2);
    }
    const data = await r.json();
    return { token: data.token, restaurant: data.restaurant?._id || data.restaurant };
}

async function getVictimAssets() {
    // Use DB directly to find one ObjectId per resource type owned by tenant A.
    // We never query as the attacker — we just need known target IDs.
    await mongoose.connect(process.env.MONGO_URL, { family: 4 });
    require('../models/restaurant');
    const Restaurant = mongoose.model('Restaurant');
    const victim = await Restaurant.findOne({ slug: TENANT_A_SLUG }).select('_id').lean();
    if (!victim) {
        console.error(`${red}FATAL — victim tenant '${TENANT_A_SLUG}' not found in DB.${reset}`);
        process.exit(2);
    }
    const tenantId = victim._id;
    const Inventory = require('../models/inventory');
    const MenuItem = require('../models/menuItem');
    const Order = require('../models/order');
    const inv = await Inventory.findOne({ restaurant: tenantId }).select('_id name').lean();
    const menu = await MenuItem.findOne({ restaurant: tenantId }).select('_id name').lean();
    const order = await Order.findOne({ restaurant: tenantId }).select('_id orderId').lean();
    await mongoose.disconnect();
    return { tenantId, inv, menu, order };
}

async function fetchJson(url, options = {}) {
    const r = await fetch(url, options);
    let body;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
}

async function main() {
    console.log('');
    console.log(`Tenant-isolation runtime test`);
    console.log(`${dim}Victim: ${TENANT_A_SLUG}   Attacker: ${TENANT_B_SLUG}${reset}`);
    console.log('');

    const attacker = await loginAttacker();
    const victim = await getVictimAssets();
    const H = {
        'Authorization': 'Bearer ' + attacker.token,
        'X-Restaurant-Slug': TENANT_B_SLUG, // attacker's own slug
    };

    console.log(`${dim}Attacker token issued for tenant ${attacker.restaurant}${reset}`);
    console.log(`${dim}Victim tenant id  ${victim.tenantId}${reset}`);
    console.log('');

    // ── Test 1-7: slug-spoofing on list endpoints ────────────────
    const HSpoof = { ...H, 'X-Restaurant-Slug': TENANT_A_SLUG };
    const lists = [
        { name: 'GET /inventory with victim slug',  url: `${API}/inventory?limit=10`, key: 'items' },
        { name: 'GET /menu with victim slug',       url: `${API}/menu?limit=10`,      key: 'data'  },
        { name: 'GET /combos with victim slug',     url: `${API}/combos?limit=10`,    key: 'data'  },
        { name: 'GET /tables with victim slug',     url: `${API}/tables`,             key: 'tables' },
        { name: 'GET /staff with victim slug',      url: `${API}/staff?limit=10`,     key: 'staff' },
        { name: 'GET /inventory/recipes spoof',     url: `${API}/inventory/recipes`,  key: 'recipes' },
        { name: 'GET /orders with victim slug',     url: `${API}/orders?limit=10`,    key: 'orders' },
    ];
    for (const t of lists) {
        const r = await fetchJson(t.url, { headers: HSpoof });
        const list = (r.body && (r.body[t.key] || r.body.data)) || [];
        const leaked = Array.isArray(list)
            ? list.filter(x => String(x.restaurant) === String(victim.tenantId)).length
            : 0;
        record(
            t.name,
            leaked === 0,
            leaked > 0 ? `LEAKED ${leaked} item(s) belonging to victim` : `count=${Array.isArray(list) ? list.length : '?'}, leaked=0`
        );
    }

    // ── Test 8-10: direct-ID reads of victim assets ──────────────
    if (victim.inv) {
        const r = await fetchJson(`${API}/inventory/${victim.inv._id}`, { headers: H });
        record(
            `GET /inventory/<victim-id> direct lookup`,
            r.status === 404,
            `status=${r.status} (expect 404)`
        );
    }
    if (victim.menu) {
        const r = await fetchJson(`${API}/menu/${victim.menu._id}`, { headers: H });
        record(
            `GET /menu/<victim-id> direct lookup`,
            r.status === 404,
            `status=${r.status} (expect 404)`
        );
    }
    if (victim.order) {
        const r = await fetchJson(`${API}/orders/${victim.order._id}`, { headers: H });
        record(
            `GET /orders/<victim-id> direct lookup`,
            r.status === 404 || r.status === 405,
            `status=${r.status} (expect 404)`
        );
    }

    // ── Test 11-12: mutations on victim assets ───────────────────
    if (victim.inv) {
        const r = await fetchJson(`${API}/inventory/${victim.inv._id}`, {
            method: 'PUT',
            headers: { ...H, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'HACKED-BY-' + Date.now() }),
        });
        record(
            `PUT /inventory/<victim-id> rename attempt`,
            r.status === 404 || r.status === 403,
            `status=${r.status} (expect 404)`
        );
        // Verify in DB that no rename happened
        await mongoose.connect(process.env.MONGO_URL, { family: 4 });
        const Inventory = require('../models/inventory');
        const after = await Inventory.findById(victim.inv._id).select('name').lean();
        record(
            `DB: victim inventory name unchanged after attack`,
            after && after.name === victim.inv.name,
            `before='${victim.inv.name}' after='${after?.name}'`
        );
        await mongoose.disconnect();
    }
    if (victim.menu) {
        const r = await fetchJson(`${API}/menu/${victim.menu._id}`, { method: 'DELETE', headers: H });
        record(
            `DELETE /menu/<victim-id> delete attempt`,
            r.status === 404 || r.status === 403,
            `status=${r.status} (expect 404)`
        );
        await mongoose.connect(process.env.MONGO_URL, { family: 4 });
        const MenuItem = require('../models/menuItem');
        const after = await MenuItem.findById(victim.menu._id).select('status').lean();
        record(
            `DB: victim menu item still exists after delete attempt`,
            !!after,
            after ? 'doc still present' : 'DOC DELETED — BIG PROBLEM'
        );
        await mongoose.disconnect();
    }

    // ── Test 13: smuggle foreign menu id into own order ──────────
    if (victim.menu) {
        const r = await fetchJson(`${API}/orders`, {
            method: 'POST',
            headers: {
                ...H,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                type: 'takeaway',
                items: [{ menuItem: victim.menu._id, name: 'SMUGGLED', quantity: 1, price: 1 }],
                subtotal: 1, total: 1,
                paymentStatus: 'Paid', paymentMethod: 'Cash',
            }),
        });
        record(
            `POST /orders with foreign menuItem id`,
            r.status === 400 || r.status === 404 || r.status === 403,
            `status=${r.status} (expect 400)`
        );
    }

    // ── Summary ──────────────────────────────────────────────────
    const failed = results.filter(r => !r.ok);
    console.log('');
    console.log(`Total: ${results.length}   ${green}Pass: ${results.length - failed.length}${reset}   ${failed.length ? red : green}Fail: ${failed.length}${reset}`);
    console.log('');
    if (failed.length) {
        console.log(`${red}❌ One or more tenant-isolation guarantees broke.${reset}`);
        process.exit(1);
    }
    console.log(`${green}✅ All isolation guarantees held.${reset}`);
    process.exit(0);
}

main().catch(err => {
    console.error(red + 'TEST RUNNER ERROR' + reset, err);
    process.exit(2);
});
