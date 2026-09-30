#!/usr/bin/env node
/**
 * List existing restaurants whose slug is RESERVED (utils/reservedSlugs.js).
 *
 * Restaurant landing pages live at /<restaurantSlug>, mounted after every
 * frontend app route — a tenant whose slug equals a top-level app path
 * (admin, login, kiosk, ...) has an unreachable landing page. New tenants
 * can no longer get such a slug; this script finds pre-existing ones so an
 * operator can rename them deliberately (QR codes use qrToken, but shared
 * /r/<slug> links would change).
 *
 * READ-ONLY: one find() on the restaurants collection, nothing is written.
 *
 * Usage (from Backend/):
 *   node scripts/check-reserved-slugs.js          # human-readable
 *   node scripts/check-reserved-slugs.js --json   # machine-readable
 *
 * Exit code: 0 = no collisions, 1 = collisions found, 2 = error.
 */
'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const Restaurant = require('../models/restaurant');
const { RESERVED_SLUGS } = require('../utils/reservedSlugs');

const asJson = process.argv.includes('--json');

(async () => {
    const uri = config.mongoUrl || process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set (see Backend/.env)');
        process.exit(2);
    }
    let exitCode = 0;
    try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false, autoCreate: false });
        // AUDIT-EXEMPT: platform-wide read-only maintenance scan.
        const hits = await Restaurant.find({ slug: { $in: [...RESERVED_SLUGS] } })
            .select('name slug status contactEmail createdAt')
            .sort({ slug: 1 })
            .lean();

        if (asJson) {
            console.log(JSON.stringify({
                count: hits.length,
                restaurants: hits.map((r) => ({
                    _id: String(r._id), slug: r.slug, name: r.name, status: r.status,
                    contactEmail: r.contactEmail, createdAt: r.createdAt,
                })),
            }, null, 2));
        } else if (hits.length === 0) {
            console.log(`OK - no restaurant uses a reserved slug (${RESERVED_SLUGS.size} reserved).`);
        } else {
            console.log(`Found ${hits.length} restaurant(s) with a reserved slug:\n`);
            for (const r of hits) {
                console.log(`  ${String(r.slug).padEnd(24)} ${String(r.status).padEnd(10)} ${r.name}  <${r.contactEmail}>  id=${r._id}`);
            }
            console.log('\nTheir /<slug> landing page is shadowed by an app route. Rename deliberately.');
        }
        exitCode = hits.length > 0 ? 1 : 0;
    } catch (err) {
        console.error('check-reserved-slugs failed:', err.message);
        exitCode = 2;
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
    process.exit(exitCode);
})();
