const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Reservation = require('../models/reservation');
const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const DecorationPackage = require('../models/decorationPackage');
const Package = require('../models/package');
const Addon = require('../models/addon');
const EventType = require('../models/eventType');
const Branch = require('../models/branch');
const logger = require('../utils/logger');

const { tenantFilter, tenantId, pinnedBranchId, strictBranchFilter, branchScopeClause } = require('../utils/tenantScope');
const { tenantInsertMany } = require('../utils/tenantSafe');
const { parseCsv } = require('../utils/csvParser');
const { sendServerError } = require('../utils/httpErrors');

/**
 * Branch filter for advance-booking catalog reads (Event Types,
 * Packages, Decorations, Addons, Cakes).
 *
 *   - Pinned staff (Branch Admin) → STRICT `{ branch: pinned }`.
 *     Tenant-null and other-branch records are HIDDEN. Sharing across
 *     branches happens at branch-create via the syncFromMain catalog.
 *   - Customer at a QR-scanned branch (req.branch) → permissive
 *     `{ $or: [null, selected] }` so seeded tenant-level catalogs
 *     remain visible to guests.
 *   - Tenant owner (no pin) → unfiltered.
 */
function bookingCatalogBranchFilter(req) {
  const mongoose = require('mongoose');
  const pinned = pinnedBranchId(req);
  if (pinned) return branchScopeClause(req, pinned._id || pinned);
  // Tenant owner using the admin branch switcher passes ?branch=<id>.
  const raw = req?.query?.branch;
  if (raw === 'all') return {};
  if (raw === 'tenant-only' || raw === 'none') return { branch: null };
  if (raw && mongoose.isValidObjectId(raw)) return branchScopeClause(req, raw);
  if (req?.branch?._id) return { $or: [{ branch: null }, { branch: req.branch._id }] };
  return {};
}

exports.getBookingResources = async (req, res) => {
  try {
    const tf = tenantFilter(req);
    const bf = bookingCatalogBranchFilter(req);
    // Find cake categories first (per-tenant + branch). Cake categories
    // themselves are branch-scoped now — only this branch's categories
    // surface, so cakes don't bleed in via tenant-level seed categories.
    const cakeCategories = await Category.find({ name: { $regex: /cake|bakery/i }, ...tf, ...bf });
    const cakeCategoryIds = cakeCategories.map(c => c._id);

    // Run all independent queries in parallel (per-tenant + branch).
    const [cakes, decorations, packages, addons, eventTypes] = await Promise.all([
      MenuItem.find({ category: { $in: cakeCategoryIds }, status: 'active', 'sizes.0': { $exists: true }, ...tf, ...bf }),
      DecorationPackage.find({ isActive: true, ...tf, ...bf }),
      Package.find({ ...tf, ...bf }),
      Addon.find({ isActive: true, ...tf, ...bf }),
      EventType.find({ ...tf, ...bf }),
    ]);

    res.status(200).json({
      success: true,
      cakes,
      decorations,
      packages,
      addons,
      eventTypes
    });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.getBookingResources');
  }
};

exports.getCakes = async (req, res) => {
  try {
    const tf = tenantFilter(req);
    const bf = bookingCatalogBranchFilter(req);
    // Match only cake/bakery categories (per-tenant + branch)
    const categories = await Category.find({
      name: { $regex: /cake|bakery/i },
      ...tf,
      ...bf,
    });

    if (!categories || categories.length === 0) {
      return res.status(200).json({ success: true, cakes: [] });
    }

    const categoryIds = categories.map(c => c._id);
    // Only return items that have sizes (weight options) defined.
    // MenuItem branch scope follows the same rule as the rest of the
    // menu — branch-pinned admin sees their own + opted-in shared.
    const cakes = await MenuItem.find({
      category: { $in: categoryIds },
      status: 'active',
      'sizes.0': { $exists: true },
      ...tf,
      ...bf,
    })
      // QA N8/N9 — the cake step only needs these; the full MenuItem
      // documents (descriptions, recipes, every image…) made the payload
      // heavy for a picker that renders a name + one thumbnail.
      .select('name vegType images image sizes')
      .lean();

    res.status(200).json({ success: true, cakes });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.getCakes');
  }
};

exports.getDecorations = async (req, res) => {
  try {
    const decorations = await DecorationPackage.find({ isActive: true, ...tenantFilter(req), ...bookingCatalogBranchFilter(req) });
    res.status(200).json({
      success: true,
      decorations: decorations.map(d => ({
        ...d._doc,
        id: d._id,
        _id: d._id
      }))
    });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.getDecorations');
  }
};

exports.getPackages = async (req, res) => {
  try {
    const packages = await Package.find({ isActive: true, ...tenantFilter(req), ...bookingCatalogBranchFilter(req) });
    res.status(200).json({
      success: true,
      packages: packages.map(p => ({
        ...p._doc,
        id: p._id,
        _id: p._id
      }))
    });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.getPackages');
  }
};

exports.getEventTypes = async (req, res) => {
  try {
    const eventTypes = await EventType.find({ isActive: true, ...tenantFilter(req), ...bookingCatalogBranchFilter(req) });
    res.status(200).json({ success: true, eventTypes });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.getEventTypes');
  }
};

exports.getAddons = async (req, res) => {
  try {
    const addons = await Addon.find({ isActive: true, ...tenantFilter(req), ...bookingCatalogBranchFilter(req) });
    res.status(200).json({
      success: true,
      addons: addons.map(a => ({
        ...a._doc,
        id: a._id,
        _id: a._id
      }))
    });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.getAddons');
  }
};

// Parking config for the customer's Parking step (QA N10/N11): vehicle
// types with hourly rates, the max custom duration, and the hours billed
// for "whole event" parking. Same resolver the booking pricing uses, so
// what the customer sees is what the server charges.
exports.getParkingRates = async (req, res) => {
  try {
    const { loadParkingConfig } = require('../utils/parkingConfig');
    const parking = await loadParkingConfig(tenantFilter(req));
    res.status(200).json({ success: true, parking });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.getParkingRates');
  }
};

// --- Administrative Methods ---

// Event Types
exports.createEventType = async (req, res) => {
  try {
    // Pinned admin's event types are owned by their branch; tenant
    // owner may pass body.branch or leave null for tenant-level.
    const pinned = pinnedBranchId(req);
    const ownerBranch = pinned || req.body.branch || null;
    const newEventType = new EventType({ ...req.body, restaurant: tenantId(req), branch: ownerBranch });
    const saved = await newEventType.save();
    res.status(201).json({ success: true, eventType: saved });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.createEventType');
  }
};

exports.updateEventType = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    delete updateData.restaurant;
    if (pinnedBranchId(req)) delete updateData.branch;
    const updated = await EventType.findOneAndUpdate(
      { _id: id, ...tenantFilter(req), ...strictBranchFilter(req) },
      updateData,
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Event type not found' });
    res.status(200).json({ success: true, eventType: updated });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.updateEventType');
  }
};

exports.deleteEventType = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await EventType.findOneAndDelete({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
    if (!deleted) return res.status(404).json({ success: false, message: 'Event type not found' });
    res.status(200).json({ success: true, message: 'Event type deleted successfully' });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.deleteEventType');
  }
};

// Add-ons
//
// Slug policy: free-text kebab-case so any restaurant can add their
// own catalogue. The six "standard" slugs below get rich
// configurators on the customer side (AddonDetailModal); anything
// else falls through to the generic configurator (description +
// quantity stepper) which works for any custom add-on the admin
// dreams up — florist, magician, balloon arch, etc.
const STANDARD_ADDON_SLUGS = ['photographer', 'dj', 'photobooth', 'live', 'kids', 'host'];
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

exports.createAddon = async (req, res) => {
    try {
        const { title, slug, description, price, icon, category, options, isFeatured, isPopular, isActive } = req.body || {};

        if (!title || !String(title).trim()) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        if (!slug || !String(slug).trim()) {
            return res.status(400).json({ success: false, message: 'Slug is required' });
        }
        const cleanSlug = String(slug).toLowerCase().trim();
        if (!SLUG_REGEX.test(cleanSlug)) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_SLUG',
                message: 'Slug must be lowercase letters, digits and hyphens only (e.g. floral-arch).',
            });
        }
        const cleanPrice = Number(price);
        if (!Number.isFinite(cleanPrice) || cleanPrice < 0) {
            return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
        }

        // Pinned admin owns the addon at their branch; tenant owner
        // creates at tenant-level (null) unless body.branch is passed.
        const pinned = pinnedBranchId(req);
        const ownerBranch = pinned || req.body.branch || null;

        // Slug uniqueness is per (tenant, branch). The compound unique
        // index will throw 11000 if violated; check first for a friendlier
        // message.
        const existing = await Addon.findOne({ slug: cleanSlug, ...tenantFilter(req), branch: ownerBranch });
        if (existing) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_TAKEN',
                message: `An add-on with slug "${cleanSlug}" already exists. Edit that one or pick a different slug.`,
            });
        }

        const created = await Addon.create({
            restaurant: tenantId(req),
            branch: ownerBranch,
            title: String(title).trim(),
            slug: cleanSlug,
            description: description ? String(description).trim() : '',
            price: cleanPrice,
            icon: icon ? String(icon).trim() : '',
            category: category ? String(category).trim() : '',
            options: Array.isArray(options) ? options : [],
            isFeatured: !!isFeatured,
            isPopular: !!isPopular,
            isActive: isActive !== false,
        });
        res.status(201).json({ success: true, addon: created });
    } catch (err) {
        if (err?.code === 11000) {
            return res.status(409).json({ success: false, code: 'SLUG_TAKEN', message: 'Slug already in use' });
        }
        sendServerError(res, err, 'bookingInfoController.createAddon');
    }
};

exports.updateAddon = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = { ...req.body };
        // Strip fields the caller must never overwrite.
        delete updates.restaurant;
        delete updates._id;
        delete updates.createdAt;
        delete updates.updatedAt;
        // A pinned admin cannot re-assign an addon to a different branch.
        if (pinnedBranchId(req)) delete updates.branch;

        // Slug must remain kebab-case but is otherwise free-text —
        // the customer modal handles unknown slugs via its generic
        // configurator, so admin can rename / repoint without
        // breaking anything.
        if (updates.slug !== undefined) {
            const cleanSlug = String(updates.slug).toLowerCase().trim();
            if (!SLUG_REGEX.test(cleanSlug)) {
                return res.status(400).json({
                    success: false,
                    code: 'INVALID_SLUG',
                    message: 'Slug must be lowercase letters, digits and hyphens only.',
                });
            }
            updates.slug = cleanSlug;
        }
        if (updates.price !== undefined) {
            const cleanPrice = Number(updates.price);
            if (!Number.isFinite(cleanPrice) || cleanPrice < 0) {
                return res.status(400).json({ success: false, message: 'Price must be a non-negative number' });
            }
            updates.price = cleanPrice;
        }

        const updated = await Addon.findOneAndUpdate(
            { _id: id, ...tenantFilter(req), ...strictBranchFilter(req) },
            updates,
            { new: true, runValidators: true }
        );
        if (!updated) return res.status(404).json({ success: false, message: 'Add-on not found' });
        res.status(200).json({ success: true, addon: updated });
    } catch (err) {
        if (err?.code === 11000) {
            return res.status(409).json({ success: false, code: 'SLUG_TAKEN', message: 'Slug already in use' });
        }
        sendServerError(res, err, 'bookingInfoController.updateAddon');
    }
};

exports.deleteAddon = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await Addon.findOneAndDelete({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
        if (!deleted) return res.status(404).json({ success: false, message: 'Add-on not found' });
        res.status(200).json({ success: true, message: 'Add-on deleted successfully' });
    } catch (err) {
        sendServerError(res, err, 'bookingInfoController.deleteAddon');
    }
};

// Expose the standard-slug list to the admin UI as smart suggestions
// (renderer-pills next to the slug input). Admin can pick one for a
// rich configurator OR type a custom slug for the generic flow.
exports.getAddonSlugs = (req, res) => {
    res.status(200).json({ success: true, slugs: STANDARD_ADDON_SLUGS });
};

// Admin variant of getAddons that includes inactive entries — the
// public getAddons hides them but the admin grid needs to see them
// to toggle them back on.
exports.getAdminAddons = async (req, res) => {
    try {
        const addons = await Addon.find({ ...tenantFilter(req), ...bookingCatalogBranchFilter(req) }).sort({ createdAt: -1 });
        res.status(200).json({ success: true, addons });
    } catch (err) {
        sendServerError(res, err, 'bookingInfoController.getAdminAddons');
    }
};

// Packages
exports.createPackage = async (req, res) => {
  try {
    // Pinned admin owns the package at their branch; tenant owner may
    // pass body.branch explicitly or leave it null for tenant-level.
    const pinned = pinnedBranchId(req);
    const ownerBranch = pinned || req.body.branch || null;
    const newPackage = new Package({ ...req.body, restaurant: tenantId(req), branch: ownerBranch });
    const saved = await newPackage.save();
    res.status(201).json({ success: true, package: saved });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.createPackage');
  }
};

exports.updatePackage = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    delete updateData.restaurant;
    if (pinnedBranchId(req)) delete updateData.branch;
    const updated = await Package.findOneAndUpdate(
      { _id: id, ...tenantFilter(req), ...strictBranchFilter(req) },
      updateData,
      // runValidators: the schema refuses negative prices / headcounts.
      { returnDocument: 'after', runValidators: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Package not found' });
    res.status(200).json({ success: true, package: updated });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.updatePackage');
  }
};

exports.deletePackage = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Package.findOneAndDelete({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
    if (!deleted) return res.status(404).json({ success: false, message: 'Package not found' });
    res.status(200).json({ success: true, message: 'Package deleted successfully' });
  } catch (err) {
    sendServerError(res, err, 'bookingInfoController.deletePackage');
  }
};

// ── BULK ONBOARDING ──────────────────────────────────────────────────────────
// Shared between Event Types and Packages. Same pattern as Tables / Staff
// bulk-add: ship a curated CSV → admin trims → uploads → bulk insert with
// per-row errors / skips surfaced individually.
//
// Branch resolution (mirrors Staff bulk-add):
//   1. Sub Admin uploader → force-pinned to their own branch (form body ignored).
//   2. Tenant owner + `branch` form field → that branch (validated).
//   3. Tenant owner + no field → tenant-level (null).

const EVENT_TYPES_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'eventType-master-template.csv');
const PACKAGES_TEMPLATE_PATH    = path.join(__dirname, '..', 'data', 'package-master-template.csv');
const PACKAGE_CATEGORIES = new Set(['All', 'Classic', 'Royal', 'Gold', 'Elite']);

// Generic resolver: takes the body.branch form field, validates against the
// tenant, returns ObjectId or null. Sub Admin pin overrides everything else.
async function resolveBulkTargetBranch(req) {
  const pinned = pinnedBranchId(req);
  if (pinned) {
    const id = pinned._id || pinned;
    return { ok: true, branchId: id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)) };
  }
  const raw = req.body?.branch;
  if (!raw || raw === 'null' || raw === 'tenant-only') return { ok: true, branchId: null };
  if (!mongoose.isValidObjectId(raw)) {
    return { ok: false, message: 'Invalid branch id in upload' };
  }
  const exists = await Branch.exists({ _id: raw, ...tenantFilter(req), isActive: true });
  if (!exists) {
    return { ok: false, message: 'Selected branch not found or not part of your restaurant.' };
  }
  return { ok: true, branchId: new mongoose.Types.ObjectId(String(raw)) };
}

// GET /api/booking-info/event-types/template
exports.downloadEventTypeTemplate = (req, res) => {
  try {
    if (!fs.existsSync(EVENT_TYPES_TEMPLATE_PATH)) {
      logger.error('Event types template missing on disk', { path: EVENT_TYPES_TEMPLATE_PATH });
      return res.status(500).json({ success: false, message: 'Starter template not available' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="eventType-master-template.csv"');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(EVENT_TYPES_TEMPLATE_PATH).pipe(res);
  } catch (error) {
    logger.error('downloadEventTypeTemplate error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to serve template' });
  }
};

// POST /api/booking-info/event-types/import
// CSV header: title,description,guests   (only `title` required)
exports.importEventTypesCsv = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'CSV file is required (form field: file)' });
    }
    const rows = parseCsv(req.file.buffer.toString('utf8'));
    if (rows.length < 2) {
      return res.status(400).json({ success: false, message: 'CSV must contain a header row and at least one data row' });
    }
    const tenant = tenantId(req);
    if (!tenant) return res.status(400).json({ success: false, message: 'Tenant context required for bulk import' });

    const target = await resolveBulkTargetBranch(req);
    if (!target.ok) return res.status(400).json({ success: false, message: target.message });
    const branchId = target.branchId;

    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = {
      title:       header.indexOf('title'),
      description: header.indexOf('description'),
      guests:      header.indexOf('guests'),
      icon:        header.indexOf('icon'),
    };
    if (idx.title === -1) {
      return res.status(400).json({ success: false, message: 'CSV missing required column: title' });
    }

    // Pre-fetch existing titles in the (tenant, branch) scope so a re-upload
    // is idempotent — duplicates land in `skipped`, not `errors`.
    const existing = new Set(
      (await EventType.find({
        restaurant: tenant,
        branch: branchId,
      }).select('title').lean()).map(d => String(d.title).trim().toLowerCase())
    );

    const errors = [];
    const skipped = [];
    const toInsert = [];
    const seenTitles = new Set();

    for (let i = 1; i < rows.length; i++) {
      const rowNum = i + 1;
      const cells = rows[i];
      const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

      const title       = get('title');
      const description = get('description');
      const guests      = get('guests');
      const icon        = get('icon');

      if (!title && !description && !guests && !icon) continue;       // skip blank rows

      try {
        if (!title) throw new Error('title is required');
        if (title.length > 120) throw new Error('title must be 120 characters or fewer');
        // Icon is stored as a string — typically a single emoji (canonical, e.g. '🎂')
        // or a relative/absolute URL when an admin uploads an image. The
        // BookTableDetails render site auto-detects which one and falls back
        // to '🎂' if absent. Cap length to keep the column small.
        if (icon && icon.length > 16) throw new Error('icon must be 16 characters or fewer');

        const key = title.toLowerCase();
        if (existing.has(key)) {
          skipped.push({ row: rowNum, title, reason: 'already in your system' });
          continue;
        }
        if (seenTitles.has(key)) {
          skipped.push({ row: rowNum, title, reason: 'duplicate row in this file' });
          continue;
        }
        seenTitles.add(key);

        toInsert.push({
          title,
          description: description || undefined,
          guests: guests || '10-200',
          icon: icon || undefined,
          restaurant: tenant,
          branch: branchId,
          isActive: true,
        });
      } catch (err) {
        errors.push({ row: rowNum, message: err.message });
      }
    }

    let created = 0;
    let writeErrors = [];
    if (toInsert.length) {
      try {
        const inserted = await tenantInsertMany(EventType, toInsert, tenant, { ordered: false });
        created = inserted.length;
      } catch (err) {
        created = err?.result?.nInserted || err?.insertedDocs?.length || 0;
        writeErrors = err?.writeErrors || [];
      }
    }
    for (const we of writeErrors) {
      const docIdx = we.index ?? we.err?.index;
      const failing = typeof docIdx === 'number' ? toInsert[docIdx] : null;
      const isDup = we.code === 11000 || we.err?.code === 11000;
      if (isDup) skipped.push({ row: '—', title: failing?.title || '—', reason: 'already in your system' });
      else errors.push({ row: '—', message: we.errmsg || we.err?.errmsg || 'database write failed' });
    }

    return res.status(200).json({
      success: true,
      created,
      skippedCount: skipped.length,
      skipped,
      errorCount: errors.length,
      errors,
    });
  } catch (error) {
    logger.error('importEventTypesCsv error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to import event types CSV' });
  }
};

// GET /api/booking-info/packages/template
exports.downloadPackageTemplate = (req, res) => {
  try {
    if (!fs.existsSync(PACKAGES_TEMPLATE_PATH)) {
      logger.error('Packages template missing on disk', { path: PACKAGES_TEMPLATE_PATH });
      return res.status(500).json({ success: false, message: 'Starter template not available' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="package-master-template.csv"');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(PACKAGES_TEMPLATE_PATH).pipe(res);
  } catch (error) {
    logger.error('downloadPackageTemplate error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to serve template' });
  }
};

// POST /api/booking-info/packages/import
// CSV header: name,price,category,description,minPeople,maxPeople
// Required: name, price. Category falls back to 'All' if blank/invalid.
exports.importPackagesCsv = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'CSV file is required (form field: file)' });
    }
    const rows = parseCsv(req.file.buffer.toString('utf8'));
    if (rows.length < 2) {
      return res.status(400).json({ success: false, message: 'CSV must contain a header row and at least one data row' });
    }
    const tenant = tenantId(req);
    if (!tenant) return res.status(400).json({ success: false, message: 'Tenant context required for bulk import' });

    const target = await resolveBulkTargetBranch(req);
    if (!target.ok) return res.status(400).json({ success: false, message: target.message });
    const branchId = target.branchId;

    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = {
      name:        header.indexOf('name'),
      price:       header.indexOf('price'),
      type:        header.indexOf('type'),
      category:    header.indexOf('category'),
      description: header.indexOf('description'),
      minpeople:   header.indexOf('minpeople'),
      maxpeople:   header.indexOf('maxpeople'),
      badge:       header.indexOf('badge'),
      features:    header.indexOf('features'),
      starters:    header.indexOf('starters'),
      maincourse:  header.indexOf('maincourse'),
      drinks:      header.indexOf('drinks'),
    };
    const missing = ['name', 'price'].filter(col => idx[col] === -1);
    if (missing.length) {
      return res.status(400).json({ success: false, message: `CSV missing required columns: ${missing.join(', ')}` });
    }

    const existing = new Set(
      (await Package.find({
        restaurant: tenant,
        branch: branchId,
      }).select('name').lean()).map(d => String(d.name).trim().toLowerCase())
    );

    const errors = [];
    const skipped = [];
    const toInsert = [];
    const seenNames = new Set();

    for (let i = 1; i < rows.length; i++) {
      const rowNum = i + 1;
      const cells = rows[i];
      const get = (col) => idx[col] === -1 ? '' : String(cells[idx[col]] || '').trim();

      const name        = get('name');
      const priceRaw    = get('price');
      const typeRaw     = get('type');
      const categoryRaw = get('category');
      const description = get('description');
      const minRaw      = get('minpeople');
      const maxRaw      = get('maxpeople');
      const badgeRaw    = get('badge');
      const featuresRaw = get('features');
      const startersRaw = get('starters');
      const mainRaw     = get('maincourse');
      const drinksRaw   = get('drinks');

      if (!name && !priceRaw && !typeRaw && !categoryRaw && !description && !minRaw && !maxRaw
          && !badgeRaw && !featuresRaw && !startersRaw && !mainRaw && !drinksRaw) continue;

      try {
        if (!name)     throw new Error('name is required');
        if (name.length > 120) throw new Error('name must be 120 characters or fewer');
        if (!priceRaw) throw new Error('price is required');
        const price = Number(priceRaw);
        if (!Number.isFinite(price) || price < 0) throw new Error('price must be a non-negative number');

        // Coerce category to schema's enum — anything outside the list
        // silently falls back to 'All' rather than failing the row, so
        // a typo in the CSV doesn't block the whole batch.
        const categoryTitleCase = categoryRaw
          ? categoryRaw.charAt(0).toUpperCase() + categoryRaw.slice(1).toLowerCase()
          : 'All';
        const category = PACKAGE_CATEGORIES.has(categoryTitleCase) ? categoryTitleCase : 'All';

        const minPeople = minRaw ? Math.max(0, parseInt(minRaw, 10) || 0) : 0;
        const maxPeople = maxRaw ? Math.max(0, parseInt(maxRaw, 10) || 0) : 0;
        if (maxPeople && minPeople && maxPeople < minPeople) {
          throw new Error('maxPeople must be greater than or equal to minPeople');
        }

        const key = name.toLowerCase();
        if (existing.has(key)) {
          skipped.push({ row: rowNum, name, reason: 'already in your system' });
          continue;
        }
        if (seenNames.has(key)) {
          skipped.push({ row: rowNum, name, reason: 'duplicate row in this file' });
          continue;
        }
        seenNames.add(key);

        // Pipe-delimited list parser — used for features / starters /
        // mainCourse / drinks. Pipe `|` chosen over semicolon to avoid
        // Excel EU-locale CSV separator collisions. Empty cell → [].
        const splitList = (raw) =>
          raw
            ? String(raw).split('|').map(s => s.trim()).filter(Boolean)
            : [];
        const features  = splitList(featuresRaw);
        const starters   = splitList(startersRaw).map(name => ({ name }));
        const mainCourse = splitList(mainRaw).map(name => ({ name }));
        const drinks     = splitList(drinksRaw).map(name => ({ name }));

        // Auto-derive badgeColor from badge label so admins don't have
        // to think about Tailwind classes in the CSV. Falls back to the
        // schema default for unrecognised labels.
        const badge = badgeRaw || undefined;
        const BADGE_COLORS = {
          silver:   'bg-gray-100 text-gray-700',
          gold:     'bg-yellow-100 text-yellow-700',
          platinum: 'bg-purple-100 text-purple-700',
          royal:    'bg-red-100 text-red-700',
          elite:    'bg-orange-100 text-orange-700',
          premium:  'bg-blue-100 text-blue-700',
          basic:    'bg-slate-100 text-slate-600',
        };
        const badgeColor = badge ? BADGE_COLORS[badge.toLowerCase()] : undefined;

        // Package type is stored lowercase to match the AddPackageModal
        // dropdown's stored value (e.g. 'wedding', not 'Wedding'). Empty
        // cell → undefined → schema default ''. The modal accepts any
        // string and only renders its title-case label when it matches
        // one of the dropdown options — anything else just stays as
        // entered (no error), so the CSV can ship richer categories.
        const type = typeRaw ? typeRaw.trim().toLowerCase() : undefined;

        toInsert.push({
          name,
          price,
          type,
          category,
          description: description || undefined,
          minPeople,
          maxPeople,
          badge,
          badgeColor,
          features: features.length ? features : undefined,
          starters: starters.length ? starters : undefined,
          mainCourse: mainCourse.length ? mainCourse : undefined,
          drinks: drinks.length ? drinks : undefined,
          restaurant: tenant,
          branch: branchId,
          isActive: true,
        });
      } catch (err) {
        errors.push({ row: rowNum, message: err.message });
      }
    }

    let created = 0;
    let writeErrors = [];
    if (toInsert.length) {
      try {
        const inserted = await tenantInsertMany(Package, toInsert, tenant, { ordered: false });
        created = inserted.length;
      } catch (err) {
        created = err?.result?.nInserted || err?.insertedDocs?.length || 0;
        writeErrors = err?.writeErrors || [];
      }
    }
    for (const we of writeErrors) {
      const docIdx = we.index ?? we.err?.index;
      const failing = typeof docIdx === 'number' ? toInsert[docIdx] : null;
      const isDup = we.code === 11000 || we.err?.code === 11000;
      if (isDup) skipped.push({ row: '—', name: failing?.name || '—', reason: 'already in your system' });
      else errors.push({ row: '—', message: we.errmsg || we.err?.errmsg || 'database write failed' });
    }

    return res.status(200).json({
      success: true,
      created,
      skippedCount: skipped.length,
      skipped,
      errorCount: errors.length,
      errors,
    });
  } catch (error) {
    logger.error('importPackagesCsv error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to import packages CSV' });
  }
};

// Exported for hallController + decorationPackageController so they can
// reuse the same branch-resolution logic without re-implementing it.
exports._resolveBulkTargetBranch = resolveBulkTargetBranch;
