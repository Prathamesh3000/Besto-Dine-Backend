/**
 * Tenant data export (Phase 7.1 — GDPR compliance; v2 structured bundle).
 *
 * Gives a tenant owner the ability to download ALL of their restaurant's
 * data as a single structured .zip bundle. The bundle contains BOTH a
 * lossless JSON copy and a human-readable Excel workbook:
 *
 *   <slug>-data-export-<date>.zip
 *   ├── manifest.json                  ← metadata + per-collection counts
 *   ├── README.txt                     ← what's inside + how to read it
 *   ├── <slug>-data-export.xlsx        ← one sheet per collection (tabular)
 *   └── json/
 *        ├── restaurant.json
 *        ├── orders.json
 *        ├── menuitems.json
 *        ├── recipes.json
 *        └── … one file per collection
 *
 * EVERY tenant-scoped collection is included automatically. Instead of a
 * hand-maintained list of models (which silently drifted out of date and
 * shipped only ~16 of ~40 collections), we discover collections
 * DYNAMICALLY: any Mongoose model whose schema carries a `restaurant`
 * path is the tenant's own data and gets exported. Platform-global models
 * (lead, marketingSetting, blogPost, auditLog, otp, subscriptionPlan)
 * have no `restaurant` path and are therefore never included — the same
 * rule the tenant-isolation audit uses. New tenant-scoped models are
 * picked up for free; nothing to wire here when you add one.
 *
 * Auth: protect + adminExclusive (owner-only — GDPR data portability is an
 * ownership right, not a delegated staff capability). Tenant id is forced
 * from req.restaurant — never from the URL or body, so no cross-tenant
 * data can leak.
 *
 * The whole bundle is built in memory and streamed with
 * Content-Disposition: attachment. Payload per tenant is bounded (typical:
 * < 10 MB zipped even for busy restaurants); each collection is capped at
 * 50k rows. If a tenant grows past that we'd switch to NDJSON streaming.
 *
 * Rate-limited to 1 export per 5 minutes per tenant (the query fans out
 * across ~40 parallel collection reads).
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const Restaurant = require('../models/restaurant');
const logger = require('../utils/logger');

// Eagerly register every model so dynamic discovery below sees them all,
// regardless of which routes happen to have been required first.
const MODELS_DIR = path.join(__dirname, '..', 'models');
for (const file of fs.readdirSync(MODELS_DIR)) {
    if (!file.endsWith('.js')) continue;
    try { require(path.join(MODELS_DIR, file)); } catch (err) {
        logger.warn(`tenantExport: could not preload model ${file}: ${err.message}`);
    }
}

// Tenant-scoped models that we still DON'T want in an export:
//   IdempotencyRecord — technical request-dedup rows, not business data.
const DENYLIST = new Set(['IdempotencyRecord']);

// Per-collection row cap — protects memory on pathologically large tenants.
const PER_COLLECTION_LIMIT = 50000;

// Per-tenant cooldown — one export every 5 minutes. Stored on the
// Restaurant document (`lastExportAt`) so it holds across backend
// instances; claimed with an atomic findOneAndUpdate so two concurrent
// requests (on any instances) can't both win.
const COOLDOWN_MS = 5 * 60 * 1000;

function cooldownResponse(res, lastExportAt) {
    const last = lastExportAt ? new Date(lastExportAt).getTime() : 0;
    const retryAfterSec = Math.max(1, Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000));
    return res.status(429).json({
        success: false,
        code: 'EXPORT_COOLDOWN',
        message: `You can export again in ${retryAfterSec} seconds.`,
    });
}

/**
 * Every Mongoose model whose schema has a top-level `restaurant` path is,
 * by definition, tenant-scoped business data. Returns them minus the
 * denylist. The Restaurant model itself has no `restaurant` path and is
 * handled separately (the tenant's own profile document).
 */
function discoverTenantModels() {
    return mongoose.modelNames()
        .map((name) => mongoose.model(name))
        .filter((model) => model.schema.path('restaurant') && !DENYLIST.has(model.modelName));
}

/**
 * Read one collection's rows for this tenant. User is special-cased: only
 * staff roles, never the password hash. Everything else is a straight
 * tenant-scoped read, newest-first where the schema is timestamped.
 */
async function readCollection(model, tenantId) {
    let query;
    if (model.modelName === 'User') {
        query = model
            .find({ restaurant: tenantId, role: { $nin: ['customer', 'superadmin'] } })
            .select('-password');
    } else {
        query = model.find({ restaurant: tenantId });
    }
    if (model.schema.path('createdAt')) query = query.sort({ createdAt: -1 });
    return query.limit(PER_COLLECTION_LIMIT).lean();
}

// ── Excel cell coercion ──────────────────────────────────────────────────
// ExcelJS accepts string/number/boolean/Date directly. ObjectIds become
// their hex string; nested objects/arrays are JSON-stringified so no field
// is silently dropped (the JSON copy stays the lossless source of truth).
function toCell(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value;
    if (value instanceof mongoose.Types.ObjectId) return value.toString();
    if (Buffer.isBuffer(value)) return value.toString('base64');
    const t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'string') return value;
    if (t === 'object') {
        try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
}

// Excel sheet names: max 31 chars, no []:*?/\, must be unique.
function makeSheetName(base, used) {
    let name = String(base).replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'sheet';
    let candidate = name;
    let i = 2;
    while (used.has(candidate.toLowerCase())) {
        const suffix = `_${i++}`;
        candidate = name.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/**
 * Build the multi-sheet workbook (one worksheet per collection + a Summary
 * sheet) and return it as a Buffer ready to drop into the zip.
 */
async function buildWorkbook(collections, restaurantMeta) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BestoDine';
    workbook.created = restaurantMeta.exportedAt;

    const usedNames = new Set();

    // Summary sheet first.
    const summary = workbook.addWorksheet(makeSheetName('Summary', usedNames));
    summary.columns = [
        { header: 'Collection', key: 'collection', width: 28 },
        { header: 'Records', key: 'records', width: 12 },
    ];
    summary.getRow(1).font = { bold: true };
    summary.addRow({ collection: 'Restaurant', records: 'Exported: ' + restaurantMeta.name });
    collections.forEach((c) => summary.addRow({ collection: c.key, records: c.docs.length }));

    // One sheet per collection.
    for (const { key, docs } of collections) {
        const ws = workbook.addWorksheet(makeSheetName(key, usedNames));
        if (docs.length === 0) {
            ws.addRow(['(no records)']);
            continue;
        }
        // Union of keys across all rows — sparse fields aren't lost.
        const columns = [...new Set(docs.flatMap((d) => Object.keys(d)))];
        ws.columns = columns.map((k) => ({ header: k, key: k, width: 22 }));
        ws.getRow(1).font = { bold: true };
        for (const doc of docs) {
            const row = {};
            for (const k of columns) row[k] = toCell(doc[k]);
            ws.addRow(row);
        }
    }

    return workbook.xlsx.writeBuffer();
}

/**
 * GET /api/v1/tenant/export
 *
 * Streams the full tenant data bundle as a .zip attachment.
 */
exports.exportTenantData = async (req, res) => {
    try {
        if (!req.restaurant) {
            return res.status(400).json({ success: false, message: 'No tenant context' });
        }
        const tenantId = req.restaurant._id;
        // ── Cooldown check (cheap pre-check; the atomic claim is below) ──
        const cd = await Restaurant.findById(tenantId).select('lastExportAt').lean();
        if (cd?.lastExportAt && Date.now() - new Date(cd.lastExportAt).getTime() < COOLDOWN_MS) {
            return cooldownResponse(res, cd.lastExportAt);
        }

        // ── Read everything (all reads scoped to this tenant) ──────
        // Done BEFORE any header is written so a failure here still
        // returns a clean JSON 500 rather than a half-streamed zip.
        const restaurant = await Restaurant.findById(tenantId).lean();
        const models = discoverTenantModels();
        const scopedCollections = await Promise.all(
            models.map(async (model) => ({
                key: model.collection.collectionName,
                docs: await readCollection(model, tenantId),
            })),
        );
        scopedCollections.sort((a, b) => a.key.localeCompare(b.key));

        // The tenant's own profile leads the bundle as its own collection.
        const collections = [
            { key: 'restaurant', docs: restaurant ? [restaurant] : [] },
            ...scopedCollections,
        ];

        const exportedAt = new Date();
        const stamp = exportedAt.toISOString().slice(0, 10);
        const slug = restaurant?.slug || 'export';

        const counts = {};
        let totalDocuments = 0;
        for (const { key, docs } of collections) {
            counts[key] = docs.length;
            totalDocuments += docs.length;
        }

        const manifest = {
            exportedAt: exportedAt.toISOString(),
            exportVersion: '2.0',
            format: 'zip (json + xlsx)',
            restaurant: restaurant
                ? { _id: restaurant._id, name: restaurant.name, slug: restaurant.slug }
                : null,
            totalCollections: collections.length,
            totalDocuments,
            counts,
            notes: [
                'Every collection here is scoped to your restaurant only — no other tenant data is included.',
                'json/*.json is the lossless source of truth; the .xlsx is a flattened, human-readable view.',
                'The "users" collection contains STAFF accounts only (no customers, no password hashes).',
            ],
        };

        // Build the Excel workbook in memory.
        const workbookBuffer = await buildWorkbook(
            collections,
            { exportedAt, name: restaurant?.name || slug },
        );

        const readme =
            `BestoDine — Restaurant Data Export\n` +
            `======================================\n\n` +
            `Restaurant : ${restaurant?.name || '(unknown)'} (${slug})\n` +
            `Exported   : ${exportedAt.toISOString()}\n` +
            `Version    : 2.0 (structured bundle)\n\n` +
            `Contents\n--------\n` +
            `  manifest.json              Metadata and per-collection record counts.\n` +
            `  ${slug}-data-export.xlsx   One worksheet per collection (tabular, human-readable).\n` +
            `  json/<collection>.json     One file per collection (lossless — keeps nested fields).\n\n` +
            `Collections (${collections.length}, ${totalDocuments} records total)\n` +
            collections.map((c) => `  - ${c.key}: ${c.docs.length}`).join('\n') + '\n\n' +
            `Notes\n-----\n` +
            `  * All data is scoped to your restaurant only. No other tenant's data is included.\n` +
            `  * "users" contains staff accounts only — no customers and no password hashes.\n` +
            `  * For migration or re-import, use the json/ files (the .xlsx flattens nested data).\n`;

        // ── Assemble the zip bundle ────────────────────────────────
        // Built fully in memory (payload is bounded), so any failure
        // still surfaces as a clean JSON 500 before headers are sent.
        const zip = new JSZip();
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        zip.file('README.txt', readme);
        zip.file(`${slug}-data-export.xlsx`, workbookBuffer);
        const jsonDir = zip.folder('json');
        for (const { key, docs } of collections) {
            jsonDir.file(`${key}.json`, JSON.stringify(docs, null, 2));
        }

        const zipBuffer = await zip.generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 },
        });

        // Commit the cooldown only once we have a complete bundle to send.
        // Atomic: only succeeds if no other export was committed within
        // the window (by this or any other instance).
        const now = new Date();
        const cutoff = new Date(now.getTime() - COOLDOWN_MS);
        const claimed = await Restaurant.findOneAndUpdate(
            { _id: tenantId, $or: [{ lastExportAt: { $lt: cutoff } }, { lastExportAt: null }] },
            { $set: { lastExportAt: now } },
            { projection: { _id: 1 } },
        ).lean();
        if (!claimed) {
            const cur = await Restaurant.findById(tenantId).select('lastExportAt').lean();
            return cooldownResponse(res, cur?.lastExportAt);
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${slug}-data-export-${stamp}.zip"`,
        );
        res.setHeader('Content-Length', zipBuffer.length);

        logger.info(
            `tenant data export (v2) for ${slug}: ${collections.length} collections, ${totalDocuments} records, ${zipBuffer.length} bytes`,
        );

        return res.status(200).send(zipBuffer);
    } catch (err) {
        logger.error('tenantExport.exportTenantData error: ' + err.message);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, message: 'Failed to export data' });
        }
        res.destroy();
    }
};
