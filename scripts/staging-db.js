#!/usr/bin/env node
/**
 * staging-db.js — a PERSISTENT local MongoDB for the staging environment.
 *
 *   npm run db:staging          (keep this terminal open)
 *
 * Uses the mongod binary that mongodb-memory-server already downloads for
 * the integration tests, but with a fixed port and an on-disk data
 * directory (Backend/.staging-db, git-ignored), so the data survives
 * restarts — unlike the throw-away in-memory servers the tests use.
 *
 * It runs as a SINGLE-NODE REPLICA SET, not a bare standalone: the app
 * uses multi-document transactions (services/orderCreateService.js,
 * wallet / tips / refunds), which a standalone mongod rejects. The
 * connection string stays plain (`mongodb://127.0.0.1:27018/bestodine_staging`)
 * — the driver discovers the replica set from the single seed.
 *
 *   URI      mongodb://127.0.0.1:27018/bestodine_staging
 *   Data     Backend/.staging-db
 *   Stop     Ctrl+C (clean shutdown; data is kept)
 *   Reset    stop it, delete Backend/.staging-db, start again, re-seed
 *
 * Override the port / data dir with STAGING_DB_PORT / STAGING_DB_PATH.
 *
 * To use a real Atlas free-tier cluster instead, see Backend/STAGING.md.
 */
const path = require('path');
const fs = require('fs');
const { assertStagingDb, STAGING_DB_NAME } = require('../utils/stagingGuard');

const BACKEND = path.join(__dirname, '..');
const PORT = Number(process.env.STAGING_DB_PORT) || 27018;
const DB_PATH = process.env.STAGING_DB_PATH
    ? path.resolve(process.env.STAGING_DB_PATH)
    : path.join(BACKEND, '.staging-db');
const REPLSET_NAME = 'staging';
const URI = `mongodb://127.0.0.1:${PORT}/${STAGING_DB_NAME}`;

// Belt and braces: the URI this script hands out must itself pass the guard.
assertStagingDb(URI, 'scripts/staging-db.js');

async function main() {
    const { MongoMemoryReplSet } = require('mongodb-memory-server');

    fs.mkdirSync(DB_PATH, { recursive: true });
    const hadData = fs.readdirSync(DB_PATH).length > 0;

    console.log(`[staging-db] data dir : ${DB_PATH} (${hadData ? 'existing data found' : 'fresh'})`);
    console.log(`[staging-db] starting mongod on 127.0.0.1:${PORT} (replica set "${REPLSET_NAME}", wiredTiger) ...`);

    let replSet;
    try {
        replSet = await MongoMemoryReplSet.create({
            replSet: { name: REPLSET_NAME, count: 1, dbName: STAGING_DB_NAME, storageEngine: 'wiredTiger' },
            instanceOpts: [{ port: PORT, dbPath: DB_PATH, storageEngine: 'wiredTiger' }],
        });
        await replSet.waitUntilRunning();
    } catch (err) {
        console.error(`[staging-db] failed to start: ${err.message}`);
        if (/port|EADDRINUSE|in use/i.test(String(err.message))) {
            console.error(`[staging-db] Is another db:staging already running on ${PORT}? Reuse it, or set STAGING_DB_PORT.`);
        }
        process.exit(1);
    }

    const reported = replSet.getUri(STAGING_DB_NAME);
    console.log('[staging-db] running.');
    console.log(`[staging-db] URI : ${URI}`);
    console.log(`[staging-db] (driver view: ${reported})`);
    console.log(`[staging-db] PID : ${process.pid}`);
    console.log('[staging-db] Next: `npm run seed:staging` then `npm run start:staging`. Ctrl+C to stop (data is kept).');

    let stopping = false;
    async function shutdown(signal) {
        if (stopping) return;
        stopping = true;
        console.log(`\n[staging-db] ${signal} received — stopping mongod (data in ${DB_PATH} is kept) ...`);
        const force = setTimeout(() => {
            console.error('[staging-db] shutdown took too long — exiting.');
            process.exit(1);
        }, 15000);
        force.unref();
        try {
            // doCleanup: false — never delete the persistent data directory.
            await replSet.stop({ doCleanup: false, force: false });
            console.log('[staging-db] stopped.');
            process.exit(0);
        } catch (err) {
            console.error(`[staging-db] error while stopping: ${err.message}`);
            process.exit(1);
        }
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));

    // Keep the event loop alive for as long as the server runs.
    setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
    console.error('[staging-db] fatal:', err);
    process.exit(1);
});
