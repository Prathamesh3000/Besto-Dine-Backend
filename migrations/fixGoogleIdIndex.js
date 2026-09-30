/**
 * Repair the users.googleId unique index.
 *
 * Why: models/user.js used to declare
 *     googleId: { type: String, default: null, unique: true, sparse: true }
 * A sparse index only skips documents that LACK the field, but the
 * `default: null` stored googleId: null on every password-only user, so
 * the unique index admitted exactly ONE such user per database — every
 * later registration failed with E11000 on googleId_1.
 *
 * The schema now has no default and declares
 *     { googleId: 1 }  name 'googleId_1', unique,
 *     partialFilterExpression: { googleId: { $type: 'string' } }
 * Mongo does not replace an existing index whose options differ, so an
 * existing database needs this script:
 *
 *   1. $unset googleId on every user where it is null (or '') — those
 *      values carry no meaning; "no Google account" is now "no field".
 *   2. Drop the existing `googleId_1` index IF its definition differs
 *      from the schema's (i.e. the legacy unique+sparse one).
 *   3. Create the schema's `googleId_1` index. By default only this one
 *      index is built (User.createIndexes semantics, nothing dropped).
 *      Pass --sync to run the full User.syncIndexes() instead, which
 *      ALSO drops any users index not declared in the schema — the
 *      script prints User.diffIndexes() first so you can see what that
 *      would be.
 *
 * Idempotent: a second run finds nothing to unset, an index that already
 * matches, and does nothing. Safe to run before or after deploying the
 * new code (the new code never writes googleId: null; old code writing
 * null is harmless under the partial index). NOT run automatically.
 *
 * Run (from Backend/, after taking a mongodump):
 *   node migrations/fixGoogleIdIndex.js --dry     # report only
 *   node migrations/fixGoogleIdIndex.js           # apply
 *   node migrations/fixGoogleIdIndex.js --sync    # apply + User.syncIndexes()
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const SYNC = process.argv.includes('--sync');
const INDEX_NAME = 'googleId_1';

function sameDefinition(existing, wanted) {
    const norm = (v) => JSON.stringify(v === undefined ? null : v);
    return norm(existing.key) === norm(wanted.key)
        && Boolean(existing.unique) === Boolean(wanted.unique)
        && Boolean(existing.sparse) === Boolean(wanted.sparse)
        && norm(existing.partialFilterExpression) === norm(wanted.partialFilterExpression);
}

async function main() {
    if (!process.env.MONGO_URL) throw new Error('MONGO_URL is not set in Backend/.env');
    await mongoose.connect(process.env.MONGO_URL, { autoIndex: false });
    console.log(`Connected to MongoDB${DRY ? ' (dry run — no writes)' : ''}`);

    const User = require('../models/user');
    const coll = User.collection;

    // What the schema wants for googleId_1.
    const spec = User.schema.indexes().find(([, opts]) => opts && opts.name === INDEX_NAME);
    if (!spec) throw new Error(`models/user.js declares no index named ${INDEX_NAME}`);
    const [wantedKey, wantedOpts] = spec;
    const wanted = { key: wantedKey, ...wantedOpts };

    // 1. Unset meaningless googleId values.
    const badFilter = { $or: [{ googleId: { $type: 'null' } }, { googleId: '' }] };
    const badCount = await coll.countDocuments(badFilter);
    if (badCount === 0) {
        console.log('Step 1: no users with googleId null/"" — nothing to unset.');
    } else if (DRY) {
        console.log(`Step 1: would $unset googleId on ${badCount} user(s).`);
    } else {
        const r = await coll.updateMany(badFilter, { $unset: { googleId: '' } });
        console.log(`Step 1: unset googleId on ${r.modifiedCount} user(s) (matched ${r.matchedCount}).`);
    }

    // 2. Drop the legacy index if its definition differs.
    const indexes = await coll.indexes();
    const existing = indexes.find((i) => i.name === INDEX_NAME);
    let needCreate = true;
    if (!existing) {
        console.log(`Step 2: no existing ${INDEX_NAME} index.`);
    } else if (sameDefinition(existing, wanted)) {
        console.log(`Step 2: ${INDEX_NAME} already matches the schema — keeping it.`);
        needCreate = false;
    } else {
        console.log(`Step 2: ${INDEX_NAME} differs from the schema:`);
        console.log(`        existing: ${JSON.stringify(existing)}`);
        console.log(`        wanted:   ${JSON.stringify(wanted)}`);
        if (DRY) {
            console.log(`        would drop ${INDEX_NAME}.`);
        } else {
            await coll.dropIndex(INDEX_NAME);
            console.log(`        dropped ${INDEX_NAME}.`);
        }
    }

    // 3. Build the new index.
    if (SYNC) {
        const diff = await User.diffIndexes();
        console.log(`Step 3 (--sync): diffIndexes → toDrop=${JSON.stringify(diff.toDrop)} toCreate=${JSON.stringify(diff.toCreate)}`);
        if (!DRY) {
            const dropped = await User.syncIndexes();
            console.log(`        User.syncIndexes() done; dropped: ${JSON.stringify(dropped)}`);
        }
    } else if (!needCreate) {
        console.log('Step 3: nothing to create.');
    } else if (DRY) {
        console.log(`Step 3: would create ${INDEX_NAME} ${JSON.stringify(wanted)}.`);
    } else {
        await coll.createIndex(wantedKey, wantedOpts);
        console.log(`Step 3: created ${INDEX_NAME} ${JSON.stringify(wanted)}.`);
    }

    await mongoose.disconnect();
    console.log('Done.');
}

main()
    .then(() => process.exit(0))
    .catch(async (err) => {
        console.error('Migration failed:', err);
        try { await mongoose.disconnect(); } catch { /* ignore */ }
        process.exit(1);
    });
