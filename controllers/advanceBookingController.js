const mongoose = require('mongoose');
const AdvanceBooking = require('../models/advanceBooking');
const idGen = require('../utils/idGenerator');
const Table = require('../models/table');
const Area = require('../models/area');
const Hall = require('../models/hall');
const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');
const { notify } = require('../services/notificationService');
const { getSettings } = require('../utils/settingsCache');
const { sendEmail } = require('../utils/email');
const User = require('../models/user');
const Restaurant = require('../models/restaurant');
const Coupon = require('../models/coupon');
const CouponRedemption = require('../models/couponRedemption');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { loadBookingPrice, applyBookingDetailsEdit } = require('../utils/advanceBookingPricing');
const { loadParkingConfig, normalizeParkingDetails } = require('../utils/parkingConfig');
const {
    checkSettledPayment,
    mergedNotes,
    isValidCheckoutSignature,
    resolveBookingPaymentOutcome,
} = require('../utils/paymentChecks');
const { claimPayment, releaseClaim } = require('../utils/paymentClaim');
const { devError } = require('../utils/AppError');

// CUS-073 — build an RFC-5545 .ics calendar invite for a booking. Times
// are emitted in local-floating format (no Z) so the user's calendar app
// honours the restaurant's local time instead of doing UTC math.
function buildIcsInvite({ bookingId, bookingDate, bookingTime, durationHours = 2, summary, description, location }) {
    if (!bookingDate) return null;
    const to24h = (raw) => {
        if (!raw) return '19:00';
        const s = String(raw).trim();
        const hhmm = s.match(/^(\d{1,2}):(\d{2})/);
        if (hhmm) {
            const h = String(Math.min(23, parseInt(hhmm[1], 10))).padStart(2, '0');
            return `${h}:${hhmm[2]}`;
        }
        const range = s.match(/^(\d{1,2})\s*-\s*\d{1,2}\s*(AM|PM)/i);
        if (range) {
            let h = parseInt(range[1], 10);
            const isPm = /PM/i.test(range[2]);
            if (isPm && h < 12) h += 12;
            if (!isPm && h === 12) h = 0;
            return `${String(h).padStart(2, '0')}:00`;
        }
        const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
        if (ampm) {
            let h = parseInt(ampm[1], 10);
            const m = ampm[2] || '00';
            const isPm = /PM/i.test(ampm[3]);
            if (isPm && h < 12) h += 12;
            if (!isPm && h === 12) h = 0;
            return `${String(h).padStart(2, '0')}:${m}`;
        }
        return '19:00';
    };

    const dateStr = String(bookingDate).slice(0, 10); // tolerate ISO strings
    const [y, m, d] = dateStr.split('-');
    const [hh, mm] = to24h(bookingTime).split(':');
    const startLocal = `${y}${m}${d}T${hh}${mm}00`;
    const endHour = String(Math.min(23, parseInt(hh, 10) + Math.floor(durationHours))).padStart(2, '0');
    const endLocal = `${y}${m}${d}T${endHour}${mm}00`;
    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//BestoDine//Advance Booking//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        `UID:${bookingId || 'booking'}@bestodine.in`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${startLocal}`,
        `DTEND:${endLocal}`,
        `SUMMARY:${esc(summary)}`,
        `DESCRIPTION:${esc(description)}`,
        `LOCATION:${esc(location)}`,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'BEGIN:VALARM',
        'TRIGGER:-PT1H',
        'ACTION:DISPLAY',
        `DESCRIPTION:${esc(summary)} in 1 hour`,
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\r\n');
}

// CUS-073 — fire-and-forget confirmation email + .ics attachment. Best-
// effort: any failure is logged and swallowed so the booking creation
// response is never blocked by an email outage.
async function sendBookingConfirmationEmail({ booking, user, restaurant }) {
    try {
        if (!user?.email) return;
        const dateFmt = booking.bookingDate
            ? new Date(booking.bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
            : '—';
        const venueName = restaurant?.name || 'BestoDine';
        const venueAddr = restaurant?.city || '';
        const bookingType = booking.bookingType === 'hall' ? 'Hall' : 'Table';
        const summary = `${bookingType} reservation at ${venueName}`;
        const description = `Booking ID: ${booking.bookingId}\nGuests: ${booking.guestCount}\n${booking.specialEvent && booking.specialEvent !== 'None' ? `Event: ${booking.specialEvent}\n` : ''}Show this email at the venue or scan the QR in your account.`;

        const ics = buildIcsInvite({
            bookingId: booking.bookingId,
            bookingDate: booking.bookingDate,
            bookingTime: booking.bookingTime,
            durationHours: booking.durationHours || (booking.bookingType === 'hall' ? DEFAULT_HALL_DURATION : 2),
            summary,
            description,
            location: venueAddr,
        });

        const html = `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1A181B;">
              <h2 style="color:#FE8301;margin:0 0 8px;">Booking Confirmed ✓</h2>
              <p style="margin:0 0 16px;color:#645E66;">Hi ${user.name || 'guest'}, your reservation at <strong>${venueName}</strong> is confirmed.</p>
              <div style="background:#FFFAF5;border:1px solid #FEE7CC;border-radius:12px;padding:16px;">
                <p style="margin:0 0 8px;"><strong>Booking ID:</strong> ${booking.bookingId}</p>
                <p style="margin:0 0 8px;"><strong>Type:</strong> ${bookingType} Booking</p>
                <p style="margin:0 0 8px;"><strong>Date:</strong> ${dateFmt}</p>
                <p style="margin:0 0 8px;"><strong>Time:</strong> ${booking.bookingTime || '—'} (${booking.timeSlot || ''})</p>
                <p style="margin:0 0 8px;"><strong>Guests:</strong> ${booking.guestCount}</p>
                ${booking.specialEvent && booking.specialEvent !== 'None' ? `<p style="margin:0 0 8px;"><strong>Event:</strong> ${booking.specialEvent}</p>` : ''}
                ${venueAddr ? `<p style="margin:0 0 8px;"><strong>Venue:</strong> ${venueAddr}</p>` : ''}
              </div>
              <p style="margin:16px 0 8px;color:#645E66;font-size:13px;">An <strong>.ics calendar invite</strong> is attached — open it to add this reservation to your calendar with a 1-hour reminder.</p>
              <p style="margin:16px 0 0;color:#645E66;font-size:13px;">See you soon!<br/>— ${venueName}</p>
            </div>
        `;
        const text = `Booking Confirmed!\n\nBooking ID: ${booking.bookingId}\nDate: ${dateFmt}\nTime: ${booking.bookingTime || '—'} (${booking.timeSlot || ''})\nGuests: ${booking.guestCount}\nVenue: ${venueName}${venueAddr ? `, ${venueAddr}` : ''}\n\nA calendar invite is attached.`;

        await sendEmail({
            to: user.email,
            subject: `Booking Confirmed — ${booking.bookingId}`,
            html,
            text,
            attachments: ics ? [{
                filename: `Booking_${booking.bookingId}.ics`,
                content: ics,
                contentType: 'text/calendar; method=REQUEST',
            }] : [],
        });
    } catch (err) {
        logger.warn(`Booking confirmation email failed for ${booking.bookingId}: ${err.message}`);
    }
}
// Parse a free-text time ("7:00 PM", "19:00", "11 AM - 12 PM") into a
// 24-hour `hour` value (0-23). Returns null if the string can't be parsed
// so the caller can fall back to its existing default. Used to auto-
// derive `timeSlot` (Lunch vs Dinner) from `selectedTime` when the
// frontend didn't send an explicit `selectedTimeType` — without this
// every booking defaulted to "Lunch" regardless of the actual time
// (Hall booked for 7 PM showing "(Lunch)" on the customer receipt).
function parseHourFromTimeString(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    // "HH:MM" 24-hour
    const hhmm = s.match(/^(\d{1,2}):(\d{2})\s*$/);
    if (hhmm) return Math.min(23, Math.max(0, parseInt(hhmm[1], 10)));
    // "9-10 AM" / "11 AM - 12 PM" range — first hour wins
    const range = s.match(/^(\d{1,2})\s*-\s*\d{1,2}\s*(AM|PM)/i);
    if (range) {
        let h = parseInt(range[1], 10);
        if (/PM/i.test(range[2]) && h < 12) h += 12;
        if (/AM/i.test(range[2]) && h === 12) h = 0;
        return h;
    }
    // "7:00 PM" / "7 PM" single time
    const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
    if (ampm) {
        let h = parseInt(ampm[1], 10);
        if (/PM/i.test(ampm[3]) && h < 12) h += 12;
        if (/AM/i.test(ampm[3]) && h === 12) h = 0;
        return h;
    }
    return null;
}

// Cafe convention: 04:00–15:59 = Lunch, 16:00–03:59 = Dinner. Matches
// the time slots the BookTableDetails UI exposes (Lunch vs Dinner
// toggle splits at 4 PM).
function deriveTimeSlot(timeStr, fallback = 'Lunch') {
    const h = parseHourFromTimeString(timeStr);
    if (h === null) return fallback;
    return (h >= 4 && h < 16) ? 'Lunch' : 'Dinner';
}

// Hall bookings are sold as multi-hour blocks (5h / 6h). Anything outside
// this list is rejected so a crafted request can't book a 1h hall slot.
const HALL_DURATION_OPTIONS = [5, 6];
const DEFAULT_HALL_DURATION = 5;
// Legacy hall bookings stored no duration — assume the default block.
const LEGACY_HALL_DURATION = DEFAULT_HALL_DURATION;
// Table bookings are sold as one-hour slots ("7-8 PM"); two bookings of
// the same table conflict when their slots overlap.
const TABLE_SLOT_HOURS = 1;

// Absolute start of the booked event: the booking's calendar date (the
// date-only value stored at 00:00 UTC) at its `startTime` ("HH:MM") as
// wall-clock time in the tenant's timezone (IST default). Bookings with
// no stored start time fall back to the stored `bookingDate` instant.
function bookingEventStart(booking, timeZone = 'Asia/Kolkata') {
    const date = new Date(booking.bookingDate);
    if (Number.isNaN(date.getTime())) return date;
    const m = String(booking.startTime || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return date;
    let tz = timeZone || 'Asia/Kolkata';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'Asia/Kolkata'; }
    const wallClockUTC = Date.UTC(
        date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
        Math.min(23, Number(m[1])), Math.min(59, Number(m[2])), 0,
    );
    const p = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(wallClockUTC)).reduce((acc, x) => { if (x.type !== 'literal') acc[x.type] = Number(x.value); return acc; }, {});
    const offsetMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wallClockUTC;
    return new Date(wallClockUTC - offsetMs);
}

// Hours from now until the event start (negative = already started).
async function hoursUntilEvent(req, booking) {
    let timeZone;
    try {
        const settings = await getSettings(req);
        timeZone = settings?.general?.timezone;
    } catch { /* default timezone */ }
    return (bookingEventStart(booking, timeZone) - Date.now()) / (1000 * 60 * 60);
}

// Start hour of a booking as a number (0-23). Prefers the explicit
// `startTime` ("HH:MM") and falls back to parsing the display label.
function bookingStartHour(startTime, bookingTime) {
    if (startTime && /^\d{1,2}:\d{2}$/.test(String(startTime))) {
        return parseHourFromTimeString(String(startTime));
    }
    return parseHourFromTimeString(bookingTime);
}

// Create a new advance booking
const createAdvanceBooking = async (req, res) => {
    try {
        const {
            bookingType,
            selectedDate,
            selectedTime,
            guests,
            selectedTableIds,
            selectedHallId,
            selectedPackage,
            selectedFlavor,
            selectedFlavorName,
            selectedSize,
            selectedSizeName,
            isVeg,
            selectedAddons,
            selectedAddonDetails,
            selectedEvent,
            selectedEventName,
            selectedTimeType,
            selectedTypes,
            selectedDecor,
            quantity,
            specialMessage,
            total,
            paymentMethod,
            couponCode,
            walletPointsUsed,
            razorpayPaymentId,
            razorpay_order_id,
            razorpay_signature,
        } = req.body;
        // `total` from the browser is display-only now (bug #9) — the
        // booking price is recomputed from the catalog below.
        void total;

        const userId = req.user ? req.user.id : null;
        if (!userId) {
            logger.error('Advance booking: User not authenticated');
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }

        // 1. Validation
        if (!bookingType || !['table', 'hall'].includes(bookingType)) {
            return res.status(400).json({ success: false, message: 'Booking type must be "table" or "hall"' });
        }
        if (bookingType === 'table' && (!selectedTableIds || selectedTableIds.length === 0)) {
            console.warn('Warning: Booking attempt without tables');
            return res.status(400).json({ success: false, message: 'Please select at least one table' });
        }
        if (bookingType === 'hall' && !selectedHallId) {
            console.warn('Warning: Hall booking attempt without hall selection');
            return res.status(400).json({ success: false, message: 'Please select a hall' });
        }
        // Cross-type mix-up guard — staff sometimes select both. The
        // intent is ambiguous and the bill calculator can't reconcile
        // a hall + table booking, so reject upfront.
        if (bookingType === 'table' && selectedHallId) {
            return res.status(400).json({ success: false, message: 'Pick either a hall OR tables, not both' });
        }
        if (bookingType === 'hall' && selectedTableIds?.length > 0) {
            return res.status(400).json({ success: false, message: 'Hall bookings should not include individual tables' });
        }
        if (!selectedDate) {
            return res.status(400).json({ success: false, message: 'Please select a booking date' });
        }
        // Booking date must be today or later — staff typo guard.
        const bookingWhen = new Date(selectedDate);
        if (Number.isNaN(bookingWhen.getTime())) {
            return res.status(400).json({ success: false, message: 'Invalid booking date' });
        }
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        if (bookingWhen < todayStart) {
            return res.status(400).json({ success: false, message: 'Booking date cannot be in the past' });
        }

        // Guest count sanity + capacity validation. Without this, a
        // hall booked for "500 guests" but actually fitting 200 looks
        // fine to the system but blows up at the door on event day.
        const guestCount = Number(guests);
        if (!Number.isFinite(guestCount) || guestCount < 1) {
            return res.status(400).json({ success: false, message: 'Guest count must be at least 1' });
        }
        if (guestCount > 2000) {
            return res.status(400).json({ success: false, message: 'Guest count looks unrealistic (max 2000)' });
        }
        if (bookingType === 'hall' && selectedHallId) {
            // The hall must exist in THIS tenant and be bookable. A foreign
            // or unknown id used to skip the capacity guard and get priced
            // at ₹0; a deactivated hall used to stay bookable via the API.
            const hall = mongoose.Types.ObjectId.isValid(String(selectedHallId))
                ? await Hall.findOne({ _id: selectedHallId, ...tenantFilter(req) }).select('minCapacity maxCapacity name isActive').lean()
                : null;
            if (!hall) {
                return res.status(404).json({ success: false, code: 'HALL_NOT_FOUND', message: 'Hall not found' });
            }
            if (hall.isActive === false) {
                return res.status(400).json({ success: false, code: 'HALL_UNAVAILABLE', message: `${hall.name} is not available for booking.` });
            }
            // CUS-079 — capacity validation MUST check both ends.
            // Previously only maxCapacity was enforced, so a hall
            // with minCapacity=50 would accept a 5-guest booking
            // and the host arrived to find a giant empty room
            // (and an unhappy customer who was charged a hall
            // minimum they didn't expect).
            if (hall.maxCapacity && guestCount > hall.maxCapacity) {
                return res.status(400).json({
                    success: false,
                    code: 'HALL_CAPACITY_EXCEEDED',
                    message: `${hall.name} fits up to ${hall.maxCapacity} guests. Pick a bigger hall or reduce the count.`,
                    min: hall.minCapacity || null,
                    max: hall.maxCapacity,
                });
            }
            if (hall.minCapacity && guestCount < hall.minCapacity) {
                return res.status(400).json({
                    success: false,
                    code: 'HALL_CAPACITY_BELOW_MIN',
                    message: `${hall.name} requires a minimum of ${hall.minCapacity} guests. Pick a smaller hall or increase the count.`,
                    min: hall.minCapacity,
                    max: hall.maxCapacity || null,
                });
            }
        }

        // 1b. Hall availability check — prevent double-bookings (per-tenant).
        // Two hall bookings on the same day conflict only when their
        // [start, start + duration) windows overlap. If either start time
        // can't be determined we fall back to the safe whole-day block.
        const tf = tenantFilter(req);
        const startHour = bookingStartHour(req.body.selectedStartTime, selectedTime);
        let durationHours = null;
        if (bookingType === 'hall') {
            const requested = Number(req.body.durationHours);
            if (req.body.durationHours !== undefined && req.body.durationHours !== null && req.body.durationHours !== '') {
                if (!HALL_DURATION_OPTIONS.includes(requested)) {
                    return res.status(400).json({
                        success: false,
                        message: `Hall bookings are available for ${HALL_DURATION_OPTIONS.join(' or ')} hours.`
                    });
                }
                durationHours = requested;
            } else {
                durationHours = DEFAULT_HALL_DURATION;
            }
        }
        if (bookingType === 'hall' && selectedHallId) {
            const sameDay = await AdvanceBooking.find({
                hall: selectedHallId,
                bookingDate: selectedDate,
                status: { $in: ['Pending', 'Confirmed'] },
                ...tf,
            }).select('bookingTime startTime durationHours').lean();
            const conflicting = sameDay.find((b) => {
                const otherStart = bookingStartHour(b.startTime, b.bookingTime);
                if (startHour === null || otherStart === null) return true;
                const otherEnd = otherStart + (Number(b.durationHours) || LEGACY_HALL_DURATION);
                const myEnd = startHour + durationHours;
                return startHour < otherEnd && otherStart < myEnd;
            });
            if (conflicting) {
                return res.status(409).json({
                    success: false,
                    code: 'HALL_SLOT_TAKEN',
                    message: 'This hall is already booked for an overlapping time on the selected date. Please choose a different time, date or hall.'
                });
            }
        }

        // 1b'. Table availability — same overlap rule as halls: a table
        // already held by a Pending / Confirmed booking for an overlapping
        // slot on that date cannot be booked again.
        const bookedTableIds = bookingType === 'table'
            ? (selectedTableIds || []).filter(id => mongoose.Types.ObjectId.isValid(id))
            : [];
        if (bookedTableIds.length > 0) {
            const sameDay = await AdvanceBooking.find({
                tables: { $in: bookedTableIds },
                bookingDate: selectedDate,
                status: { $in: ['Pending', 'Confirmed'] },
                ...tf,
            }).select('bookingTime startTime durationHours').lean();
            const conflicting = sameDay.find((b) => {
                const otherStart = bookingStartHour(b.startTime, b.bookingTime);
                if (startHour === null || otherStart === null) return true;
                const otherEnd = otherStart + (Number(b.durationHours) || TABLE_SLOT_HOURS);
                const myEnd = startHour + TABLE_SLOT_HOURS;
                return startHour < otherEnd && otherStart < myEnd;
            });
            if (conflicting) {
                return res.status(409).json({
                    success: false,
                    code: 'TABLE_SLOT_TAKEN',
                    message: 'This table is already booked for an overlapping time on the selected date. Please choose a different time, date or table.'
                });
            }
        }

        // 1c. Wallet points must be a non-negative number.
        const numericWalletPoints = parseFloat(walletPointsUsed) || 0;
        if (!Number.isFinite(numericWalletPoints) || numericWalletPoints < 0) {
            return res.status(400).json({ success: false, message: 'Invalid wallet points amount' });
        }

        // Branch resolution (needed for coupon branch scope below):
        //   - Admin with a branch pin (Sub Admin making a manual booking) → their pin.
        //   - Customer booking a table → derive from the selected table's branch
        //     so the booking shows up on that branch's admin tab.
        //   - Otherwise (hall booking by customer, or data with no branch
        //     context) → null (tenant-level, visible to tenant owner only).
        let bookingBranch = pinnedBranchId(req) || null;
        if (!bookingBranch && bookingType === 'table' && (selectedTableIds || []).length > 0) {
            const firstTableId = (selectedTableIds || []).find(id => mongoose.Types.ObjectId.isValid(id));
            if (firstTableId) {
                const tbl = await Table.findOne({ _id: firstTableId, ...tf }).select('branch');
                if (tbl && tbl.branch) bookingBranch = tbl.branch;
            }
        }

        // 1d. Bug #9 — authoritative price from the tenant catalog.
        const pricingSettings = await getSettings(req);
        const pointsToRupee = pricingSettings?.wallet?.pointsToRupee || 0.1;
        const price = await loadBookingPrice({ body: req.body, tf, userId, pointsToRupee, branch: bookingBranch });
        if (price.parkingError) {
            return res.status(400).json({ success: false, code: 'INVALID_PARKING', message: price.parkingError });
        }

        // 1e. Validate wallet points BEFORE creating the booking (per-tenant).
        // Only the points the booking actually needs are spent — requesting
        // 10,000 points against a ₹600 booking at ₹0.1/pt uses 6,000.
        const pointsToDeduct = price.pointsUsed || 0;
        let walletForDeduction = null;
        if (pointsToDeduct > 0) {
            walletForDeduction = await Wallet.findOne({ user: userId, ...tf });
            if (!walletForDeduction || walletForDeduction.loyaltyPoints < pointsToDeduct) {
                return res.status(400).json({
                    success: false,
                    message: `Insufficient wallet points. Available: ${walletForDeduction?.loyaltyPoints || 0}`
                });
            }
        }
        const clientTotal = parseFloat(total);
        if (Number.isFinite(clientTotal) && Math.abs(clientTotal - price.total) > 1) {
            logger.warn('Advance booking: client total differs from server price — using server price', {
                userId: String(userId), clientTotal, serverTotal: price.total,
            });
        }

        // 2. Generate human-readable Booking ID
        const bookingId = bookingType === 'hall' ? idGen.hallBookingId() : idGen.tableBookingId();

        // 2b. Bug #9 — payment status is only ever derived from a payment
        // the SERVER verified: checkout signature + Razorpay fetch
        // (settled, this tenant, this payer, enough money) + single-use
        // claim. Cash, or no payment proof, stays Pending with ₹0 paid.
        let paymentOutcome = { status: 'Pending', advancePaid: 0 };
        let verifiedPayment = null;
        if (paymentMethod !== 'cash' && razorpayPaymentId) {
            if (!_razorpayInstance) {
                return res.status(503).json({ success: false, code: 'PAYMENT_GATEWAY_UNAVAILABLE', message: 'Online payments are not configured.' });
            }
            if (!isValidCheckoutSignature({
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpayPaymentId,
                signature: razorpay_signature,
                secret: process.env.RAZORPAY_KEY_SECRET,
            })) {
                return res.status(400).json({ success: false, code: 'PAYMENT_SIGNATURE_INVALID', message: 'Payment could not be verified.' });
            }
            let rzpPayment;
            let rzpOrder;
            try {
                rzpPayment = await _razorpayInstance.payments.fetch(razorpayPaymentId);
                rzpOrder = await _razorpayInstance.orders.fetch(razorpay_order_id);
            } catch (fetchErr) {
                logger.error('Advance booking: Razorpay fetch failed', { error: fetchErr.message, razorpayPaymentId });
                return res.status(502).json({ success: false, code: 'GATEWAY_UNAVAILABLE', message: 'Could not confirm the payment with the gateway. Please try again in a moment.' });
            }
            const settled = checkSettledPayment(rzpPayment, razorpay_order_id);
            if (!settled.ok) {
                return res.status(settled.status).json({ success: false, code: settled.code, message: settled.message });
            }
            const notes = mergedNotes(rzpPayment, rzpOrder);
            const purpose = notes.purpose || notes.type || notes.kind;
            if (purpose && purpose !== 'cafe_order') {
                return res.status(400).json({ success: false, code: 'PAYMENT_PURPOSE_MISMATCH', message: 'This payment was not made for a booking.' });
            }
            if (!notes.restaurantId || String(notes.restaurantId) !== String(tenantId(req))) {
                return res.status(403).json({ success: false, code: 'TENANT_MISMATCH', message: 'This payment belongs to a different restaurant.' });
            }
            if (notes.cafeOrderId && notes.cafeOrderId !== 'none') {
                return res.status(400).json({ success: false, code: 'PAYMENT_ORDER_MISMATCH', message: 'This payment was made for a food order.' });
            }
            if (notes.userId && String(notes.userId) !== String(userId)) {
                return res.status(403).json({ success: false, code: 'PAYER_MISMATCH', message: 'This payment was made by a different customer.' });
            }
            const outcome = resolveBookingPaymentOutcome({ total: price.total, paidAmount: settled.amount });
            if (!outcome.ok) {
                return res.status(outcome.status).json({ success: false, code: outcome.code, message: outcome.message });
            }
            const claim = await claimPayment(razorpayPaymentId, {
                purpose: 'advance_booking',
                ref: bookingId,
                razorpayOrderId: razorpay_order_id,
                restaurant: tenantId(req) || null,
                user: userId,
                amount: settled.amount,
            });
            if (!claim.claimed) {
                return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used.' });
            }
            paymentOutcome = outcome;
            verifiedPayment = { paymentId: razorpayPaymentId, orderId: razorpay_order_id };
        } else if (!(Number(price.total) > 0)) {
            // Nothing is due (coupon / points cover the whole booking):
            // there is no payment to verify, and the booking is fully
            // settled rather than left 'Pending' at ₹0 (2026-10).
            paymentOutcome = { status: 'Paid', advancePaid: 0 };
        }
        const releasePaymentClaim = async () => {
            if (verifiedPayment) await releaseClaim(verifiedPayment.paymentId, { purpose: 'advance_booking', ref: bookingId });
        };

        // 3. Map Frontend Data to AdvanceBooking Model
        const newBooking = new AdvanceBooking({
            bookingId,
            user: userId,
            restaurant: tenantId(req),
            branch: bookingBranch,
            bookingType: bookingType || 'table',
            // Table flow specific
            area: (selectedTypes && selectedTypes.length > 0) ? selectedTypes[0] : (req.body.areaId || null), 
            tables: (selectedTableIds || []).filter(id => mongoose.Types.ObjectId.isValid(id)),
            // Hall flow specific
            hall: selectedHallId || null,
            package: selectedPackage?._id || selectedPackage?.id || null,

            bookingDate: selectedDate,
            bookingTime: selectedTime,
            // Explicit `selectedTimeType` from the UI wins; otherwise
            // derive from `selectedTime` so a 7:00 PM hall booking
            // doesn't get labelled "(Lunch)" on the confirmation
            // email / customer history card.
            timeSlot: selectedTimeType || deriveTimeSlot(selectedTime, 'Lunch'),
            startTime: startHour !== null ? `${String(startHour).padStart(2, '0')}:00` : null,
            durationHours,
            guestCount: parseInt(guests) || 1,
            specialEvent: selectedEventName || selectedEvent || 'None',
            cakeDetails: {
                quantity: parseInt(quantity) || 0,
                flavor: selectedFlavorName || selectedFlavor,
                size: selectedSizeName || selectedSize,
                specialMessage: specialMessage,
                isVeg: isVeg !== undefined ? isVeg : true,
                isSkipped: !selectedFlavor
            },
            addons: {
                // Prices from the catalog lookup, not the browser.
                decoration: price.lines.decoration,
                otherAddons: price.lines.addons,
                isSkipped: !selectedDecor && (!selectedAddons || selectedAddons.length === 0)
            },
            // Multi-vehicle parking (QA N10/N11) — rows, rates and hours
            // as priced by utils/parkingConfig. `vehicleType` / `count`
            // stay populated (first type / total vehicles) for older
            // readers of the single-type shape.
            parkingDetails: price.lines.parking ? {
                vehicleType: price.lines.parking.vehicles[0].vehicleType,
                count: price.lines.parking.vehicles.reduce((s, v) => s + v.count, 0),
                timeDuration: `${price.lines.parking.hours}hrs`,
                vehicles: price.lines.parking.vehicles,
                mode: price.lines.parking.mode,
                startTime: price.lines.parking.startTime,
                isSkipped: false,
            } : { count: 0, isSkipped: true },
            payment: {
                totalAmount: price.total,
                // Only a server-verified payment moves these (bug #9).
                advancePaid: paymentOutcome.advancePaid,
                method: paymentMethod || 'cash',
                status: paymentOutcome.status,
                couponCode: couponCode || null,
                // Points actually spent (≤ requested), not the request.
                walletPointsUsed: pointsToDeduct,
                razorpayPaymentId: verifiedPayment?.paymentId || null,
                razorpayOrderId: verifiedPayment?.orderId || null,
                priceBreakdown: price.breakdown,
            },
            notes: `Booking for ${selectedEventName || 'General'} via Website`
        });

        // Coupon consumption — the discount was priced in, so the coupon is
        // spent now: atomically bump usageCount (respecting usageLimit at
        // this moment, as orderCreateService does) and log a
        // CouponRedemption row so usagePerUser holds for the next booking.
        let couponConsumed = null; // { couponId, redemptionId }
        const releaseCoupon = async () => {
            if (!couponConsumed) return;
            try {
                if (couponConsumed.redemptionId) await CouponRedemption.deleteOne({ _id: couponConsumed.redemptionId, ...tf });
                await Coupon.updateOne({ _id: couponConsumed.couponId, usageCount: { $gt: 0 }, ...tf }, { $inc: { usageCount: -1 } });
            } catch (rbErr) {
                logger.error('Advance booking: coupon rollback failed', { couponId: String(couponConsumed.couponId), error: rbErr.message });
            }
            couponConsumed = null;
        };
        if (price.coupon && price.breakdown.discount > 0) {
            const coupon = await Coupon.findOneAndUpdate(
                {
                    _id: price.coupon._id,
                    isActive: true,
                    ...tf,
                    $or: [
                        { usageLimit: { $lte: 0 } },          // unlimited
                        { $expr: { $lt: ['$usageCount', '$usageLimit'] } },
                    ],
                },
                { $inc: { usageCount: 1 } },
                { returnDocument: 'after' }
            );
            if (!coupon) {
                await releasePaymentClaim();
                return res.status(409).json({
                    success: false,
                    code: 'COUPON_UNAVAILABLE',
                    message: 'This coupon has reached its usage limit or is no longer active. Please remove it and try again.',
                });
            }
            couponConsumed = { couponId: coupon._id, redemptionId: null };
            const redemption = await CouponRedemption.create({
                coupon: coupon._id,
                couponCode: coupon.code,
                couponTitle: coupon.title,
                user: userId,
                restaurant: tenantId(req),
                branch: coupon.branch || null,
                orderValue: price.subtotal,
                discountAmount: price.breakdown.discount,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
            });
            couponConsumed.redemptionId = redemption._id;
            // Per-customer limit re-checked after our own row is written so
            // two concurrent bookings cannot both slip under it.
            if (Number(coupon.usagePerUser) > 0) {
                const used = await CouponRedemption.countDocuments({ coupon: coupon._id, user: userId, ...tf });
                if (used > coupon.usagePerUser) {
                    await releaseCoupon();
                    await releasePaymentClaim();
                    return res.status(409).json({
                        success: false,
                        code: 'COUPON_USER_LIMIT',
                        message: `You can only use this coupon ${coupon.usagePerUser} time${coupon.usagePerUser > 1 ? 's' : ''}.`,
                    });
                }
            }
        }

        // Wallet was already validated above (walletForDeduction)
        if (pointsToDeduct > 0 && walletForDeduction) {
            // Atomic deduction to prevent race conditions (per-tenant)
            const updated = await Wallet.findOneAndUpdate(
                { user: userId, loyaltyPoints: { $gte: pointsToDeduct }, ...tf },
                { $inc: { loyaltyPoints: -pointsToDeduct } },
                { returnDocument: 'after' }
            );
            if (!updated) {
                await releaseCoupon();
                await releasePaymentClaim();
                return res.status(400).json({ success: false, message: 'Wallet points changed. Please try again.' });
            }

            // Record points redemption transaction
            const transaction = new Transaction({
                user: userId,
                restaurant: tenantId(req),
                branch: bookingBranch,
                type: 'points_redeemed',
                amount: -pointsToDeduct, // Debit
                paymentMethod: 'points',
                description: `Points redeemed for booking ${bookingType}`,
                transactionId: idGen.transactionId(),
                balanceBefore: updated.loyaltyPoints + pointsToDeduct,
                balanceAfter: updated.loyaltyPoints,
                status: 'completed'
            });
            await transaction.save();
        }

        // 3. (Optional) Update Table Status or check availability
        // For 'Advance booking' we usually don't block table status as 'occupied' immediately but as 'reserved' 

        let savedBooking;
        try {
            savedBooking = await newBooking.save();
        } catch (saveErr) {
            // Undo the side effects so the customer can retry (or get an
            // orphan refund) instead of losing points / a spent payment.
            await releasePaymentClaim();
            await releaseCoupon();
            if (pointsToDeduct > 0 && walletForDeduction) {
                try {
                    await Wallet.findOneAndUpdate({ user: userId, ...tf }, { $inc: { loyaltyPoints: pointsToDeduct } });
                } catch (rbErr) {
                    logger.error('Advance booking: points rollback failed', { userId: String(userId), error: rbErr.message });
                }
            }
            throw saveErr;
        }
        try { require('../utils/webhookService').emitWebhookEvent(tenantId(req), 'booking.created', require('../utils/publicApiSerializers').serializeBooking(savedBooking)); } catch { /* webhooks never affect the booking */ }

        // CUS-073 — fire confirmation email (with .ics attachment) in
        // the background. We don't await the response in the request
        // path so a slow SMTP provider can't drag out the booking
        // create. Lookup user + restaurant once; failures are swallowed
        // inside sendBookingConfirmationEmail.
        (async () => {
            try {
                const [emailUser, restaurant] = await Promise.all([
                    User.findById(userId).select('name email').lean(),
                    Restaurant.findById(tenantId(req)).select('name city slug').lean(),
                ]);
                await sendBookingConfirmationEmail({ booking: savedBooking, user: emailUser, restaurant });
            } catch (mailErr) {
                logger.warn(`booking-email background fanout failed: ${mailErr.message}`);
            }
        })();

        // NOTIFY ADMIN (per-tenant)
        const settings = await getSettings(req);
        if (!settings || settings.notifications?.newOrder !== false) {
           await notify({
               restaurant: tenantId(req),
               branch: savedBooking.branch || null,
               audience: 'admin',
               notification: {
                   title: 'New Advance Booking',
                   description: `New ${bookingType} booking for ${guests} guests on ${selectedDate}.`,
                   category: 'Service',
                   recipientRole: 'admin',
                   meta: { bookingId: savedBooking.bookingId, orderId: savedBooking._id.toString() },
               },
               payload: { title: 'Advance Booking', description: `${bookingType.toUpperCase()} - ${guests} guests` },
           });
        }

        res.status(201).json({ 
            success: true, 
            message: 'Advance booking created successfully!', 
            booking: savedBooking 
        });

    } catch (error) {
        logger.error('Advance Booking error:', { error: error.message });
        res.status(500).json({ 
            success: false, 
            message: 'Error creating advance booking',
            ...devError(error),
        });
    }
};

// Get all advance bookings — Sub Admin sees only their own branch's
// bookings; tenant owner sees all (or narrows via ?branch=<id>).
const getAdvanceBookings = async (req, res) => {
    try {
        const bookings = await AdvanceBooking.find({
            ...tenantFilter(req),
            ...strictBranchFilter(req),
        })
            .populate('user', 'name email mobile')
            .populate('tables', 'name capacity')
            .populate('area', 'name')
            .populate('hall', 'name basePrice maxCapacity')
            .populate('package', 'name price')
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, bookings });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching bookings', ...devError(error) });
    }
};

// Friendly date format used inside customer-facing notification copy.
// (Notifications can outlive the customer's session, so we format once
// here on the server in a consistent locale.)
const fmtBookingDate = (d) => {
    try {
        return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return ''; }
};

// Update booking status
const updateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = ['Pending', 'Confirmed', 'Completed', 'Cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        // Read previous status BEFORE the update so we only fire the
        // customer notification on actual transitions (not on the same
        // status being saved twice).
        const prev = await AdvanceBooking.findOne(
            { _id: id, ...tenantFilter(req), ...strictBranchFilter(req) }
        ).select('status user payment').lean();
        if (!prev) return res.status(404).json({ success: false, message: 'Booking not found' });

        const booking = await AdvanceBooking.findOneAndUpdate(
            { _id: id, ...tenantFilter(req), ...strictBranchFilter(req) },
            { status },
            { returnDocument: 'after', runValidators: true }
        );
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

        // ── Notify the customer when status genuinely changes ──────────
        // Mirrors the order status notification pattern in
        // orderController.updateOrderStatus (line ~2228): persistent
        // Notification doc + a one-shot socket emit to the customer's
        // userId-room so any open tab gets a toast immediately.
        if (status !== prev.status && booking.user) {
            const total = booking.payment?.totalAmount || 0;
            const paid = booking.payment?.advancePaid || 0;
            const remaining = Math.max(total - paid, 0);
            const dateStr = fmtBookingDate(booking.bookingDate);

            let title = '';
            let description = '';
            let priority = 'normal';
            let category = 'Service';

            if (status === 'Confirmed') {
                title = 'Booking Confirmed';
                description = remaining > 0
                    ? `Your booking ${booking.bookingId} is confirmed for ${dateStr}. ₹${remaining} balance is due before the event.`
                    : `Your booking ${booking.bookingId} is confirmed for ${dateStr}.`;
                priority = 'high';
                category = remaining > 0 ? 'Payment' : 'Service';
            } else if (status === 'Cancelled') {
                title = 'Booking Cancelled';
                description = `Your booking ${booking.bookingId} for ${dateStr} was cancelled by the restaurant. Please contact us for refunds or rescheduling.`;
                priority = 'high';
            } else if (status === 'Completed') {
                title = 'Booking Completed';
                description = `Thanks for choosing us! We hope you enjoyed your visit on ${dateStr}.`;
            }

            if (title) {
                await notify({
                    restaurant: booking.restaurant,
                    branch: booking.branch || null,
                    recipients: booking.user,
                    notification: {
                        title,
                        description,
                        category,
                        recipientRole: 'customer',
                        priority,
                        meta: {
                            bookingId: booking.bookingId,
                            bookingDocId: booking._id.toString(),
                            bookingStatus: status,
                            remainingAmount: remaining,
                        },
                    },
                    payload: { title, description },
                });
            }
        }

        res.status(200).json({ success: true, message: `Booking status updated to ${status}` });
    } catch (error) {
        logger.error('Error updating booking status:', error);
        res.status(500).json({ success: false, message: 'Error updating status', ...devError(error) });
    }
};
// PATCH /api/advance-booking/:id/details — admin edits add-ons / extra
// cakes / parking and applies a one-off discount (BookingDrawer "Edit").
// The route validator only lets { cakes, addons, parking, discount }
// through; everything else on the booking (dates, tables, payment refs,
// status) is untouchable here. Tenant + branch scoped like updateStatus.
const updateBookingDetails = async (req, res) => {
    try {
        const scope = { _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) };
        const booking = await AdvanceBooking.findOne(scope)
            .select('status bookingType cakeDetails addons parkingDetails payment branch')
            .lean();
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
        if (!['Pending', 'Confirmed'].includes(booking.status)) {
            return res.status(400).json({ success: false, message: `A ${booking.status.toLowerCase()} booking can no longer be edited` });
        }

        const { cakes, addons, parking, discount } = req.body;
        const edit = { cakes, addons, parking, discount };

        // Per-type parking rates — same source as loadBookingPrice
        // (Settings.reservation.parking, else the default table).
        let parkingRate = 0;
        let parkingRates = null;
        if (parking !== undefined && booking.bookingType !== 'hall') {
            const config = await loadParkingConfig(tenantFilter(req));
            parkingRates = Object.fromEntries(config.vehicles.map((v) => [v.id, v.pricePerHour]));
            const vehicleType = normalizeParkingDetails(booking.parkingDetails || {})?.vehicles?.[0]?.vehicleType;
            parkingRate = vehicleType ? (Number(parkingRates[vehicleType]) || 0) : 0;
            const unknown = (Array.isArray(parking.vehicles) ? parking.vehicles : [])
                .map((v) => String(v?.vehicleType || '').trim().toLowerCase())
                .filter((t) => t && parkingRates[t] === undefined);
            if (unknown.length) {
                return res.status(400).json({ success: false, message: `Parking is not available for vehicle type "${unknown[0]}"` });
            }
            // Staff may book longer than the customer-facing maximum.
            const maxHours = Math.max(24, config.maxDuration);
            if (Number(parking.hours) > maxHours) {
                return res.status(400).json({ success: false, message: `Parking hours cannot exceed ${maxHours}` });
            }
        }

        const result = applyBookingDetailsEdit({ booking, edit, parkingRate, parkingRates });
        const update = { $set: result.set };
        // Audit trail next to the original catalog price lines.
        update.$push = {
            'payment.priceBreakdown.adminEdits': {
                at: new Date(),
                by: req.user?._id || null,
                previousTotal: result.oldTotal,
                delta: result.delta,
                discount: result.discount,
                newTotal: result.total,
            },
        };
        if (!booking.payment?.priceBreakdown || typeof booking.payment.priceBreakdown !== 'object') {
            // $push into a null Mixed path fails — seed it first.
            update.$set['payment.priceBreakdown'] = { adminEdits: [update.$push['payment.priceBreakdown.adminEdits']] };
            delete update.$push;
        }

        const updated = await AdvanceBooking.findOneAndUpdate(scope, update, { returnDocument: 'after', runValidators: true });
        if (!updated) return res.status(404).json({ success: false, message: 'Booking not found' });

        res.status(200).json({ success: true, message: 'Booking updated', booking: updated });
    } catch (error) {
        logger.error('Error updating booking details:', { error: error.message });
        res.status(500).json({ success: false, message: 'Error updating booking' });
    }
};

// Delete a booking
const deleteBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await AdvanceBooking.findOneAndDelete({ _id: id, ...tenantFilter(req), ...strictBranchFilter(req) });
        if (!deleted) return res.status(404).json({ success: false, message: 'Booking not found' });
        
        res.status(200).json({ success: true, message: 'Booking deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting booking', ...devError(error) });
    }
};

// Get bookings for the logged-in customer (per-tenant)
const getMyBookings = async (req, res) => {
    try {
        const userId = req.user.id;

        const bookings = await AdvanceBooking.find({ user: userId, ...tenantFilter(req) })
            .populate('hall', 'name basePrice maxCapacity')
            .populate('tables', 'name capacity')
            .populate('package', 'name price')
            .sort({ bookingDate: -1 });

        const formatted = bookings.map(b => ({
            _id: b._id,
            bookingId: b.bookingId, // friendly human-readable id (e.g. TBL-001 / HALL-001)
            bookingType: b.bookingType,
            bookingDate: b.bookingDate,
            bookingTime: b.bookingTime,
            timeSlot: b.timeSlot,
            guestCount: b.guestCount,
            status: b.status,
            hall: b.hall,
            tables: b.tables,
            package: b.package,
            specialEvent: b.specialEvent,
            cakeDetails: b.cakeDetails,
            addons: b.addons,
            parkingDetails: normalizeParkingDetails(b.parkingDetails),
            payment: b.payment,
            notes: b.notes,
            createdAt: b.createdAt,
        }));

        res.status(200).json({ success: true, bookings: formatted });
    } catch (error) {
        logger.error('Get My Bookings Error:', { error: error.message });
        res.status(500).json({ success: false, message: 'Error fetching your bookings', ...devError(error) });
    }
};

// Get single booking by ID with full details (per-tenant)
const getBookingById = async (req, res) => {
    try {
        const booking = await AdvanceBooking.findOne({ _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) })
            .populate('user', 'name email mobile avatar')
            .populate('tables', 'name capacity')
            .populate('area', 'name')
            .populate('hall', 'name basePrice maxCapacity amenities')
            .populate('package', 'name price');

        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

        res.status(200).json({ success: true, booking });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching booking', ...devError(error) });
    }
};

// ─── Razorpay glue for the second-leg "pay remaining" charge ──────────
// Loaded lazily so a deployment without RAZORPAY_KEY_ID doesn't crash
// at module load — the create-remaining endpoint will return a clear
// 503 instead. Mirrors razorpayController's instance shape.
const Razorpay = require('razorpay');
const crypto = require('crypto');
const _razorpayInstance = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
    ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
    : null;

// Constant-time HMAC compare — same protection razorpayController uses.
function _safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// POST /api/advance-booking/:id/create-remaining-payment
// Customer-initiated. Creates a Razorpay order for `totalAmount -
// advancePaid` so the customer can settle the balance from their
// Booking History page before the event starts.
const createRemainingPaymentOrder = async (req, res) => {
    try {
        if (!_razorpayInstance) {
            return res.status(503).json({
                success: false,
                code: 'PAYMENT_GATEWAY_UNAVAILABLE',
                message: 'Online payments are not configured. Please pay at the counter.',
            });
        }

        const { id } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        // Booking must exist, belong to the caller, and be in a state
        // where a balance is genuinely outstanding. Cancelled bookings
        // can't accept new charges; fully-paid ones already settled.
        const booking = await AdvanceBooking.findOne({
            _id: id,
            user: userId,
            ...tenantFilter(req),
        });
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
        if (booking.status === 'Cancelled') {
            return res.status(400).json({ success: false, message: 'This booking has been cancelled.' });
        }
        if (booking.payment?.status === 'Paid') {
            return res.status(400).json({ success: false, message: 'This booking is already fully paid.' });
        }

        const total = booking.payment?.totalAmount || 0;
        const paid = booking.payment?.advancePaid || 0;
        const remaining = Math.max(total - paid, 0);
        if (remaining <= 0) {
            return res.status(400).json({ success: false, message: 'Nothing left to pay on this booking.' });
        }

        const tenant = tenantId(req);
        const options = {
            amount: Math.round(remaining * 100), // paise
            currency: 'INR',
            receipt: `bk_rem_${booking.bookingId}_${Date.now()}`.slice(0, 40),
            notes: {
                bookingId: String(booking._id),
                bookingCode: booking.bookingId,
                restaurantId: String(tenant || ''),
                kind: 'advance-booking-remaining',
            },
        };

        const rzpOrder = await _razorpayInstance.orders.create(options);

        // Stamp the Razorpay order id onto the booking so verify (and a
        // future webhook) can locate the booking from the gateway side.
        booking.payment.remainingRazorpayOrderId = rzpOrder.id;
        await booking.save();

        return res.status(200).json({
            success: true,
            razorpayOrder: {
                id: rzpOrder.id,
                amount: rzpOrder.amount,
                currency: rzpOrder.currency,
                receipt: rzpOrder.receipt,
            },
            key: process.env.RAZORPAY_KEY_ID,
            booking: {
                _id: booking._id,
                bookingId: booking.bookingId,
                remainingAmount: remaining,
            },
        });
    } catch (err) {
        logger.error('createRemainingPaymentOrder error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to create payment order' });
    }
};

// POST /api/advance-booking/:id/verify-remaining-payment
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Verifies the gateway signature, marks the booking fully paid, and
// notifies the customer + admins. Idempotent: a re-submitted verify
// for an already-paid booking just returns success.
const verifyRemainingPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Missing Razorpay payment fields' });
        }

        const booking = await AdvanceBooking.findOne({
            _id: id,
            user: userId,
            ...tenantFilter(req),
        });
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

        // Idempotency: if we already settled this booking on a prior
        // verify call, just acknowledge and move on instead of throwing.
        if (booking.payment?.status === 'Paid') {
            return res.status(200).json({ success: true, alreadyPaid: true, booking });
        }

        // The order id stamped at create-time MUST match — otherwise a
        // caller could replay another booking's signature.
        if (booking.payment?.remainingRazorpayOrderId !== razorpay_order_id) {
            return res.status(400).json({ success: false, message: 'Razorpay order does not match this booking.' });
        }

        const expected = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (!_safeEqual(expected, razorpay_signature)) {
            logger.warn('Remaining-payment signature mismatch', { bookingId: booking.bookingId });
            return res.status(400).json({ success: false, message: 'Invalid payment signature' });
        }

        // A valid signature only proves the browser saw a checkout — confirm
        // with the gateway that the money actually settled, for this
        // booking, this restaurant and (at least) the outstanding balance.
        if (!_razorpayInstance) {
            return res.status(503).json({ success: false, code: 'PAYMENT_GATEWAY_UNAVAILABLE', message: 'Online payments are not configured.' });
        }
        let rzpPayment;
        let rzpOrder;
        try {
            rzpPayment = await _razorpayInstance.payments.fetch(razorpay_payment_id);
            rzpOrder = await _razorpayInstance.orders.fetch(razorpay_order_id);
        } catch (fetchErr) {
            logger.error('Remaining payment: Razorpay fetch failed', { error: fetchErr.message, razorpayPaymentId: razorpay_payment_id });
            return res.status(502).json({ success: false, code: 'GATEWAY_UNAVAILABLE', message: 'Could not confirm the payment with the gateway. Please try again in a moment.' });
        }
        const settled = checkSettledPayment(rzpPayment, razorpay_order_id);
        if (!settled.ok) {
            return res.status(settled.status).json({ success: false, code: settled.code, message: settled.message });
        }
        const notes = mergedNotes(rzpPayment, rzpOrder);
        const purpose = notes.purpose || notes.type || notes.kind;
        if (purpose && purpose !== 'advance-booking-remaining') {
            return res.status(400).json({ success: false, code: 'PAYMENT_PURPOSE_MISMATCH', message: 'This payment was not made for a booking balance.' });
        }
        if (notes.bookingId && String(notes.bookingId) !== String(booking._id)) {
            return res.status(400).json({ success: false, code: 'PAYMENT_ORDER_MISMATCH', message: 'This payment was made for a different booking.' });
        }
        const bookingTenant = booking.restaurant ? String(booking.restaurant) : String(tenantId(req) || '');
        if (bookingTenant && (!notes.restaurantId || String(notes.restaurantId) !== bookingTenant)) {
            return res.status(403).json({ success: false, code: 'TENANT_MISMATCH', message: 'This payment belongs to a different restaurant.' });
        }
        const outstanding = Math.max((booking.payment?.totalAmount || 0) - (booking.payment?.advancePaid || 0), 0);
        if (settled.amount + 0.01 < outstanding) {
            return res.status(400).json({ success: false, code: 'PAYMENT_AMOUNT_MISMATCH', message: 'Payment amount does not cover the remaining balance.' });
        }

        // Single-use: this payment id can never be spent twice (here, on
        // another booking, an order or a wallet top-up).
        const claimRef = `${booking.bookingId}:remaining`;
        const claim = await claimPayment(razorpay_payment_id, {
            purpose: 'advance_booking',
            ref: claimRef,
            razorpayOrderId: razorpay_order_id,
            restaurant: booking.restaurant || tenantId(req) || null,
            user: userId,
            amount: settled.amount,
        });
        if (!claim.claimed) {
            return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used.' });
        }

        // Land the second leg.
        const total = booking.payment?.totalAmount || 0;
        booking.payment.advancePaid = total;
        booking.payment.status = 'Paid';
        booking.payment.method = 'online';
        booking.payment.fullyPaidAt = new Date();
        try {
            await booking.save();
        } catch (saveErr) {
            if (!claim.replay) await releaseClaim(razorpay_payment_id, { purpose: 'advance_booking', ref: claimRef });
            throw saveErr;
        }

        // Customer-facing confirmation.
        if (booking.user) {
            await notify({
                restaurant: booking.restaurant,
                branch: booking.branch || null,
                recipients: booking.user,
                notification: {
                    title: 'Payment Received',
                    description: `We received your final payment for booking ${booking.bookingId}. See you on ${fmtBookingDate(booking.bookingDate)}!`,
                    category: 'Payment',
                    recipientRole: 'customer',
                    priority: 'normal',
                    meta: {
                        bookingId: booking.bookingId,
                        bookingDocId: booking._id.toString(),
                        razorpayPaymentId: razorpay_payment_id,
                    },
                },
                payload: {
                    title: 'Payment Received',
                    description: `Final payment for booking ${booking.bookingId} confirmed.`,
                },
            });
        }

        // Admin-facing audit trail. Mirrors createAdvanceBooking pattern.
        await notify({
            restaurant: booking.restaurant,
            branch: booking.branch || null,
            audience: 'admin',
            notification: {
                title: 'Booking Balance Paid',
                description: `Customer settled the balance for booking ${booking.bookingId}.`,
                category: 'Payment',
                recipientRole: 'admin',
                meta: { bookingId: booking.bookingId, bookingDocId: booking._id.toString() },
            },
            payload: { title: 'Booking Balance Paid', description: `Booking ${booking.bookingId}` },
        });

        return res.status(200).json({ success: true, booking });
    } catch (err) {
        logger.error('verifyRemainingPayment error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to verify payment' });
    }
};

// CUS-075 — customer self-cancellation with refund-per-policy.
//
// Policy (configurable later via tenant settings; defaults sane for v1):
//   ≥ 48h before event → 100% refund of advance paid
//   24-48h            →  50%
//   < 24h             →   0% (non-refundable window)
//   Already-confirmed bookings cancelled WITHIN 24h still need the
//   "Cancel anyway" confirmation — the customer loses the deposit but
//   the booking comes off our books.
//
// The actual refund POST to Razorpay is queued as a refund-request row
// so the admin can review and trigger the payout, matching the existing
// /refund-requests flow used elsewhere. The booking status flips
// immediately so the customer sees the cancellation reflected.
const cancelMyBooking = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const booking = await AdvanceBooking.findOne({
            _id: id,
            user: userId,
            ...tenantFilter(req),
        });
        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found' });
        }
        if (booking.status === 'Cancelled') {
            return res.status(400).json({ success: false, code: 'ALREADY_CANCELLED', message: 'This booking is already cancelled.' });
        }
        if (booking.status === 'Completed') {
            return res.status(400).json({ success: false, code: 'BOOKING_COMPLETED', message: 'Completed bookings cannot be cancelled.' });
        }

        // Hours until the event START (booking date + start time in the
        // tenant timezone). Negative = event already started.
        const hoursUntil = await hoursUntilEvent(req, booking);

        // Refund tier from policy.
        const advancePaid = Number(booking.payment?.advancePaid || 0);
        let refundPct = 0;
        let refundTierLabel = 'Non-refundable (< 24h)';
        if (hoursUntil >= 48) {
            refundPct = 100;
            refundTierLabel = 'Full refund (≥ 48h notice)';
        } else if (hoursUntil >= 24) {
            refundPct = 50;
            refundTierLabel = '50% refund (24–48h notice)';
        }
        const refundAmount = Math.round(advancePaid * (refundPct / 100));

        // Apply cancellation
        booking.status = 'Cancelled';
        booking.cancellation = {
            cancelledAt: new Date(),
            cancelledBy: 'customer',
            refundPct,
            refundAmount,
            refundTier: refundTierLabel,
            hoursBeforeEvent: Math.round(hoursUntil),
            policy: 'standard-v1',
            ...(req.body?.reason ? { reason: String(req.body.reason).slice(0, 500) } : {}),
        };
        await booking.save();

        // Notify the admin so they know to process the refund.
        await notify({
            restaurant: booking.restaurant,
            branch: booking.branch || null,
            audience: 'admin',
            notification: {
                title: 'Booking Cancelled by Customer',
                description: `${booking.bookingId} — ${refundTierLabel}. Refund due: ₹${refundAmount}`,
                category: 'Booking',
                recipientRole: 'admin',
                priority: refundAmount > 0 ? 'high' : 'normal',
                meta: {
                    bookingId: booking.bookingId,
                    bookingDocId: booking._id.toString(),
                    refundAmount,
                    refundPct,
                },
            },
            payload: { title: 'Booking Cancelled', description: `${booking.bookingId} — refund ₹${refundAmount}` },
        });

        return res.status(200).json({
            success: true,
            message: refundAmount > 0
                ? `Booking cancelled. ₹${refundAmount} will be refunded per policy (${refundTierLabel}).`
                : `Booking cancelled. No refund — within the non-refundable window (${refundTierLabel}).`,
            booking: {
                _id: booking._id,
                bookingId: booking.bookingId,
                status: booking.status,
                cancellation: booking.cancellation,
            },
        });
    } catch (err) {
        logger.error('cancelMyBooking error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to cancel booking' });
    }
};

// CUS-075 — read-only preview of what the refund would be. Lets the
// frontend show the exact amount in the "Are you sure?" modal before
// the customer commits. Same policy as cancelMyBooking; no DB writes.
const previewCancellation = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const booking = await AdvanceBooking.findOne({
            _id: id,
            user: userId,
            ...tenantFilter(req),
        }).lean();
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

        const advancePaid = Number(booking.payment?.advancePaid || 0);
        const hoursUntil = await hoursUntilEvent(req, booking);
        let refundPct = 0;
        let refundTierLabel = 'Non-refundable (< 24h)';
        if (hoursUntil >= 48) { refundPct = 100; refundTierLabel = 'Full refund (≥ 48h notice)'; }
        else if (hoursUntil >= 24) { refundPct = 50; refundTierLabel = '50% refund (24–48h notice)'; }
        const refundAmount = Math.round(advancePaid * (refundPct / 100));

        return res.status(200).json({
            success: true,
            preview: {
                advancePaid,
                refundPct,
                refundAmount,
                refundTier: refundTierLabel,
                hoursBeforeEvent: Math.round(hoursUntil),
                cancellable: booking.status !== 'Cancelled' && booking.status !== 'Completed',
            },
        });
    } catch (err) {
        logger.error('previewCancellation error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to compute cancellation preview' });
    }
};

module.exports = {
    updateBookingDetails,
    createAdvanceBooking,
    getAdvanceBookings,
    getBookingById,
    updateStatus,
    deleteBooking,
    getMyBookings,
    createRemainingPaymentOrder,
    verifyRemainingPayment,
    cancelMyBooking,
    previewCancellation,
};
