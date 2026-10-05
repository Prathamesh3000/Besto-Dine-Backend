const Reservation = require('../models/reservation');
const Table = require('../models/table');
const logger = require('../utils/logger');
const { notify } = require('../services/notificationService');
const { getSettings } = require('../utils/settingsCache');

const { tenantFilter, tenantId, strictBranchFilter } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');

// Create a new reservation
const createReservation = async (req, res) => {
    try {
        const { guestName, contactNo, date, time, guestCount, selectedArea, selectedTable, notes } = req.body;

        // Basic validation
        if (!guestName || !contactNo || !time || !guestCount || !selectedArea || !selectedTable) {
            return res.status(400).json({ success: false, message: 'All fields except notes are required' });
        }
        // Guest count sanity — staff typo guard.
        const gc = Number(guestCount);
        if (!Number.isFinite(gc) || gc < 1 || gc > 200) {
            return res.status(400).json({ success: false, message: 'Guest count must be between 1 and 200' });
        }
        // Reject reservations in the past — date+time combined.
        if (date) {
            const when = new Date(date);
            if (Number.isNaN(when.getTime())) {
                return res.status(400).json({ success: false, message: 'Invalid reservation date' });
            }
            // Allow today bookings (compare at start-of-day granularity) — staff
            // legitimately book tables for the same evening.
            const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
            if (when < startOfDay) {
                return res.status(400).json({ success: false, message: 'Cannot reserve a date in the past' });
            }
        }

        // Check if table exists (scoped to tenant)
        const tf = tenantFilter(req);
        const table = await Table.findOne({ _id: selectedTable, ...tf });
        if (!table) {
            return res.status(404).json({ success: false, message: 'Table not found' });
        }

        // Guest count vs table capacity — over-booking guard.
        if (table.capacity && gc > table.capacity) {
            return res.status(400).json({
                success: false,
                message: `Selected table seats ${table.capacity}. Pick a bigger table or split into multiple reservations.`,
            });
        }

        // If table is disabled, prevent it
        if (table.status === 'disabled') {
            return res.status(400).json({ success: false, message: 'Cannot reserve a disabled table.' });
        }

        // Atomically claim the table (prevents double-booking under concurrent requests)
        const claimedTable = await Table.findOneAndUpdate(
            { _id: selectedTable, status: { $in: ['free', 'merged'] }, ...tf },
            { $set: { status: 'reserved' } },
            { returnDocument: 'after' }
        );
        if (!claimedTable) {
            return res.status(409).json({ success: false, message: 'Table is no longer available. Please choose another table.' });
        }

        // Create the reservation
        const newReservation = new Reservation({
            guestName,
            contactNo,
            // Always the authenticated caller — never read from the
            // client body. On the customer path this is the customer
            // (createCustomerReservation); on the staff path it records
            // the staff member who took the booking.
            bookedBy: req.user?._id || null,
            date: date || new Date(),
            time,
            guestCount,
            area: selectedArea,
            table: selectedTable,
            notes,
            restaurant: tenantId(req),
            // Branch of the reserved table, so branch-pinned staff (whose
            // list is filtered by strictBranchFilter) see it.
            branch: table.branch || null,
        });

        const savedReservation = await newReservation.save();

        // For merged tables: mark all tables in the group as 'reserved' (scoped)
        if (claimedTable.mergedWith?.length > 0) {
            await Table.updateMany(
                { _id: { $in: claimedTable.mergedWith }, ...tf },
                { $set: { status: 'reserved' } }
            );
        }

        const populatedReservation = await Reservation.findById(savedReservation._id)
            .populate('area', 'name')
            .populate('table', 'name capacity id');

        // NOTIFY ADMIN (per-tenant)
        const settings = await getSettings(req);
        if (!settings || settings.notifications?.newOrder !== false) {
           await notify({
               restaurant: tenantId(req),
               branch: table.branch || null,
               audience: 'admin',
               notification: {
                   title: 'New Reservation',
                   description: `Manual reservation for ${guestName} (Table ${table.name}) at ${time}.`,
                   category: 'Service',
                   recipientRole: 'admin',
                   meta: { table: table.name, bookingId: savedReservation._id.toString() },
               },
               payload: { title: 'New Reservation', description: `${guestName} - Table ${table.name}` },
           });
        }

        res.status(201).json({ success: true, message: 'Reservation created successfully', reservation: populatedReservation });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating reservation', ...devError(error) });
    }
};

// Sweep Pending/Approved reservations whose scheduled date has already
// passed. Without this, a guest who booked weeks ago but never showed up
// leaves their name / phone / date lingering on the table — merging two
// free tables today surfaces that stale record in the admin drawer. Runs
// inline on every getReservations call so the dashboard always sees fresh
// state; after the first sweep of the day the updateMany is a no-op.
// Scoped to the caller's tenant.
const expireStaleReservations = async (req) => {
    const tf = tenantFilter(req);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const stale = await Reservation.find({
        ...tf,
        status: { $in: ['Pending', 'Approved'] },
        date: { $lt: todayStart },
    }).select('_id table tables').lean();

    if (!stale.length) return;

    const staleIds = stale.map(r => r._id);
    await Reservation.updateMany(
        { _id: { $in: staleIds }, ...tf },
        { $set: { status: 'Cancelled' } }
    );

    // Free any tables still marked 'reserved' for these stale records.
    // Tables that flipped to 'occupied' or 'free' since are left alone.
    const tableIds = [
        ...new Set(
            stale.flatMap(r => [
                r.table ? String(r.table) : null,
                ...(Array.isArray(r.tables) ? r.tables.map(String) : []),
            ]).filter(Boolean)
        ),
    ];
    if (tableIds.length) {
        await Table.updateMany(
            { _id: { $in: tableIds }, status: 'reserved', ...tf },
            { $set: { status: 'free', seats: [] } }
        );
    }

    logger.info('reservation.stale.swept', { count: staleIds.length, tenant: String(tenantId(req) || '') });
};

// Get all reservations (for the dashboard history or list, scoped to tenant)
const getReservations = async (req, res) => {
    try {
        try { await expireStaleReservations(req); } catch (e) {
            logger.warn('reservation.stale.sweep-failed', { error: e.message });
        }

        // Branch-pinned admin sees ONLY their branch's reservations —
        // strictBranchFilter returns `{}` for tenant owners so they
        // still see everything in the tenant.
        //
        // Customers (and any non-staff caller) only ever see their OWN
        // bookings — the list carries other diners' names, emails and
        // phone numbers, so a tenant-wide view is staff-only.
        const STAFF_ROLES = ['admin', 'manager', 'captain', 'waiter', 'chef'];
        const isStaff = STAFF_ROLES.includes(req.user?.role);
        const filter = isStaff
            ? { ...tenantFilter(req), ...strictBranchFilter(req) }
            : {
                ...tenantFilter(req),
                $or: [{ user: req.user._id }, { bookedBy: req.user._id }],
            };
        const reservations = await Reservation.find(filter)
            .populate('area', 'name')
            .populate('table', 'name capacity id')
            .populate('hall', 'name')
            .populate('user', 'name email mobile')
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, reservations });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching reservations', ...devError(error) });
    }
};


// Release the table (and its merge group) a reservation was holding —
// only tables still 'reserved' are touched; an occupied / free table is
// left alone. Seat reservations are reset with it (QA #13).
const releaseReservedTable = async (reservation, tf) => {
    const table = await Table.findOne({ _id: reservation.table, ...tf });
    if (table && table.status === 'reserved') {
        table.status = 'free';
        await table.save();
        await Table.updateOne({ _id: table._id, ...tf }, { $set: { seats: [] } });

        // Also free merged tables that were set to 'reserved' when the reservation was created
        if (table.mergedWith?.length > 0) {
            await Table.updateMany(
                { _id: { $in: table.mergedWith }, status: 'reserved', ...tf },
                { $set: { status: 'free', seats: [] } }
            );
        }
    }
};

// Cancel a reservation
const cancelReservation = async (req, res) => {
    try {
        const { id } = req.params;
        const tf = tenantFilter(req);
        const reservation = await Reservation.findOne({ _id: id, ...tf });

        if (!reservation) {
            return res.status(404).json({ success: false, message: 'Reservation not found' });
        }

        reservation.status = 'Cancelled';
        await reservation.save();

        // Free the table and any merged tables in the group (scoped)
        await releaseReservedTable(reservation, tf);

        res.status(200).json({ success: true, message: 'Reservation cancelled successfully', reservation });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error cancelling reservation', ...devError(error) });
    }
};

// Update reservation status
const updateReservationStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const tf = tenantFilter(req);
        const reservation = await Reservation.findOne({ _id: id, ...tf });
        if (!reservation) {
            return res.status(404).json({ success: false, message: 'Reservation not found' });
        }

        reservation.status = status;
        await reservation.save();

        // A reservation that is over (Cancelled / Completed) no longer holds
        // its table — same release as cancelReservation. The stale sweep
        // only frees tables of Pending / Approved reservations, so without
        // this the table stayed 'reserved' forever.
        if (['Cancelled', 'Completed'].includes(status)) {
            await releaseReservedTable(reservation, tf);
        }

        res.status(200).json({ success: true, message: 'Status updated', reservation });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating status', ...devError(error) });
    }
};

// Apply late arrival deduction to a reservation
const applyLateDeduction = async (req, res) => {
    try {
        const { id } = req.params;
        const { deductionAmount } = req.body;

        if (!deductionAmount || deductionAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Deduction amount must be positive' });
        }

        const tf = tenantFilter(req);
        const reservation = await Reservation.findOne({ _id: id, ...tf });
        if (!reservation) {
            return res.status(404).json({ success: false, message: 'Reservation not found' });
        }

        if (reservation.bookingType === 'hall') {
            return res.status(400).json({ success: false, message: 'Late deductions do not apply to hall bookings' });
        }

        if (reservation.lateArrival?.deductedAt) {
            return res.status(400).json({ success: false, message: 'Deduction already applied to this reservation' });
        }

        const advance = reservation.payment?.advancePaid || 0;
        const actualDeduction = Math.min(deductionAmount, advance);

        const set = {
            lateArrival: {
                isLate: true,
                deductionAmount: actualDeduction,
                deductedAt: new Date()
            },
        };
        if (reservation.payment) {
            const advanceAfter = Math.max(0, advance - actualDeduction);
            set['payment.advancePaid'] = advanceAfter;
            set['payment.balance'] = (reservation.payment.total || 0) - advanceAfter;
        }

        // Conditional write: only a reservation with no deduction yet is
        // updated, so two concurrent calls cannot both take a bite.
        const updated = await Reservation.findOneAndUpdate(
            { _id: reservation._id, 'lateArrival.deductedAt': null, ...tf },
            { $set: set },
            { returnDocument: 'after' }
        );
        if (!updated) {
            return res.status(400).json({ success: false, message: 'Deduction already applied to this reservation' });
        }

        res.status(200).json({
            success: true,
            message: `₹${actualDeduction.toFixed(2)} deducted from advance payment`,
            reservation: updated
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to apply deduction', ...devError(error) });
    }
};

/**
 * POST /api/v1/reservations/customer — a CUSTOMER books their own table.
 *
 * Why this is separate from createReservation(): that handler is
 * `staffOnly` because it trusts its caller. It takes an arbitrary
 * guestName/contactNo (staff booking on behalf of a walk-in) and does
 * no rate limiting, because a logged-in waiter is not a threat model.
 *
 * The customer "Book a Table" flow used to POST to it and received a
 * flat 403 "Access denied. Staff only." — the journey could not be
 * completed at all. Rather than loosening the staff route (which would
 * let any customer book in anyone's name), this handler pins identity
 * to the authenticated user and then delegates.
 */
const createCustomerReservation = async (req, res) => {
    try {
        if (!req.user?._id) {
            return res.status(401).json({ success: false, message: 'Please log in to book a table.' });
        }

        // Identity is taken from the session, NEVER from the body — a
        // customer may not book under someone else's name or number.
        const guestName = req.user.name;
        const contactNo = req.user.mobile || req.body.contactNo;
        if (!contactNo) {
            return res.status(400).json({
                success: false,
                code: 'CONTACT_REQUIRED',
                message: 'Add a mobile number to your profile before booking.',
            });
        }

        // Cap concurrent live bookings so one account cannot hold the
        // whole floor. Staff have no such cap; a customer needs one.
        const MAX_OPEN = 3;
        const openCount = await Reservation.countDocuments({
            bookedBy: req.user._id,
            // 'Pending' / 'Approved' are the schema's upcoming states
            // (models/reservation.js enum has no 'Confirmed').
            status: { $in: ['Pending', 'Approved'] },
            ...tenantFilter(req),
        });
        if (openCount >= MAX_OPEN) {
            return res.status(429).json({
                success: false,
                code: 'TOO_MANY_RESERVATIONS',
                message: `You already have ${MAX_OPEN} upcoming bookings. Cancel one before making another.`,
            });
        }

        // Delegate to the shared handler, which owns capacity checks,
        // the past-date guard and the atomic table claim that prevents
        // double-booking. Overriding req.body keeps that single source
        // of truth rather than duplicating the rules here.
        req.body = {
            ...req.body,
            guestName,
            contactNo,
            bookedBy: req.user._id,
        };
        return createReservation(req, res);
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error creating reservation', ...devError(error) });
    }
};

module.exports = {
    createReservation,
    createCustomerReservation,
    getReservations,
    cancelReservation,
    updateReservationStatus,
    applyLateDeduction
};

