# Tenant audit log (plan task 2.1)

Per-restaurant, append-only record of sensitive staff actions. Separate from
`AuditLog` (platform / super admin only).

## Model: `models/tenantAudit.js`
`restaurant` (required, tenant plugin), `branch?`, `actor {id,name,role}`,
`action`, `entityType`, `entityId`, `summary`, `before`, `after`, `ip`,
`createdAt`. Actions: order.cancel, order.void, order.discount,
order.price_edit, order.refund, bill.edit, bill.finalize, staff.create,
staff.deactivate, staff.role_change, staff.permission_change,
settings.change, menu.price_change, other.
Indexes: (restaurant, createdAt), (restaurant, action, createdAt),
(restaurant, actor.id, createdAt). TTL on `createdAt` from env
`AUDIT_RETENTION_DAYS` (default 730). Changing the env after the index exists
needs the TTL index to be updated (collMod) or recreated.

## Service: `services/tenantAuditService.js`
`recordTenantAudit(reqOrCtx, { action, entityType, entityId, summary, before, after })`
never throws and is detached from the request path; await it only in tests.
Snapshots are redacted (password, secret, token, api/agent key, UPI id, phone,
email, address, card, OTP, ...) and capped near 8KB (oversize becomes
`{_truncated:true, preview}`). Skips silently when there is no tenant.
`services/tenantAuditHooks.js` holds the one-line adapters used at call sites.

## Hook points (one guarded line each)
- orderStatusService: cancel (order.cancel, or order.void if the order was paid) and manualDiscount change (order.discount)
- orderLifecycleService.cancelOrder: customer cancel
- orderBillService: save draft (bill.edit), finalise (bill.finalize), reopen (bill.edit)
- razorpayController.refundPayment and refundRequestController.approveRefundRequest: order.refund
- staffController: add, status->inactive and delete (staff.deactivate), update (role / permission change)
- settingsController: PUT and PATCH /:section, changed keys only, secrets redacted
- menuController.updateMenuItem: price fields (basePrice, offer %, sizes, toppings)

## API (mounted at /api/v1/audit)
- `GET /audit` filters `from,to,action,actorId,entityType,entityId,page,limit` (limit max 100)
- `GET /audit/export` same filters, CSV, max 5000 rows, formula-injection safe
Visibility: admin sees everything; manager only rows where actor.id is
themselves (actorId filter is ignored); other roles 403.

## Frontend
`/admin/audit` (Pages/Admin/AuditLog.jsx), nav item "Audit Log" for admin and manager.

## Not covered / follow-ups
order.price_edit has no emitter yet (no per-item price edit path found);
branch-price overrides, coupon application and walk-in create-time discounts
are not hooked; branch-pinned admins see the whole tenant's log.
