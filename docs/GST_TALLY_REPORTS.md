# GST data, Tally export, scheduled reports (plan 3B.1, 3B.3-Tally, 3B.7)

**Export aid only.** None of this is a GST return or a tax filing tool, and
every output says so. The numbers are what each bill stored when it was
raised. A CA must check them before anything is filed. E-invoice (IRN) is out
of scope (needs the owner's CA).

## What exists

| Piece | Where |
| --- | --- |
| HSN on items / categories | `MenuItem.hsnCode`, `Category.hsnCode` (optional, 8 chars max), both in the body allowlists (`utils/bodyAllowlist.js`). Admin menu item form has an optional "HSN/SAC code" input. |
| Tenant default HSN/SAC | `Settings.taxExport.defaultHsn` (default `996331`, restaurant service). Edited on the Tax Reports page. |
| GST maths split | `utils/gstReport.js` (pure, integer paise) |
| Tally XML | `utils/tallyExport.js` (pure) |
| Tender helper | `utils/orderTenders.js` (`payments[]` first, else legacy `paymentMethod` + `amountPaid`) |
| Timezone day ranges | `utils/reportDates.js` |
| DB loading | `services/gstReportService.js` |
| Schedules | `models/reportSchedule.js`, `services/reportScheduleService.js`, `controllers/reportScheduleController.js` |
| Routes | `routes/reportsRoute.js`, mounted at `/api/reports` (one line in `app.js`) |
| Job | `reportScheduleService.register()` (one line in `server.js`), job name `report-schedules`, every 15 min, cluster-locked via `utils/scheduler` + `utils/jobLock` |
| Frontend | `Pages/Admin/TaxReports.jsx`, route `/admin/reports/tax`, nav item "Tax Reports" |

All routes need login, admin or manager, and the `revenueAnalytics` plan
feature (same gate as analytics).

## Endpoints

- `GET /api/reports/gst/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&branch=&format=json|csv|xlsx`
  Range is inclusive, in the restaurant timezone, max 366 days, default this month.
  Branch follows `analyticsBranchFilter` (branch-pinned staff cannot widen it).
- `GET /api/reports/tally/export?from&to&branch` returns Tally Prime import XML (`X-Voucher-Count` header).
- `GET|PUT /api/reports/gst/config` default HSN, party mode (`cash` | `debtors`), ledger names.
  PUT needs the tenant Settings document to exist (409 `NO_SETTINGS` otherwise); it never creates one.
- `GET|POST /api/reports/schedules`, `PATCH|DELETE /api/reports/schedules/:id`.

## GST report maths

For each paid, non-cancelled, non-refunded bill (date = `paidAt`, else `createdAt`):

- taxable value = max(0, items subtotal incl. toppings - `couponDiscount`)
  (same base as `utils/billing.computeBill`, which is not changed or re-implemented)
- tax = `order.gst`, shown as CGST + SGST halves (odd paisa goes to SGST). IGST is 0 (no inter-state data).
- rate = `order.gstPercentage` (derived from tax / taxable for old bills that lack it)
- service charge, additional charges, delivery, tip, loyalty points are shown as separate columns.
  They are not part of taxable value because the bill maths does not tax them.
- Line allocation of taxable value and tax uses integer paise with the remainder spread, so lines sum exactly to the invoice.
- HSN resolution per line: item `hsnCode`, else category `hsnCode` (matched by the category name snapshot on the order line), else tenant default.
- Customer GSTIN is read from `order.customerGstin` or `order.gstin` if present and valid. Nothing stores it today, so the column is usually empty.
- Cancelled bills, fully refunded bills: listed separately, excluded from the tables. Partly refunded bills stay in the tables and are also listed (a credit note may be needed).
- Bill number: `utils/billNumber.formatBillNo`.

`selfCheck` in the JSON (and the top of the CSV / Excel):
HSN table and by-rate table must equal the invoice register for taxable value and tax (within 0.01), and each bill's parts
(taxable + tax + charges + tip - points) must equal its stored total. Older bills created before the tax breakdown was stored
may not add up. They are flagged (`reconciled: false`, listed in `selfCheck.unreconciledInvoices`) rather than hidden.

## Tally XML

`ENVELOPE / HEADER / BODY / IMPORTDATA / REQUESTDESC / REQUESTDATA / TALLYMESSAGE / VOUCHER`, one `Sales` voucher per paid bill.

- Credits: Sales (taxable), Output CGST, Output SGST, service charge, other charges, tips.
- Debits: one line per tender used (cash, UPI, card, wallet, online, other), loyalty points (wallet ledger), manual discount,
  and any remainder on the party ledger (`Cash` or `Sundry Debtors`).
- A Round Off line is added only for an old bill whose parts do not sum to its total, so every voucher balances.
- Voucher number = formatted bill number (else order id). All text is XML-escaped; control characters are dropped.
- Ledger names: defaults in `utils/tallyExport.DEFAULT_LEDGERS`, overridable per tenant in `Settings.taxExport.ledgers`.
  The ledgers must exist in Tally (or the accountant creates them) before importing.
- Only paid bills are exported; the tender split is capped at what the bill is worth.

## Scheduled reports

`ReportSchedule { restaurant, type (daily-sales | gst-summary), frequency (daily | weekly | monthly), hour, recipients[], enabled, lastRunAt, lastError, lastPeriodKey }`.

- Daily = yesterday; weekly = last Monday to Sunday (sent from Monday); monthly = last calendar month (sent from the 1st).
  Sent once the tenant-local hour has passed. A missed tick catches up on the next one (most recent period only).
- Idempotent: the job claims the period with an atomic conditional update on `lastPeriodKey`; only the winner emails.
  New, re-enabled and re-timed schedules start from the next boundary, so old periods are never replayed.
  If every recipient fails the claim is rolled back (retry next tick); if some succeeded it is kept (no duplicate mails) and `lastError` lists failures.
  With no mail transport configured nothing is sent, the period is kept and `lastError` says so.
- Caps: 10 schedules per restaurant, 5 recipients per schedule, recipients validated and lower-cased, 500 schedules processed per tick.
- The email carries a CSV attachment through `utils/email.sendEmail` (one mail per recipient).

## Environment flags

None added. Email uses the existing `EMAIL_*` / `SMTP_*` configuration. The feature is additive; nothing changes for tenants who do not open the new page.

## Not done / hand-offs

- HSN is not snapshotted onto order lines, so reports resolve it from the current menu / category (an item whose HSN is edited later reports under the new code).
  The receipt prints `HSN/SAC` in the tax block only when the order data carries `order.hsnCode` or `items[].hsnCode`; nothing sets those yet.
  Whoever owns order item creation can copy `MenuItem.hsnCode` onto the line to enable it.
- No category HSN input in the admin category form (the field and API support exist).
- IGST / inter-state supply, composition-scheme, cess, credit notes and e-invoice (IRN) are not handled.
- Service charge is reported as a non-taxed charge because the bill maths does not tax it. If the CA treats it as taxable, the bill maths (owned elsewhere) must change first.
- Consolidation of `utils/billing.js` and `services/orderBillMath.js` into a shared engine: `gstReport` only reads stored fields, so it is unaffected.
