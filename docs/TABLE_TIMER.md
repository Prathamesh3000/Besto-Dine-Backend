# Table timer

How long has each table been occupied? Admin, manager and captain see a timer per table.
The server stores ONE timestamp (`startedAt`); nothing ticks on the server. Clients compute
`elapsed = (Date.now() - clientClockOffset) - startedAt`, where the offset comes from `serverTime`
(`offset = Date.now() - Date.parse(serverTime)` at fetch time), so a wrong device clock does not matter.

## When it starts / stops

* Starts at the FIRST CONFIRMED order of a sitting: dine-in, has a table, at least one item, status not
  `awaiting-payment` and not `cancelled`. A bare QR scan (table `occupied`, no order), an empty staff-opened
  order and a held pay-first order do NOT start it. `releaseHeldOrder` does (startedAt = release time).
* A second order never resets it (atomic update filtered on `sessionStartedAt: null`; at most one open
  `TableSession` per table via a partial unique index).
* Stops when the table is released (`utils/tableMerge.freeTableOrUnmergeGroup`): payment (`paid`, even while
  food is cooking, same rule as table status), manual free / reset to free / disable (`freed`), force-free of an
  unpaid bill (`forced`). Cancelling the first of two orders keeps it running; when no non-cancelled order with
  items remains the timer is cleared (`cleared`, duration 0).
* Move table: `startedAt` and the session travel with the party unchanged (same transaction).
* Merge groups: each member reports the EARLIEST `sessionStartedAt` of the group (computed at read time);
  freeing the group closes the session(s) once.

## Data

`TableSession` (`models/tableSession.js`): `{restaurant, branch, table, startedAt, endedAt, durationMinutes
(Math.round(minutes)), endReason: paid|freed|forced|cleared, firstOrder, orderCount, createdAt}`.
`Table.sessionStartedAt` (Date|null) and `Table.tableSession` are `select:false` and stripped from `toJSON`;
only staff list endpoints select them, and only for admin/manager/captain.

## API

For roles admin, manager, captain (absent for every other role and for customers):

* `GET /tables`: `tables[].sessionStartedAt` (ISO | null), top level `serverTime` (ISO), `tableTimer {amberMinutes, redMinutes}`.
* `GET /captain/floor-overview`: same fields (`tables[].sessionStartedAt`, `serverTime`, `tableTimer`).
* `GET /admin/bootstrap` (tables section): `data.tables[].sessionStartedAt`; `serverTime` and `tableTimer` at the
  top level (and `data.settings.tableTimer` when the settings section is requested).
* Settings: `GET /settings` returns `tableTimer {amberMinutes: 60, redMinutes: 90}` (defaults when unset; not in
  public/customer settings). Write with `PATCH /settings/tableTimer` or `PUT /settings {tableTimer}` (admin/manager).
  Ints 1..1440 and red > amber, otherwise 400 `{success:false, message, errors:{tableTimer}}`. Inherited from the
  main branch like taxes (sub-branch PATCH is 403 `INHERITED_FROM_MAIN`).

## Realtime (admin, manager, captain rooms of the table's branch only)

* `table:timer-started` `{tableId, startedAt, at, restaurant}`
* `table:timer-stopped` `{tableId, endedAt, durationMinutes, endReason, cleared?: true, at, restaurant}`
  (one event per freed table id of a group; `cleared:true` when the timer was cleared with no order left).

`restaurant` is routing metadata and can be ignored. `table:updated` is still emitted as before.

## Mobile apps

Read `sessionStartedAt` + `serverTime` + `tableTimer` from the floor endpoints, keep `offset = now - serverTime`,
render `elapsed` locally and colour amber at `amberMinutes`, red at `redMinutes`. Update on the two events
(refetch on `table:updated` as today).

## Report query

```js
// Average and max occupied minutes per branch, last 30 days
TableSession.aggregate([
  { $match: { restaurant, endedAt: { $ne: null }, endReason: { $ne: 'cleared' },
              startedAt: { $gte: new Date(Date.now() - 30 * 864e5) } } },
  { $group: { _id: '$branch', avg: { $avg: '$durationMinutes' }, max: { $max: '$durationMinutes' }, sittings: { $sum: 1 } } },
]);
```

## Backfill

`node migrations/backfillTableTimers.js` (dry run) / `--apply`; optional `TENANT_SLUG`. Gives tables that are
occupied with open confirmed orders a timer (earliest such order's `createdAt`). Idempotent.
