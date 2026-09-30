# Backend/migrations — one-off data migrations, backfills and repairs

These scripts were written to move existing data forward after a schema or
behaviour change. Keep them for (a) upgrading an older database copy and
(b) history; most are idempotent, but read each header before running. A fresh
database seeded with `Seed/seedSuperAdmin.js` + `Seed/seedDefaultTenant.js`
does **not** need them.

Run from `Backend/`: `node migrations/<file>.js`. Most support `--dry`
(or `--dry-run`) — check each file's header comment first. **Take a
`mongodump` before running any of them against production.**

> Older comments in `models/*` and `controllers/*` still say
> `Seed/<name>.js` for these files — the scripts now live here.

| Script | Purpose |
|---|---|
| `addRestaurantField.js` | Codemod (edits `models/*.js`, not the DB) that added the `restaurant` field in Phase 1. Already applied — do not re-run. |
| `dropLegacyIndexes.js` | Drops global unique indexes replaced by per-tenant ones (Phase 1). |
| `fixGoogleIdIndex.js` | Unsets `googleId: null` on users and replaces the legacy unique+sparse `googleId_1` index with a unique partial one (`--dry`, `--sync`). Required once on databases created before the fix. |
| `dropOneActiveOrderIndex.js` | Drops the old `one_active_order_per_table` unique index on orders. |
| `migrateAddonIndex.js` | Replaces addon `{slug, restaurant}` index with `{slug, restaurant, branch}`. |
| `migrateCategoryIndex.js` | Replaces category `{name, restaurant}` index with `{name, restaurant, branch}`. |
| `migrateOrderPickupLocation.js` | Renames legacy `Order.branch` (string) to `Order.pickupLocation`. |
| `migrateLegacyBranchNulls.js` | Assigns `branch: null` operational records to the tenant's Main branch. |
| `migrateNullCatalogsToMain.js` | Re-stamps branch-null catalog records onto each tenant's Main branch. |
| `migrateUploadsToCloudinary.js` | Uploads `Backend/uploads/*` to Cloudinary and rewrites DB URLs (map saved to `uploads-migration-map.json`). |
| `backfillMainBranch.js` | Ensures every restaurant has a Main branch and links orphan data to it. |
| `backfillStaffToMainBranch.js` | Moves staff with `branch: null` onto their tenant's Main branch. |
| `backfillTenantOwner.js` | Sets `isTenantOwner` on each restaurant's owner user. |
| `backfillCouponBranch.js` | Assigns the Main branch to coupons with `branch: null`. |
| `backfillCouponRedemptions.js` | Rebuilds `CouponRedemption` rows so they match `Coupon.usageCount`. |
| `backfillMenuCustomisations.js` | Adds default sizes/toppings to older menu items. |
| `backfillMenuNutrition.js` | Adds nutrition info / health tags to older menu items. |
| `backfillOrderCounts.js` | Recomputes `MenuItem.orderCount` from existing orders. |
| `backfillPrepStation.js` | Infers `MenuItem.prepStation` (kitchen vs. counter) for existing items. |
| `backfillSubscriptionPrice.js` | Stamps the agreed `subscription.price` on existing tenants. |
| `applyPlanPricing2026.js` | Re-prices the standard plans to the 2026 tiers. |
| `syncRestaurantFromSettings.js` | Copies Settings.general (name, phone, email) onto the Restaurant doc. |
| `renameDefaultTenant.js` | Renames the legacy "Default Restaurant" tenant to "The Coffee House". |
| `renumberTenantStaff.js` | Gives each tenant its own `EMP-###` staff-id sequence. |
| `renumberStaffPerBranch.js` | Gives each branch its own `EMP-###` sequence. |
| `cleanCorruptedImageUrls.js` | Repairs corrupted image URLs on menu items, categories, combos (`--apply` to write). |
| `clearMenuAvailabilityWindow.js` | Clears start/end times so all items show 24x7. |
| `closeStaleTableRequests.js` | Closes open service requests (water / waiter / bill) on freed tables. |
| `freeStaleTables.js` | Frees tables stuck "occupied" with no active order. |
| `realignOrderBranchFromTable.js` | Sets each order's branch from its table's branch. |
| `moveBranchData.js` | Repair tool: moves records between two branch ids (`--from= --to= [--before=] [--dry]`; find ids with `node Seed/listBranches.js`). |
