#!/usr/bin/env node
/**
 * repair-cross-tenant-refs.js - find (and optionally clear) legacy references
 * that cross a tenant boundary: a document of tenant X whose ObjectId ref
 * field points at a document of tenant Y.
 *
 *   node scripts/repair-cross-tenant-refs.js            # DRY RUN (default): report only
 *   node scripts/repair-cross-tenant-refs.js --apply    # write the fixes
 *
 * Fix: a scalar ref is set to null; an array of refs has the foreign ids
 * $pulled. Idempotent (a second run finds nothing). Targets with a null
 * `restaurant` (customers / superadmins / shared rows) are never treated as
 * foreign. Only top-level and array-of-ObjectId ref paths of strict
 * tenant-owned models are examined (subdocument paths are not touched).
 *
 * Uses the raw driver collections, so the tenant plugin does not interfere.
 * Needs MONGO_URL like every other script - point it at the DB you mean to
 * repair (take a backup first). Exports repairCrossTenantRefs() for tests.
 */
'use strict';

const mongoose = require('mongoose');

function refPaths(model) {
    const out = [];
    model.schema.eachPath((p, st) => {
        if (p === '_id' || p === 'restaurant') return;
        const opts = st.options || {};
        if (st.instance === 'ObjectId' && typeof opts.ref === 'string') {
            out.push({ path: p, ref: opts.ref, array: false });
        } else if (st.instance === 'Array' && st.caster && st.caster.instance === 'ObjectId') {
            const ref = (st.caster.options && st.caster.options.ref)
                || (opts.type && opts.type[0] && opts.type[0].ref);
            if (typeof ref === 'string') out.push({ path: p, ref, array: true });
        }
    });
    return out;
}

/**
 * @param {{apply?:boolean, models?:string[], log?:Function, batch?:number}} opts
 * @returns {Promise<{apply:boolean, found:number, fixed:number, details:Array}>}
 */
async function repairCrossTenantRefs({ apply = false, models, log = () => {}, batch = 500 } = {}) {
    const names = (models && models.length ? models : mongoose.modelNames());
    const report = { apply, found: 0, fixed: 0, details: [] };
    for (const name of names) {
        const Model = mongoose.model(name);
        if (!Model.schema.options || Model.schema.options.tenantScopeMode !== 'strict') continue;
        for (const { path, ref, array } of refPaths(Model)) {
            let Target;
            try { Target = mongoose.model(ref); } catch (_) { continue; }
            if (!Target.schema.path('restaurant')) continue;
            const cursor = Model.collection.find(
                { restaurant: { $ne: null }, [path]: { $exists: true, $ne: null } },
                { projection: { restaurant: 1, [path]: 1 } },
            );
            let buf = [];
            const flush = async () => {
                if (!buf.length) return;
                const ids = [...new Set(buf.flatMap((d) => (array ? d[path] || [] : [d[path]])).map(String))]
                    .map((s) => new mongoose.Types.ObjectId(s));
                const owners = new Map();
                for await (const t of Target.collection.find({ _id: { $in: ids } }, { projection: { restaurant: 1 } })) {
                    owners.set(String(t._id), t.restaurant ? String(t.restaurant) : null);
                }
                for (const d of buf) {
                    const mine = String(d.restaurant);
                    const foreign = (array ? d[path] || [] : [d[path]])
                        .filter((id) => { const o = owners.get(String(id)); return o && o !== mine; });
                    if (!foreign.length) continue;
                    report.found += foreign.length;
                    report.details.push({ model: name, _id: String(d._id), path, restaurant: mine, foreign: foreign.map(String) });
                    log(`${apply ? 'FIX  ' : 'FOUND'} ${name}#${d._id}.${path} (tenant ${mine}) -> foreign ${foreign.map(String).join(',')}`);
                    if (apply) {
                        const upd = array ? { $pull: { [path]: { $in: foreign } } } : { $set: { [path]: null } };
                        const r = await Model.collection.updateOne({ _id: d._id }, upd);
                        if (r.modifiedCount) report.fixed += foreign.length;
                    }
                }
                buf = [];
            };
            for await (const d of cursor) { buf.push(d); if (buf.length >= batch) await flush(); }
            await flush();
        }
    }
    return report;
}

module.exports = { repairCrossTenantRefs };

if (require.main === module) {
    (async () => {
        const apply = process.argv.includes('--apply');
        if (!process.env.MONGO_URL) { console.error('MONGO_URL is required'); process.exit(1); }
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', 'models');
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.js')) { try { require(path.join(dir, f)); } catch (_) { /* skip */ } }
        }
        await mongoose.connect(process.env.MONGO_URL);
        console.log(apply ? 'APPLY mode: writing fixes' : 'DRY RUN (use --apply to write)');
        const r = await repairCrossTenantRefs({ apply, log: console.log });
        console.log(`cross-tenant refs found: ${r.found}${apply ? `, cleared: ${r.fixed}` : ''}`);
        await mongoose.disconnect();
    })().catch((e) => { console.error(e); process.exit(1); });
}
