# Inventory deduction reliability + stocktake (plan 2.4 / 3B.6)

## Deduction reliability
- `deductInventoryForOrder` claims the order atomically (`inventoryDeducted: true` via findOneAndUpdate with `$ne: true`) before touching stock -> never double-deducts. Restore-on-cancel keys off the same marker.
- `services/inventoryDeductionService.runDeductionWithRecovery` wraps it (used by `orderStatusService.runInventoryHooks`) and records the outcome in `InventoryDeductionJob` (one row per order, TTL 60d):
  - systemic failure (outer catch) and NO usage rows written -> claim released, job `pending` + backoff (30s x 2^n, cap 1h);
  - systemic failure but partial usage rows exist -> job `failed`, not retryable (retry would double-deduct), admin alert;
  - item-level errors (unit mismatch, missing item, shortage) -> job `failed`, not retryable (data problem);
  - attempts >= cap -> `failed` + `inventory:alert`.
- Worker: `utils/inventoryDeductionRetryJob.js` (scheduler + joblock, one line in server.js). Tenant context: runs with `runWithoutContext` like the other sweepers (function `inSystemContext`, one place to swap for runAsTenant); each job query carries its own `restaurant`.
- A cancel racing a successful retry triggers `restoreInventoryForOrder`.
- Other deduct call sites (orderCreateService, orderItemsService, orderHoldService, counter-only path, orderStatusService ~line 745) still call `deductInventoryForOrder` directly: they stay idempotent but are not job-backed yet (swap to `runDeductionWithRecovery`).

Env: `INVENTORY_DEDUCTION_RETRY_DISABLED`, `INVENTORY_DEDUCTION_RETRY_SECONDS` (60), `INVENTORY_DEDUCTION_MAX_ATTEMPTS` (6), `INVENTORY_DEDUCTION_BACKOFF_BASE_MS` (30000).

## Endpoints (mounted at /api/inventory by routes/stocktakeRoute.js, before inventoryRoute)
Gate: login + tenant + `inventory` feature; reads = admin/manager or `manageStock`; writes = admin/manager.
- `GET /reports/deduction-health?days=7&limit=100` -> counts, failed/pending jobs, preparing-or-later orders without the marker.
- `POST /reports/deduction-health/retry` `{jobId}` or `{orderId}` -> retry now (409 if a retry would double-deduct).
- `GET/POST /stocktakes`, `GET /stocktakes/:id`, `PUT /stocktakes/:id/counts`, `POST .../submit`, `POST .../apply`.

## Stocktake semantics
- create snapshots `expectedQty` for every item of the branch (optional `category`).
- counts only while `draft`; variance = counted - expected.
- apply (status `submitted`): per line, claim `appliedAt` atomically, then apply the VARIANCE relative to live stock (sales since the snapshot are kept), floor 0, history row `type: 'correction'` (quantity = resulting stock, like PATCH /:id/adjust). Failed line releases its claim (207, retry applies only the remainder). Second apply returns `alreadyApplied`.
- Frontend: Inventory page -> "Stocktake" tab (`StocktakeTab.jsx`).
