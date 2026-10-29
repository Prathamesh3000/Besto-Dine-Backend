#!/usr/bin/env node
/**
 * backup-mongodump.js - whole-database backup via mongodump.
 *
 *   node scripts/backup-mongodump.js            run a backup
 *   node scripts/backup-mongodump.js --dry-run  print the plan, connect to nothing
 *
 * Env:
 *   BACKUP_MONGO_URI        required. Use a READ-ONLY Atlas user (built-in role "backup"
 *                           or "read" on the database). Deliberately NOT the app's
 *                           MONGO_URL: refuses to run if unset.
 *   BACKUP_DIR              required. Must be OUTSIDE the OneDrive-synced project.
 *   BACKUP_RETENTION_DAYS   default 14. Archives older than this are deleted.
 *
 * Needs the MongoDB Database Tools (`mongodump`) on PATH.
 * The URI / password is never printed; all child output is redacted.
 *
 * Exit codes: 0 ok, 1 failure, 2 configuration error.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DRY = process.argv.includes('--dry-run');

function secretsOf(uri) {
  const out = new Set();
  const m = /^mongodb(?:\+srv)?:\/\/([^/?#]*)@/.exec(uri || '');
  if (m) {
    const cred = m[1];
    out.add(cred);
    const i = cred.indexOf(':');
    if (i >= 0) {
      const pw = cred.slice(i + 1);
      if (pw) {
        out.add(pw);
        try { out.add(decodeURIComponent(pw)); } catch (_) { /* ignore */ }
      }
    }
  }
  if (uri) out.add(uri);
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}
function makeRedactor(uri) {
  const secrets = secretsOf(uri);
  return (s) => {
    let t = String(s);
    for (const x of secrets) t = t.split(x).join('***');
    return t.replace(/(mongodb(?:\+srv)?:\/\/)[^/\s@]*@/gi, '$1***@');
  };
}

function fail(code, msg) { console.error('backup: ' + msg); process.exit(code); }

const uri = process.env.BACKUP_MONGO_URI;
if (!uri) fail(2, 'BACKUP_MONGO_URI is not set. Refusing to run (it intentionally does not fall back to MONGO_URL).');
if (!/^mongodb(\+srv)?:\/\//.test(uri)) fail(2, 'BACKUP_MONGO_URI is not a mongodb:// or mongodb+srv:// URI.');
const dir = process.env.BACKUP_DIR;
if (!dir) fail(2, 'BACKUP_DIR is not set.');
const retention = process.env.BACKUP_RETENTION_DAYS === undefined || process.env.BACKUP_RETENTION_DAYS === ''
  ? 14 : Number(process.env.BACKUP_RETENTION_DAYS);
if (!Number.isFinite(retention) || retention < 1) fail(2, 'BACKUP_RETENTION_DAYS must be a number >= 1.');

const redact = makeRedactor(uri);
const absDir = path.resolve(dir);
if (/onedrive/i.test(absDir)) {
  console.warn('backup: WARNING BACKUP_DIR is inside a OneDrive folder. Use a non-synced path (see BACKUP_RESTORE.md).');
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261028T031500Z
const file = path.join(absDir, `bestodine-${stamp}.archive.gz`);
const tmp = file + '.partial';
const args = ['--uri', uri, '--gzip', `--archive=${tmp}`];
const PREFIX = 'bestodine-';
const SUFFIX = '.archive.gz';

function prune() {
  const cutoff = Date.now() - retention * 86400000;
  let names = [];
  try { names = fs.readdirSync(absDir); } catch (_) { return; }
  for (const n of names) {
    if (!n.startsWith(PREFIX) || !(n.endsWith(SUFFIX) || n.endsWith(SUFFIX + '.partial'))) continue;
    const p = path.join(absDir, n);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        if (DRY) console.log(`backup: [dry-run] would delete old archive ${n}`);
        else { fs.unlinkSync(p); console.log(`backup: pruned ${n}`); }
      }
    } catch (e) { console.warn('backup: could not prune ' + n + ': ' + e.message); }
  }
}

// TODO(offsite): upload `file` to an S3-compatible bucket. No AWS SDK is a dependency
// of this project, so none is added here. Options: run `aws s3 cp` / `rclone copy` after
// this script from the scheduler, or implement it in this function.
async function uploadOffsite(/* file */) { /* intentionally empty */ }

if (DRY) {
  console.log('backup: [dry-run] no connection will be made, nothing written.');
  console.log('backup: [dry-run] would run: mongodump ' + redact(args.join(' ')));
  console.log(`backup: [dry-run] final archive: ${file}`);
  console.log(`backup: [dry-run] retention: ${retention} day(s) in ${absDir}`);
  prune();
  console.log('backup: [dry-run] offsite upload: not configured (TODO hook)');
  process.exit(0);
}

fs.mkdirSync(absDir, { recursive: true });
console.log('backup: starting mongodump -> ' + file);
const child = spawn('mongodump', args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(redact(d)));
child.stderr.on('data', (d) => process.stderr.write(redact(d)));
child.on('error', (e) => {
  try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  fail(1, 'could not start mongodump (installed and on PATH?): ' + redact(e.message));
});
child.on('close', async (code) => {
  if (code !== 0) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    fail(1, `mongodump exited with code ${code}`);
  }
  try {
    const size = fs.statSync(tmp).size;
    if (size < 1024) throw new Error('archive suspiciously small (' + size + ' bytes)');
    fs.renameSync(tmp, file);
    console.log(`backup: OK ${file} (${(size / 1048576).toFixed(2)} MB)`);
    prune();
    await uploadOffsite(file);
  } catch (e) {
    fail(1, redact(e.message));
  }
});
