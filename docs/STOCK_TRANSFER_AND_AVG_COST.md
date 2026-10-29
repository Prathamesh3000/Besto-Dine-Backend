# Inter-branch stock transfer and weighted-average costing (Phase 5)

## Transfers
Model `StockTransfer` (tenant plugin). Status: `draft` -> `in_transit` -> `received`; `draft`/`in_transit` -> `cancelled`.
Number `TRF-0001` per restaurant. Both branches must belong to the restaurant; items must live in the source branch
(legacy `branch: null` items count as the Main branch, like the rest of inventory).

Endpoints (`/api/inventory`, admin/manager, plan feature `inventory`, mounted before `inventoryRoute`):

| Method | Path | Notes |
|---|---|---|
| GET | `/transfers`, `/transfers/:id` | branch-pinned admins see only transfers touching their branch |
| POST | `/transfers` | `{fromBranch,toBranch,lines:[{item,qty}],note}` creates a draft; no stock moves |
| POST | `/transfers/:id/send` | refuses 400 `INSUFFICIENT_STOCK` (with `shortages`) and moves nothing; else deducts source with a `transfer_out` row |
| POST | `/transfers/:id/receive` | optional `{lines:[{lineId,receivedQty}]}`; default = full quantity; adds `transfer_in` at destination |
| POST | `/transfers/:id/cancel` | draft: no stock; in transit: stock returned to source (`transfer_in` row) |
| GET | `/reports/valuation` | see below |

Atomicity and idempotency: every stock effect is claimed on the transfer line first (`outAppliedAt`, `inAppliedAt`,
`returnedAt`, conditional update), then written with `Inventory.incStock` (atomic `$inc`; deductions are guarded by
`currentStock >= qty`). Repeat or parallel send/receive/cancel never moves stock twice (repeat returns `already: true`).
A send that loses a stock race part-way rolls back the lines it already took and returns 409. A receive whose
destination write fails releases its claim (retry is safe). A cancel and a receive on the same line are mutually exclusive.

Destination mapping: same name (case-insensitive) and unit in the destination branch; otherwise a new zero-stock item is
created (category, list cost, supplier copied; min stock 0, next `INV-nnn`). There is no SKU field on inventory items, so
SKU matching is not possible.

Partial receive: only the received quantity is added; `shortfallQty = sent - received` is stored on the line and in the
audit record. The shortfall is NOT refunded to the source (treated as lost in transit); the source keeps the deduction.

Permissions: a branch-pinned admin can create/send/cancel only from their own branch and receive only into their own branch.
Audit: one guarded `recordTenantAudit` per state change (`action: other`, `entityType: StockTransfer`).

## Weighted-average cost
`Inventory.avgCost` (null = unknown) and `avgCostUpdatedAt`. `services/inventoryCostService.js`:

`new = (oldQty*oldCost + inQty*inCost) / (oldQty + inQty)`, 4-decimal rounding, `oldQty` floored at 0.
- Empty shelf + costed receipt: `avgCost = inCost`.
- Missing / zero cost or zero quantity: unchanged.
- Existing stock with unknown cost + costed receipt: stays unknown (nothing is invented). Optional env
  `INVENTORY_AVGCOST_SEED_FROM_LIST_COST=true` (default off) seeds the old cost from `costPerUnit` in that case.
- usage / waste / correction / transfer_out never change it.
- Hooked (one guarded, never-throwing line) into the PO/GRN receive path using the PO line `rate`; transfer_in uses the
  source `avgCost` snapshot taken at send. The update is optimistic (applies only if `avgCost` is unchanged since read), so a
  rare concurrent receipt can leave the average one step stale rather than wrong.
- Manual restock through `PATCH /inventory/:id/adjust` carries no cost, so it does not change `avgCost` (the controller was
  not edited; it can call `recordReceiptCost` once a cost field is added to that request).

## Valuation report
`GET /api/inventory/reports/valuation[?branch=<id|all>]` returns `totals {value, unknownCostItems, unknownCostListValue, items}`,
`byItem`, `byCategory`, `byBranch`. Known-cost stock is valued at `avgCost`; unknown-cost items are flagged
(`unknownCost: true`), excluded from `value`, and their value at `costPerUnit` is reported separately.
The existing food-cost report is unchanged (it uses `costPerUnit`; switching it would change current numbers).

## Frontend
Inventory page, new "Transfers" tab (`TransfersTab.jsx`): list, new draft, send, receive (editable received quantity),
cancel, plus a Valuation sub-view. API wrappers in `src/utils/transferApi.js`.

## Env flags
`INVENTORY_AVGCOST_SEED_FROM_LIST_COST` (default off). No migrations; old items keep `avgCost: null`.

## Tests
`Backend/__tests__/stockTransfer.test.js`, `Frontend/src/Pages/Admin/components/TransfersTab.test.jsx`.
