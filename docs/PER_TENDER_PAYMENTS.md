# Per-tender payments (Plan task 2.3)

An order can record what was collected as separate lines (cash + UPI at the counter).

## Data
- `Order.payments[]`: `{ method: cash|upi|card|wallet|razorpay|other, amount, reference, receivedBy, at, source }`. `source` is `counter`, `wallet`, `razorpay` or `legacy`.
- `paymentMethod`, `amountPaid`, `paymentStatus` stay as the derived summary, written on every change. `paymentMethod` is `mixed` when more than one method is involved. Readers and totals are unchanged.
- No backfill. `utils/tenders.getTenders(order)` returns `payments[]`, or synthesises lines from `paymentMethod` / `amountPaid` / `walletAmountPaid`. Money present in `amountPaid` but missing from `payments[]` shows up as one `legacy` line, so the sum always equals `amountPaid`.
- Helpers: `getTenders`, `sumTenders`, `totalsByMethod`, `summarizeTenders(order|lines, { due })`, `parseCounterTenders`.

## API
`PATCH /orders/:id/status` accepts `payments: [{ method, amount, reference? }]` (max 10 lines).
- Captain / admin / manager only (403 `BILLING_CAPTAIN_ONLY` otherwise, so the waiter billing-field gate cannot be bypassed by sending only `payments`). Requires an Idempotency-Key like other settles (`settlesPaymentViaStatus`).
- Staff may enter `cash | upi | card | other`. `wallet` / `razorpay` lines are only appended by the server flows that move that money (400 `INVALID_PAYMENT_METHOD`).
- amount due = total - manualDiscount - amountPaid already recorded (+ a raised `tipAmount`, + the table's other unpaid dine-in rounds, which a dine-in settle clears too).
- Status is derived: lines cover due (INR 1 tolerance, as before) -> `Paid`; otherwise `Partially Paid` (table stays occupied: release only runs on Paid/Refunded). `paymentStatus: 'Paid'` in the body with short lines -> 400 `AMOUNT_TOO_LOW`. Any other body status -> 400 `INVALID_PAYMENT_STATUS`.
- Overpayment is change and only cash can give it: excess beyond the cash lines -> 400 `OVERPAYMENT_NOT_CASH`. `payment.cashReceived` / `changeDue` are filled from the cash lines.
- Persisted: full `payments[]` (earlier lines kept, legacy partials materialised), cumulative `amountPaid`, `paymentMethod` summary. The write is pinned to the `amountPaid` read, so a concurrent payment gives 409 rather than a lost line.
- Requests without `payments` take the old code path unchanged.

`PATCH /orders/:id/payment` (customer, optionalAuth) is intent-only by design (Bug #5) and never records money, so it does not take `payments`.

## Server flows that append a line
- `walletController.payWithWallet`: `$push` a `wallet` line in the same conditional claim.
- `razorpayController.markOrderPaidAtomically` (verify, webhook, reconciliation): `$push` a `razorpay` line (reference = payment id) with the Paid claim.
- `orderPaymentService` has no money movement (it does ledger / intent), so nothing is appended there.
- Not appended (left as legacy): sibling rounds settled with `amountPaid 0`, refunds.

## Receipt
`utils/receiptRenderer.renderBill` lists one line per tender under "Paid" when `payments[]` has more than one entry.

## Frontend
- `utils/tenderLines.js` + `Pages/Admin/components/SplitTenderEditor.jsx`; "Split payment" toggle in the TablesDashboard settle view and the OrderDetailsModal takeaway payment tab. Single method stays the default.
- `orderPayKey` fingerprint includes the payments.

## Env flags
None. The feature is additive: nothing changes unless a client sends `payments`.

## Tests
`Backend/__tests__/tenders.test.js`; Frontend `utils/tenderLines.test.js`, `OrderDetailsModal.split.test.jsx`, `TablesDashboard.split.test.jsx`.
