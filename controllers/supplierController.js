const mongoose = require('mongoose');
const Supplier = require('../models/supplier');
const PurchaseOrder = require('../models/purchaseOrder');
const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Procurement master data (suppliers / POs / production) follows MENU
// semantics, not Inventory: branch:null means "shared with all branches"
// (a vendor serves every location), so a branch view shows that branch's
// own records PLUS shared ones. Uses `$in` (not `$or`) so it composes with
// a search `$or` without key collision. Pinned sub-admins still never see
// OTHER branches' records.
function branchScopeFilter(req) {
    const pinned = pinnedBranchId(req);
    const raw = req?.query?.branch;
    let bid = null;
    if (pinned) bid = pinned._id || pinned;
    else if (raw && raw !== 'all' && mongoose.isValidObjectId(raw)) bid = raw;
    else if (req?.branch) bid = req.branch._id || req.branch;
    if (!bid) return {};
    return { branch: { $in: [new mongoose.Types.ObjectId(String(bid)), null] } };
}
const branchFilter = (req) => branchScopeFilter(req);

// Per-tenant SUP-### serial generator (mirrors inventory generateNextId).
const generateNextCode = async (req, retries = 3) => {
    const tf = tenantFilter(req);
    for (let attempt = 0; attempt < retries; attempt++) {
        const last = await Supplier.findOne(tf).sort({ code: -1 });
        let next = 'SUP-001';
        if (last && last.code) {
            const num = parseInt(last.code.split('-')[1], 10) + 1;
            next = `SUP-${num.toString().padStart(3, '0')}`;
        }
        const exists = await Supplier.findOne({ code: next, ...tf });
        if (!exists) return next;
    }
    return `SUP-${Date.now().toString(36).toUpperCase()}`;
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function validate(body) {
    const errors = [];
    if (!body.name || !String(body.name).trim()) errors.push('Supplier name is required');
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.push('Invalid email');
    if (body.mobile && !/^[0-9+\-\s()]{6,15}$/.test(body.mobile)) errors.push('Invalid mobile number');
    if (body.gstNumber && !GSTIN_RE.test(String(body.gstNumber).trim().toUpperCase())) errors.push('Enter a valid 15-character GSTIN, e.g. 27ABCDE1234F1Z5');
    if (body.paymentTermsDays !== undefined && (isNaN(Number(body.paymentTermsDays)) || Number(body.paymentTermsDays) < 0)) {
        errors.push('Payment terms (days) must be 0 or greater');
    }
    return errors;
}

// GET /api/v1/suppliers — list with derived outstanding balance.
exports.list = asyncHandler(async (req, res) => {
    const { search, active } = req.query;
    const filter = { ...tenantFilter(req), ...branchFilter(req) };
    if (active === 'true') filter.isActive = true;
    else if (active === 'false') filter.isActive = false;
    if (search) {
        const safe = escapeRegex(search.trim());
        filter.$or = [
            { name: { $regex: safe, $options: 'i' } },
            { code: { $regex: safe, $options: 'i' } },
            { contactPerson: { $regex: safe, $options: 'i' } },
            { mobile: { $regex: safe, $options: 'i' } },
        ];
    }

    const suppliers = await Supplier.find(filter).sort({ createdAt: -1 }).populate('branch', 'name').lean();

    // Derive per-supplier outstanding (grandTotal - amountPaid across
    // non-cancelled POs) so the figure can never drift.
    const ids = suppliers.map(s => s._id);
    const owed = await PurchaseOrder.aggregate([
        { $match: { ...tenantFilter(req), supplier: { $in: ids }, status: { $ne: 'cancelled' } } },
        { $group: {
            _id: '$supplier',
            outstanding: { $sum: { $subtract: ['$grandTotal', '$amountPaid'] } },
            poCount: { $sum: 1 },
            totalBilled: { $sum: '$grandTotal' },
        } },
    ]);
    const owedMap = Object.fromEntries(owed.map(o => [String(o._id), o]));

    const enriched = suppliers.map(s => {
        const o = owedMap[String(s._id)] || { outstanding: 0, poCount: 0, totalBilled: 0 };
        return {
            ...s,
            outstanding: Math.round((o.outstanding || 0) * 100) / 100,
            poCount: o.poCount || 0,
            totalBilled: Math.round((o.totalBilled || 0) * 100) / 100,
        };
    });

    res.json({ success: true, suppliers: enriched });
}, 'Failed to fetch suppliers');

// GET /api/v1/suppliers/next-code
exports.nextCode = asyncHandler(async (req, res) => {
    res.json({ success: true, code: await generateNextCode(req) });
}, 'Failed to generate code');

// GET /api/v1/suppliers/:id
exports.getOne = asyncHandler(async (req, res) => {
    const supplier = await Supplier.findOne({ _id: req.params.id, ...tenantFilter(req), ...branchFilter(req) })
        .populate('branch', 'name').lean();
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

    const pos = await PurchaseOrder.find({ supplier: supplier._id, ...tenantFilter(req) })
        .sort({ createdAt: -1 }).limit(20)
        .select('poNumber orderDate grandTotal amountPaid paymentStatus status').lean();
    const outstanding = pos.filter(p => p.status !== 'cancelled')
        .reduce((s, p) => s + (p.grandTotal - p.amountPaid), 0);

    res.json({ success: true, supplier: { ...supplier, outstanding: Math.round(outstanding * 100) / 100 }, purchaseOrders: pos });
}, 'Failed to fetch supplier');

// POST /api/v1/suppliers
exports.create = async (req, res) => {
    try {
        const errors = validate(req.body);
        if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

        const tf = tenantFilter(req);
        const safe = escapeRegex(String(req.body.name).trim());
        const dup = await Supplier.findOne({ name: { $regex: new RegExp(`^${safe}$`, 'i') }, ...tf });
        if (dup) return res.status(400).json({ success: false, message: 'A supplier with this name already exists' });

        // Branch: pinned admin forced to own branch; owner may pass
        // body.branch, else inherit the branch they're currently viewing
        // (req.branch) so the new supplier is visible in that scope — same
        // model as Inventory's strictBranchFilter.
        let branchId = pinnedBranchId(req) || null;
        if (!branchId && req.body.branch && mongoose.isValidObjectId(req.body.branch)) {
            const Branch = require('../models/branch');
            if (await Branch.exists({ _id: req.body.branch, ...tf, isActive: true })) branchId = req.body.branch;
        }
        if (!branchId && req.branch) branchId = req.branch._id || req.branch;

        const code = await generateNextCode(req);
        const supplier = await Supplier.create({
            restaurant: tenantId(req),
            branch: branchId,
            code,
            name: String(req.body.name).trim(),
            contactPerson: req.body.contactPerson || '',
            mobile: req.body.mobile || '',
            email: req.body.email || '',
            gstNumber: req.body.gstNumber || '',
            address: req.body.address || '',
            paymentTermsDays: Number(req.body.paymentTermsDays) || 0,
            categories: Array.isArray(req.body.categories) ? req.body.categories.filter(Boolean) : [],
            notes: req.body.notes || '',
        });
        res.status(201).json({ success: true, supplier });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ success: false, message: 'Duplicate supplier code — try again' });
        res.status(500).json({ success: false, message: 'Failed to create supplier', ...devError(err) });
    }
};

// PUT /api/v1/suppliers/:id
exports.update = asyncHandler(async (req, res) => {
    const errors = validate({ ...req.body, name: req.body.name ?? 'x' });
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const tf = tenantFilter(req);
    const supplier = await Supplier.findOne({ _id: req.params.id, ...tf });
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

    if (req.body.name && req.body.name.trim().toLowerCase() !== supplier.name.toLowerCase()) {
        const safe = escapeRegex(req.body.name.trim());
        const dup = await Supplier.findOne({ _id: { $ne: supplier._id }, name: { $regex: new RegExp(`^${safe}$`, 'i') }, ...tf });
        if (dup) return res.status(400).json({ success: false, message: 'A supplier with this name already exists' });
    }

    const fields = ['name', 'contactPerson', 'mobile', 'email', 'gstNumber', 'address', 'notes'];
    fields.forEach(f => { if (req.body[f] !== undefined) supplier[f] = typeof req.body[f] === 'string' ? req.body[f].trim() : req.body[f]; });
    if (req.body.paymentTermsDays !== undefined) supplier.paymentTermsDays = Number(req.body.paymentTermsDays) || 0;
    if (req.body.categories !== undefined) supplier.categories = Array.isArray(req.body.categories) ? req.body.categories.filter(Boolean) : [];
    if (req.body.isActive !== undefined) supplier.isActive = !!req.body.isActive;

    await supplier.save();
    res.json({ success: true, supplier });
}, 'Failed to update supplier');

// DELETE /api/v1/suppliers/:id — blocks if open POs reference it.
exports.remove = asyncHandler(async (req, res) => {
    const tf = tenantFilter(req);
    const supplier = await Supplier.findOne({ _id: req.params.id, ...tf });
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

    const openPo = await PurchaseOrder.countDocuments({ supplier: supplier._id, ...tf, status: { $nin: ['received', 'cancelled'] } });
    if (openPo > 0) {
        return res.status(400).json({ success: false, message: `Cannot delete — ${openPo} open purchase order(s) reference this supplier. Deactivate instead.` });
    }
    await Supplier.deleteOne({ _id: supplier._id, ...tf });
    res.json({ success: true, message: 'Supplier deleted' });
}, 'Failed to delete supplier');
