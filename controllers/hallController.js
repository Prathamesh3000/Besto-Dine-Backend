const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Hall = require('../models/hall');
const Branch = require('../models/branch');
const logger = require('../utils/logger');

const { tenantFilter, tenantId, pinnedBranchId, branchScopeClause } = require('../utils/tenantScope');
const { parseCsv } = require('../utils/csvParser');
const { _resolveBulkTargetBranch: resolveBulkTargetBranch } = require('./bookingInfoController');
const { sendServerError } = require('../utils/httpErrors');

/**
 * Phase 6 step 7 — halls mirror the MenuItem branch-filter pattern:
 *   branch: null → tenant-level / shared across all branches
 *   branch: <id> → specific to that physical branch
 *
 * Customers at a branch (X-Branch-Id header) see "tenant-level + their
 * branch" halls. Sub Admins see the same scope for their pinned branch
 * and cannot widen it. Tenant owners get explicit query control
 * (?branch=<id> / ?branch=all / ?branch=tenant-only) or fall through
 * to "everything in tenant" when no param is passed.
 */
function hallBranchFilter(req) {
  // Branch-pinned admin sees ONLY their branch's halls.
  // Tenant owner using the admin switcher passes ?branch=<id> and
  // gets the same strict view of that branch — without this, picking
  // "Main" in the dropdown still surfaced every tenant-null hall and
  // looked like a data leak. Customer at a QR-scanned branch keeps
  // the permissive shared+branch view (different code path: req.branch
  // is set via X-Branch-Id header, not a query param).
  const pinned = pinnedBranchId(req);
  if (pinned) {
    return branchScopeClause(req, pinned._id || pinned);
  }
  const raw = req?.query?.branch;
  if (raw === 'all') return null;
  if (raw === 'tenant-only' || raw === 'none') return { branch: null };
  if (raw && mongoose.isValidObjectId(raw)) return branchScopeClause(req, raw);
  if (req?.branch?._id) {
    return { $or: [{ branch: null }, { branch: req.branch._id }] };
  }
  return null;
}

async function resolveBranchForWrite(req, rawBranchId) {
  const pinned = pinnedBranchId(req);
  if (pinned) return { ok: true, branchId: pinned };
  if (rawBranchId === null || rawBranchId === undefined || rawBranchId === '') {
    return { ok: true, branchId: null };
  }
  if (!mongoose.isValidObjectId(rawBranchId)) {
    return { ok: false, message: 'Invalid branch id' };
  }
  const exists = await Branch.exists({ _id: rawBranchId, ...tenantFilter(req), isActive: true });
  if (!exists) return { ok: false, message: 'Branch not found in this tenant' };
  return { ok: true, branchId: rawBranchId };
}

// Get all halls (per-tenant, branch-scoped)
exports.getHalls = async (req, res) => {
  try {
    const filter = { ...tenantFilter(req) };
    const branchClause = hallBranchFilter(req);
    if (branchClause) Object.assign(filter, branchClause);
    const halls = await Hall.find(filter).populate('branch', 'name slug');
    res.status(200).json({
      success: true,
      halls: halls.map(h => ({
        id: h._id,
        _id: h._id, // Add compatibility for hall._id
        name: h.name,
        title: h.name, // Add compatibility for hall.title
        branch: h.branch ? { _id: h.branch._id, name: h.branch.name, slug: h.branch.slug } : null,
        type: h.type,
        price: `₹${h.basePrice?.toLocaleString()}`,
        basePrice: h.basePrice,
        description: h.description,
        minPeople: h.minCapacity,
        maxPeople: h.maxCapacity,
        infrastructure: h.infrastructure?.length > 0 ? h.infrastructure : Object.keys(h.amenities || {})
          .filter(k => h.amenities[k])
          .map(k => k.replace(/([A-Z])/g, ' $1').trim()),
        features: h.features || [],
        audioVisual: h.audioVisual || [],
        policies: h.policies || [],
        bestFor: h.bestFor || [],
        badges: h.badges || [],
        tags: h.badges || [], // Add compatibility for hall.tags
        contact: h.contact,
        status: h.isActive,
        images: h.images.length > 0 ? h.images : ['https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=2000'],
        image: h.images.length > 0 ? h.images[0] : 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=2000'
      }))
    });
  } catch (err) {
    sendServerError(res, err, 'hallController.getHalls');
  }
};

// Create a hall (Admin)
// Capacity sanity beyond the schema's per-field `min`: a minimum above
// the maximum makes every guest count unbookable. Returns an error
// message or null. Only checks the pair when both are known.
function capacityError(minCapacity, maxCapacity) {
  const min = minCapacity === undefined || minCapacity === null || minCapacity === '' ? null : Number(minCapacity);
  const max = maxCapacity === undefined || maxCapacity === null || maxCapacity === '' ? null : Number(maxCapacity);
  if (min !== null && max !== null && Number.isFinite(min) && Number.isFinite(max) && min > max) {
    return 'Minimum capacity cannot be greater than maximum capacity';
  }
  return null;
}

exports.createHall = async (req, res) => {
  try {
    const body = { ...req.body };
    delete body.restaurant;
    const capErr = capacityError(body.minCapacity, body.maxCapacity);
    if (capErr) return res.status(400).json({ success: false, message: capErr });
    const branchCheck = await resolveBranchForWrite(req, body.branch);
    if (!branchCheck.ok) {
      return res.status(400).json({ success: false, message: branchCheck.message });
    }
    body.branch = branchCheck.branchId;
    const hall = await Hall.create({ ...body, restaurant: tenantId(req) });
    res.status(201).json({ success: true, hall });
  } catch (err) {
    sendServerError(res, err, 'hallController.createHall');
  }
};

// Update a hall (Admin)
exports.updateHall = async (req, res) => {
  try {
    const { id } = req.params;
    const body = { ...req.body };
    delete body.restaurant;
    // Handle UI status mapping to isActive
    if (body.status !== undefined) {
      body.isActive = body.status;
    }
    const capErr = capacityError(body.minCapacity, body.maxCapacity);
    if (capErr) return res.status(400).json({ success: false, message: capErr });
    // If the admin is moving this hall to a different branch, validate.
    // Sub Admins are auto-pinned to their branch (resolveBranchForWrite
    // ignores the body value for them).
    if (Object.prototype.hasOwnProperty.call(body, 'branch')) {
      const branchCheck = await resolveBranchForWrite(req, body.branch);
      if (!branchCheck.ok) {
        return res.status(400).json({ success: false, message: branchCheck.message });
      }
      body.branch = branchCheck.branchId;
    }
    // Sub Admin updating an existing hall — they can only touch halls
    // at their own branch or shared halls. Mirrors the read-side scope.
    const pinned = pinnedBranchId(req);
    const scopeFilter = pinned
      ? { $or: [{ branch: null }, { branch: pinned }] }
      : {};
    const updated = await Hall.findOneAndUpdate(
      { _id: id, ...tenantFilter(req), ...scopeFilter },
      body,
      // runValidators: the schema refuses negative prices / capacities.
      { returnDocument: 'after', runValidators: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Hall not found' });
    res.status(200).json({ success: true, hall: updated });
  } catch (err) {
    sendServerError(res, err, 'hallController.updateHall');
  }
};

// Delete a hall (Admin)
exports.deleteHall = async (req, res) => {
  try {
    const { id } = req.params;
    const pinned = pinnedBranchId(req);
    const scopeFilter = pinned
      ? { $or: [{ branch: null }, { branch: pinned }] }
      : {};
    const deleted = await Hall.findOneAndDelete({ _id: id, ...tenantFilter(req), ...scopeFilter });
    if (!deleted) return res.status(404).json({ success: false, message: 'Hall not found' });
    res.status(200).json({ success: true, message: 'Hall deleted successfully' });
  } catch (err) {
    sendServerError(res, err, 'hallController.deleteHall');
  }
};

// ── BULK ONBOARDING ──────────────────────────────────────────────────────────
// Same pattern as Tables / Staff / Event Types / Packages bulk-add. Halls
// have stricter validation: `type` must be in the schema enum and capacity
// + price must be positive numbers.

const HALLS_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'hall-master-template.csv');
const HALL_TYPES = new Set(['Banquet Hall', 'Auditorium', 'Conference Room', 'Outdoor Space']);

// GET /api/halls/template
exports.downloadHallTemplate = (req, res) => {
  try {
    if (!fs.existsSync(HALLS_TEMPLATE_PATH)) {
      logger.error('Halls template missing on disk', { path: HALLS_TEMPLATE_PATH });
      return res.status(500).json({ success: false, message: 'Starter template not available' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hall-master-template.csv"');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(HALLS_TEMPLATE_PATH).pipe(res);
  } catch (error) {
    logger.error('downloadHallTemplate error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to serve template' });
  }
};

// POST /api/halls/import
// CSV header: name,type,maxCapacity,basePrice,minCapacity,description,floorLevel
// Required: name, type (enum), maxCapacity, basePrice.
exports.importHallsCsv = async (req, res) => {
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
      // ── Required core (kept first for legacy CSVs) ────────────────
      name:            header.indexOf('name'),
      type:            header.indexOf('type'),
      maxcapacity:     header.indexOf('maxcapacity'),
      baseprice:       header.indexOf('baseprice'),
      mincapacity:     header.indexOf('mincapacity'),
      description:     header.indexOf('description'),
      floorlevel:      header.indexOf('floorlevel'),
      // ── Extra numbers & strings parity with AddHallModal ─────────
      optimalcapacity: header.indexOf('optimalcapacity'),
      hourlyrate:      header.indexOf('hourlyrate'),
      cleaningcharges: header.indexOf('cleaningcharges'),
      securitydeposit: header.indexOf('securitydeposit'),
      buildingwing:    header.indexOf('buildingwing'),
      // ── 9 amenity flags (each its own boolean column) ────────────
      soundsystem:     header.indexOf('soundsystem'),
      projector:       header.indexOf('projector'),
      wifi:            header.indexOf('wifi'),
      ledscreen:       header.indexOf('ledscreen'),
      airconditioning: header.indexOf('airconditioning'),
      elevator:        header.indexOf('elevator'),
      powerbackup:     header.indexOf('powerbackup'),
      parking:         header.indexOf('parking'),
      kitchen:         header.indexOf('kitchen'),
      // ── Array fields (pipe-delimited) ─────────────────────────────
      features:        header.indexOf('features'),
      audiovisual:     header.indexOf('audiovisual'),
      policies:        header.indexOf('policies'),
      bestfor:         header.indexOf('bestfor'),
      badges:          header.indexOf('badges'),
      // ── Nested contact { name, phone, email } via 3 cols ─────────
      contactname:     header.indexOf('contactname'),
      contactphone:    header.indexOf('contactphone'),
      contactemail:    header.indexOf('contactemail'),
      // ── Images (pipe-delimited URLs) ──────────────────────────────
      // Each `|`-separated URL becomes one entry in the model's
      // `images: [String]` array. Empty cell → schema default
      // (empty array), at which point `getHalls` injects its
      // hard-coded Unsplash placeholder so cards never render naked.
      images:          header.indexOf('images'),
    };
    const missing = ['name', 'type', 'maxcapacity', 'baseprice'].filter(col => idx[col] === -1);
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `CSV missing required columns: ${missing.map(m => m === 'maxcapacity' ? 'maxCapacity' : m === 'baseprice' ? 'basePrice' : m).join(', ')}`,
      });
    }

    const existing = new Set(
      (await Hall.find({
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
      const typeRaw     = get('type');
      const maxRaw      = get('maxcapacity');
      const priceRaw    = get('baseprice');
      const minRaw      = get('mincapacity');
      const description = get('description');
      const floorLevel  = get('floorlevel');
      // Extra numeric / string columns
      const optRaw          = get('optimalcapacity');
      const hourlyRaw       = get('hourlyrate');
      const cleanRaw        = get('cleaningcharges');
      const depositRaw      = get('securitydeposit');
      const buildingWing    = get('buildingwing');
      // 9 amenity flags
      const amSound  = get('soundsystem');
      const amProj   = get('projector');
      const amWifi   = get('wifi');
      const amLed    = get('ledscreen');
      const amAC     = get('airconditioning');
      const amElev   = get('elevator');
      const amPwr    = get('powerbackup');
      const amPark   = get('parking');
      const amKitch  = get('kitchen');
      // Array fields
      const featuresRaw    = get('features');
      const audioVisualRaw = get('audiovisual');
      const policiesRaw    = get('policies');
      const bestForRaw     = get('bestfor');
      const badgesRaw      = get('badges');
      // Contact nested
      const contactName  = get('contactname');
      const contactPhone = get('contactphone');
      const contactEmail = get('contactemail');
      // Images (pipe-delimited URLs)
      const imagesRaw    = get('images');

      if (!name && !typeRaw && !maxRaw && !priceRaw && !minRaw && !description && !floorLevel
          && !optRaw && !hourlyRaw && !cleanRaw && !depositRaw && !buildingWing
          && !amSound && !amProj && !amWifi && !amLed && !amAC && !amElev && !amPwr && !amPark && !amKitch
          && !featuresRaw && !audioVisualRaw && !policiesRaw && !bestForRaw && !badgesRaw
          && !contactName && !contactPhone && !contactEmail && !imagesRaw) continue;

      try {
        if (!name)    throw new Error('name is required');
        if (name.length > 120) throw new Error('name must be 120 characters or fewer');
        if (!typeRaw) throw new Error('type is required');
        if (!HALL_TYPES.has(typeRaw)) {
          throw new Error(`type must be one of: ${[...HALL_TYPES].join(', ')}`);
        }
        if (!maxRaw)   throw new Error('maxCapacity is required');
        const maxCapacity = parseInt(maxRaw, 10);
        if (!Number.isFinite(maxCapacity) || maxCapacity < 1) throw new Error('maxCapacity must be a positive integer');
        if (!priceRaw) throw new Error('basePrice is required');
        const basePrice = Number(priceRaw);
        if (!Number.isFinite(basePrice) || basePrice < 0) throw new Error('basePrice must be a non-negative number');

        let minCapacity;
        if (minRaw) {
          minCapacity = parseInt(minRaw, 10);
          if (!Number.isFinite(minCapacity) || minCapacity < 0) throw new Error('minCapacity must be a non-negative integer');
          if (minCapacity > maxCapacity) throw new Error('minCapacity cannot exceed maxCapacity');
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

        // ── Helpers — coerce CSV cells to model types ─────────────────
        // Boolean: accept true/yes/1/y/on (case-insensitive) → true.
        // Anything else (including empty cell) → false.
        const toBool = (raw) => /^(true|yes|y|1|on)$/i.test(String(raw || '').trim());
        // Pipe-delimited list parser (same as packages/decorations).
        const splitList = (raw) =>
          raw ? String(raw).split('|').map(s => s.trim()).filter(Boolean) : [];
        // Non-negative number from text. Returns undefined for blank
        // so the schema's default (0 / unset) wins instead of forcing 0.
        const toNum = (raw) => {
          if (!raw) return undefined;
          const n = Number(raw);
          return Number.isFinite(n) && n >= 0 ? n : undefined;
        };

        const features    = splitList(featuresRaw);
        const audioVisual = splitList(audioVisualRaw);
        const policies    = splitList(policiesRaw);
        const bestFor     = splitList(bestForRaw);
        const badges      = splitList(badgesRaw);
        const images      = splitList(imagesRaw);

        // Build nested contact object only if at least one sub-field
        // was given — otherwise let the schema sit with an empty
        // sub-document so it doesn't show "Contact: undefined" in admin UI.
        const contact = (contactName || contactPhone || contactEmail)
          ? { name: contactName || undefined, phone: contactPhone || undefined, email: contactEmail || undefined }
          : undefined;

        // Build amenities sub-object. ALL 9 keys always emitted so the
        // schema's defaults (false) don't accidentally clobber an
        // intentional `true` row, and so the admin UI checkbox state
        // round-trips identically whether the row was uploaded or
        // hand-created in AddHallModal.
        const amenities = {
          soundSystem:     toBool(amSound),
          projector:       toBool(amProj),
          wifi:            toBool(amWifi),
          ledScreen:       toBool(amLed),
          airConditioning: toBool(amAC),
          elevator:        toBool(amElev),
          powerBackup:     toBool(amPwr),
          parking:         toBool(amPark),
          kitchen:         toBool(amKitch),
        };

        toInsert.push({
          name,
          type: typeRaw,
          maxCapacity,
          basePrice,
          ...(minCapacity !== undefined ? { minCapacity } : {}),
          ...(toNum(optRaw) !== undefined ? { optimalCapacity: toNum(optRaw) } : {}),
          ...(toNum(hourlyRaw) !== undefined ? { hourlyRate: toNum(hourlyRaw) } : {}),
          ...(toNum(cleanRaw) !== undefined ? { cleaningCharges: toNum(cleanRaw) } : {}),
          ...(toNum(depositRaw) !== undefined ? { securityDeposit: toNum(depositRaw) } : {}),
          description: description || undefined,
          floorLevel: floorLevel || undefined,
          buildingWing: buildingWing || undefined,
          amenities,
          features:    features.length    ? features    : undefined,
          audioVisual: audioVisual.length ? audioVisual : undefined,
          policies:    policies.length    ? policies    : undefined,
          bestFor:     bestFor.length     ? bestFor     : undefined,
          badges:      badges.length      ? badges      : undefined,
          images:      images.length      ? images      : undefined,
          contact,
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
        const inserted = await Hall.insertMany(toInsert, { ordered: false });
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
    logger.error('importHallsCsv error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to import halls CSV' });
  }
};
