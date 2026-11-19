// Delegated super-admin users ("platform staff") — PLATFORM_STAFF_PLAN.md.
// Every route here is full-super-admin only (routes/superadminRoute.js); platform
// staff themselves can never reach it (platformStaffGate denies by default).
const mongoose = require('mongoose');
const User = require('../../models/user');
const AuditLog = require('../../models/auditLog');
const { recordAudit } = require('../../utils/audit');
const { sendEmail } = require('../../utils/email');
const { platformStaffWelcome } = require('../../utils/emailTemplates');
const logger = require('../../utils/logger');
const { MODULES, parseAccess, describeCatalog } = require('../../config/platformModules');
const { generateTempPassword } = require('./_shared');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_FIELDS = 'name email status platformAccess mustChangePassword createdAt updatedAt';

const cleanName = (v) => (typeof v === 'string' ? v.trim() : '');
const isId = (v) => mongoose.isValidObjectId(v);

/** Latest sign-in and latest action per staff member, for the list view. */
async function activitySummary(ids) {
    if (!ids.length) return new Map();
    const rows = await AuditLog.aggregate([
        { $match: { actor: { $in: ids } } },
        {
            $group: {
                _id: '$actor',
                lastActivityAt: { $max: '$createdAt' },
                lastLoginAt: { $max: { $cond: [{ $eq: ['$action', 'platformstaff.login'] }, '$createdAt', null] } },
                actions: { $sum: 1 },
            },
        },
    ]);
    return new Map(rows.map((r) => [String(r._id), r]));
}

const shape = (u, sum) => ({
    _id: u._id,
    name: u.name,
    email: u.email,
    status: u.status,
    modules: u.platformAccess || {},
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt,
    lastLoginAt: sum?.lastLoginAt || null,
    lastActivityAt: sum?.lastActivityAt || null,
    actionCount: sum?.actions || 0,
});

async function findStaff(id) {
    if (!isId(id)) return null;
    return User.findOne({ _id: id, role: 'platformstaff' });
}

const moduleLabels = (access) => Object.keys(access).map((k) => `${MODULES[k]?.label || k} (${access[k]})`);

async function emailCredentials(user, tempPassword) {
    try {
        const r = await sendEmail({
            to: user.email,
            ...platformStaffWelcome({
                name: user.name,
                email: user.email,
                tempPassword,
                moduleLabels: moduleLabels(user.platformAccess || {}),
            }),
        });
        return !!r?.sent;
    } catch (err) {
        logger.warn('platform staff welcome email failed: ' + err.message);
        return false;
    }
}

// GET /superadmin/platform-staff/modules
exports.listModules = (_req, res) => res.json({ success: true, modules: describeCatalog() });

// GET /superadmin/platform-staff
exports.listStaff = async (_req, res) => {
    try {
        const users = await User.find({ role: 'platformstaff' }).select(PUBLIC_FIELDS).sort({ createdAt: -1 }).lean();
        const sums = await activitySummary(users.map((u) => u._id));
        return res.json({ success: true, staff: users.map((u) => shape(u, sums.get(String(u._id)))) });
    } catch (err) {
        logger.error('listStaff error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list team members' });
    }
};

// GET /superadmin/platform-staff/:id
exports.getStaff = async (req, res) => {
    try {
        const u = await findStaff(req.params.id);
        if (!u) return res.status(404).json({ success: false, message: 'Team member not found' });
        const sums = await activitySummary([u._id]);
        return res.json({ success: true, staff: shape(u.toObject(), sums.get(String(u._id))) });
    } catch (err) {
        logger.error('getStaff error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load team member' });
    }
};

// POST /superadmin/platform-staff  { name, email, modules }
exports.createStaff = async (req, res) => {
    try {
        const name = cleanName(req.body?.name);
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (name.length < 2 || name.length > 80) {
            return res.status(400).json({ success: false, message: 'Name must be 2-80 characters' });
        }
        if (!EMAIL_RE.test(email) || email.length > 254) {
            return res.status(400).json({ success: false, message: 'A valid email is required' });
        }
        const access = parseAccess(req.body?.modules);
        if (access.error) return res.status(400).json({ success: false, message: access.error });

        // The same email on ANY account (customer, tenant staff, super admin) is refused: login
        // resolves portal accounts globally, so a shared email would make sign-in ambiguous.
        if (await User.exists({ email })) {
            return res.status(409).json({ success: false, message: 'An account with this email already exists' });
        }

        const tempPassword = generateTempPassword();
        const user = await User.create({
            name,
            email,
            password: tempPassword,          // hashed by the pre-save hook
            role: 'platformstaff',
            platformAccess: access.value,
            createdByPlatform: req.user._id,
            mustChangePassword: true,
            status: 'active',
        });

        await recordAudit(req, {
            action: 'platformstaff.create',
            targetType: 'user',
            targetId: user._id,
            targetName: user.email,
            details: { name, modules: access.value },
        });
        const emailed = await emailCredentials(user, tempPassword);

        return res.status(201).json({
            success: true,
            staff: shape(user.toObject(), null),
            tempPassword,                    // shown once; never stored in clear and redacted from the audit row
            emailed,
        });
    } catch (err) {
        if (err?.code === 11000) {
            return res.status(409).json({ success: false, message: 'An account with this email already exists' });
        }
        logger.error('createStaff error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create team member' });
    }
};

// PATCH /superadmin/platform-staff/:id  { name?, modules?, status? }
exports.updateStaff = async (req, res) => {
    try {
        const u = await findStaff(req.params.id);
        if (!u) return res.status(404).json({ success: false, message: 'Team member not found' });

        const before = { name: u.name, status: u.status, modules: u.platformAccess || {} };
        const body = req.body || {};

        if (body.name !== undefined) {
            const n = cleanName(body.name);
            if (n.length < 2 || n.length > 80) {
                return res.status(400).json({ success: false, message: 'Name must be 2-80 characters' });
            }
            u.name = n;
        }
        if (body.modules !== undefined) {
            const a = parseAccess(body.modules);
            if (a.error) return res.status(400).json({ success: false, message: a.error });
            u.platformAccess = a.value;
            u.markModified('platformAccess');
        }
        let statusChange = null;
        if (body.status !== undefined) {
            if (!['active', 'inactive'].includes(body.status)) {
                return res.status(400).json({ success: false, message: 'status must be active or inactive' });
            }
            if (body.status !== u.status) {
                statusChange = body.status === 'inactive' ? 'deactivate' : 'reactivate';
                u.status = body.status;
                // Deactivation ends every session (access + refresh tokens) at once.
                if (body.status === 'inactive') u.tokenVersion = (u.tokenVersion || 0) + 1;
            }
        }
        await u.save();

        await recordAudit(req, {
            action: statusChange ? `platformstaff.${statusChange}` : 'platformstaff.update',
            targetType: 'user',
            targetId: u._id,
            targetName: u.email,
            details: { before, after: { name: u.name, status: u.status, modules: u.platformAccess || {} } },
        });
        const sums = await activitySummary([u._id]);
        return res.json({ success: true, staff: shape(u.toObject(), sums.get(String(u._id))) });
    } catch (err) {
        logger.error('updateStaff error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update team member' });
    }
};

// POST /superadmin/platform-staff/:id/reset-password
exports.resetStaffPassword = async (req, res) => {
    try {
        const u = await findStaff(req.params.id);
        if (!u) return res.status(404).json({ success: false, message: 'Team member not found' });

        const tempPassword = generateTempPassword();
        u.password = tempPassword;
        u.mustChangePassword = true;
        u.tokenVersion = (u.tokenVersion || 0) + 1;     // signs them out everywhere
        await u.save();

        await recordAudit(req, {
            action: 'platformstaff.reset_password',
            targetType: 'user',
            targetId: u._id,
            targetName: u.email,
        });
        const emailed = await emailCredentials(u, tempPassword);
        return res.json({ success: true, tempPassword, emailed });
    } catch (err) {
        logger.error('resetStaffPassword error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
};

// GET /superadmin/platform-staff/:id/activity?page&limit&from&to&action
exports.staffActivity = async (req, res) => {
    try {
        const u = await findStaff(req.params.id);
        if (!u) return res.status(404).json({ success: false, message: 'Team member not found' });

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const filter = { actor: u._id };
        if (typeof req.query.action === 'string' && req.query.action) filter.action = req.query.action;
        const range = {};
        for (const [q, op] of [['from', '$gte'], ['to', '$lte']]) {
            const d = req.query[q] ? new Date(req.query[q]) : null;
            if (d && !Number.isNaN(d.getTime())) range[op] = d;
        }
        if (Object.keys(range).length) filter.createdAt = range;

        const [items, total] = await Promise.all([
            AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            AuditLog.countDocuments(filter),
        ]);
        return res.json({
            success: true,
            data: items,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (err) {
        logger.error('staffActivity error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load activity' });
    }
};
