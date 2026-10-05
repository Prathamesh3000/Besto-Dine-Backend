// Parking for table bookings (QA N10 / N11).
//
// Config lives in Settings.reservation.parking (admin → Settings →
// Reservation → Parking). Every piece here is pure except
// `loadParkingConfig`, so the same rules drive:
//   - GET /booking-info/parking   (what the customer is offered)
//   - utils/advanceBookingPricing (what the customer is charged)
//   - the admin "Edit booking" re-price
//
// Request shape (POST /advance-booking/create):
//   parkingVehicles: [{ vehicleType: 'car', count: 3 }, { vehicleType: 'bike', count: 5 }]
//   parkingMode:     'event' (whole event, billed at config.eventHours) | 'custom'
//   parkingStartTime:'HH:MM' (custom mode, optional)
//   parkingDuration: hours  (custom mode, 1..config.maxDuration)
// Legacy single-type requests (selectedVehicle + vehicleCount +
// parkingDuration) are still accepted and mapped to one row.

const DEFAULT_PARKING_VEHICLES = [
    { id: 'bike', label: 'Bike', pricePerHour: 20 },
    { id: 'car', label: 'Car', pricePerHour: 50 },
    { id: 'bus', label: 'Bus', pricePerHour: 100 },
];
const DEFAULT_MAX_DURATION = 6;
const DEFAULT_EVENT_HOURS = 3;
const MAX_VEHICLES_PER_TYPE = 500;
const MAX_VEHICLE_ROWS = 10;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const intIn = (v, min, max, fallback) => {
    const n = Math.floor(num(v));
    if (!Number.isFinite(n) || n < min) return fallback;
    return Math.min(max, n);
};
const slug = (v) => String(v || '').trim().toLowerCase();

/** Fill defaults / drop junk from a stored (or legacy top-level) parking config. */
function normalizeParkingConfig(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const vehicles = (Array.isArray(cfg.vehicles) ? cfg.vehicles : [])
        .map((v) => {
            const id = slug(v?.id || v?.label);
            return id ? { id, label: String(v.label || id).trim() || id, pricePerHour: Math.max(0, num(v.pricePerHour)) } : null;
        })
        .filter((v) => v && !seen.has(v.id) && seen.add(v.id));
    const maxDuration = intIn(cfg.maxDuration, 1, 24, DEFAULT_MAX_DURATION);
    const eventHours = intIn(cfg.eventHours, 1, 24, DEFAULT_EVENT_HOURS);
    return {
        vehicles: vehicles.length ? vehicles : DEFAULT_PARKING_VEHICLES.map((v) => ({ ...v })),
        maxDuration,
        eventHours,
    };
}

/** Settings doc → its parking config (new home first, legacy top-level fallback). */
function parkingConfigFromSettings(settings) {
    const raw = settings?.reservation?.parking;
    if (raw && Array.isArray(raw.vehicles) && raw.vehicles.length) return normalizeParkingConfig(raw);
    if (settings?.parking && Array.isArray(settings.parking.vehicles) && settings.parking.vehicles.length) {
        return normalizeParkingConfig(settings.parking);
    }
    return normalizeParkingConfig(raw || {});
}

/**
 * Tenant's parking config. Reservation settings are edited on the
 * tenant-level doc (or the main branch — sub-branches inherit), so prefer
 * the tenant doc, then any doc of the tenant that has parking configured.
 */
async function loadParkingConfig(tf) {
    const Settings = require('../models/settings');
    const docs = await Settings.find({ ...tf }).select('branch reservation.parking parking').lean();
    const configured = (d) => (Array.isArray(d?.reservation?.parking?.vehicles) && d.reservation.parking.vehicles.length > 0)
        || (Array.isArray(d?.parking?.vehicles) && d.parking.vehicles.length > 0);
    const pick = docs.find((d) => !d.branch && configured(d))
        || docs.find(configured)
        || docs.find((d) => !d.branch)
        || docs[0];
    return parkingConfigFromSettings(pick);
}

/**
 * Pure. Validate + price the parking part of a create-booking body.
 * Returns null when there is no (billable) parking, { error } on a bad
 * request, else { vehicles, hours, mode, startTime, total }.
 */
function resolveParkingRequest(body, config) {
    const b = body || {};
    if (b.bookingType === 'hall' || b.parkingSkipped === true || b.parkingSkipped === 'true') return null;
    const cfg = config && Array.isArray(config.vehicles) ? config : normalizeParkingConfig(config);

    let rows;
    if (Array.isArray(b.parkingVehicles)) {
        rows = b.parkingVehicles;
    } else if (b.selectedVehicle) {
        rows = [{ vehicleType: b.selectedVehicle, count: b.vehicleCount === undefined ? 1 : b.vehicleCount }];
    } else {
        return null;
    }
    if (rows.length > MAX_VEHICLE_ROWS) return { error: `At most ${MAX_VEHICLE_ROWS} vehicle types can be booked` };

    const byType = new Map();
    for (const r of rows) {
        const type = slug(r?.vehicleType);
        if (!type) return { error: 'Each parking row needs a vehicle type' };
        const count = Math.floor(num(r?.count));
        if (count < 0) return { error: 'Vehicle count cannot be negative' };
        byType.set(type, (byType.get(type) || 0) + count);
    }
    const vehicles = [];
    for (const [type, count] of byType) {
        if (count <= 0) continue;
        if (count > MAX_VEHICLES_PER_TYPE) return { error: `At most ${MAX_VEHICLES_PER_TYPE} vehicles per type` };
        const v = cfg.vehicles.find((x) => x.id === type);
        if (!v) return { error: `Parking is not available for vehicle type "${type}"` };
        vehicles.push({ vehicleType: v.id, label: v.label, count, rate: v.pricePerHour });
    }
    if (!vehicles.length) return null;

    const mode = b.parkingMode === 'event' ? 'event' : 'custom';
    let hours;
    if (mode === 'event') {
        hours = cfg.eventHours;
    } else {
        const raw = b.parkingDuration === undefined || b.parkingDuration === null || b.parkingDuration === ''
            ? 2
            : num(b.parkingDuration);
        hours = Math.floor(raw);
        if (!(hours >= 1) || hours !== raw) return { error: 'Parking duration must be a whole number of hours' };
        if (hours > cfg.maxDuration) return { error: `Parking duration cannot exceed ${cfg.maxDuration} hours` };
    }
    let startTime = null;
    const st = mode === 'event' ? (b.parkingStartTime || b.selectedStartTime) : b.parkingStartTime;
    if (st !== undefined && st !== null && st !== '') {
        if (!HHMM_RE.test(String(st))) {
            if (mode === 'custom') return { error: 'Parking start time must be HH:MM' };
        } else {
            startTime = String(st);
        }
    }

    for (const v of vehicles) v.amount = v.rate * v.count * hours;
    const total = vehicles.reduce((s, v) => s + v.amount, 0);
    return { vehicles, hours, mode, startTime, total };
}

/**
 * Pure. Read-side normaliser for AdvanceBooking.parkingDetails — old
 * single-type bookings ({ vehicleType, count }) gain a one-row
 * `vehicles` list so every view can render the list shape.
 */
function normalizeParkingDetails(pd) {
    if (!pd || typeof pd !== 'object') return pd;
    const obj = typeof pd.toObject === 'function' ? pd.toObject() : { ...pd };
    let vehicles = (Array.isArray(obj.vehicles) ? obj.vehicles : [])
        .filter((v) => v && v.vehicleType && num(v.count) > 0)
        .map((v) => ({ ...v }));
    if (!vehicles.length && obj.vehicleType && num(obj.count) > 0) {
        vehicles = [{ vehicleType: obj.vehicleType, count: num(obj.count) }];
    }
    return {
        ...obj,
        vehicles,
        mode: obj.mode || 'custom',
        startTime: obj.startTime || null,
    };
}

module.exports = {
    DEFAULT_PARKING_VEHICLES,
    DEFAULT_MAX_DURATION,
    DEFAULT_EVENT_HOURS,
    MAX_VEHICLE_ROWS,
    MAX_VEHICLES_PER_TYPE,
    normalizeParkingConfig,
    parkingConfigFromSettings,
    loadParkingConfig,
    resolveParkingRequest,
    normalizeParkingDetails,
};
