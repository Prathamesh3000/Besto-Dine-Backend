/**
 * One-shot migration: upload every file in Backend/uploads/ to
 * Cloudinary and rewrite all DB references that point at
 * `/uploads/<filename>` to the new `secure_url`.
 *
 * Run once on a machine that still has the local uploads folder:
 *
 *   cd Backend && node migrations/migrateUploadsToCloudinary.js              (live)
 *   cd Backend && node migrations/migrateUploadsToCloudinary.js --dry-run    (preview)
 *
 * --dry-run: still uploads to Cloudinary (so the mapping JSON is real),
 * but skips every DB write — only PRINTS what would change. Use this
 * to sanity-check the rewrite plan before touching production data.
 *
 * Idempotent — re-running on already-migrated data is a no-op (each
 * file's Cloudinary public_id collides on the second run; we skip the
 * upload and just rewrite if a mapping already exists in
 * uploads-migration-map.json).
 *
 * The mapping JSON lives next to the script so you can inspect it,
 * commit it to source control as audit, and re-run rewrite passes
 * without re-uploading.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const MAP_FILE   = path.join(__dirname, 'uploads-migration-map.json');
const DRY_RUN    = process.argv.includes('--dry-run');

function loadMap() {
  try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMap(m) {
  fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 2));
}

async function uploadOne(filename, mapping) {
  const relRef = `/uploads/${filename}`;
  if (mapping[relRef]) {
    console.log(`  ↪ skip (already mapped): ${filename}`);
    return mapping[relRef];
  }
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠ file gone: ${filename}`);
    return null;
  }
  // Use the filename-without-ext as the Cloudinary public_id so a
  // re-run inside the same folder is naturally idempotent (Cloudinary
  // overwrites instead of duplicating).
  const baseName = path.parse(filename).name;
  const result = await cloudinary.uploader.upload(filePath, {
    folder: 'bestodine/migrated',
    public_id: baseName,
    overwrite: true,
    resource_type: 'image',
  });
  mapping[relRef] = result.secure_url;
  saveMap(mapping);
  console.log(`  ✓ ${filename} → ${result.secure_url}`);
  return result.secure_url;
}

// Walk every property on a doc (deep) and replace any string equal to
// `/uploads/<filename>` with the matching Cloudinary URL.
function rewriteValue(value, mapping) {
  if (typeof value === 'string') {
    if (mapping[value]) return { changed: true, next: mapping[value] };
    // Some rows store an absolute URL like `http://localhost:5000/uploads/foo.png`.
    // Normalize by matching on the suffix.
    const idx = value.indexOf('/uploads/');
    if (idx >= 0) {
      const tail = value.slice(idx);
      if (mapping[tail]) return { changed: true, next: mapping[tail] };
    }
    return { changed: false, next: value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = rewriteValue(v, mapping);
      if (r.changed) changed = true;
      return r.next;
    });
    return { changed, next };
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !mongoose.isValidObjectId(value)) {
    let changed = false;
    const next = {};
    for (const k of Object.keys(value)) {
      const r = rewriteValue(value[k], mapping);
      if (r.changed) changed = true;
      next[k] = r.next;
    }
    return { changed, next };
  }
  return { changed: false, next: value };
}

async function rewriteCollection(collName, mapping) {
  const coll = mongoose.connection.db.collection(collName);
  const cursor = coll.find({});
  let scanned = 0;
  let updated = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    scanned += 1;
    const r = rewriteValue(doc, mapping);
    if (r.changed) {
      // Only $set the keys that actually changed, not the whole doc —
      // safer with concurrent writes and avoids touching _id.
      const setOps = {};
      for (const k of Object.keys(doc)) {
        if (k === '_id') continue;
        if (JSON.stringify(doc[k]) !== JSON.stringify(r.next[k])) {
          setOps[k] = r.next[k];
        }
      }
      if (Object.keys(setOps).length > 0) {
        if (DRY_RUN) {
          console.log(`    [dry] would update ${collName}/${doc._id}: ${Object.keys(setOps).join(', ')}`);
        } else {
          await coll.updateOne({ _id: doc._id }, { $set: setOps });
        }
        updated += 1;
      }
    }
  }
  console.log(`  ${collName}: scanned ${scanned}, updated ${updated}`);
}

async function main() {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.error('CLOUDINARY_* env vars missing — set them in Backend/.env first.');
    process.exit(1);
  }
  if (!process.env.MONGO_URL) {
    console.error('MONGO_URL missing — cannot connect to DB.');
    process.exit(1);
  }
  if (!fs.existsSync(UPLOADS_DIR)) {
    console.error(`uploads dir not found: ${UPLOADS_DIR}`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('🟡 DRY RUN MODE — uploads will happen, DB writes will be skipped.');
    console.log('   Re-run without --dry-run to actually rewrite the DB.\n');
  }

  console.log('1. Connecting to MongoDB…');
  await mongoose.connect(process.env.MONGO_URL);

  console.log('2. Uploading local files to Cloudinary…');
  const mapping = loadMap();
  const files = fs.readdirSync(UPLOADS_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  console.log(`   Found ${files.length} image file(s).`);
  for (const f of files) {
    try { await uploadOne(f, mapping); }
    catch (err) { console.error(`  ✗ failed: ${f} — ${err.message}`); }
  }

  console.log('3. Rewriting DB references…');
  // Hit every collection — we don't enumerate model names because some
  // (settings, advanceBooking, decorationPackage) carry image refs in
  // nested fields and we want full coverage.
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of collections) {
    if (name.startsWith('system.')) continue;
    await rewriteCollection(name, mapping);
  }

  console.log('4. Done. Mapping saved at:', MAP_FILE);
  console.log('   Verify a few records, then you can safely delete Backend/uploads/.');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
