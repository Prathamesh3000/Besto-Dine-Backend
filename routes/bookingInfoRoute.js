const express = require('express');
const router = express.Router();
const bookingInfoController = require('../controllers/bookingInfoController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { featureGate, featureGateAny } = require('../middlewares/featureGate');
const { csvUpload } = require('../middlewares/csvUpload');

// Customer-facing booking resources fall into two buckets:
//
//   - SHARED (cakes, event types, addons, /resources combo) — used by
//     BOTH the table-booking flow and the hall-booking flow on the
//     customer side. Gating these behind `advanceBookingHall` alone
//     made them disappear for tenants on a Basic-plan that has only
//     `advanceBookingTable` enabled, which is what the customer "all
//     content not loading" report was about. Use `featureGateAny` so
//     either feature unlocks them.
//
//   - HALL-ONLY (decorations, packages) — only ever rendered on the
//     hall-booking flow, so keep the strict `advanceBookingHall` gate.
//
// Parking rates is NOT gated — it's looked up from settings and used
// even for simple table reservations in some flows.
const sharedGate = featureGateAny('advanceBookingTable', 'advanceBookingHall');
const hallGate   = featureGate('advanceBookingHall');

router.get('/resources',    sharedGate, bookingInfoController.getBookingResources);
router.get('/cakes',        sharedGate, bookingInfoController.getCakes);
router.get('/decorations',  hallGate,   bookingInfoController.getDecorations);
router.get('/packages',     hallGate,   bookingInfoController.getPackages);
router.get('/event-types',  sharedGate, bookingInfoController.getEventTypes);
router.get('/addons',       sharedGate, bookingInfoController.getAddons);
router.get('/parking',                  bookingInfoController.getParkingRates);

// --- Admin Only ---
// IMPORTANT — keep /event-types/template + /event-types/import (and the
// equivalent /packages routes) BEFORE the `/:id` patterns below so Express
// doesn't try to interpret "template" or "import" as an ObjectId. Same
// ordering rule as tableRoute / staffRoute.
router.get('/event-types/template',  protect, adminOnly, hallGate, bookingInfoController.downloadEventTypeTemplate);
router.post('/event-types/import',   protect, adminOnly, hallGate, csvUpload.single('file'), bookingInfoController.importEventTypesCsv);
router.post('/event-types',          protect, adminOnly, hallGate, bookingInfoController.createEventType);
router.put('/event-types/:id',       protect, adminOnly, hallGate, bookingInfoController.updateEventType);
router.delete('/event-types/:id',    protect, adminOnly, hallGate, bookingInfoController.deleteEventType);

router.get('/packages/template',  protect, adminOnly, hallGate, bookingInfoController.downloadPackageTemplate);
router.post('/packages/import',   protect, adminOnly, hallGate, csvUpload.single('file'), bookingInfoController.importPackagesCsv);
router.post('/packages',          protect, adminOnly, hallGate, bookingInfoController.createPackage);
router.put('/packages/:id',       protect, adminOnly, hallGate, bookingInfoController.updatePackage);
router.delete('/packages/:id',    protect, adminOnly, hallGate, bookingInfoController.deletePackage);

// Add-ons admin CRUD — gated by the SHARED feature set so a tenant on
// only `advanceBookingTable` can still curate add-ons used by their
// table-booking flow. The slug allowlist mirrors AddonDetailModal's
// switch — `/addons/slugs` exposes it so the Add Add-on form's
// dropdown can render the same options without duplication.
router.get('/addons/slugs',    protect, adminOnly, sharedGate, bookingInfoController.getAddonSlugs);
router.get('/addons/admin',    protect, adminOnly, sharedGate, bookingInfoController.getAdminAddons);
router.post('/addons',         protect, adminOnly, sharedGate, bookingInfoController.createAddon);
router.put('/addons/:id',      protect, adminOnly, sharedGate, bookingInfoController.updateAddon);
router.delete('/addons/:id',   protect, adminOnly, sharedGate, bookingInfoController.deleteAddon);

module.exports = router;
