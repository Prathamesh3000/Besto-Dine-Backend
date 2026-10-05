const fs = require('fs');
const path = require('path');
const DecorationPackage = require('../models/decorationPackage');
const logger = require('../utils/logger');

const { tenantFilter, tenantId, pinnedBranchId, strictBranchFilter } = require('../utils/tenantScope');
const { parseCsv } = require('../utils/csvParser');
const { _resolveBulkTargetBranch: resolveBulkTargetBranch } = require('./bookingInfoController');
const { sendServerError } = require('../utils/httpErrors');

// Branch filter for decoration-package reads. Pinned admin sees ONLY
// their branch's decoration packages; customer at a QR-scanned branch
// gets the permissive shared+branch view; tenant owner sees everything.
function decorationBranchFilter(req) {
    const mongoose = require('mongoose');
    const pinned = pinnedBranchId(req);
    if (pinned) return { branch: pinned };
    // Tenant owner using the admin branch switcher passes ?branch=<id>.
    const raw = req?.query?.branch;
    if (raw === 'all') return {};
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) return { branch: raw };
    if (req?.branch?._id) return { $or: [{ branch: null }, { branch: req.branch._id }] };
    return {};
}

exports.createDecorationPackage = async (req, res) => {
    try {
        // Pinned admin owns the decoration package at their branch.
        const pinned = pinnedBranchId(req);
        const ownerBranch = pinned || req.body.branch || null;
        const decorPackage = new DecorationPackage({
            ...req.body,
            restaurant: tenantId(req),
            branch: ownerBranch,
        });
        await decorPackage.save();
        res.status(201).json({ success: true, decorPackage });
    } catch (err) {
        sendServerError(res, err, 'decorationPackageController.createDecorationPackage');
    }
};

exports.getDecorationPackages = async (req, res) => {
    try {
        const decorPackages = await DecorationPackage.find({ isActive: true, ...tenantFilter(req), ...decorationBranchFilter(req) });
        res.status(200).json({ success: true, decorPackages });
    } catch (err) {
        sendServerError(res, err, 'decorationPackageController.getDecorationPackages');
    }
};

exports.getDecorationPackageById = async (req, res) => {
    try {
        const decorPackage = await DecorationPackage.findOne({ _id: req.params.id, ...tenantFilter(req), ...decorationBranchFilter(req) });
        if (!decorPackage) {
            return res.status(404).json({ success: false, message: 'Package not found' });
        }
        res.status(200).json({ success: true, decorPackage });
    } catch (err) {
        sendServerError(res, err, 'decorationPackageController.getDecorationPackageById');
    }
};

exports.updateDecorationPackage = async (req, res) => {
    try {
        const updateData = { ...req.body };
        delete updateData.restaurant;
        if (pinnedBranchId(req)) delete updateData.branch;
        const decorPackage = await DecorationPackage.findOneAndUpdate(
            { _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) },
            updateData,
            // runValidators: the schema refuses negative prices.
            { returnDocument: 'after', runValidators: true }
        );
        if (!decorPackage) {
            return res.status(404).json({ success: false, message: 'Package not found' });
        }
        res.status(200).json({ success: true, decorPackage });
    } catch (err) {
        sendServerError(res, err, 'decorationPackageController.updateDecorationPackage');
    }
};

exports.deleteDecorationPackage = async (req, res) => {
    try {
        const decorPackage = await DecorationPackage.findOneAndDelete({ _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) });
        if (!decorPackage) {
            return res.status(404).json({ success: false, message: 'Package not found' });
        }
        res.status(200).json({ success: true, message: 'Package deleted successfully' });
    } catch (err) {
        sendServerError(res, err, 'decorationPackageController.deleteDecorationPackage');
    }
};

exports.toggleStatus = async (req, res) => {
    try {
        const decorPackage = await DecorationPackage.findOne({ _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) });
        if (!decorPackage) {
            return res.status(404).json({ success: false, message: 'Package not found' });
        }
        decorPackage.isActive = !decorPackage.isActive;
        await decorPackage.save();
        res.status(200).json({ success: true, decorPackage });
    } catch (err) {
        sendServerError(res, err, 'decorationPackageController.toggleStatus');
    }
};

// ── BULK ONBOARDING ──────────────────────────────────────────────────────────
// Mirror of the Tables / Staff / Event Types / Packages / Halls bulk-add
// flow. DecorationPackage requires `name + category + basePrice`; the CSV
// template carries `name, category, basePrice, description, themeStyle, setupTime`.

const DECORATIONS_TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'decorationPackage-master-template.csv');

// GET /api/decoration-packages/template
exports.downloadDecorationPackageTemplate = (req, res) => {
    try {
        if (!fs.existsSync(DECORATIONS_TEMPLATE_PATH)) {
            logger.error('Decoration packages template missing on disk', { path: DECORATIONS_TEMPLATE_PATH });
            return res.status(500).json({ success: false, message: 'Starter template not available' });
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="decorationPackage-master-template.csv"');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(DECORATIONS_TEMPLATE_PATH).pipe(res);
    } catch (error) {
        logger.error('downloadDecorationPackageTemplate error', { error: error.message });
        res.status(500).json({ success: false, message: 'Failed to serve template' });
    }
};

// POST /api/decoration-packages/import
// CSV header: name,category,basePrice,description,themeStyle,setupTime
// Required: name, category, basePrice. Category is a free-form string
// (no enum) — common values: Wedding, Birthday, Anniversary, Corporate, etc.
exports.importDecorationPackagesCsv = async (req, res) => {
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
            // ── Basic Info ─────────────────────────────────────────────
            name:           header.indexOf('name'),
            category:       header.indexOf('category'),
            description:    header.indexOf('description'),
            themestyle:     header.indexOf('themestyle'),
            primarycolor:   header.indexOf('primarycolor'),
            secondarycolor: header.indexOf('secondarycolor'),
            accentcolor:    header.indexOf('accentcolor'),
            // 8 suitableFor flags
            su_indoor:      header.indexOf('suitableforindoor'),
            su_outdoor:     header.indexOf('suitableforoutdoor'),
            su_hall:        header.indexOf('suitableforhall'),
            su_banquet:     header.indexOf('suitableforbanquet'),
            su_garden:      header.indexOf('suitableforgarden'),
            su_terrace:     header.indexOf('suitableforterrace'),
            su_beach:       header.indexOf('suitableforbeach'),
            su_restaurant:  header.indexOf('suitableforrestaurant'),
            minarea:        header.indexOf('minarea'),
            maxarea:        header.indexOf('maxarea'),
            ceilingheight:  header.indexOf('ceilingheight'),
            searchtags:     header.indexOf('searchtags'),
            isfeatured:     header.indexOf('isfeatured'),
            ispopular:      header.indexOf('ispopular'),
            // ── Items & Materials ──────────────────────────────────────
            materialsused:  header.indexOf('materialsused'),
            // ── Setup Details ──────────────────────────────────────────
            setuptime:           header.indexOf('setuptime'),
            advancebookingdays:  header.indexOf('advancebookingdays'),
            waterrequired:       header.indexOf('waterrequired'),
            technicalsupport:    header.indexOf('technicalsupport'),
            onsitesupervision:   header.indexOf('onsitesupervision'),
            numberofcaretakers:  header.indexOf('numberofcaretakers'),
            // ── Pricing ─────────────────────────────────────────────────
            baseprice:           header.indexOf('baseprice'),
            setupcharges:        header.indexOf('setupcharges'),
            dismantlingcharges:  header.indexOf('dismantlingcharges'),
            transportcharges:    header.indexOf('transportcharges'),
            iscustomizable:      header.indexOf('iscustomizable'),
            // ── Add-ons & Restrictions ─────────────────────────────────
            allowcustomization:       header.indexOf('allowcustomization'),
            additionalchargespercent: header.indexOf('additionalchargespercent'),
            re_indooronly:            header.indexOf('restrictionsindooronly'),
            re_outdooronly:           header.indexOf('restrictionsoutdooronly'),
            re_weatherdependent:      header.indexOf('restrictionsweatherdependent'),
            re_firehazard:            header.indexOf('restrictionsfirehazard'),
            re_specialpermission:     header.indexOf('restrictionsspecialpermission'),
            re_notsuitableforkids:    header.indexOf('restrictionsnotsuitableforkids'),
            bestfor:                  header.indexOf('bestfor'),
            notrecommendedfor:        header.indexOf('notrecommendedfor'),
            simultaneousbookings:     header.indexOf('simultaneousbookings'),
            sa_spring:                header.indexOf('seasonalspring'),
            sa_summer:                header.indexOf('seasonalsummer'),
            sa_fall:                  header.indexOf('seasonalfall'),
            sa_winter:                header.indexOf('seasonalwinter'),
            clientnotes:              header.indexOf('clientnotes'),
            // ── Media & Vendor ─────────────────────────────────────────
            images:        header.indexOf('images'),
            vendorname:    header.indexOf('vendorname'),
            vendoremail:   header.indexOf('vendoremail'),
            vendorphone:   header.indexOf('vendorphone'),
            vendorrating:  header.indexOf('vendorrating'),
        };
        const missing = ['name', 'category', 'baseprice'].filter(col => idx[col] === -1);
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `CSV missing required columns: ${missing.map(m => m === 'baseprice' ? 'basePrice' : m).join(', ')}`,
            });
        }

        const existing = new Set(
            (await DecorationPackage.find({
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
            const category    = get('category');
            const priceRaw    = get('baseprice');
            const description = get('description');
            const themeStyle  = get('themestyle');
            const setupTime   = get('setuptime');

            // Skip rows with no name AND no category AND no price — these are
            // typically trailing blanks from Excel exports. Any row with even
            // a partial entry will fall through and surface a clear validation
            // error so the admin knows which field they forgot.
            if (!name && !category && !priceRaw) continue;

            try {
                if (!name)     throw new Error('name is required');
                if (name.length > 120) throw new Error('name must be 120 characters or fewer');
                if (!category) throw new Error('category is required');
                if (!priceRaw) throw new Error('basePrice is required');
                const basePrice = Number(priceRaw);
                if (!Number.isFinite(basePrice) || basePrice < 0) throw new Error('basePrice must be a non-negative number');

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

                // ── Helpers ────────────────────────────────────────────
                // Coerce CSV cell to a boolean (true/yes/y/1/on → true,
                // anything else including blank → false). Used for the
                // 8 suitableFor / 6 restrictions / 4 seasonal flags.
                const toBool = (raw) => /^(true|yes|y|1|on)$/i.test(String(raw || '').trim());
                // Pipe-delimited array. Same convention as Halls/Packages.
                const splitList = (raw) =>
                    raw ? String(raw).split('|').map(s => s.trim()).filter(Boolean) : [];
                // Non-negative number — blank cell → undefined so the
                // schema default (0 / unset) wins instead of forcing 0.
                const toNum = (raw) => {
                    if (!raw && raw !== 0) return undefined;
                    const n = Number(raw);
                    return Number.isFinite(n) && n >= 0 ? n : undefined;
                };

                // Build nested objects only when at least one sub-flag /
                // sub-field exists so the model's defaults stay intact
                // for rows that don't bother filling them in.
                const suitableFor = {
                    Indoor:     toBool(get('su_indoor')),
                    Outdoor:    toBool(get('su_outdoor')),
                    Hall:       toBool(get('su_hall')),
                    Banquet:    toBool(get('su_banquet')),
                    Garden:     toBool(get('su_garden')),
                    Terrace:    toBool(get('su_terrace')),
                    Beach:      toBool(get('su_beach')),
                    Restaurant: toBool(get('su_restaurant')),
                };
                const restrictions = {
                    indoorOnly:         toBool(get('re_indooronly')),
                    outdoorOnly:        toBool(get('re_outdooronly')),
                    weatherDependent:   toBool(get('re_weatherdependent')),
                    fireHazard:         toBool(get('re_firehazard')),
                    specialPermission:  toBool(get('re_specialpermission')),
                    notSuitableForKids: toBool(get('re_notsuitableforkids')),
                };
                // For seasonalAvailability the schema default is `true`
                // (all four seasons). Treat a fully-blank seasonal cluster
                // as "use defaults" and only override when the row
                // actually specified one of the four flags.
                const saSpring = get('sa_spring'), saSummer = get('sa_summer'),
                      saFall = get('sa_fall'), saWinter = get('sa_winter');
                const hasSeasonal = saSpring || saSummer || saFall || saWinter;
                const seasonalAvailability = hasSeasonal ? {
                    spring: toBool(saSpring),
                    summer: toBool(saSummer),
                    fall:   toBool(saFall),
                    winter: toBool(saWinter),
                } : undefined;

                const searchTags       = splitList(get('searchtags'));
                const materialsUsed    = splitList(get('materialsused'));
                const bestFor          = splitList(get('bestfor'));
                const notRecommendedFor= splitList(get('notrecommendedfor'));
                const images           = splitList(get('images'));

                toInsert.push({
                    name,
                    category,
                    basePrice,
                    description: description || undefined,
                    themeStyle:  themeStyle  || undefined,
                    setupTime:   setupTime   || undefined,
                    // Basic Info — extras
                    primaryColor:   get('primarycolor')   || undefined,
                    secondaryColor: get('secondarycolor') || undefined,
                    accentColor:    get('accentcolor')    || undefined,
                    suitableFor,
                    minArea:       toNum(get('minarea')),
                    maxArea:       toNum(get('maxarea')),
                    ceilingHeight: toNum(get('ceilingheight')),
                    searchTags:    searchTags.length ? searchTags : undefined,
                    isFeatured:    toBool(get('isfeatured')),
                    isPopular:     toBool(get('ispopular')),
                    // Items & Materials
                    materialsUsed: materialsUsed.length ? materialsUsed : undefined,
                    // Setup Details
                    advanceBookingDays: toNum(get('advancebookingdays')),
                    waterRequired:      toBool(get('waterrequired')),
                    technicalSupport:   toBool(get('technicalsupport')),
                    onSiteSupervision:  toBool(get('onsitesupervision')),
                    numberOfCaretakers: toNum(get('numberofcaretakers')),
                    // Pricing extras
                    setupCharges:       toNum(get('setupcharges')),
                    dismantlingCharges: toNum(get('dismantlingcharges')),
                    transportCharges:   toNum(get('transportcharges')),
                    isCustomizable:     toBool(get('iscustomizable')),
                    // Add-ons & Restrictions
                    allowCustomization:       toBool(get('allowcustomization')),
                    additionalChargesPercent: toNum(get('additionalchargespercent')),
                    restrictions,
                    bestFor:           bestFor.length ? bestFor : undefined,
                    notRecommendedFor: notRecommendedFor.length ? notRecommendedFor : undefined,
                    simultaneousBookings: toNum(get('simultaneousbookings')),
                    ...(seasonalAvailability ? { seasonalAvailability } : {}),
                    clientNotes: get('clientnotes') || undefined,
                    // Media & Vendor
                    images:      images.length ? images : undefined,
                    vendorName:  get('vendorname')  || undefined,
                    vendorEmail: get('vendoremail') || undefined,
                    vendorPhone: get('vendorphone') || undefined,
                    vendorRating: toNum(get('vendorrating')),
                    // System
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
                const inserted = await DecorationPackage.insertMany(toInsert, { ordered: false });
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
        logger.error('importDecorationPackagesCsv error', { error: error.message });
        return res.status(500).json({ success: false, message: 'Failed to import decoration packages CSV' });
    }
};
