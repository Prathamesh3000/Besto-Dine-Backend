#!/usr/bin/env node
/**
 * staging-health.js — print the staging server's /health response.
 *
 *   npm run health:staging        (loads .env.staging, then runs this)
 *
 * Refuses to run unless MONGO_URL is the staging database, and warns when
 * the server that answered is not reporting appEnv "staging" — the desktop
 * e2e harness relies on exactly that field before it starts crawling.
 * Exit code 0 only when the server answered 200 with appEnv === 'staging'.
 */
const { assertStagingDb } = require('../utils/stagingGuard');

assertStagingDb(process.env.MONGO_URL, 'scripts/staging-health.js');

const port = process.env.PORT || 5001;
const base = process.env.STAGING_API_URL || `http://127.0.0.1:${port}`;
const url = `${base.replace(/\/$/, '')}/health`;

async function main() {
    let res;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
        console.error(`[staging-health] ${url} unreachable: ${err.cause?.message || err.message}`);
        console.error('[staging-health] Is `npm run start:staging` (or dev:staging) running?');
        process.exit(1);
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    console.log(`[staging-health] GET ${url} -> ${res.status}`);
    console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));

    const ok = res.ok && body && body.appEnv === 'staging';
    if (!ok) {
        console.error(`[staging-health] NOT a staging server (appEnv=${body?.appEnv ?? 'missing'}).`);
        process.exit(1);
    }
    if (body.db !== 'connected') {
        console.error(`[staging-health] warning: db is "${body.db}" (expected "connected").`);
        process.exit(1);
    }
}

main();
