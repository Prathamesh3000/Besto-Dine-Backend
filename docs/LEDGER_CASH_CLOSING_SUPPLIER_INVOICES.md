# Ledger-lite, daily cash closing, supplier invoices (Plan 3B.3 / 3B.5)

Additive, small-business scope. Nothing here edits an order, payment, refund or purchase flow; it only reads them.

## Endpoints (all `/api/v1`, admin or manager; supplier invoices also need the `inventory` module)

| Area | Endpoint |
|---|---|
| Ledger | `GET /ledger/accounts`, `POST /ledger/post-day {businessDate}` or `{from,to}` (max 31 days), `GET /ledger/trial-balance?from&to&branch`, `GET /ledger/accounts/:code/ledger`, `GET /ledger/pnl` |
| Expenses | `GET/POST /ledger/expenses`, `POST /ledger/expenses/:id/void {reason}` (new `Expense` model: the codebase had none) |
| Cash closing | `GET /cash-closings/preview?businessDate`, `POST /open`, `POST /close`, `GET /`, `GET /:id`, `PATCH /:id` |
| Supplier invoices | `POST/GET /supplier-invoices`, `GET /:id`, `POST /:id/payments`, `GET /reports/outstanding`, `GET /reports/three-way-match` |

## Ledger-lite
- `LedgerAccount` (default chart created lazily: Cash 1000, Bank/UPI/Online 1010, Card 1020, Inventory 1100, Input GST 1200, Accounts payable 2000, Wallet liability 2100, Output GST 2200, Equity 3000, Sales 4000, Purchases/COGS 5000, Operating expenses 5100).
- `LedgerEntry`: one debit-or-credit line; `key = refType:refId:account:dr|cr`, unique per tenant, so posting is idempotent. A batch (all lines of one source document) always balances; `assertBalanced` throws before anything is written.
- Post-day reads, for a business date in the restaurant time zone (`utils/businessDate.js`, default Asia/Kolkata, same fallback as `billWorkspace`):
  - order tenders via `utils/tenders.getTenders` (uses `order.payments[]` when present, else legacy `paymentMethod`/`amountPaid`). Dr cash/bank/card/wallet, Cr Sales + Output GST (GST share = `order.gst / order.total`).
  - `order.refunds[]`: Dr Sales + Output GST, Cr the order's dominant tender account.
  - expenses, supplier invoices (Dr Purchases + Input GST, Cr AP), supplier payments (Dr AP, Cr cash/bank), and legacy PO payments for POs that have no supplier invoice (Dr Purchases, Cr cash/bank).
- Posted lines are append-only. A source changed after posting is not re-posted; later corrections arrive as their own batch on their own day.
- Known limits: wallet top-ups are not posted (wallet liability shows redemptions only); tips and aggregator payouts are ignored; Inventory account exists but purchases are expensed, no stock-movement COGS.
- Job: `utils/ledgerPostJob.js` posts yesterday + today for every live tenant hourly, cluster-locked. **Off unless `LEDGER_AUTO_POST=true`.** The endpoint always works.

## Daily cash closing
- `CashClosing`, unique `(restaurant, branch, businessDate)` (branch null = tenant-level, reads the whole tenant).
- `expectedCash = openingCash + cash tenders - cash refunds - cash pay-outs` (cash expenses, cash supplier payments, cash legacy PO payments). `variance = counted - expected` (negative = short). Maths in `utils/cashMath.js`.
- `open` defaults opening cash to the previous closed day's count. `close` computes expected on the server, is conditional on `status: open` and the unique index, so a second close returns 409 `ALREADY_CLOSED`. Future dates are refused.
- A closed day is changed only by `PATCH` from the `admin` role (managers get 403), with a required `reason`; before/after plus reason, user and time are pushed to `edits[]`.

## Supplier invoices
- `SupplierInvoice` (unique `(restaurant, supplier, invoiceNo)`, optional PO link and billed `lines` for quantity matching), `SupplierPayment` (append-only).
- Payment: one conditional pipeline update (`amountPaid + amount <= total`) advances `amountPaid` and `status`; overpayment returns 400 `EXCEEDS_OUTSTANDING`. If the payment row cannot be written the reserved amount is rolled back.
- Aging buckets by days past due date: not due, 1-30, 31-60, 61-90, 90+.
- 3-way match per PO: received value from GRN lines x PO rate x tax vs the sum of invoices. Flags: `AMOUNT_MISMATCH` (beyond `tolerance`, default Rs 1), `INVOICED_NOT_RECEIVED`, `OVER_RECEIVED`, `SHORT_RECEIVED`, `INVOICED_QTY_EXCEEDS_RECEIVED`, `RECEIVED_NOT_FULLY_INVOICED`, `NO_INVOICE`. Status: `matched | mismatch | no-invoice | pending`.
- The existing `PurchaseOrder.payments[]` flow is untouched. Do not record the same money both there and as a supplier payment (cash closing and the ledger skip PO payments only when the PO has a supplier invoice).

## Frontend
Admin nav "Accounts" -> `/admin/accounts/{cash-closing,supplier-invoices,ledger}` (`Pages/Admin/CashClosing.jsx`, `SupplierInvoices.jsx`, `Ledger.jsx`; API wrappers in `utils/accountsApi.js`).

## Tests
`__tests__/ledgerPostings.test.js`, `cashClosing.test.js`, `supplierInvoices.test.js`; frontend `src/__tests__/Pages/Admin/Accounts.test.jsx`.
