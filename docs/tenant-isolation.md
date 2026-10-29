# Tenant isolation (task 4.6)

Layers, from outermost to innermost:

1. `tenantFilter(req)` / `tenantId(req)` in controllers (the primary defence).
2. `utils/tenantScopePlugin.js` - Mongoose safety net. Inside a context that has a tenant it injects `restaurant` into find/update/delete/count/aggregate (and now `insertMany` / `bulkWrite`).
3. `utils/tenantSafe.js` - explicit context API and wrappers for the operations query middleware cannot scope.
4. `scripts/audit-tenant-scope.js` - static scanner (`npm run audit:tenant`, also runs as `pretest`).

## Context API (`utils/tenantSafe.js`)

The context is the existing `AsyncLocalStorage` in `utils/requestContext.js`.

| Call | Meaning |
| --- | --- |
| `runAsTenant(restaurantId, fn)` | Run `fn` for ONE tenant. The plugin scopes every query / aggregate / write inside it (including promises and timers it starts). Throws `TenantContextError` for an invalid id. |
| `runAsSystem(reason, fn)` | Deliberate cross-tenant work. No tenant is injected; `reason` is mandatory and is stored on the context (`systemReason`). Always accepted by the native `insertMany`/`bulkWrite` guard, even in strict mode. |
| `isSystemContext()` | True inside `runAsSystem`. |

Both replace any outer context (a `runAsSystem` inside a request drops that request's tenant; `runAsTenant` inside a system job switches to one tenant).

### Where they are already used

- `utils/scheduler.js`: every job registered through `scheduleJob` now runs inside `runAsSystem('job:<name>', fn)`. That covers dormancy scan, booking reminders, menu auto-restore, category/menu image healers, payment reconciliation, halted-subscription suspender, stale/empty/held order sweepers, scheduled-takeaway releaser, incentive reconcile, shift auto-close (and any job added later). Behaviour is unchanged: system context has no tenant, so the plugin stays a no-op for queries.
- `realtime/printAgentSocket.js`: `print:pending` and `print:ack` run in `runAsTenant(<agent restaurant>)`.
- `utils/socket.js`: the guest join lookup of an order by `orderId` (tenant not known yet) runs in `runAsSystem('socket-join-order-lookup')`.

### Pattern for new jobs

```js
const { runAsTenant, runAsSystem } = require('../utils/tenantSafe');

// scheduleJob already wraps the job in runAsSystem('job:<name>').
// Iterating tenants and doing per-tenant work: switch to the tenant.
async function runMyJob() {
    const tenants = await Restaurant.find({ isActive: true }).select('_id').lean(); // AUDIT-EXEMPT: platform-wide tenant list
    for (const t of tenants) {
        await runAsTenant(t._id, () => doTenantWork(t._id));
    }
}

// Scripts / one-off code outside scheduleJob:
await runAsSystem('backfill order counts', () => backfill());
```

Prefer `runAsTenant` for anything that reads or writes tenant data one tenant at a time: queries that forget a `restaurant` filter are then scoped instead of leaking.

## Wrappers

All take the restaurant explicitly. A missing `restaurant` is stamped / injected, a matching one is left alone, a DIFFERENT one throws `TenantMismatchError` (never silently rewritten).

```js
const {
  tenantBulkWrite, tenantInsertMany, tenantLookup, tenantUnionWith,
  tenantAggregate, tenantEstimatedCount,
} = require('../utils/tenantSafe');

await tenantInsertMany(Table, rows, tenantId(req), { ordered: false });
await tenantBulkWrite(MenuItem, ops, tenantId(req), { ordered: false });

Order.aggregate([
  { $match: { ...tf } },
  tenantLookup({ from: 'tables', localField: 'table', foreignField: '_id', as: 'tableDoc' }, tenantId(req)),
]);
```

- `tenantBulkWrite` supports insertOne / updateOne / updateMany / deleteOne / deleteMany / replaceOne. Filters are rebuilt (caller objects are not mutated); a filter whose `restaurant` is an operator object (e.g. `$in`) is ANDed with the tenant.
- `tenantLookup` rewrites `localField/foreignField` into the pipeline form (`let` + `$match: { restaurant }` + `$expr $in` join) so the foreign side is tenant-matched inside the sub-pipeline. Notes: the `$expr` join does not use an index on `foreignField` the way the classic form can, and `foreignField` must not itself be an array. For a pipeline-form lookup it prepends `{ $match: { restaurant } }` (or verifies an existing one). Only use it when the foreign collection is tenant-owned; for global collections (users, plans) use a plain `$lookup` with `// AUDIT-EXEMPT: <reason>`.
- `tenantAggregate(Model, pipeline, rid)` guarantees the leading tenant `$match`; it does not rewrite `$lookup` stages inside the pipeline (build those with `tenantLookup`).
- `tenantEstimatedCount` is `countDocuments({ restaurant })` because `estimatedDocumentCount` cannot filter.

## Native plugin guards for `insertMany` / `bulkWrite`

Registered by the plugin on every tenant-owned model (`pre('insertMany')`, `pre('bulkWrite')`). Behaviour:

| Situation | Default | `TENANT_STRICT_CONTEXT=true` |
| --- | --- | --- |
| Tenant context, doc/op has no restaurant | stamped / injected, `tenantScope.injected` warning | same |
| Tenant context, doc/op names another restaurant | `tenantScope.explicit-mismatch` warning, unchanged | throws `TenantMismatchError` |
| No tenant (no context, superadmin, public) and the write carries no restaurant | `tenantScope.no-tenant-context` warning | throws `TenantContextError` |
| `runAsSystem` context | allowed | allowed |
| Write already carries `restaurant` and no tenant context | allowed | allowed |

`TENANT_SCOPE_PLUGIN=warn|off` still applies (warn: log only, no stamping; off: disabled).

## Env flags

- `TENANT_STRICT_CONTEXT` - default OFF. Turn on in staging first; scripts and seeds that insert without a `restaurant` must then wrap in `runAsSystem(reason, ...)` or stamp the restaurant.
- `TENANT_SCOPE_PLUGIN` - existing: `enforce` (default) / `warn` / `off`.

## Audit scanner

```
cd Backend
node scripts/audit-tenant-scope.js            # full report, exit 1 on offenders
node scripts/audit-tenant-scope.js --quiet    # offenders only
node scripts/audit-tenant-scope.js --json     # machine-readable
npm run audit:tenant                          # same as the first line
```

Besides the existing query scan of `controllers/` and `services/`, it now scans `controllers/`, `services/` and `utils/` for raw `bulkWrite`, `insertMany`, `$lookup`, `$unionWith`, `$graphLookup` and `estimatedDocumentCount` (logic in `scripts/lib/rawOpScan.js`). Such an offender prints as:

```
  services/foo.js:42  RAW bulkWrite
     await Thing.bulkWrite(ops);
     fix: use tenantBulkWrite(Model, ops, restaurantId) from utils/tenantSafe
```

Fix it by using the wrapper, or, for a deliberately global model / already-scoped sub-pipeline, add `// AUDIT-EXEMPT: <reason>` on the same line or on the line above (up to two lines above for a multi-line stage). `utils/tenantSafe.js` and `utils/tenantScopePlugin.js` are skipped (they implement the wrappers); `EXEMPT_FILES` controllers are skipped as before. `scripts/`, `Seed/` and `migrations/` are not scanned (they run outside requests; staging-seed-heavy carries explicit exemptions for completeness).

## Known limits

- Query middleware still cannot see raw collection access (`Model.collection.*`) or `$graphLookup`.
- `$lookup` inside `$facet` / nested sub-pipelines is not auto-detected for rewriting; the scanner flags the `$lookup` token wherever it appears.
- `runAsTenant` does not validate that the tenant exists, only that the id is well formed.
