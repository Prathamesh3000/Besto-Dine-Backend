#!/usr/bin/env node
/**
 * restore-drill.js - restore a backup archive into a SCRATCH database and sanity-count it.
 *
 *   node scripts/restore-drill.js <archive.gz> [--dry-run] [--drop]
 *
 * Env:
 *   RESTORE_TARGET_URI   required. Where to restore (scratch server, or Atlas staging).
 *   RESTORE_TARGET_DB    required. Must start with "restore_drill_" or "bestodine_staging".
 *   RESTORE_SOURCE_DB    database name inside the archive. Default: db name in the
 *                        BACKUP_MONGO_URI path, else "bestodine".
 *   PRODUCTION_DB_NAME   optional extra name to refuse (the db names found in
 *                        BACKUP_MONGO_URI and MONGO_URL are refused too, if set).
 *   --drop               pass --drop to mongorestore (replace existing collections).
 *
 * The target URI's own path is ignored; --nsFrom/--nsTo maps <source>.* to <target>.*
 * Needs `mongorestore` on PATH. Never prints credentials.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const DROP = argv.includes('--drop');
const archive = argv.find((a) => !a.startsWith('--'));

function fail(code, msg) { console.error('restore-drill: ' + msg); process.exit(code); }
function dbFromUri(u) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?#]*)/.exec(u || '');
  return m && m[1] ? decodeURIComponent(m[1]) : '';
}
function makeRedactor(uri) {
  const secrets = new Set([uri]);
  const m = /^mongodb(?:\+srv)?:\/\/([^/?#]*)@/.exec(uri);
  if (m) {
    secrets.add(m[1]);
    const i = m[1].indexOf(':');
    if (i >= 0 && m[1].slice(i + 1)) {
      const pw = m[1].slice(i + 1);
      secrets.add(pw);
      try { secrets.add(decodeURIComponent(pw)); } catch (_) { /* ignore */ }
    }
  }
  const list = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  return (s) => {
    let t = String(s);
    for (const x of list) t = t.split(x).join('***');
    return t.replace(/(mongodb(?:\+srv)?:\/\/)[^/\s@]*@/gi, '$1***@');
  };
}

const uri = process.env.RESTORE_TARGET_URI;
const targetDb = process.env.RESTORE_TARGET_DB;
if (!archive) fail(2, 'usage: node scripts/restore-drill.js <archive.gz> [--dry-run] [--drop]');
if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri)) fail(2, 'RESTORE_TARGET_URI is not set or not a mongodb URI.');
if (!targetDb) fail(2, 'RESTORE_TARGET_DB is not set.');

if (!(targetDb.startsWith('restore_drill_') || targetDb.startsWith('bestodine_staging'))) {
  fail(2, `REFUSED: target database "${targetDb}" must start with "restore_drill_" or "bestodine_staging".`);
}
const prodNames = new Set(
  [process.env.PRODUCTION_DB_NAME, dbFromUri(process.env.BACKUP_MONGO_URI), dbFromUri(process.env.MONGO_URL)]
    .filter(Boolean).map((s) => s.toLowerCase())
);
if (prodNames.has(targetDb.toLowerCase())) fail(2, `REFUSED: "${targetDb}" is the production database name.`);
const uriDb = dbFromUri(uri);
if (uriDb && prodNames.has(uriDb.toLowerCase())) fail(2, `REFUSED: RESTORE_TARGET_URI points at production database "${uriDb}".`);
if (uriDb && uriDb !== targetDb) console.warn(`restore-drill: note, URI path db "${uriDb}" is ignored; restoring into "${targetDb}".`);

const sourceDb = process.env.RESTORE_SOURCE_DB || dbFromUri(process.env.BACKUP_MONGO_URI) || 'bestodine';
if (sourceDb.toLowerCase() === targetDb.toLowerCase()) fail(2, 'source and target database names are identical; refusing.');

const archivePath = path.resolve(archive);
const redact = makeRedactor(uri);
const args = ['--uri', uri, '--gzip', `--archive=${archivePath}`, '--nsFrom', `${sourceDb}.*`, '--nsTo', `${targetDb}.*`];
if (DROP) args.push('--drop');

if (DRY) {
  console.log('restore-drill: [dry-run] nothing will be run or connected to.');
  console.log('restore-drill: [dry-run] archive exists: ' + fs.existsSync(archivePath));
  console.log('restore-drill: [dry-run] would run: mongorestore ' + redact(args.join(' ')));
  console.log(`restore-drill: [dry-run] then count users, restaurants, orders in "${targetDb}"`);
  process.exit(0);
}
if (!fs.existsSync(archivePath)) fail(2, 'archive not found: ' + archivePath);

async function counts() {
  const mongoose = require('mongoose');
  const conn = await mongoose.createConnection(uri, { dbName: targetDb, family: 4, serverSelectionTimeoutMS: 15000 }).asPromise();
  try {
    const names = (await conn.db.listCollections().toArray()).map((c) => c.name);
    console.log(`restore-drill: database "${targetDb}" has ${names.length} collection(s)`);
    for (const want of ['users', 'restaurants', 'orders']) {
      if (!names.includes(want)) { console.log(`  ${want}: MISSING collection`); continue; }
      console.log(`  ${want}: ${await conn.db.collection(want).countDocuments({})}`);
    }
  } finally { await conn.close(); }
}

console.log(`restore-drill: mongorestore ${archivePath} -> ${targetDb} (from ${sourceDb})`);
const child = spawn('mongorestore', args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(redact(d)));
child.stderr.on('data', (d) => process.stderr.write(redact(d)));
child.on('error', (e) => fail(1, 'could not start mongorestore: ' + redact(e.message)));
child.on('close', async (code) => {
  if (code !== 0) fail(1, `mongorestore exited with code ${code}`);
  try {
    await counts();
    console.log('restore-drill: DONE. Compare these counts with production, then record the drill in BACKUP_RESTORE.md.');
    process.exit(0);
  } catch (e) { fail(1, 'sanity counts failed: ' + redact(e.message)); }
});
