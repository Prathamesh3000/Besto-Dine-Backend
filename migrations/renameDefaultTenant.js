// One-shot migration — rename the legacy "Default Restaurant" tenant
// (slug='default') to "The Coffee House" (slug='the-coffee-house').
//
// Why: the original seed used a generic placeholder name. The single
// real tenant on this deployment is The Coffee House, so we rename
// the document to match. All linked data (orders, users, menu, etc.)
// is referenced by ObjectId — only the human-readable name + URL
// slug change.
//
// ⚠ Customer QR codes that embed `?restaurant=default` will stop
// resolving after this runs. Reprint them with `?restaurant=the-coffee-house`.
//
// Run once:
//     cd Backend && node migrations/renameDefaultTenant.js
//
// Idempotent — safe to re-run.
require('dotenv').config();
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');

const OLD_SLUG = 'default';
const NEW_SLUG = 'the-coffee-house';
const NEW_NAME = 'The Coffee House';

async function main() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('FATAL: MONGO_URL is not set');
        process.exit(1);
    }
    await mongoose.connect(uri, { family: 4 });
    console.log('Connected.');

    const existingNew = await Restaurant.findOne({ slug: NEW_SLUG }).select('_id name slug');
    const existingOld = await Restaurant.findOne({ slug: OLD_SLUG }).select('_id name slug');

    if (existingNew && !existingOld) {
        console.log(`Already renamed — tenant "${existingNew.name}" (${NEW_SLUG}) exists. Nothing to do.`);
        await mongoose.disconnect();
        return;
    }

    if (existingNew && existingOld) {
        console.error(
            `FATAL: both slugs already exist — "${existingOld.name}" (${OLD_SLUG}) ` +
            `AND "${existingNew.name}" (${NEW_SLUG}). Resolve the conflict manually before re-running.`
        );
        process.exit(1);
    }

    if (!existingOld) {
        console.log(`No tenant with slug "${OLD_SLUG}" found. Nothing to do.`);
        await mongoose.disconnect();
        return;
    }

    console.log(`Renaming "${existingOld.name}" (${OLD_SLUG}) → "${NEW_NAME}" (${NEW_SLUG})…`);
    const result = await Restaurant.updateOne(
        { _id: existingOld._id },
        { $set: { name: NEW_NAME, slug: NEW_SLUG } }
    );

    console.log(`Modified: ${result.modifiedCount}`);
    console.log('Done.');
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('renameDefaultTenant failed:', err);
    process.exit(1);
});
