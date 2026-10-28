const Settings = require('../models/settings');
const Branch = require('../models/branch');
const Restaurant = require('../models/restaurant');
const MenuItem = require('../models/menuItem');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { invalidateCache } = require('../utils/settingsCache');
const { getIO, emitToStaff } = require('../utils/socket');

const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { getMainBranchId, isSubBranchCaller } = require('../utils/mainBranch');
const EVENTS = require('../realtime/events');
const logger = require('../utils/logger');
const { normalizeVpa, normalizePayeeName, maskVpa } = require('../utils/upiQr');

// Broadcast `settings:updated` to every staff dashboard at the caller's
// branch so headers (admin / waiter / chef) can refetch and swap the
// logo / cafe name live, instead of going stale until the next page
// reload. Keep the payload tiny — consumers call getSettings() to fetch
// the full document fresh (the cache was just invalidated).
function broadcastSettingsUpdated(req, section = 'general') {
    try {
        const io = getIO();
        const branchId = pinnedBranchId(req) || null;
        emitToStaff(io, branchId, EVENTS.SETTINGS_UPDATED, {
            section,
            restaurant: String(tenantId(req) || ''),
            branch: branchId ? String(branchId) : null,
            at: Date.now(),
        });
    } catch { /* socket not critical — a missed broadcast just means
                   the header waits until its next natural refetch. */ }
}

// Sections that sub-branches INHERIT from the main branch's Settings
// doc. Sub-branches see the main branch's values on GET and cannot
// edit them (writes return 403). The tenant owner / main-branch admin
// remains the single source of truth for these.
//
// `general` and `branches` stay per-branch so each location keeps its
// own address, contact, and cafe name.
const INHERITED_SECTIONS = ['taxes', 'reservation', 'wallet', 'notifications', 'operatingHours', 'delivery'];

const EMAIL_REGEX   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_REGEX = /^[0-9]{6}$/;
const FSSAI_REGEX   = /^[0-9]{14}$/;
const GSTIN_REGEX   = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX     = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

// Joins the structured address parts into a single human-readable
// string — kept in `general.address` for legacy readers (receipts,
// landing pages) that still expect one string.
function formatAddressLine(addr = {}) {
  return [addr.line1, addr.line2, addr.city, addr.state, addr.pincode, addr.country]
    .map(s => (s || '').trim())
    .filter(Boolean)
    .join(', ');
}

// Keep the Restaurant doc (Super Admin's source of truth for tenant
// profile) in sync when the tenant owner edits their Cafe Information.
// Only runs at the tenant-level scope — branch-pinned edits belong to
// the Branch doc and are handled by the branch CRUD flow.
//
// Slug is intentionally NOT regenerated here: it's referenced by
// customer URLs, QR tokens, and the X-Restaurant-Slug header.
//
// Tenant === Main contract: the tenant doc and the Main branch (slug='main')
// represent the same physical location to the customer. Whenever the
// tenant's display name / phone / email change here, the Main branch
// mirrors them so the customer-facing branch picker, receipts, and
// branch-aware UI surfaces stay aligned. Sub-branches are independent
// and unaffected.
async function syncRestaurantFromGeneral(req, general) {
  if (pinnedBranchId(req)) return;
  const tId = tenantId(req);
  if (!tId || !general || typeof general !== 'object') return;

  const update = {};
  if (typeof general.cafeName === 'string' && general.cafeName.trim()) {
    update.name = general.cafeName.trim();
  }
  if (typeof general.contactNumber === 'string') {
    update.contactPhone = general.contactNumber.trim();
  }
  if (typeof general.email === 'string' && general.email.trim()) {
    const clean = general.email.trim().toLowerCase();
    if (EMAIL_REGEX.test(clean)) update.contactEmail = clean;
  }

  // Mirror structured address into Restaurant.address. Only set the
  // field when the caller actually sent an addressDetails object, so
  // a save of just the cafe name doesn't clobber existing address.
  if (general.addressDetails && typeof general.addressDetails === 'object') {
    const ad = general.addressDetails;
    update.address = {
      line1:   (ad.line1   || '').trim(),
      line2:   (ad.line2   || '').trim(),
      state:   (ad.state   || '').trim(),
      pincode: (ad.pincode || '').trim(),
      country: (ad.country || 'India').trim(),
    };
    // city is denormalised onto Restaurant.city (separate top-level
    // field used by list filters) — keep it in sync.
    if (typeof ad.city === 'string') update.city = ad.city.trim();
  }

  // Mirror regulatory / tax identifiers. Same "only if present" rule.
  if (general.legal && typeof general.legal === 'object') {
    const l = general.legal;
    update.legal = {
      legalBusinessName: (l.legalBusinessName || '').trim(),
      fssaiLicense:      (l.fssaiLicense      || '').trim(),
      gstin:             (l.gstin             || '').trim().toUpperCase(),
      pan:               (l.pan               || '').trim().toUpperCase(),
    };
  }

  if (typeof general.timezone === 'string' && general.timezone.trim()) {
    update.timezone = general.timezone.trim();
  }

  if (Object.keys(update).length === 0) return;

  // R-10: use updateOne with an explicit _id filter rather than a bare
  // findByIdAndUpdate. `tId` here comes from tenantId(req), which is
  // derived from the authenticated user's JWT — so today there IS no
  // cross-tenant vector. The rewrite is defensive / declarative: the
  // filter `{_id: tId}` reads unambiguously as "update THIS tenant,
  // nothing else", which prevents a future refactor that swaps tId
  // for a client-controlled value from silently becoming exploitable.
  await Restaurant.updateOne({ _id: tId }, { $set: update });

  // Mirror the same fields onto the Main branch so it stays the
  // canonical representation of the tenant in the branch list.
  // Settings.general.address is a single free-text string while
  // the Branch schema splits it into line1/2/city/state/postalCode —
  // we put the whole string into addressLine1 so the existing
  // formatAddress() helper in the Branches admin UI picks it up
  // without parsing.
  const mainUpdate = {};
  if (update.name)         mainUpdate.name         = update.name;
  if (update.contactPhone !== undefined) mainUpdate.contactPhone = update.contactPhone;
  if (update.contactEmail) mainUpdate.contactEmail = update.contactEmail;

  // Prefer the structured address (new flow). Fall back to the legacy
  // single-string `general.address` so older clients still write
  // something sensible into addressLine1.
  if (update.address) {
    mainUpdate.addressLine1 = update.address.line1;
    mainUpdate.addressLine2 = update.address.line2;
    mainUpdate.state        = update.address.state;
    mainUpdate.postalCode   = update.address.pincode;
    mainUpdate.country      = update.address.country;
  } else if (typeof general.address === 'string') {
    mainUpdate.addressLine1 = general.address.trim();
  }
  if (update.city !== undefined) {
    mainUpdate.city = update.city;
  } else if (typeof general.city === 'string') {
    mainUpdate.city = general.city.trim();
  }
  if (Object.keys(mainUpdate).length > 0) {
    await Branch.updateOne(
      { restaurant: tId, slug: 'main' },
      { $set: mainUpdate }
    );
  }
}

// Settings are scoped per (tenant, branch). A Sub Admin pinned to a
// branch gets their own Settings document; the tenant owner gets the
// branch=null document. Creation of the default doc happens lazily on
// first GET so Sub Admins see sane defaults rather than main-branch
// config leaking through.
//
// Customers/guests have no `req.user.branch` pin, so they fall back to
// `req.branch?._id` — the branch resolved from the X-Branch-Id header
// by attachTenant. This makes the public GET /settings honour the
// branch the customer picked at /branch-selection (taxes, additional
// charges, contact details all scoped to that branch).
function resolveScopeBranchId(req) {
  const pinned = pinnedBranchId(req);
  if (pinned) return pinned;
  const role = req?.user?.role;
  const isStaff = role && role !== 'customer';
  if (isStaff) return null;
  return req?.branch?._id || null;
}
const settingsScope = (req) => ({
  ...tenantFilter(req),
  branch: resolveScopeBranchId(req),
});

// Build the Cafe / Hotel Information defaults from:
//   - Sub Admin (branch-pinned)  → the Branch doc (name, phone, email, address)
//   - Tenant owner               → the Restaurant doc (tenant-level contact)
async function buildDefaults(req) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const branchId = resolveScopeBranchId(req);

  let general;
  if (branchId) {
    const branch = await Branch.findOne({ _id: branchId, ...tenantFilter(req) }).lean();
    // Deduplicate: users sometimes type the full address (city + postal)
    // into addressLine1 AND fill the separate city/state/postalCode
    // fields, which would double up ("Baner Road, Pune – 411045, Pune,
    // Maharashtra, 411045"). Skip any later part whose text already
    // appears (case-insensitive) in what we've collected so far.
    const addressParts = [];
    const addPart = (raw) => {
      const part = String(raw || '').trim();
      if (!part) return;
      const seen = addressParts.join(' ').toLowerCase();
      if (!seen.includes(part.toLowerCase())) addressParts.push(part);
    };
    if (branch) {
      addPart(branch.addressLine1);
      addPart(branch.addressLine2);
      addPart(branch.city);
      addPart(branch.state);
      addPart(branch.postalCode);
    }
    general = {
      cafeName: branch?.name || req.restaurant?.name || 'The Coffee House',
      contactNumber: branch?.contactPhone || '',
      email: branch?.contactEmail || '',
      address: addressParts.join(', '),
      addressDetails: {
        line1:   branch?.addressLine1 || '',
        line2:   branch?.addressLine2 || '',
        city:    branch?.city         || '',
        state:   branch?.state        || '',
        pincode: branch?.postalCode   || '',
        country: branch?.country      || 'India',
      },
      // Regulatory/tax identifiers live on the Restaurant doc only —
      // they're tenant-wide, not per-branch. Sub-branch settings mirror
      // the tenant's values for display but the edit UI should gate
      // these to the main-branch admin.
      legal: {
        legalBusinessName: req.restaurant?.legal?.legalBusinessName || '',
        fssaiLicense:      req.restaurant?.legal?.fssaiLicense      || '',
        gstin:             req.restaurant?.legal?.gstin             || '',
        pan:               req.restaurant?.legal?.pan               || '',
      },
      timezone: req.restaurant?.timezone || 'Asia/Kolkata',
    };
  } else {
    const r = req.restaurant || {};
    const ra = r.address || {};
    // Legacy tenants only have address on their Main branch — pull
    // from there so the Settings form renders populated fields on
    // first load instead of forcing the owner to retype everything.
    let mainBranch = null;
    const hasRestAddress = !!(ra.line1 || ra.pincode || ra.state);
    if (!hasRestAddress && tenantId(req)) {
      mainBranch = await Branch.findOne({
        restaurant: tenantId(req),
        slug: 'main',
      }).lean();
    }
    general = {
      cafeName: r.name || 'The Coffee House',
      contactNumber: r.contactPhone || '',
      email: r.contactEmail || '',
      address: formatAddressLine(hasRestAddress ? { ...ra, city: r.city } : {
        line1: mainBranch?.addressLine1,
        line2: mainBranch?.addressLine2,
        city: mainBranch?.city,
        state: mainBranch?.state,
        pincode: mainBranch?.postalCode,
        country: mainBranch?.country,
      }),
      addressDetails: hasRestAddress
        ? {
            line1:   ra.line1   || '',
            line2:   ra.line2   || '',
            city:    r.city     || '',
            state:   ra.state   || '',
            pincode: ra.pincode || '',
            country: ra.country || 'India',
          }
        : {
            line1:   mainBranch?.addressLine1 || '',
            line2:   mainBranch?.addressLine2 || '',
            city:    mainBranch?.city         || r.city || '',
            state:   mainBranch?.state        || '',
            pincode: mainBranch?.postalCode   || '',
            country: mainBranch?.country      || 'India',
          },
      legal: {
        legalBusinessName: r.legal?.legalBusinessName || '',
        fssaiLicense:      r.legal?.fssaiLicense      || '',
        gstin:             r.legal?.gstin             || '',
        pan:               r.legal?.pan               || '',
      },
      timezone: r.timezone || 'Asia/Kolkata',
    };
  }

  return {
    restaurant: tenantId(req),
    branch: branchId || null,
    general,
    // Default to open 7 days a week. Admins can close specific days in
    // Settings → Operating Hours. The previous default closed Mondays,
    // which silently blocked checkout on Mondays for every fresh tenant.
    operatingHours: days.map(day => ({
      day,
      start: '09:00',
      end: '23:00',
      isOpen: true,
    })),
  };
}

// @desc    Get settings for the caller's scope (tenant owner or branch)
// @route   GET /api/settings
// @access  Admin / Sub Admin
/**
 * Resolves the effective Settings document for the caller, applying:
 *   • lazy-create defaults if none exist
 *   • Cafe Information re-sync from the Branch doc (branch-pinned callers)
 *   • main-branch inheritance (sub-branch callers)
 *   • tenant-level inheritance + logo fallback (customer/guest callers)
 *
 * Returns the resolved settings object (NOT a Mongoose doc — already
 * .toObject() / merged where needed). Pure — never touches `res`. The
 * bootstrap aggregator (controllers/adminBootstrapController.js) calls
 * this so the admin dashboard sees the same merged shape it would get
 * from a direct GET /settings.
 */
exports.resolveSettingsForRequest = async (req) => {
  let settings = await Settings.findOne(settingsScope(req));
  const resolved = await resolveSettingsCore(req, settings);
  return await shapePayments(req, await overlayTenantLandingPage(req, resolved));
};

// `payments` (UPI payee) visibility:
//   admin / manager / superadmin  full { upiId, upiPayeeName } + upiIdMasked, upiConfigured
//   captain / waiter / chef       { upiConfigured, upiIdMasked, upiPayeeName } (no raw id)
//   customers / guests            section removed
// A branch-scoped caller whose own doc has no UPI id uses the tenant-level
// one (the QR / slip do the same), reported as `upiInherited`.
async function shapePayments(req, resolved) {
  if (!resolved || typeof resolved !== 'object') return resolved;
  const out = { ...resolved };
  const role = req?.user?.role;
  const isAdminRole = ['admin', 'manager', 'superadmin'].includes(role);
  if (!isAdminRole && !['captain', 'waiter', 'chef'].includes(role)) {
    delete out.payments;
    return out;
  }
  const src = (out.payments && typeof out.payments.toObject === 'function' ? out.payments.toObject() : out.payments) || {};
  const upiId = typeof src.upiId === 'string' ? src.upiId : '';
  const upiPayeeName = typeof src.upiPayeeName === 'string' ? src.upiPayeeName : '';
  let effId = upiId;
  let effName = upiPayeeName;
  let inherited = false;
  if (!upiId && resolveScopeBranchId(req)) {
    const tenantDoc = await Settings.findOne({ ...tenantFilter(req), branch: null }).select('payments').lean();
    if (tenantDoc?.payments?.upiId) {
      effId = tenantDoc.payments.upiId;
      effName = upiPayeeName || tenantDoc.payments.upiPayeeName || '';
      inherited = true;
    }
  }
  out.payments = isAdminRole
    ? { upiId, upiPayeeName, upiIdMasked: maskVpa(effId), upiConfigured: !!effId, upiInherited: inherited }
    : { upiConfigured: !!effId, upiIdMasked: maskVpa(effId), upiPayeeName: effName };
  return out;
}

// Normalise the UPI payee fields that were sent (already shape-checked by
// the route) and log the change with masked values only.
function normalizePaymentsBody(src) {
  const out = {};
  if (src && src.upiId !== undefined && src.upiId !== null) out.upiId = normalizeVpa(src.upiId) ?? '';
  if (src && src.upiPayeeName !== undefined && src.upiPayeeName !== null) out.upiPayeeName = normalizePayeeName(src.upiPayeeName) ?? '';
  return out;
}
function logPaymentsChange(req, before, next) {
  const oldId = (before && before.upiId) || '';
  const oldName = (before && before.upiPayeeName) || '';
  const changedId = next.upiId !== undefined && next.upiId !== oldId;
  const changedName = next.upiPayeeName !== undefined && next.upiPayeeName !== oldName;
  if (!changedId && !changedName) return;
  logger.info(`settings: UPI payee changed by ${req.user?._id} (${req.user?.role}) tenant=${tenantId(req)} `
    + `upiId ${maskVpa(oldId) || '(none)'} -> ${next.upiId !== undefined ? (maskVpa(next.upiId) || '(cleared)') : 'unchanged'}; `
    + `payeeName ${next.upiPayeeName !== undefined ? (next.upiPayeeName ? 'set' : 'cleared') : 'unchanged'}`);
}

// ── Landing page (tenant-level section) ──────────────────────────────
// `landingPage` lives on the TENANT-level Settings doc (branch: null) —
// it drives the public /<restaurantSlug> page. Branch-scoped callers
// (Sub Admin, main-branch-pinned admin, customer with a branch) read the
// tenant's value so every view agrees with what the public page shows.
const {
  LANDING_SECTION_KEYS,
  LANDING_SOCIAL_KEYS,
  MAX_FEATURED_ITEMS,
  normalizeLandingPage,
} = require('../utils/landingPage');

async function overlayTenantLandingPage(req, resolved) {
  if (!resolved || typeof resolved !== 'object') return resolved;
  const tId = tenantId(req);
  const isTenantDoc = resolved.branch === null || resolved.branch === undefined;
  let source = resolved.landingPage;
  if (!isTenantDoc && tId) {
    const tenantDoc = await Settings.findOne({ restaurant: tId, branch: null })
      .select('landingPage').lean();
    source = tenantDoc?.landingPage;
  }
  const out = resolved.toObject ? resolved.toObject() : resolved;
  out.landingPage = normalizeLandingPage(source);
  return out;
}

/**
 * PATCH /settings/landingPage — merge the (route-validated) body over the
 * tenant-level landingPage and save. featuredItems must all be menu items
 * of THIS tenant. Returns { status, body } for errors, or null on success.
 */
async function saveLandingPage(req) {
  const tId = tenantId(req);
  if (!tId) {
    return { status: 400, body: { success: false, message: 'No restaurant context' } };
  }
  if (await isSubBranchCaller(req)) {
    return {
      status: 403,
      body: {
        success: false,
        code: 'INHERITED_FROM_MAIN',
        message: 'The landing page is managed from the main branch and cannot be edited here.',
      },
    };
  }
  const body = req.body || {};

  let featuredIds;
  if (Array.isArray(body.featuredItems)) {
    featuredIds = [...new Set(body.featuredItems.map((id) => String(id)))];
    if (featuredIds.some((id) => !mongoose.isValidObjectId(id))) {
      return { status: 400, body: { success: false, message: 'Each featured item must be a valid menu item id', errors: { featuredItems: 'Invalid menu item id' } } };
    }
    if (featuredIds.length > MAX_FEATURED_ITEMS) {
      return { status: 400, body: { success: false, message: `At most ${MAX_FEATURED_ITEMS} featured items are allowed`, errors: { featuredItems: `At most ${MAX_FEATURED_ITEMS} featured items are allowed` } } };
    }
    if (featuredIds.length > 0) {
      const owned = await MenuItem.countDocuments({ _id: { $in: featuredIds }, restaurant: tId });
      if (owned !== featuredIds.length) {
        return {
          status: 400,
          body: {
            success: false,
            code: 'INVALID_FEATURED_ITEMS',
            message: 'One or more featured items do not belong to this restaurant',
            errors: { featuredItems: 'One or more featured items do not belong to this restaurant' },
          },
        };
      }
    }
  }

  let doc = await Settings.findOne({ restaurant: tId, branch: null });
  if (!doc) {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    doc = new Settings({
      restaurant: tId,
      branch: null,
      operatingHours: days.map((day) => ({ day, start: '09:00', end: '23:00', isOpen: true })),
    });
  }

  const currentRaw = doc.landingPage && doc.landingPage.toObject ? doc.landingPage.toObject() : doc.landingPage;
  const current = normalizeLandingPage(currentRaw);
  const str = (v) => (typeof v === 'string' ? v.trim() : v);
  const next = { ...current };
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.tagline !== undefined) next.tagline = str(body.tagline) || '';
  if (body.about !== undefined) next.about = str(body.about) || '';
  if (body.coverImages !== undefined) {
    next.coverImages = (Array.isArray(body.coverImages) ? body.coverImages : []).map(str).filter(Boolean);
  }
  if (body.social && typeof body.social === 'object') {
    next.social = { ...current.social };
    for (const k of LANDING_SOCIAL_KEYS) {
      if (body.social[k] !== undefined) next.social[k] = str(body.social[k]) || '';
    }
  }
  if (featuredIds) next.featuredItems = featuredIds;
  if (body.sections && typeof body.sections === 'object') {
    next.sections = { ...current.sections };
    for (const k of LANDING_SECTION_KEYS) {
      if (typeof body.sections[k] === 'boolean') next.sections[k] = body.sections[k];
    }
  }
  if (body.accentColor !== undefined) next.accentColor = str(body.accentColor) || '';

  doc.landingPage = next;
  await doc.validate();
  await doc.save();
  return null;
}

async function resolveSettingsCore(req, initialSettings) {
  let settings = initialSettings;

  // Create defaults lazily for this scope if nothing exists yet.
  if (!settings) {
    settings = await Settings.create(await buildDefaults(req));
  } else if (resolveScopeBranchId(req)) {
    // For branch-pinned callers, the Branch doc is the source of truth
    // for Cafe/Hotel Information. Re-sync general.{cafeName, contact,
    // email, address, addressDetails, legal, timezone} on every GET so
    // edits made to the Branch flow through. logoUrl and banners are
    // kept as-is (they're Settings-only fields, not on the Branch).
    //
    // Bug fix (2026-05-19): the resync previously dropped `addressDetails`
    // and `legal` from the response, which is why a freshly-fetched
    // branch Settings doc showed blank Address line 1/2 and made the
    // City/State/Pincode placeholders look like generic defaults
    // ("Mumbai / Maharashtra / 400050"). Carrying both fields through
    // makes the form bind to the branch's real address.
    const defaults = await buildDefaults(req);
    const g = settings.general || {};
    const nextGeneral = {
      cafeName: defaults.general.cafeName,
      contactNumber: defaults.general.contactNumber,
      email: defaults.general.email,
      address: defaults.general.address,
      addressDetails: defaults.general.addressDetails,
      legal: defaults.general.legal,
      timezone: defaults.general.timezone,
      logoUrl: g.logoUrl,
      banners: g.banners,
    };
    const sameAddressDetails =
      g.addressDetails &&
      g.addressDetails.line1   === nextGeneral.addressDetails.line1 &&
      g.addressDetails.line2   === nextGeneral.addressDetails.line2 &&
      g.addressDetails.city    === nextGeneral.addressDetails.city &&
      g.addressDetails.state   === nextGeneral.addressDetails.state &&
      g.addressDetails.pincode === nextGeneral.addressDetails.pincode &&
      g.addressDetails.country === nextGeneral.addressDetails.country;
    const sameLegal =
      g.legal &&
      g.legal.legalBusinessName === nextGeneral.legal.legalBusinessName &&
      g.legal.fssaiLicense      === nextGeneral.legal.fssaiLicense &&
      g.legal.gstin             === nextGeneral.legal.gstin &&
      g.legal.pan               === nextGeneral.legal.pan;
    const changed =
      g.cafeName !== nextGeneral.cafeName ||
      g.contactNumber !== nextGeneral.contactNumber ||
      g.email !== nextGeneral.email ||
      g.address !== nextGeneral.address ||
      !sameAddressDetails ||
      !sameLegal ||
      g.timezone !== nextGeneral.timezone;
    if (changed) {
      settings = await Settings.findOneAndUpdate(
        settingsScope(req),
        { general: nextGeneral },
        { returnDocument: 'after' }
      );
    }
  }

  // Main-branch inheritance: a sub-branch caller keeps their own
  // `general` / `branches` but reads `taxes`, `reservation`,
  // `wallet`, `notifications`, `operatingHours` from the main
  // branch's Settings so the chain stays uniform. The response
  // leaves the sub-branch's own doc untouched on disk — only the
  // payload is merged.
  if (await isSubBranchCaller(req)) {
    const mainBranchId = await getMainBranchId(req);
    const mainSettings = await Settings.findOne({
      ...tenantFilter(req),
      branch: mainBranchId,
    }).lean();
    if (mainSettings) {
      const merged = settings.toObject ? settings.toObject() : { ...settings };
      for (const section of INHERITED_SECTIONS) {
        if (mainSettings[section] !== undefined) {
          merged[section] = mainSettings[section];
        }
      }
      merged.inheritedFromMain = {
        branch: mainBranchId,
        sections: INHERITED_SECTIONS,
      };
      return merged;
    }
  }

  // Customer inheritance: customers (and guests) fetch settings scoped
  // to their chosen branch, but the tenant owner usually edits taxes /
  // reservation / wallet on the TENANT-LEVEL doc (branch: null). Without
  // this merge, a customer at the main branch sees their branch-level
  // doc which may lack `additionalCharges` — so the bill preview missed
  // "Rohit Tax" while the waiter/admin totals (which read the tenant
  // doc) included it. Copy the inherited sections over so every view
  // sums the same way.
  const callerRole = req?.user?.role;
  const isCustomerLike = !callerRole || callerRole === 'customer';
  const scopedBranch = resolveScopeBranchId(req);

  // logoUrl + banners are brand-wide visuals — uploaded once at the
  // tenant level. Every branch-scoped reader (customer at a branch,
  // waiter / chef pinned to a branch, admin viewing a specific branch)
  // should inherit them when the branch's own Settings doc is blank.
  // Without this, the waiter screen rendered just "Hotel Tip Top 1" as
  // text with no logo even though the admin had uploaded one at the
  // tenant. Always returns a merged copy when we resolved a tenant
  // doc, so it works whether or not we also ran the customer-only
  // section merge below.
  let merged = null;
  let tenantSettings = null;
  if (scopedBranch) {
    tenantSettings = await Settings.findOne({
      ...tenantFilter(req),
      branch: null,
    }).lean();
    if (tenantSettings) {
      merged = settings.toObject ? settings.toObject() : { ...settings };
      const tGeneral = tenantSettings.general || {};
      const bGeneral = merged.general || {};
      const genFallback = { ...bGeneral };
      if (!bGeneral.logoUrl && tGeneral.logoUrl) {
        genFallback.logoUrl = tGeneral.logoUrl;
      }
      if ((!Array.isArray(bGeneral.banners) || bGeneral.banners.length === 0)
          && Array.isArray(tGeneral.banners) && tGeneral.banners.length > 0) {
        genFallback.banners = tGeneral.banners;
      }
      merged.general = genFallback;
    }
  }

  if (isCustomerLike && scopedBranch && tenantSettings) {
    merged = merged || (settings.toObject ? settings.toObject() : { ...settings });
    for (const section of INHERITED_SECTIONS) {
      const branchVal = merged[section];
      const tenantVal = tenantSettings[section];
      // Prefer the tenant-level value whenever it's meaningfully set —
      // a non-empty array / object, or a non-default primitive. This
      // keeps the customer view in step with what the admin edited
      // without overwriting genuinely per-branch overrides that the
      // branch doc intentionally holds.
      const isMeaningful = Array.isArray(tenantVal)
        ? tenantVal.length > 0
        : (tenantVal && (typeof tenantVal !== 'object' || Object.keys(tenantVal).length > 0));
      const branchIsEmpty = Array.isArray(branchVal)
        ? branchVal.length === 0
        : (!branchVal || (typeof branchVal === 'object' && Object.keys(branchVal).length === 0));
      if (isMeaningful && branchIsEmpty) {
        merged[section] = tenantVal;
      } else if (section === 'taxes' && tenantVal && branchVal) {
        // Taxes are edited at the tenant level only (Sub Admins are
        // blocked from this section, see updateSettingsSection), so
        // the customer view always wants the tenant's gst /
        // serviceCharge values. Without this, branch-scoped Settings
        // docs that were created lazily on first customer GET carry
        // the schema-default 10% / 5%, and the customer cart shows
        // those defaults even after the admin saved 18% / 15% on the
        // tenant doc — they're then charged the wrong total because
        // orderController trusts the client-computed taxes.
        //
        // `additionalCharges` may legitimately differ per branch, so
        // preserve the branch's own list when present and fall back
        // to the tenant list otherwise.
        const branchHasCharges = Array.isArray(branchVal.additionalCharges) && branchVal.additionalCharges.length > 0;
        const tenantCharges = Array.isArray(tenantVal.additionalCharges) ? tenantVal.additionalCharges : [];
        merged[section] = {
          ...branchVal,
          gst: tenantVal.gst || branchVal.gst,
          serviceCharge: tenantVal.serviceCharge || branchVal.serviceCharge,
          additionalCharges: branchHasCharges ? branchVal.additionalCharges : tenantCharges,
        };
      } else if (section === 'delivery' && tenantVal) {
        // Delivery config is edited at the tenant level only (sub-branches
        // inherit it — see INHERITED_SECTIONS). A branch-scoped Settings
        // doc lazily created on first customer GET carries the schema
        // default (disabled, no slabs); always prefer the tenant's
        // delivery config so the customer checkout offers the same km
        // ranges + toggle state the admin actually saved.
        merged[section] = tenantVal;
      }
    }
  }

  if (merged) return merged;
  return settings.toObject ? settings.toObject() : settings;
}

function sanitizePublicSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const copy = JSON.parse(JSON.stringify(settings));
  if (copy.general && copy.general.legal) {
    delete copy.general.legal;
  }
  // Printer hosts / agent state are staff-only infrastructure details.
  delete copy.printers;
  // The restaurant's UPI payee is never customer-facing.
  delete copy.payments;
  return copy;
}

// PATCH /settings/printers replaces the whole section, but the UI only
// knows about `enabled`, `autoPrint` and `list`. Carry the server-owned
// `agent` block (key version, last seen) over from the stored doc so a
// settings save can never reset `keyVersion` and resurrect a revoked
// agent key; and give every printer row a stable id the agent can use
// for per-printer overrides.
function normalizePrinters(body, existingDoc) {
  if (!body || typeof body !== 'object') return;
  delete body.agent;
  const existingAgent = existingDoc?.printers?.agent;
  if (existingAgent) {
    body.agent = typeof existingAgent.toObject === 'function' ? existingAgent.toObject() : { ...existingAgent };
  }
  if (Array.isArray(body.list)) {
    body.list = body.list.map((p) => (p && typeof p === 'object'
      ? { ...p, id: (typeof p.id === 'string' && p.id.trim()) ? p.id.trim() : crypto.randomUUID() }
      : p));
  }
}

function sanitizeMongoKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const clean = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$')) continue;
    clean[key] = typeof obj[key] === 'object' && obj[key] !== null ? sanitizeMongoKeys(obj[key]) : obj[key];
  }
  return clean;
}

exports.getSettings = async (req, res) => {
  try {
    const resolved = await exports.resolveSettingsForRequest(req);
    const isStaffOrAdmin = req.user && ['admin', 'manager', 'captain', 'waiter', 'chef', 'superadmin'].includes(req.user.role);
    const payload = isStaffOrAdmin ? resolved : sanitizePublicSettings(resolved);
    res.json(payload);
  } catch (error) {
    logger.error('getSettings error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load settings' });
  }
};

// Basic validation helpers
const validateEmail = (email) => !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validatePhone = (phone) => !phone || /^[\d\s\-\+\(\)]{7,20}$/.test(phone);

// Validate the new structured address + legal + timezone fields in
// the General settings payload. Returns an error message string when
// something is malformed, or null when everything is fine.
function validateGeneralExtras(general) {
  if (!general || typeof general !== 'object') return null;

  const ad = general.addressDetails;
  if (ad && typeof ad === 'object') {
    if (ad.pincode && !PINCODE_REGEX.test(String(ad.pincode).trim())) {
      return 'Pincode must be a 6-digit number';
    }
  }
  const l = general.legal;
  if (l && typeof l === 'object') {
    if (l.fssaiLicense && !FSSAI_REGEX.test(String(l.fssaiLicense).trim())) {
      return 'FSSAI license must be a 14-digit number';
    }
    if (l.gstin && !GSTIN_REGEX.test(String(l.gstin).trim().toUpperCase())) {
      return 'GSTIN must be a valid 15-character identifier';
    }
    if (l.pan && !PAN_REGEX.test(String(l.pan).trim().toUpperCase())) {
      return 'PAN must be a valid 10-character identifier';
    }
  }
  return null;
}

// Validate the Home Delivery config: slabs must each have a valid
// fromKm < toKm and a non-negative charge, and the set must be
// non-overlapping when sorted by fromKm. Returns an error message
// string on a problem, or null when everything is fine. A delivery
// object with `enabled:false` and no slabs is always valid.
function validateDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') return null;
  const slabs = Array.isArray(delivery.slabs) ? delivery.slabs : [];
  const normalized = [];
  for (const s of slabs) {
    const fromKm = Number(s?.fromKm);
    const toKm   = Number(s?.toKm);
    const charge = Number(s?.charge);
    if (![fromKm, toKm, charge].every(Number.isFinite)) {
      return 'Every delivery range needs a valid from-km, to-km and charge.';
    }
    if (fromKm < 0 || toKm < 0 || charge < 0) {
      return 'Delivery range values and charge cannot be negative.';
    }
    if (fromKm >= toKm) {
      return `Delivery range "${fromKm}–${toKm} km" is invalid: from-km must be less than to-km.`;
    }
    normalized.push({ fromKm, toKm, charge });
  }
  // Reject overlapping ranges so the customer never sees two slabs that
  // both cover the same distance.
  normalized.sort((a, b) => a.fromKm - b.fromKm);
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].fromKm < normalized[i - 1].toKm) {
      return `Delivery ranges overlap near ${normalized[i].fromKm} km. Ranges must not overlap.`;
    }
  }
  if (delivery.minOrderValue != null && (!Number.isFinite(Number(delivery.minOrderValue)) || Number(delivery.minOrderValue) < 0)) {
    return 'Minimum order value for delivery cannot be negative.';
  }
  // Restaurant coordinates (optional) — both or neither, within range.
  const o = delivery.origin;
  if (o && (o.lat != null || o.lng != null) && (o.lat !== '' || o.lng !== '')) {
    const lat = Number(o.lat);
    const lng = Number(o.lng);
    if (o.lat == null || o.lng == null || o.lat === '' || o.lng === ''
        || !Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return 'Restaurant location needs a valid latitude (-90 to 90) and longitude (-180 to 180).';
    }
  }
  return null;
}

// @desc    Update settings (full replacement) for the caller's scope
// @route   PUT /api/settings
// @access  Admin / Sub Admin
// Parking vehicle types are keyed by a slug id (what bookings store as
// `vehicleType`). Derive it from the label when the admin UI omits it.
function normalizeParkingSettings(reservation) {
  const parking = reservation && reservation.parking;
  if (!parking || typeof parking !== 'object' || !Array.isArray(parking.vehicles)) return;
  parking.vehicles = parking.vehicles.map((v) => ({
    id: String(v.id || v.label || '').trim().toLowerCase().replace(/\s+/g, '-'),
    label: String(v.label || v.id || '').trim(),
    pricePerHour: Number(v.pricePerHour) || 0,
  }));
}

exports.updateSettings = async (req, res) => {
  try {
    if (req.body.reservation) normalizeParkingSettings(req.body.reservation);
    // Input validation
    if (req.body.general) {
      if (req.body.general.email && !validateEmail(req.body.general.email)) {
        return res.status(400).json({ message: 'Invalid email format' });
      }
      if (req.body.general.contactNumber && !validatePhone(req.body.general.contactNumber)) {
        return res.status(400).json({ message: 'Invalid contact number format' });
      }
      const extrasErr = validateGeneralExtras(req.body.general);
      if (extrasErr) {
        return res.status(400).json({ message: extrasErr });
      }
    }
    if (req.body.delivery) {
      const deliveryErr = validateDelivery(req.body.delivery);
      if (deliveryErr) {
        return res.status(400).json({ message: deliveryErr });
      }
    }

    const scope = settingsScope(req);
    const updateBody = sanitizeMongoKeys({ ...req.body });
    // Callers cannot re-assign the settings document across scopes.
    delete updateBody.restaurant;
    delete updateBody.branch;
    // landingPage is only writable via PATCH /settings/landingPage, which
    // enforces tenant ownership of featuredItems and always targets the
    // tenant-level doc. A full-document PUT (which may echo back the
    // landingPage it read from GET) must not bypass that.
    delete updateBody.landingPage;

    // Sub-branches cannot write to sections they inherit from main.
    // Strip those keys silently so a PUT that bundles the whole doc
    // still works for their editable sections (general, branches).
    if (await isSubBranchCaller(req)) {
      for (const section of INHERITED_SECTIONS) {
        delete updateBody[section];
      }
    }

    // Keep the legacy `general.address` single-string in sync with the
    // structured `addressDetails` the admin UI writes. Without this,
    // older readers (landing page footer, receipts) see an empty/stale
    // string while the new structured fields are populated.
    if (updateBody.general && updateBody.general.addressDetails) {
      updateBody.general.address = formatAddressLine(updateBody.general.addressDetails);
    }

    let settings = await Settings.findOne(scope);

    // UPI payee: only the two known fields, merged field-by-field so a
    // partial PUT cannot blank the other one.
    if (updateBody.payments !== undefined) {
      const pay = normalizePaymentsBody(updateBody.payments);
      delete updateBody.payments;
      logPaymentsChange(req, settings?.payments, pay);
      if (settings) {
        for (const [k, v] of Object.entries(pay)) updateBody[`payments.${k}`] = v;
      } else {
        updateBody.payments = pay;
      }
    }

    if (settings) {
      settings = await Settings.findOneAndUpdate(scope, updateBody, {
        returnDocument: 'after',
        runValidators: true,
      });
    } else {
      settings = await Settings.create({ ...(await buildDefaults(req)), ...updateBody });
    }

    if (updateBody.general) {
      await syncRestaurantFromGeneral(req, updateBody.general);
    }

    invalidateCache(req);
    broadcastSettingsUpdated(req, 'all');

    res.json(settings);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = {};
      for (const field of Object.keys(error.errors)) {
        errors[field] = error.errors[field].message;
      }
      return res.status(400).json({ message: 'Validation failed', errors });
    }
    logger.error('updateSettings error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update settings' });
  }
};

// @desc    Update a specific settings section for the caller's scope
// @route   PATCH /api/settings/:section
// @access  Admin / Sub Admin
exports.updateSettingsSection = async (req, res) => {
  try {
    const { section } = req.params;
    const validSections = ['general', 'operatingHours', 'taxes', 'notifications', 'reservation', 'wallet', 'branches', 'delivery', 'landingPage', 'printers', 'payments'];

    if (!validSections.includes(section)) {
      return res.status(400).json({ message: `Invalid section: ${section}. Valid sections: ${validSections.join(', ')}` });
    }

    // Sub-branches can't edit sections inherited from the main branch.
    // Route them to the main-branch admin instead of silently dropping
    // the write so the UI can surface a clear message.
    if (INHERITED_SECTIONS.includes(section) && (await isSubBranchCaller(req))) {
      return res.status(403).json({
        message: `The "${section}" settings are managed from the main branch and cannot be edited here.`,
        code: 'INHERITED_FROM_MAIN',
      });
    }

    // Section-specific validation
    if (section === 'general' && req.body.email && !validateEmail(req.body.email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    if (section === 'general' && req.body.contactNumber && !validatePhone(req.body.contactNumber)) {
      return res.status(400).json({ message: 'Invalid contact number format' });
    }
    if (section === 'general') {
      const extrasErr = validateGeneralExtras(req.body);
      if (extrasErr) {
        return res.status(400).json({ message: extrasErr });
      }
    }
    if (section === 'reservation') normalizeParkingSettings(req.body);
    if (section === 'delivery') {
      const deliveryErr = validateDelivery(req.body);
      if (deliveryErr) {
        return res.status(400).json({ message: deliveryErr });
      }
    }

    if (section === 'landingPage') {
      const err = await saveLandingPage(req);
      if (err) return res.status(err.status).json(err.body);
      invalidateCache(req);
      broadcastSettingsUpdated(req, section);
      return res.json(await exports.resolveSettingsForRequest(req));
    }

    const scope = settingsScope(req);
    let settings = await Settings.findOne(scope);
    if (!settings) {
      settings = await Settings.create(await buildDefaults(req));
    }

    if (section === 'printers') normalizePrinters(req.body, settings);
    if (section === 'payments') {
      const pay = normalizePaymentsBody(req.body);
      logPaymentsChange(req, settings.payments, pay);
      const cur = settings.payments && typeof settings.payments.toObject === 'function' ? settings.payments.toObject() : (settings.payments || {});
      req.body = { upiId: cur.upiId || '', upiPayeeName: cur.upiPayeeName || '', ...pay };
    }

    settings[section] = req.body;

    await settings.validate();
    await settings.save();

    if (section === 'general') {
      await syncRestaurantFromGeneral(req, req.body);
    }

    invalidateCache(req);
    broadcastSettingsUpdated(req, section);

    res.json(settings);
  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = {};
      for (const field of Object.keys(error.errors)) {
        errors[field] = error.errors[field].message;
      }
      return res.status(400).json({ message: 'Validation failed', errors });
    }
    logger.error('updateSettings error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update settings' });
  }
};
