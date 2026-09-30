/**
 * seedAreaTables.js
 *
 * Adds 6 tables to each of the standard seating areas for ONE tenant:
 *   Indoor, Outdoor, AC Section, Non-AC Section, Ground Floor,
 *   Rooftop, Garden, Smoking Zone, Private Dining.
 *
 * Tenant resolution mirrors seedMenuItems.js — TENANT_SLUG env var picks
 * a specific tenant, otherwise the first Restaurant doc (by createdAt)
 * is used.
 *
 * Idempotent: tables that already exist in (area, name) are skipped, so
 * re-running is safe. Areas that don't exist are skipped with a warning
 * (the seed never auto-creates areas, since the user already curates
 * those from the Admin UI).
 *
 * Run:
 *   cd Backend
 *   node Seed/seedAreaTables.js
 *   # optional:
 *   TENANT_SLUG=your-tenant-slug node Seed/seedAreaTables.js
 */
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Area = require('../models/area');
const Table = require('../models/table');

// ─── Per-area table blueprint ────────────────────────────────────────
// Capacity mix is tuned to the area: smaller seats outdoors / smoking,
// larger seats in Private Dining. 2-digit padded numbering keeps
// names short on KOTs (e.g. "IN-01") and sorts predictably in the
// admin table list.
const BLUEPRINT = [
    { area: 'Indoor',         prefix: 'IN',   capacities: [2, 2, 4, 4, 4, 6] },
    { area: 'Outdoor',        prefix: 'OUT',  capacities: [2, 2, 4, 4, 4, 6] },
    { area: 'AC Section',     prefix: 'AC',   capacities: [2, 2, 4, 4, 4, 6] },
    { area: 'Non-AC Section', prefix: 'NAC',  capacities: [2, 2, 4, 4, 4, 6] },
    { area: 'Ground Floor',   prefix: 'GF',   capacities: [2, 2, 4, 4, 4, 6] },
    { area: 'Rooftop',        prefix: 'RT',   capacities: [2, 2, 4, 4, 4, 6] },
    { area: 'Garden',         prefix: 'GR',   capacities: [2, 2, 2, 4, 4, 4] },
    { area: 'Smoking Zone',   prefix: 'SMK',  capacities: [2, 2, 2, 4, 4, 4] },
    { area: 'Private Dining', prefix: 'PD',   capacities: [4, 6, 6, 8, 8, 10] },
];

async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant found with slug "${slug}".`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant doc exists. Run "node Seed/seedDefaultTenant.js" first.');
    return t;
}

function generateQrToken() {
    // Same format as createTable in tableController: tb-<12 hex>.
    return `tb-${crypto.randomBytes(6).toString('hex')}`;
}

const seedAreaTables = async () => {
    try {
        if (!process.env.MONGO_URL) {
            throw new Error('MONGO_URL is not set in Backend/.env');
        }
        await mongoose.connect(process.env.MONGO_URL);
        console.log('✔ Connected to MongoDB');

        const tenant = await resolveTenant();
        console.log(`✔ Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

        let totalCreated = 0;
        let totalSkipped = 0;
        let missingAreas = [];

        for (const blueprint of BLUEPRINT) {
            // Per-tenant area lookup. Areas can also be branch-scoped, so
            // we accept either a tenant-level area (branch:null) or any
            // branch's area with this name. Picks the tenant-level one
            // first so seeds are deterministic.
            const area = await Area.findOne({
                restaurant: tenant._id,
                name: blueprint.area,
                isActive: true,
            }).sort({ branch: 1 });

            if (!area) {
                console.warn(`  ⚠ Area "${blueprint.area}" not found for this tenant — skipping`);
                missingAreas.push(blueprint.area);
                continue;
            }

            const tablesForArea = blueprint.capacities.map((cap, idx) => ({
                name: `${blueprint.prefix}-${String(idx + 1).padStart(2, '0')}`,
                capacity: cap,
            }));

            for (const t of tablesForArea) {
                // Idempotent: the (name, area) compound unique index would
                // throw 11000 on duplicates, so check first to keep the
                // log clean.
                const exists = await Table.findOne({
                    name: t.name,
                    area: area._id,
                    restaurant: tenant._id,
                });
                if (exists) {
                    totalSkipped++;
                    continue;
                }

                await Table.create({
                    name: t.name,
                    capacity: t.capacity,
                    area: area._id,
                    restaurant: tenant._id,
                    branch: area.branch || null,
                    qrToken: generateQrToken(),
                });
                totalCreated++;
            }

            console.log(`  ✔ ${blueprint.area}: 6 tables ensured (${blueprint.prefix}-01 … ${blueprint.prefix}-06)`);
        }

        console.log('');
        console.log(`Summary — created: ${totalCreated}, already existed: ${totalSkipped}`);
        if (missingAreas.length) {
            console.log(`Skipped (area not found): ${missingAreas.join(', ')}`);
        }

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err.message);
        try { await mongoose.disconnect(); } catch { /* noop */ }
        process.exit(1);
    }
};

seedAreaTables();
