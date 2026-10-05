const mongoose = require('mongoose');
const Shift = require('../models/shift');
const { runShiftAutoClose } = require('../utils/shiftAutoCloser');
const { getIO, emitToAdmin } = require('../utils/socket');

const User = require('../models/user');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const EVENTS = require('../realtime/events');

// Roles that own attendance (mirrors authMiddleware.staffOnly, which
// guards the clock-in / clock-out routes; re-checked here as defence in
// depth so customers / superadmins can never write a Shift).
const SHIFT_ROLES = new Set(['waiter', 'captain', 'chef', 'manager', 'admin']);

/**
 * Branch gate for admin actions on another staff member's shifts.
 * Shift has no branch field, so a branch-pinned admin may only act on
 * staff whose User.branch is their pinned branch. Returns null when the
 * caller is allowed (tenant-wide admins always are), otherwise the
 * { status, message } to send: 404 for an unknown staff id, 403 for
 * staff of another branch.
 */
async function staffBranchDenial(req, staffId) {
    const pinned = pinnedBranchId(req);
    if (!pinned) return null;
    const staff = await User.findOne({ _id: staffId, ...tenantFilter(req) }).select('branch').lean();
    if (!staff) return { status: 404, message: 'Staff member not found' };
    if (String(staff.branch || '') !== String(pinned)) {
        return { status: 403, message: 'Staff member does not belong to your branch.' };
    }
    return null;
}

// WAI-029 — broadcast a duty change so the admin staff dashboard can
// re-query without waiting for React Query's 60s staleTime. Best-effort:
// any failure is swallowed (the next page load / poll will reconcile).
const emitDutyChanged = (req, staff, kind) => {
    try {
        const io = getIO();
        const branch = staff?.branch || req.user?.branch?._id || req.user?.branch || null;
        const payload = {
            staffId: String(staff?._id || req.user?._id || ''),
            kind, // 'clock-in' | 'clock-out' | 'force-clock-out' | 'auto-close'
            at: new Date().toISOString(),
        };
        emitToAdmin(io, branch, EVENTS.STAFF_DUTY_CHANGED, payload);
    } catch { /* socket not initialised yet — skip */ }
};

// GET /api/shifts/my — Get current user's shifts
exports.getMyShifts = async (req, res) => {
    try {
        const staffId = req.user._id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const skip = (page - 1) * limit;

        const filter = { staff: staffId, ...tenantFilter(req) };

        const totalCount = await Shift.countDocuments(filter);
        const shifts = await Shift.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        // Current active shift
        const activeShift = shifts.find(s => s.status === 'active');

        // Today's shifts
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayShifts = shifts.filter(s => new Date(s.clockIn) >= todayStart);

        // This week's total hours
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const weekShifts = shifts.filter(s => new Date(s.clockIn) >= weekStart);
        const weeklyHours = weekShifts.reduce((sum, s) => sum + (s.totalHours || 0), 0);

        // Calculate active shift duration if one exists
        let activeHours = 0;
        if (activeShift) {
            activeHours = (Date.now() - new Date(activeShift.clockIn).getTime()) / 3600000;
        }

        res.status(200).json({
            success: true,
            activeShift: activeShift || null,
            stats: {
                todayShifts: todayShifts.length,
                todayHours: todayShifts.reduce((sum, s) => sum + (s.totalHours || 0), 0) + activeHours,
                weeklyHours: Math.round((weeklyHours + activeHours) * 100) / 100,
                totalShifts: shifts.length,
            },
            pagination: {
                page,
                limit,
                totalCount,
                totalPages: Math.ceil(totalCount / limit),
            },
            shifts: shifts.map(s => ({
                _id: s._id,
                status: s.status,
                clockIn: s.clockIn,
                clockOut: s.clockOut,
                totalHours: s.totalHours,
                note: s.note,
                date: new Date(s.clockIn).toLocaleDateString('en-GB'),
                inTime: new Date(s.clockIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                outTime: s.clockOut ? new Date(s.clockOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
            })),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch shifts' });
    }
};

// ADM-070 — GET /api/shifts/staff/:userId — admin view of a single
// staff member's shift history. Mirrors getMyShifts' response shape so
// the admin drawer can render the same row format the waiter's own
// shift page uses. Tenant-scoped: an admin from tenant A can't fetch
// staff from tenant B.
exports.getStaffShifts = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid staff id' });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 30, 200);
        const skip = (page - 1) * limit;

        const denied = await staffBranchDenial(req, userId);
        if (denied) return res.status(denied.status).json({ success: false, message: denied.message });

        const filter = { staff: userId, ...tenantFilter(req) };
        const totalCount = await Shift.countDocuments(filter);
        const shifts = await Shift.find(filter)
            .sort({ clockIn: -1 })
            .skip(skip)
            .limit(limit);

        const activeShift = shifts.find(s => s.status === 'active');
        let activeHours = 0;
        if (activeShift) {
            activeHours = (Date.now() - new Date(activeShift.clockIn).getTime()) / 3600000;
        }
        const completedHours = shifts.reduce((sum, s) => sum + (s.totalHours || 0), 0);

        res.status(200).json({
            success: true,
            activeShift: activeShift || null,
            stats: {
                totalShifts: totalCount,
                totalHours: Math.round((completedHours + activeHours) * 100) / 100,
            },
            pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
            shifts: shifts.map(s => ({
                _id: s._id,
                status: s.status,
                clockIn: s.clockIn,
                clockOut: s.clockOut,
                totalHours: s.totalHours,
                note: s.note,
                date: new Date(s.clockIn).toLocaleDateString('en-GB'),
                inTime: new Date(s.clockIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                outTime: s.clockOut ? new Date(s.clockOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null,
            })),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch shifts' });
    }
};

// POST /api/shifts/clock-in — Start a shift
exports.clockIn = async (req, res) => {
    try {
        if (!SHIFT_ROLES.has(req.user?.role)) {
            return res.status(403).json({ success: false, message: 'Only staff can clock in.' });
        }
        if (!tenantId(req)) {
            return res.status(400).json({ success: false, code: 'TENANT_REQUIRED', message: 'Restaurant context required.' });
        }
        const staffId = req.user._id;

        // "Active shift" check is per-tenant: if a staff member ever
        // gets reassigned, they can still clock in at the new tenant
        // without the old tenant's dangling active shift blocking them.
        const existing = await Shift.findOne({
            staff: staffId,
            status: 'active',
            ...tenantFilter(req),
        });
        if (existing) {
            return res.status(400).json({ success: false, message: 'You already have an active shift' });
        }

        // The unique partial index { restaurant, staff } where
        // status:'active' (models/shift.js) makes concurrent clock-ins
        // safe: only one insert wins, the rest get E11000 → 400.
        let shift;
        try {
            shift = await Shift.create({
                staff: staffId,
                clockIn: new Date(),
                status: 'active',
                restaurant: tenantId(req),
            });
        } catch (err) {
            if (err?.code === 11000) {
                return res.status(400).json({ success: false, message: 'You already have an active shift' });
            }
            throw err;
        }

        emitDutyChanged(req, req.user, 'clock-in');
        res.status(201).json({ success: true, shift });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to clock in' });
    }
};

// POST /api/shifts/:id/force-clockout — Admin override to close someone
// else's stuck active shift. Used when a waiter forgot to clock out and
// the auto-closer hasn't fired yet, or when the threshold is too long
// for an immediate fix.
exports.forceClockOut = async (req, res) => {
    try {
        const { id } = req.params;
        const { note } = req.body || {};
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid shift id' });
        }

        const shift = await Shift.findOne({ _id: id, ...tenantFilter(req) });
        if (!shift) {
            return res.status(404).json({ success: false, message: 'Shift not found' });
        }
        const denied = await staffBranchDenial(req, shift.staff);
        if (denied) {
            // A shift whose staff row is gone is still out of a pinned admin's reach.
            return res.status(403).json({ success: false, message: 'Staff member does not belong to your branch.' });
        }
        if (shift.status !== 'active') {
            return res.status(400).json({ success: false, message: 'Shift is not active' });
        }

        const now = new Date();
        shift.clockOut = now;
        shift.status = 'completed';
        shift.totalHours = Math.round(((now - shift.clockIn) / 3600000) * 100) / 100;

        const actor = req.user?.name || req.user?.email || 'admin';
        const audit = `[Force-closed by ${actor}${note ? ': ' + note : ''}]`;
        shift.note = shift.note ? `${shift.note}\n${audit}` : audit;

        await shift.save();
        emitDutyChanged(req, { _id: shift.staff, branch: shift.branch || req.user?.branch }, 'force-clock-out');
        return res.status(200).json({ success: true, shift });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to force clock out' });
    }
};

// POST /api/shifts/admin/run-autoclose — Manual trigger for the
// auto-closer sweep. Used by external cron in multi-instance setups
// where SHIFT_AUTOCLOSE_DISABLED=true, and as an emergency button for
// admins who want to flush abandoned shifts immediately.
exports.runAutoCloseNow = async (req, res) => {
    try {
        // Scoped to the caller's tenant — an admin must never close other
        // restaurants' shifts.
        const summary = await runShiftAutoClose({ restaurant: req.restaurant });
        return res.status(200).json({ success: true, summary });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to run shift auto-close' });
    }
};

// POST /api/shifts/clock-out — End active shift
exports.clockOut = async (req, res) => {
    try {
        if (!SHIFT_ROLES.has(req.user?.role)) {
            return res.status(403).json({ success: false, message: 'Only staff can clock out.' });
        }
        const staffId = req.user._id;
        const { note } = req.body || {};

        const shift = await Shift.findOne({
            staff: staffId,
            status: 'active',
            ...tenantFilter(req),
        });
        if (!shift) {
            return res.status(400).json({ success: false, message: 'No active shift found' });
        }

        shift.clockOut = new Date();
        shift.status = 'completed';
        shift.totalHours = Math.round(((shift.clockOut - shift.clockIn) / 3600000) * 100) / 100;
        if (note) shift.note = note;
        await shift.save();

        emitDutyChanged(req, req.user, 'clock-out');
        res.status(200).json({ success: true, shift });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to clock out' });
    }
};
