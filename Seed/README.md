# Backend/Seed — seeders and maintenance tools

Run every script from the `Backend/` directory (`node Seed/<file>.js`); each
reads `MONGO_URL` from `Backend/.env`. Scripts that target one tenant pick it
with `TENANT_SLUG=<slug>`, otherwise the oldest restaurant.

One-off data migrations / backfills live in [`../migrations/`](../migrations/README.md).

## 1. Bootstrap (fresh database — run in this order)

| Script | Purpose |
|---|---|
| `seedSuperAdmin.js` | Creates the 4 subscription plans and the first super admin (`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`). |
| `seedDefaultTenant.js` | Creates/links a default restaurant tenant and backfills `restaurant` on untagged docs. Needs the plans above. |

## 2. Demo data for a tenant (`TENANT_SLUG` aware — read each header before running on real data)

| Script | Purpose |
|---|---|
| `seedFullBranches.js` | 5 sample Pune branches. |
| `seedCategories.js` / `seedFullCategories.js` | Base / full (24) menu categories. |
| `seedMenuItems.js` / `seedFullMenu.js` | Base menu / 5 items per category. |
| `seedNonVegMenu.js` | Non-veg items in the relevant categories. |
| `seedFullCakes.js` | 8 cake flavours. |
| `seedFullAddons.js` | Advance-booking add-ons. |
| `seedFullEventTypes.js`, `seedFullHalls.js`, `seedFullPackages.js`, `seedFullDecorationPackages.js` | Banquet / advance-booking catalog. |
| `seedFullInventoryAndRecipes.js` | Inventory items + recipes for every menu item. |
| `seedRecipes.js` | Links existing menu items to recipes. |
| `seedOffers.js` | Coupons + promotions. |
| `seedAreaTables.js` | 6 tables per standard seating area. |
| `seedBlog.js` | Marketing blog posts (platform-wide). |

## 3. Tenant-specific (hard-coded tenant — review before running)

| Script | Purpose |
|---|---|
| `seedTipTopBonusCampaigns.js` | Bonus-points campaigns for `hotel-tip-top`. |
| `seedTipTopLegalAndTax.js` | Licences + tax config for `hotel-tip-top`. |
| `reseedMenu.js` | **Destructive**: deletes and reseeds menu + orders for `the-coffee-house` (`--dry` to preview). |

## 4. Maintenance tools (safe to re-run)

| Script | Purpose |
|---|---|
| `healCategoryImages.js` | Manual run of the scheduled category-image healer (`npm run heal:category-images`). |
| `healMenuImages.js` | Manual run of the scheduled menu/combo image healer (`npm run heal:menu-images`). |
| `applyMenuImages.js` | Refresh menu/combo photos from the curated pool (`--force`, `--dry`). |
| `fetchMenuImagesGoogle.js` | Fetch dish photos via Google Custom Search (`GOOGLE_CSE_ID`/`GOOGLE_CSE_KEY`). |

## 5. Diagnostics (read-only)

| Script | Purpose |
|---|---|
| `checkInventoryDeductions.js` | Reports orders vs. inventory deductions for a tenant. |
| `inspectMenuItem.js <id>` | Shows how the server resolves one menu item's price. |
| `listBranches.js` | Prints every branch id / name / tenant. |
| `listMenuWithRecipes.js` | Lists menu items by category with recipe links. |

## 6. Legacy (pre multi-tenant) — do not run

These predate tenant scoping: they write documents without a `restaurant`
link (some `deleteMany({})` whole collections) and several require
`./models/...`, which does not resolve from this folder. They are kept only
for reference and can be deleted.

`seedBookingData.js`, `seedBookings.js`, `seedBranches.js`, `seedChef.js`,
`seedCombos.js`, `seedEventTypes.js`, `seedHall.js`, `seedInventory.js`,
`seedNotifications.js`, `seedOrders.js`, `seedPromotions.js`,
`seedRequests.js`, `seedTipTransactions.js`, `seedWaiter.js`,
`seed_addons.js`, `seed_cakes.js`, `seed_decorations.js`
