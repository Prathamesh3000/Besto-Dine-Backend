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
//   parking     settings.parking rate × count × hours  (table bookings)
//   addons      Addon.price, duration-scaled for photographer / dj /
//               host / photobooth (2h = 40%, 4h = 80%, full = 100%)
//   − coupon discount (re-validated server-side)
//   − wallet points × pointsToRupee
//
// `computeBookingPrice` is pure (unit-tested); `loadBookingPrice` does
// the catalog lookups and feeds it.

const mongoose = require('mongoose');

const DURATION_SCALED_ADDONS = new Set(['photographer', 'dj', 'host', 'photobooth']);
const DEFAULT_PARKING_RATES = { bike: 20, car: 50, bus: 100 };

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

/**
 * @param {object} p
 *   bookingType, guests,
 *   hallPrice, packagePrice, cake: { unitPrice, quantity } | null,
 *   decorationPrice, parking: { rate, count, hours } | null,
 *   addons: [{ price, slug, duration }], couponDiscount, pointsRupees
 */
function computeBookingPrice(p) {
    const isHall = p.bookingType === 'hall';
    const guests = Math.max(1, Math.floor(num(p.guests)) || 1);

    const hall = isHall ? Math.max(0, num(p.hallPrice)) : 0;
    const pkg = isHall ? Math.max(0, num(p.packagePrice)) * guests : 0;
    const cake = p.cake ? Math.max(0, num(p.cake.unitPrice)) * Math.max(1, Math.floor(num(p.cake.quantity)) || 1) : 0;
    const decoration = Math.max(0, num(p.decorationPrice));
    const parking = (!isHall && p.parking)
        ? Math.max(0, num(p.parking.rate)) * Math.max(1, Math.floor(num(p.parking.count)) || 1) * Math.max(1, num(p.parking.hours) || 2)
        : 0;
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
async function couponDiscountFor({ code, subtotal, tf, userId }) {
    if (!code || subtotal <= 0) return { discount: 0, coupon: null };
    const Coupon = require('../models/coupon');
    const CouponRedemption = require('../models/couponRedemption');
    const { computeCouponDiscount } = require('./couponScope');
    const coupon = await Coupon.findOne({ code: String(code).toUpperCase(), isActive: true, ...tf });
    if (!coupon) return { discount: 0, coupon: null };
    const now = new Date();
    if ((coupon.startDate && now < coupon.startDate) || (coupon.endDate && now > coupon.endDate)) return { discount: 0, coupon: null };
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
async function loadBookingPrice({ body, tf, userId, pointsToRupee = 0.1 }) {
    const Hall = require('../models/hall');
    const Package = require('../models/package');
    const MenuItem = require('../models/menuItem');
    const DecorationPackage = require('../models/decorationPackage');
    const Addon = require('../models/addon');
    const Settings = require('../models/settings');

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

    let parking = null;
    if (!isHall && !body.parkingSkipped && body.selectedVehicle) {
        const settings = await Settings.findOne(tf).select('parking').lean();
        const vehicles = settings?.parking?.vehicles;
        let rate;
        if (Array.isArray(vehicles) && vehicles.length > 0) {
            rate = num(vehicles.find(v => v.id === body.selectedVehicle)?.pricePerHour);
        } else {
            rate = num(DEFAULT_PARKING_RATES[body.selectedVehicle]);
        }
        const maxHours = num(settings?.parking?.maxDuration) || 24;
        const hours = Math.min(maxHours, Math.max(1, num(body.parkingDuration) || 2));
        parking = { rate, count: body.vehicleCount, hours };
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
    const { discount } = await couponDiscountFor({ code: body.couponCode, subtotal: pre.subtotal, tf, userId });
    const pointsRupees = Math.max(0, num(body.walletPointsUsed)) * num(pointsToRupee);

    const price = computeBookingPrice({
        bookingType: body.bookingType, guests: body.guests,
        hallPrice, packagePrice, cake, decorationPrice, parking, addons,
        couponDiscount: discount, pointsRupees,
    });
    return { ...price, lines };
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
 *   parking: { vehicleCount, hours }      re-priced at `parkingRate`
 *   discount: number                      one-off, capped to the balance
 *
 * The total is adjusted by the DIFFERENCE of each edited component so the
 * original catalog pricing (hall, package, decoration, coupon, points)
 * is untouched. It never drops below what has already been paid —
 * returning money goes through the refund flow, not an edit.
 */
function applyBookingDetailsEdit({ booking, edit, parkingRate = 0 }) {
    const b = booking || {};
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
    if (edit.parking !== undefined) {
        const count = Math.max(0, Math.floor(num(edit.parking.vehicleCount)));
        const hours = Math.max(0, Math.floor(num(edit.parking.hours)));
        set['parkingDetails.count'] = count;
        set['parkingDetails.timeDuration'] = `${hours}hrs`;
        set['parkingDetails.isSkipped'] = count === 0 || !b.parkingDetails?.vehicleType;
        if (!isHall && b.parkingDetails?.vehicleType) {
            const oldCount = num(b.parkingDetails?.count);
            const oldHours = parseInt(b.parkingDetails?.timeDuration, 10) || 0;
            const oldCharge = breakdown.parking !== undefined
                ? Math.max(0, num(breakdown.parking))
                : (b.parkingDetails?.isSkipped ? 0 : Math.max(0, num(parkingRate)) * oldCount * oldHours);
            const newCharge = count > 0 && hours > 0 ? Math.max(0, num(parkingRate)) * count * hours : 0;
            delta += newCharge - oldCharge;
        }
    }

    let total = round2(Math.max(paid, oldTotal + delta));
    const discount = round2(Math.min(Math.max(0, num(edit.discount)), Math.max(0, total - paid)));
    total = round2(total - discount);

    set['payment.totalAmount'] = total;
    if (paid > 0) {
        set['payment.status'] = paid >= total ? 'Paid' : 'Partial';
    }

    return { set, total, oldTotal, delta: round2(delta), discount, paid };
}

module.exports = { computeBookingPrice, addonLinePrice, loadBookingPrice, applyBookingDetailsEdit, DEFAULT_PARKING_RATES };
