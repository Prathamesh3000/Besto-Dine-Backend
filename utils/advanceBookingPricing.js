// Server-side pricing for advance bookings (bug #9).
//
// Mirrors Frontend/src/Pages/AdvanceBooking/BookingReview.jsx
// `calculatePrices()` line for line, but every unit price comes from the
// tenant's catalog in Mongo — never from the browser:
//
//   hall        Hall.basePrice                         (hall bookings)
//   package     Package.price × guests                 (hall bookings)
//   cake        MenuItem.sizes[selectedSize].price × quantity
//   decoration  DecorationPackage.basePrice
//   parking     Σ (vehicle-type rate × count) × hours  (table bookings;
//               rates + hours from Settings.reservation.parking, see
//               utils/parkingConfig.js — multi-vehicle since QA N10/N11)
//   addons      Addon.price, duration-scaled for photographer / dj /
//               host / photobooth (2h = 40%, 4h = 80%, full = 100%)
//   − coupon discount (re-validated server-side)
//   − wallet points × pointsToRupee
//
// `computeBookingPrice` is pure (unit-tested); `loadBookingPrice` does
// the catalog lookups and feeds it.

const mongoose = require('mongoose');

const {
    DEFAULT_PARKING_VEHICLES,
    loadParkingConfig,
    resolveParkingRequest,
    normalizeParkingDetails,
} = require('./parkingConfig');

const DURATION_SCALED_ADDONS = new Set(['photographer', 'dj', 'host', 'photobooth']);
const DEFAULT_PARKING_RATES = Object.fromEntries(DEFAULT_PARKING_VEHICLES.map((v) => [v.id, v.pricePerHour]));

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => Math.round(num(v) * 100) / 100;

function addonLinePrice(basePrice, slug, duration) {
    const base = Math.max(0, num(basePrice));
    if (!DURATION_SCALED_ADDONS.has(slug)) return base;
    if (String(duration) === '2') return Math.round(base * 0.4);
    if (String(duration) === '4') return Math.round(base * 0.8);
    return base;
}

// Σ rate × count over the vehicle rows, × hours. Accepts the multi-row
// shape ({ lines, hours }) and the legacy single row ({ rate, count, hours }).
function parkingCharge(pk) {
    const hours = Math.max(1, num(pk.hours) || 2);
    if (Array.isArray(pk.lines)) {
        return pk.lines.reduce((s, l) => s + Math.max(0, num(l.rate)) * Math.max(0, Math.floor(num(l.count))), 0) * hours;
    }
    return Math.max(0, num(pk.rate)) * Math.max(1, Math.floor(num(pk.count)) || 1) * hours;
}

/**
 * @param {object} p
 *   bookingType, guests,
 *   hallPrice, packagePrice, cake: { unitPrice, quantity } | null,
 *   decorationPrice,
 *   parking: { lines: [{ rate, count }], hours } | { rate, count, hours } | null,
 *   addons: [{ price, slug, duration }], couponDiscount, pointsRupees
 */
function computeBookingPrice(p) {
    const isHall = p.bookingType === 'hall';
    const guests = Math.max(1, Math.floor(num(p.guests)) || 1);

    const hall = isHall ? Math.max(0, num(p.hallPrice)) : 0;
    const pkg = isHall ? Math.max(0, num(p.packagePrice)) * guests : 0;
    const cake = p.cake ? Math.max(0, num(p.cake.unitPrice)) * Math.max(1, Math.floor(num(p.cake.quantity)) || 1) : 0;
    const decoration = Math.max(0, num(p.decorationPrice));
    const parking = (!isHall && p.parking) ? parkingCharge(p.parking) : 0;
    const addon = (p.addons || []).reduce((s, a) => s + addonLinePrice(a.price, a.slug, a.duration), 0);

    const subtotal = round2(hall + pkg + cake + decoration + parking + addon);
    const discount = round2(Math.min(Math.max(0, num(p.couponDiscount)), subtotal));
    const afterCoupon = subtotal - discount;
    const points = round2(Math.min(Math.max(0, num(p.pointsRupees)), afterCoupon));
    const total = round2(Math.max(0, afterCoupon - points));

    return {
        total,
        subtotal,
        advance: Math.round(total * 0.5),
        breakdown: { hall, package: pkg, cake, decoration, parking, addon, discount, points },
    };
}

const oid = (v) => (v && mongoose.Types.ObjectId.isValid(String(v)) ? String(v) : null);

// Coupon re-validation mirroring promotionController.applyCoupon's
// read-only checks. Invalid / scoped coupons contribute 0 discount.
// `branch` is the booking's branch: a coupon pinned to a different
// branch does not apply (unknown booking branch = no branch check, as
// applyCoupon does for a caller without branch context).
async function couponDiscountFor({ code, subtotal, tf, userId, branch = null }) {
    if (!code || subtotal <= 0) return { discount: 0, coupon: null };
    const Coupon = require('../models/coupon');
    const CouponRedemption = require('../models/couponRedemption');
    const { computeCouponDiscount } = require('./couponScope');
    const coupon = await Coupon.findOne({ code: String(code).toUpperCase(), isActive: true, ...tf });
    if (!coupon) return { discount: 0, coupon: null };
    const now = new Date();
    if ((coupon.startDate && now < coupon.startDate) || (coupon.endDate && now > coupon.endDate)) return { discount: 0, coupon: null };
    // Time-of-day window — same rule (and clock) as applyCoupon.
    if (coupon.startTime && coupon.endTime) {
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (currentTime < coupon.startTime || currentTime > coupon.endTime) return { discount: 0, coupon: null };
    }
    if (coupon.branch && branch && String(coupon.branch) !== String(branch)) return { discount: 0, coupon: null };
    if (coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) return { discount: 0, coupon: null };
    if (userId && coupon.usagePerUser > 0) {
        const used = await CouponRedemption.countDocuments({ coupon: coupon._id, user: userId });
        if (used >= coupon.usagePerUser) return { discount: 0, coupon: null };
    }
    if (subtotal < (coupon.minOrderValue || 0)) return { discount: 0, coupon: null };
    if (coupon.scope && coupon.scope !== 'all') return { discount: 0, coupon: null };
    const { discount } = computeCouponDiscount(coupon, [{ prepStation: 'kitchen', price: subtotal, quantity: 1 }]);
    return { discount: Math.min(num(discount), subtotal), coupon };
}

/**
 * Look up every priced component in the tenant's catalog and compute the
 * authoritative booking price from the create-booking request body.
 */
async function loadBookingPrice({ body, tf, userId, pointsToRupee = 0.1, parkingConfig = null, branch }) {
    const Hall = require('../models/hall');
    const Package = require('../models/package');
    const MenuItem = require('../models/menuItem');
    const DecorationPackage = require('../models/decorationPackage');
    const Addon = require('../models/addon');

    const isHall = body.bookingType === 'hall';
    const lines = { decoration: null, addons: [] };

    let hallPrice = 0;
    if (isHall && oid(body.selectedHallId)) {
        const hall = await Hall.findOne({ _id: oid(body.selectedHallId), ...tf }).select('basePrice').lean();
        hallPrice = num(hall?.basePrice);
    }

    let packagePrice = 0;
    const pkgId = oid(body.selectedPackage?._id || body.selectedPackage?.id || body.selectedPackageId);
    if (isHall && pkgId) {
        const pkg = await Package.findOne({ _id: pkgId, ...tf }).select('price').lean();
        packagePrice = num(pkg?.price);
    }

    let cake = null;
    if (oid(body.selectedFlavor) && body.selectedSize) {
        const item = await MenuItem.findOne({ _id: oid(body.selectedFlavor), ...tf }).select('sizes').lean();
        const size = (item?.sizes || []).find(s => String(s._id) === String(body.selectedSize));
        if (size) cake = { unitPrice: num(size.price), quantity: body.quantity };
    }

    let decorationPrice = 0;
    const decorId = oid(body.selectedDecor?.id || body.selectedDecor?._id || body.selectedDecorId);
    if (decorId) {
        const decor = await DecorationPackage.findOne({ _id: decorId, ...tf }).select('basePrice name').lean();
        if (decor) {
            decorationPrice = num(decor.basePrice);
            lines.decoration = { id: String(decor._id), title: decor.name, price: decorationPrice };
        }
    }

    // Parking — validated + priced by utils/parkingConfig. A bad
    // request (unknown vehicle type, too many hours) is reported back as
    // `parkingError` for the controller to turn into a 400.
    let parking = null;
    let parkingDetail = null;
    let parkingError = null;
    if (!isHall && !body.parkingSkipped && (Array.isArray(body.parkingVehicles) || body.selectedVehicle)) {
        const config = parkingConfig || await loadParkingConfig(tf);
        const resolved = resolveParkingRequest(body, config);
        if (resolved?.error) {
            parkingError = resolved.error;
        } else if (resolved) {
            parkingDetail = resolved;
            parking = { lines: resolved.vehicles.map((v) => ({ rate: v.rate, count: v.count })), hours: resolved.hours };
        }
    }

    const addonIds = Array.from(new Set(
        (Array.isArray(body.selectedAddons) && body.selectedAddons.length
            ? body.selectedAddons
            : (body.selectedAddonDetails || []).map(a => a?.id || a?._id))
            .map(oid).filter(Boolean)
    ));
    const addons = [];
    if (addonIds.length) {
        const docs = await Addon.find({ _id: { $in: addonIds }, ...tf }).select('price slug title').lean();
        for (const d of docs) {
            const sel = body.addonSelections?.[String(d._id)] || {};
            const detail = (body.selectedAddonDetails || []).find(a => String(a?.id || a?._id) === String(d._id)) || {};
            addons.push({ price: num(d.price), slug: d.slug, duration: sel.duration });
            lines.addons.push({
                id: String(d._id),
                title: d.title,
                price: addonLinePrice(d.price, d.slug, sel.duration),
                options: Array.isArray(detail.options) ? detail.options.map(String) : (Array.isArray(sel.options) ? sel.options.map(String) : []),
            });
        }
    }

    const pre = computeBookingPrice({
        bookingType: body.bookingType, guests: body.guests,
        hallPrice, packagePrice, cake, decorationPrice, parking, addons,
    });
    // The controller passes the booking's resolved branch; direct callers
    // without one fall back to the body's branchId.
    const bookingBranch = branch !== undefined ? branch : (oid(body.branchId) || null);
    const { discount, coupon } = await couponDiscountFor({ code: body.couponCode, subtotal: pre.subtotal, tf, userId, branch: bookingBranch });
    const requestedPoints = Math.max(0, num(body.walletPointsUsed));
    const pointsRupees = requestedPoints * num(pointsToRupee);

    const price = computeBookingPrice({
        bookingType: body.bookingType, guests: body.guests,
        hallPrice, packagePrice, cake, decorationPrice, parking, addons,
        couponDiscount: discount, pointsRupees,
    });
    lines.parking = parkingDetail;
    // Points actually spent: only what the (capped) rupee value needs,
    // in whole points, never more than requested.
    const rate = num(pointsToRupee);
    const pointsUsed = rate > 0 && price.breakdown.points > 0
        ? Math.min(requestedPoints, Math.ceil(Math.round((price.breakdown.points / rate) * 1e6) / 1e6))
        : 0;
    const appliedCoupon = coupon && price.breakdown.discount > 0 ? coupon : null;
    return { ...price, lines, parkingError, pointsUsed, coupon: appliedCoupon };
}

/**
 * Pure. Admin "Edit booking" (BookingDrawer) → new stored fields + total.
 *
 * `edit` is the already-validated allowlist:
 *   cakes:   [{ name, price, quantity }]  price 0 = the booking's original
 *            cake (already inside totalAmount); price > 0 = an extra cake
 *            the admin added (stored as an add-on line "Cake: name ×qty").
 *            No price-0 entry while the booking had a cake = cake removed.
 *   addons:  [{ title, price }]           replaces addons.otherAddons
 *   parking: { vehicles: [{ vehicleType, count }], hours }  re-priced at
 *            `parkingRates[type]` (legacy { vehicleCount, hours } →
 *            `parkingRate` for the booking's single vehicle type)
 *   discount: number                      one-off, capped to the balance
 *
 * The total is adjusted by the DIFFERENCE of each edited component so the
 * original catalog pricing (hall, package, decoration, coupon, points)
 * is untouched. It never drops below what has already been paid —
 * returning money goes through the refund flow, not an edit.
 */
function applyBookingDetailsEdit({ booking, edit, parkingRate = 0, parkingRates = null }) {
    const b = booking || {};
    let parkingAfter;
    const pay = b.payment || {};
    const breakdown = (pay.priceBreakdown && typeof pay.priceBreakdown === 'object') ? pay.priceBreakdown : {};
    const oldTotal = num(pay.totalAmount);
    const paid = Math.max(0, num(pay.advancePaid));
    const isHall = b.bookingType === 'hall';
    const sum = (arr) => arr.reduce((s, a) => s + Math.max(0, num(a.price)), 0);

    const set = {};
    let delta = 0;

    // Add-ons (+ extra cakes, which have no dedicated schema slot).
    const oldAddons = (b.addons?.otherAddons || []);
    let newAddons = oldAddons;
    if (edit.addons !== undefined || edit.cakes !== undefined) {
        const byKey = new Map(oldAddons.map((a) => [`${a.title}|${num(a.price)}`, a]));
        const addonRows = (edit.addons !== undefined ? edit.addons : oldAddons.filter((a) => !String(a.title || '').startsWith('Cake: ')))
            .map((a) => {
                const prev = byKey.get(`${a.title}|${num(a.price)}`);
                return prev
                    ? { id: prev.id, title: prev.title, price: num(prev.price), options: prev.options || [] }
                    : { title: String(a.title), price: round2(Math.max(0, num(a.price))) };
            });
        const extraCakes = (edit.cakes || [])
            .filter((c) => num(c.price) > 0)
            .map((c) => {
                const qty = Math.max(1, Math.floor(num(c.quantity)) || 1);
                return { title: `Cake: ${c.name} ×${qty}`, price: round2(num(c.price) * qty) };
            });
        newAddons = edit.cakes !== undefined
            ? [...addonRows.filter((a) => !String(a.title || '').startsWith('Cake: ')), ...extraCakes]
            : addonRows;
        delta += sum(newAddons) - sum(oldAddons);
        set['addons.otherAddons'] = newAddons;
    }

    // Original cake removed?
    if (edit.cakes !== undefined) {
        const hadCake = num(b.cakeDetails?.quantity) > 0 && !b.cakeDetails?.isSkipped;
        const keepsOriginal = edit.cakes.some((c) => !(num(c.price) > 0));
        if (hadCake && !keepsOriginal) {
            set['cakeDetails.isSkipped'] = true;
            set['cakeDetails.quantity'] = 0;
            delta -= Math.max(0, num(breakdown.cake));
        }
    }

    // Parking (table bookings only — hall parking is not billed).
    // Multi-vehicle edit: { vehicles: [{ vehicleType, count }], hours }.
    // Legacy edit: { vehicleCount, hours } re-counts the booking's single
    // vehicle type (or the first row of an old single-type booking).
    if (edit.parking !== undefined) {
        const old = normalizeParkingDetails(b.parkingDetails || {}) || {};
        const oldRows = old.vehicles || [];
        const hours = Math.max(0, Math.floor(num(edit.parking.hours)));
        let rows;
        if (Array.isArray(edit.parking.vehicles)) {
            const byType = new Map();
            for (const v of edit.parking.vehicles) {
                const t = String(v?.vehicleType || '').trim().toLowerCase();
                if (t) byType.set(t, (byType.get(t) || 0) + Math.max(0, Math.floor(num(v.count))));
            }
            rows = [...byType].map(([vehicleType, count]) => ({ vehicleType, count })).filter((r) => r.count > 0);
        } else if (oldRows.length > 1) {
            rows = oldRows.map((r) => ({ vehicleType: r.vehicleType, count: num(r.count) }));
        } else {
            const count = Math.max(0, Math.floor(num(edit.parking.vehicleCount)));
            const type = oldRows[0]?.vehicleType || b.parkingDetails?.vehicleType;
            rows = type && count > 0 ? [{ vehicleType: type, count }] : [];
        }
        const rateFor = (t) => {
            if (parkingRates && parkingRates[t] !== undefined) return Math.max(0, num(parkingRates[t]));
            return Math.max(0, num(parkingRate));
        };
        const priced = rows.map((r) => ({ ...r, rate: rateFor(r.vehicleType), amount: hours > 0 ? rateFor(r.vehicleType) * r.count * hours : 0 }));
        const totalCount = rows.reduce((s, r) => s + r.count, 0);
        const legacyCount = Array.isArray(edit.parking.vehicles) ? totalCount : Math.max(0, Math.floor(num(edit.parking.vehicleCount)));
        set['parkingDetails.count'] = oldRows.length > 1 && !Array.isArray(edit.parking.vehicles) ? totalCount : legacyCount;
        set['parkingDetails.timeDuration'] = `${hours}hrs`;
        set['parkingDetails.vehicles'] = priced;
        if (rows.length) set['parkingDetails.vehicleType'] = rows[0].vehicleType;
        set['parkingDetails.isSkipped'] = totalCount === 0 || hours === 0;
        const oldHours = parseInt(b.parkingDetails?.timeDuration, 10) || 0;
        if (hours !== oldHours) set['parkingDetails.mode'] = 'custom';
        if (!isHall && (oldRows.length > 0 || rows.length > 0)) {
            const oldCharge = breakdown.parking !== undefined
                ? Math.max(0, num(breakdown.parking))
                : (b.parkingDetails?.isSkipped ? 0 : oldRows.reduce((s, r) => s + rateFor(r.vehicleType) * num(r.count), 0) * oldHours);
            const newCharge = totalCount > 0 && hours > 0 ? priced.reduce((s, r) => s + r.amount, 0) : 0;
            delta += newCharge - oldCharge;
            parkingAfter = newCharge;
        }
    }

    let total = round2(Math.max(paid, oldTotal + delta));
    const discount = round2(Math.min(Math.max(0, num(edit.discount)), Math.max(0, total - paid)));
    total = round2(total - discount);

    set['payment.totalAmount'] = total;
    if (parkingAfter !== undefined && breakdown && Object.keys(breakdown).length) {
        set['payment.priceBreakdown.parking'] = round2(parkingAfter);
    }
    if (paid > 0) {
        set['payment.status'] = paid >= total ? 'Paid' : 'Partial';
    }

    return { set, total, oldTotal, delta: round2(delta), discount, paid };
}

module.exports = { computeBookingPrice, addonLinePrice, loadBookingPrice, applyBookingDetailsEdit, DEFAULT_PARKING_RATES };
