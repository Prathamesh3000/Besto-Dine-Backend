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
- `tenantAggregate(Model, pipeline, rid)` guarantees the leading tenant `$match`; `$lookup` stages inside the pipeline are rewritten by the plugin when run in a tenant context, otherwise build them with `tenantLookup`.
- `tenantEstimatedCount` is `countDocuments({ restaurant })` because `estimatedDocumentCount` cannot filter.

## Query scoping rules (updated 2026-11)

Inside a tenant context (request with a tenant, or `runAsTenant`) the plugin **always** ANDs `restaurant: <tenant>` into find / count / distinct / update / delete / replace queries and aggregates. A filter that already pins exactly this tenant is left alone; anything else (another tenant, `$ne` / `$in` / `$exists`, `null`, `$or` / `$and` wrappers, an explicit aggregate `$match`) gets the tenant ANDed on top, so it can only ever match this tenant. A scalar mismatch is additionally logged (`tenantScope.explicit-mismatch`). `runAsSystem` and no-context code (boot, seeds, jobs, superadmin, public routes) are unchanged.

- **`$lookup` / `$unionWith` / `$graphLookup`** (also inside `$facet` and nested sub-pipelines) are rewritten automatically when the target collection belongs to a model registered in strict mode (schema has a `restaurant` path and the plugin). Global collections (`users`, `plans`, `restaurants`, anything unregistered) are left untouched. The rewrite reuses `scopeLookupSpec` (see the `tenantLookup` notes above: the classic `localField/foreignField` form becomes the `let` + `$expr` pipeline form).
- **Opt-out**: the `{ skipTenantScope: true }` query option is **no longer trusted** (it could arrive via user input, e.g. `Model.find(f, null, req.body)`). It is stripped and only honoured inside `runAsSystem`. Use `skipScope(query)` from `utils/tenantScopePlugin` (module-private WeakSet) or wrap the call in `runAsSystem(reason, fn)`.
- **`models/user.js`** registers the plugin in *nullable mode* (`{ allowNull: true }`): customers and superadmins have `restaurant = null`, so inside a tenant context `User` reads are limited to `restaurant in [tenant, null]` (other tenants' staff become invisible). Write hooks are not installed for it. Login / auth lookups run with no tenant context and are unaffected.
- **Production**: `TENANT_SCOPE_PLUGIN=off|warn` is ignored when `NODE_ENV=production` (an error is logged and the plugin enforces).

## Native plugin guards for `insertMany` / `bulkWrite` / `save`

Registered by the plugin on every strict tenant-owned model (`pre('insertMany')`, `pre('bulkWrite')`, `pre('save')`). Behaviour:

| Situation | Default |
| --- | --- |
| Tenant context, doc/op has no restaurant | stamped / injected, `tenantScope.injected` warning |
| Tenant context, doc/op/`save()`/`create()` names another restaurant | **rejected** with `TenantMismatchError` |
| No tenant (no context, superadmin, public) and the write carries no restaurant | `tenantScope.no-tenant-context` warning; throws `TenantContextError` when `TENANT_STRICT_CONTEXT=true`, or in `NODE_ENV=production` for models whose `restaurant` is required |
| `runAsSystem` context | allowed |
| Write already carries `restaurant` and no tenant context | allowed |

`TENANT_SCOPE_PLUGIN=warn` (non-production only) downgrades rejections to warnings and disables stamping; `off` disables the plugin.

## Caches without a tenant argument

`settingsCache.getSettings()` with no argument now resolves the tenant from the active context; with no tenant and outside `runAsSystem` it throws (it no longer runs an unscoped `findOne` under a shared `__legacy__` key). `listCache.get()` with no argument keys by the context tenant; the shared legacy key is only used when there is no tenant context at all (genuinely global lists such as public plans). `invalidateCache()` with no argument still clears everything.

## Socket emit routing

`resolveTenantSync` ranks: branch argument, then the **request / auth tenant**, then the payload hint (`restaurant` / `restaurantId` / `tenantId`), then order/table caches. A payload built from user input can no longer steer an emit to another tenant's rooms.

## Env flags

- `TENANT_STRICT_CONTEXT` - explicit opt-in (`true`) for tenant-less writes everywhere. Unset, it is OFF except in `NODE_ENV=production`, where required-restaurant models reject restaurant-less writes by default (`false` overrides). Scripts and seeds that insert without a `restaurant` must wrap in `runAsSystem(reason, ...)` or stamp the restaurant.
- `TENANT_SCOPE_PLUGIN` - `enforce` (default) / `warn` / `off` (the last two ignored in production).

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

## Build-time tenant capture and populate guard (2026-11)

- `tenantScopePlugin` wraps `Query.prototype` op methods (find, findOne, updateOne, ...) and `Aggregate#model(m)` once, stamping the tenant context in force when the query/aggregate is BUILT.
- At exec: built under A + executed under B throws `TenantMismatchError` (enforce mode; warn mode logs and scopes by the executing tenant); built under A + executed with no context is scoped by A; built with no context / system / tenantless request is scoped by the executing context as before; executing inside `runAsSystem` is never scoped.
- Populate with no tenant context (jobs, scripts, sockets; not `runAsSystem`): the parent query's populate options get a per-document `match` of `restaurant in [parent.restaurant, null]` when the target model is tenant-owned (nested populates included), so a legacy ref to another tenant's doc hydrates to null/empty. Inside a tenant context populate sub-queries were already scoped.
- Data repair: `node scripts/repair-cross-tenant-refs.js` (dry run) / `--apply` nulls (or `$pull`s from arrays) top-level ref fields that point at another tenant's document. Idempotent; take a backup and point `MONGO_URL` at the intended DB first.
- Tests: strictTenant_infra_context (build/exec matrix), strictTenant_schema_refs (populate), strictTenant_repair_refs (script, in-memory only).


## Known limits

- Query middleware cannot see raw collection access (`Model.collection.*`).
- ~~A Query built in A but awaited in B is scoped by B~~ - fixed 2026-11: see "Build-time tenant capture" below. Residual: a query built under a tenant and executed in `runWithoutContext` is scoped by the builder (not unscoped); use `runAsSystem` or `skipScope()` for deliberate cross-tenant reads.
- `$lookup` rewriting only covers collections whose model is registered with the plugin in strict mode.
- `runAsTenant` does not validate that the tenant exists, only that the id is well formed.
