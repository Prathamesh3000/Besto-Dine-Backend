# Simple payroll (Phase 5)

Attendance-based payroll runs with payout to the staff wallet, cash or bank.

**Scope: attendance + wallet payout only. This is NOT statutory payroll.** There is no PF, ESI, TDS, professional tax, gratuity, leave accrual or Form 16. Payslips say so. Do not market it as compliant payroll.

## Access
- Admin (owner or branch-pinned sub-admin) only: `protect, restrictTo('admin')`. Managers are excluded.
- Plan gate: reuses `tipManagement` (the staff wallet's key), because wallet payout depends on it. No new plan key or tier.
- A branch-pinned admin only sees/creates runs for their branch and only sees staff of that branch.
- Mount: `/api/v1/payroll` (one line in `app.js`).

## Files
- Models: `StaffPayProfile`, `PayrollRun`, `PayrollPayout` (all use the tenant plugin).
- Services: `services/payroll/payCalc.js` (pure maths), `attendanceSummary.js` (shift rules), `payrollService.js`.
- `controllers/payrollController.js`, `routes/payrollRoute.js`.
- Frontend: `Pages/Admin/Payroll.jsx`, `utils/payrollApi.js`, route `/admin/payroll`, nav item "Payroll".

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/payroll/profiles` | payable staff (waiter, captain, chef, manager) with their pay profile |
| PUT | `/payroll/profiles/:staffId` | upsert profile `{payType, baseRate, overtimeRate?, overtimeThresholdHours?, workingDaysPerMonth?, active?}` |
| GET | `/payroll/runs` | latest 100 runs (without lines) |
| POST | `/payroll/runs` | create + compute a draft `{periodStart, periodEnd, branch?, staffIds?}` |
| GET | `/payroll/runs/:id` | run with lines |
| PUT | `/payroll/runs/:id/adjustments` | draft only: `{adjustments:[{staff, advances, deductions, adjustmentNote}]}` |
| POST | `/payroll/runs/:id/finalize` | lock the numbers |
| POST | `/payroll/runs/:id/pay` | `{method: wallet|cash|bank, reference?}` |
| GET | `/payroll/runs/:id/export.csv` | CSV (formula-injection guarded) |
| GET | `/payroll/runs/:id/payslip/:staffId` | JSON, or `?format=html` printable page (all text escaped) |

## How attendance is computed
Periods are business dates (`YYYY-MM-DD`, inclusive, restaurant timezone from `Restaurant.timezone`, default Asia/Kolkata, via `utils/businessDate.js`). Max 31 days; `periodEnd` cannot be in the future.
- A shift belongs to the business date of its `clockIn`. A shift crossing midnight is credited wholly to the day it started.
- Only closed shifts count. `completed` counts. `missed` (auto-closed by `shiftAutoCloser`, hours capped at the sweep threshold, default 16h) counts at its capped hours and adds a warning for the admin to verify.
- An `active` (open) shift is not paid and adds a warning. Fix: force clock-out the shift, then create a new draft.
- Shift hours = `clockOut - clockIn`, else `totalHours`; clamped to 0..24.
- A day is present when its closed shifts total more than 0 hours. Overtime is per day: hours above `overtimeThresholdHours` (default 8).

## Pay rules
- hourly: base = regular hours x rate; overtime = OT hours x (`overtimeRate` or base rate).
- daily: base = days present x rate; overtime = OT hours x `overtimeRate` (0 if unset).
- monthly: `factor = periodDays / daysInMonth(periodStart)`; `expected = workingDaysPerMonth(26) x factor`; base = rate x factor x min(1, daysPresent / expected); overtime as daily. No leave or weekly-off tracking: set `workingDaysPerMonth` to match the staff member's real roster.
- Incentives: `IncentiveEntry` rows in state `confirmed` whose business `day` is in the period and whose ids are not in any finalized/paid run (ids are stored on the line). Finalize re-checks this.
- Tips paid out: sum of `TipSettlement` created in the period, informational only, never added to net.
- Advances / deductions: entered manually on a draft. Net = base + overtime + incentives - advances - deductions; a negative net is rejected.
- All money uses `round2`; amounts must be finite, 0..10,000,000 (rates: monthly 10,000,000, daily 1,000,000, hourly 100,000).

## Lifecycle and locking
`draft -> finalized -> paid`. Only drafts can be edited. Finalizing sets `locked: true`.
- Unique partial index `payroll_staff_period_once` on `{restaurant, lines.staff, periodStart, periodEnd}` where `locked: true`: the same staff + exact period cannot be in two finalized runs (also guarded against concurrent finalizes).
- The service additionally rejects any overlapping period for a staff member who is in another locked run (409 `PERIOD_OVERLAP`); draft creation skips such staff and reports them in `skipped`.

## Payout
- `cash` / `bank`: conditional update `finalized -> paid`, records method and reference. A repeat call with the same method returns `alreadyPaid: true`; a different method is 409.
- `wallet`: ONE mongo transaction (same session pattern as `staffWalletController`): per line, credit the `StaffWallet`, insert a unique `PayrollPayout` row (`run + staff`), write a `StaffWalletTransaction` (type `adjustment`, `referenceKind: AdminAdjustment`, `referenceId` = run id, note "Payroll <period>"), then flip the run to `paid` with a conditional update. Any failure aborts everything. A retry after success sees `paid` and credits nothing; a concurrent duplicate loses on the unique payout index or the conditional update (409 `ALREADY_PAID`).
- Wallet payout only works for waiter/captain (the roles that can own a wallet); the whole payout is refused (400 `WALLET_ROLE`) if any paid line belongs to another role, so use cash/bank for chefs and managers. A frozen wallet aborts with 409. Requires a Mongo replica set (transactions), like the existing wallet code.
- The wallet ledger enums were not changed (no edit to existing models), so payroll credits show as `adjustment` entries.

## Audit
`recordTenantAudit` (action `other`, entityType `PayrollRun`) is called once on finalize and once on a first (non-repeat) paid, wrapped in try/catch; it can never fail the request.

## Env flags
None.

## Known limits
No statutory deductions, leave, weekly off, holiday pay, rounding of paise to rupees, undo of a finalized/paid run (reverse manually via wallet adjustment), or per-branch timezone (restaurant timezone is used).
