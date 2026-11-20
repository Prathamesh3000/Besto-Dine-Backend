# Move table

Move a seated party - every open order of one table - to a free table, without
touching what the kitchen is cooking or what has been paid.

Code: `services/tableMoveService.js` (the move), `utils/tableMove.js` (pure
helpers + the scan-session lookup), `controllers/tableController.js#moveTable`
(thin), route `POST /api/v1/tables/move` (`routes/tableRoute.js`, registered
before every `/:id` route).
Tests: `__tests__/integration/tableMove.test.js`, `__tests__/tableMoveHelpers.test.js`.

## API

`POST /api/v1/tables/move` - roles: **captain, admin, manager** (waiter, chef,
customer, guest: 401/403). Tenant scoped; a branch-pinned caller may only touch
its own branch's tables. Refused with `400 TABLES_DISABLED` for token-number
restaurants (tables off).

Body: `{ "fromTableId": "<id>", "toTableId": "<id>", "preview": false }`.
The server finds the open orders itself; order ids are never accepted.

### Preview (`"preview": true`) - runs ALL validation, writes nothing

```json
{ "success": true,
  "preview": { "from": { "id": "...", "name": "T5" }, "to": { "id": "...", "name": "T9" },
               "orderCount": 2, "itemCount": 5, "total": 640.5 } }
```

### Move

```json
{ "success": true,
  "moved": { "fromTableId": "...", "toTableId": "...", "fromName": "T5", "toName": "T9",
             "orderIds": ["ORD-0042", "ORD-0043"], "orderCount": 2, "itemCount": 5, "total": 640.5 } }
```

`itemCount` = sum of item quantities; `total` = sum of `order.total`, 2 dp.

### Errors - `{ "success": false, "code": "...", "message": "..." }`

| HTTP | code | when |
|---|---|---|
| 400 | `VALIDATION` | missing / malformed ids, non-boolean `preview` |
| 400 | `MOVE_SAME_TABLE` | from == to |
| 400 | `TABLES_DISABLED` | token-number restaurant |
| 403 | `BRANCH_MISMATCH` | caller pinned to another branch, or the two tables are in different branches |
| 404 | `TABLE_NOT_FOUND` | unknown / deleted / other tenant's table |
| 409 | `SOURCE_NOT_OCCUPIED` | source not `occupied`/`alert`, inactive, or no open order |
| 409 | `DEST_NOT_FREE` (+ `destinationStatus`) | destination occupied / alert / has an activeOrder or open order |
| 409 | `DEST_RESERVED` / `DEST_DISABLED` | destination reserved / disabled or inactive |
| 409 | `TABLE_MERGED` ("Unmerge tables first") | source or destination is in a merge group |
| 409 | `BILL_FINAL` | any open order has `bill.status === 'final'` (reopen the bill first) |
| 409 | `PAYMENT_ATTACHED` | any open order is Paid / Partially Paid / Refunded or has `amountPaid > 0` |
| 409 | `MOVE_CONFLICT` | lost a race with another move (or one that just finished); nothing was changed |
| 500 | - | includes: the audit row could not be written (the move is rolled back) |

## What changes (and what never does)

Open = status `awaiting-payment | new | preparing | ready | served`. Held pay-first
orders move and **stay `awaiting-payment`**. Nothing else stores a held order's
table: pay links / Razorpay notes carry the order id, the sweeper and the
cashier lookups read `order.table` live, so they follow the move automatically.

* Orders: only `table` changes, plus an appended `tableMoves[]` entry
  `{ fromTable, fromTableName, toTable, toTableName, at, by, byName }`. Status,
  `paymentStatus`, items, `kotNo`, timestamps are untouched
  (`updatedAt` is bumped by Mongoose). `counterPaymentRequestedAt` stays on the order.
* Destination table: takes the source's `status` (`occupied`, or `alert` when it
  carries alerts), `activeOrder`, `seats` (appended to its own), `currentDiner`,
  `assignedWaiter` (when the source had one) and `alerts`, and records
  `movedSessions: [{ sessionId, fromTable, at }]`.
* Source table: freed (`free`, no activeOrder / seats / diner / waiter / alerts).
  **`sessionEpoch` is not stamped**, so the diners are not signed out.
* Pending / accepted service `Request`s (waiter call, bill, counter payment) of the
  source table are re-pointed to the destination so the cashier sees them there.
* Everything - including the `table.move` audit row - is one Mongo transaction.
  Conditional updates (`status: 'free'` on the destination, `occupied|alert` on the
  source, order filter on status/payment) make concurrent moves exclusive.
* `movedSessions` is wiped whenever the table is freed (`freeTableOrUnmergeGroup`).

## Audit

`TenantAudit` action `table.move`, `entityType: 'table'`, `entityId` = source table
id. `actor` = id/name/role; `before = { tableId, tableName }` (source);
`after = { tableId, tableName, orderIds, itemCount, total, at }` (destination).
Written inside the transaction (`recordTenantAuditInSession`, the one audit writer
that is allowed to throw).

## Realtime (after commit)

`EVENTS.TABLE_MOVED = 'table:moved'`.

Staff rooms (admin, manager, captain, waiter, kitchen of the branch):

```json
{ "fromTableId": "...", "toTableId": "...", "fromTableName": "T5", "toTableName": "T9",
  "orderIds": ["ORD-0042"], "itemCount": 5, "total": 640.5,
  "movedBy": { "id": "...", "name": "Asha" }, "at": "2026-11-19T10:15:00.000Z", "restaurant": "..." }
```

Also: `table:updated` for both tables (`{ tableId, status }`) and `order:updated` per
moved order (`{ orderId, _id, type, status, table, tableName, movedFrom, restaurant }`).

Diners' phones (the sockets in the old `table:<id>` room whose scan `sessionId` moved):

```json
{ "toTableId": "...", "toTableName": "T9", "scanToken": "<jwt>", "sessionId": "..." }
```

The token is a normal scan token for the **new** table with the **same sessionId**.
Those sockets are also moved to the `table:<new>` room, so a later `session:ended`
for the freed old table cannot sign them out.

## Phone sessions without the push (fallback)

A scan token is bound to a table. If the phone missed the push it still holds the
old table's token. The destination's `movedSessions` entry (sessionId + fromTable)
lets these paths treat the party as being at the new table, tenant-scoped and only
for that exact session:

* `POST /orders` (`orderCreateService.resolveMovedScanTable`) - the next order lands
  on the new table whether the body names the old or the new table.
* `POST /requests` (waiter / water / bill) - lands on the new table.
* `GET /orders/active/table/:id`, `/active-list/table/:id` for the guest.
* `tableSessionGuard` - freeing the old table later does not give the moved party
  `401 TABLE_SESSION_ENDED` (the destination's epoch is used instead).
* Socket connect - a reconnect with the old token joins the new table's room.

Anyone else holding an old-table token is unaffected: a different party's token for
the old table is refused on the new table (`SCAN_TOKEN_MISMATCH`) and a brand-new
party scanning the now-free old table gets a normal new session.

## Where staff / kitchen see it

Every order shape that already carries the table now carries
`movedFrom: { tableId, tableName, at } | null` (the latest move's from-side):
live orders, order detail, table order lists (`active-list`, `active`), the chef
list and completed drawer, the KOT reprint payload (`order:kot-reprint` and the HTTP
response). Printed KOTs get a `Moved from <name>` line; printed bills a
`Moved from <name>` row under the table row. Never-moved orders are unchanged.

## Calling it from a mobile app

```
POST /api/v1/tables/move      Authorization: Bearer <staff access token>
{ "fromTableId": "...", "toTableId": "...", "preview": true }   // confirm dialog: "Move 2 orders (5 items, 640.50) from T5 to T9?"
{ "fromTableId": "...", "toTableId": "..." }                    // then do it
```

Show `message` for any `success: false`; on `MOVE_CONFLICT` / `DEST_NOT_FREE`
refresh the floor and let the user pick again. Subscribe to `table:moved` and
`table:updated` to keep the floor view live. Customer apps handle `table:moved`
by storing the new `scanToken` and switching their table to `toTableId`.
