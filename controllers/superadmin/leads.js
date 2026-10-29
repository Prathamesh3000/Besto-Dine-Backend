// Split out of controllers/superadminController.js (task 4.7). Behaviour unchanged.
const mongoose = require('mongoose');
const Lead = require('../../models/lead');
const { recordAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

const LEAD_STATUSES = ['new', 'contacted', 'demoed', 'converted', 'lost'];

// GET /api/v1/superadmin/leads?status=&search=&page=&limit=
exports.listLeads = async (req, res) => {
    try {
        const { status, search } = req.query;
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        const filter = {};
        if (status && LEAD_STATUSES.includes(status)) filter.status = status;
        if (search && search.trim()) {
            const esc = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(esc, 'i');
            filter.$or = [{ name: rx }, { restaurantName: rx }, { phone: rx }, { email: rx }];
        }

        const [leads, total, statusAgg] = await Promise.all([
            // AUDIT-EXEMPT: global pre-tenant lead — no restaurant scope by design.
            Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            Lead.countDocuments(filter),
            Lead.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        ]);

        // Per-status counts for filter chips + the "new" nav badge.
        const counts = { all: 0, new: 0, contacted: 0, demoed: 0, converted: 0, lost: 0 };
        for (const row of statusAgg) {
            if (counts[row._id] !== undefined) counts[row._id] = row.n;
            counts.all += row.n;
        }

        return res.status(200).json({
            success: true,
            data: {
                leads,
                counts,
                pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
            },
        });
    } catch (err) {
        logger.error('listLeads error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load leads' });
    }
};

// GET /api/v1/superadmin/leads/:id
exports.getLead = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid lead id' });
        }
        // AUDIT-EXEMPT: global pre-tenant lead.
        const lead = await Lead.findById(id)
            .populate({ path: 'notes.createdBy', select: 'name email' })
            .populate({ path: 'convertedToRestaurant', select: 'name slug status' })
            .lean();
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
        return res.status(200).json({ success: true, data: lead });
    } catch (err) {
        logger.error('getLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load lead' });
    }
};

// PATCH /api/v1/superadmin/leads/:id   { status?, note?, convertedToRestaurant? }
// One endpoint handles status transitions, appending a note, and linking a
// converted restaurant. The frontend "Convert" button creates the Restaurant
// via the existing create flow, then PATCHes the lead with
// { status: 'converted', convertedToRestaurant: <newId> }.
exports.updateLead = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid lead id' });
        }
        // AUDIT-EXEMPT: global pre-tenant lead.
        const lead = await Lead.findById(id);
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

        const { status, note, convertedToRestaurant } = req.body || {};
        const changed = {};

        if (status !== undefined) {
            if (!LEAD_STATUSES.includes(status)) {
                return res.status(400).json({ success: false, message: 'Invalid status' });
            }
            changed.status = { from: lead.status, to: status };
            lead.status = status;
            if (status === 'converted' && !lead.convertedAt) lead.convertedAt = new Date();
        }

        if (convertedToRestaurant !== undefined) {
            if (convertedToRestaurant && !mongoose.isValidObjectId(convertedToRestaurant)) {
                return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
            }
            lead.convertedToRestaurant = convertedToRestaurant || undefined;
            if (convertedToRestaurant && lead.status !== 'converted') {
                lead.status = 'converted';
                lead.convertedAt = new Date();
                changed.status = { from: changed.status?.from ?? lead.status, to: 'converted' };
            }
        }

        if (note !== undefined && String(note).trim()) {
            lead.notes.push({ text: String(note).trim().slice(0, 1000), createdBy: req.user._id });
            changed.noteAdded = true;
        }

        if (Object.keys(changed).length === 0) {
            return res.status(400).json({ success: false, message: 'Nothing to update' });
        }

        await lead.save();

        await recordAudit(req, {
            action: 'lead.update',
            targetType: '',
            targetId: lead._id,
            targetName: lead.restaurantName,
            details: changed,
        });

        return res.status(200).json({ success: true, data: lead });
    } catch (err) {
        logger.error('updateLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update lead' });
    }
};

// DELETE /api/v1/superadmin/leads/:id  — spam cleanup (full superadmins only)
exports.deleteLead = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid lead id' });
        }
        // AUDIT-EXEMPT: global pre-tenant lead.
        const lead = await Lead.findByIdAndDelete(id);
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

        await recordAudit(req, {
            action: 'lead.delete',
            targetType: '',
            targetId: lead._id,
            targetName: lead.restaurantName,
            details: { phone: lead.phone, source: lead.source },
        });

        return res.status(200).json({ success: true, message: 'Lead deleted' });
    } catch (err) {
        logger.error('deleteLead error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete lead' });
    }
};
