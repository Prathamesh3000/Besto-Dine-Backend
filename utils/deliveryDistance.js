/**
 * deliveryDistance — server-side home-delivery distance + fee.
 *
 * The customer used to type/pick their delivery distance by hand, and the
 * server charged whatever slab they picked. Now the distance is measured:
 *
 *   origin   = the branch's latitude/longitude, else the tenant-level
 *              Settings.delivery.origin
 *   customer = coordinates sent by the checkout (browser geolocation or
 *              an address geocoded in the browser), else the address
 *              geocoded here via OpenStreetMap Nominatim (no API key)
 *   distance = haversine (straight-line) km between the two
 *   fee      = the Settings.delivery.slabs row covering that distance
 *
 * When either end can't be located (origin not configured, geocoder down)
 * the caller falls back to the slab the customer picked manually, so a
 * tenant that never set coordinates keeps working exactly as before.
 */
const mongoose = require('mongoose');
const logger = require('./logger');
const { tenantFilter } = require('./tenantScope');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const GEOCODE_TIMEOUT_MS = 5000;
const GEOCODE_CACHE_MAX = 500;
const geocodeCache = new Map(); // address → { lat, lng } | null

function toCoord(lat, lng) {
    if (lat === '' || lng === '' || lat == null || lng == null) return null;
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
    if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
    // 0,0 is the schema-default "unset" signal in some older docs.
    if (la === 0 && ln === 0) return null;
    return { lat: la, lng: ln };
}

/** Great-circle distance in km. */
function haversineKm(a, b) {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Geocode a free-text address with Nominatim. Returns { lat, lng } or
 * null — never throws. Results (including misses) are cached in-process
 * to respect Nominatim's 1 req/s usage policy.
 */
async function geocodeAddress(address) {
    const q = String(address || '').trim().slice(0, 300);
    if (!q) return null;
    const key = q.toLowerCase();
    if (geocodeCache.has(key)) return geocodeCache.get(key);
    let result = null;
    try {
        const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(q)}`;
        const resp = await fetch(url, {
            headers: {
                // Nominatim requires an identifying User-Agent.
                'User-Agent': 'BestoDine/1.0 (restaurant delivery distance)',
                'Accept-Language': 'en',
            },
            signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
        });
        if (resp.ok) {
            const rows = await resp.json();
            if (Array.isArray(rows) && rows[0]) result = toCoord(rows[0].lat, rows[0].lon);
        }
    } catch (err) {
        logger.warn(`Delivery geocode failed: ${err.message}`);
        return null; // don't cache transient failures
    }
    if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
        geocodeCache.delete(geocodeCache.keys().next().value);
    }
    geocodeCache.set(key, result);
    return result;
}

/**
 * Origin for the delivery distance. Branch coordinates win (candidate ids
 * are verified to belong to the caller's tenant), then the tenant origin.
 */
async function resolveDeliveryOrigin(req, settings, branchId) {
    const candidates = [];
    if (branchId && mongoose.isValidObjectId(branchId)) candidates.push(String(branchId));
    if (req.branch?._id) candidates.push(String(req.branch._id));
    if (candidates.length) {
        try {
            const Branch = require('../models/branch');
            for (const id of candidates) {
                const b = await Branch.findOne({ _id: id, ...tenantFilter(req) })
                    .select('latitude longitude').lean();
                const c = b && toCoord(b.latitude, b.longitude);
                if (c) return { ...c, source: 'branch' };
            }
        } catch (err) {
            logger.warn(`Delivery origin branch lookup failed: ${err.message}`);
        }
    }
    const o = settings?.delivery?.origin;
    const c = o && toCoord(o.lat, o.lng);
    return c ? { ...c, source: 'restaurant' } : null;
}

/**
 * The slab covering `km`. Slabs are non-overlapping; a distance that falls
 * in a gap between two slabs is charged at the next slab up. Returns null
 * when the distance is beyond the last slab (out of delivery range).
 */
function findSlabForDistance(slabs, km) {
    const sorted = (Array.isArray(slabs) ? slabs : [])
        .map((s) => ({ fromKm: Number(s.fromKm), toKm: Number(s.toKm), charge: Number(s.charge) || 0 }))
        .filter((s) => Number.isFinite(s.fromKm) && Number.isFinite(s.toKm))
        .sort((a, b) => a.fromKm - b.fromKm);
    return sorted.find((s) => km <= s.toKm) || null;
}

/**
 * Compute a delivery quote.
 *
 * @returns {Promise<
 *   { ok: true, distanceKm, slab, charge, customer, origin } |
 *   { ok: false, code, message, fallback: boolean }
 * >}
 * `fallback: true` means distance couldn't be measured (not configured /
 * not locatable) and the caller may use the manually chosen slab.
 */
async function quoteDelivery({ req, settings, branchId, lat, lng, address }) {
    const cfg = settings?.delivery || {};
    if (!cfg.enabled) {
        return { ok: false, fallback: false, code: 'DELIVERY_DISABLED', message: 'Home delivery is not available right now.' };
    }
    const slabs = Array.isArray(cfg.slabs) ? cfg.slabs : [];
    if (slabs.length === 0) {
        return { ok: false, fallback: false, code: 'DELIVERY_NO_SLABS', message: 'No delivery ranges are configured. Please contact the restaurant.' };
    }

    const origin = await resolveDeliveryOrigin(req, settings, branchId);
    if (!origin) {
        return { ok: false, fallback: true, code: 'DELIVERY_ORIGIN_UNSET', message: 'Restaurant location is not configured; please select your distance.' };
    }

    let customer = toCoord(lat, lng);
    let method = 'coordinates';
    if (!customer && address) {
        customer = await geocodeAddress(address);
        method = 'geocoded';
    }
    if (!customer) {
        return { ok: false, fallback: true, code: 'DELIVERY_ADDRESS_NOT_FOUND', message: "We couldn't locate that address. Add more detail (area, city, PIN) or use your current location." };
    }

    const distanceKm = Math.round(haversineKm(origin, customer) * 100) / 100;
    const slab = findSlabForDistance(slabs, distanceKm);
    if (!slab) {
        const maxKm = Math.max(...slabs.map((s) => Number(s.toKm) || 0));
        return {
            ok: false,
            fallback: false,
            code: 'DELIVERY_OUT_OF_RANGE',
            message: `Your address is about ${distanceKm.toFixed(1)} km away — we deliver up to ${maxKm} km.`,
            distanceKm,
            maxKm,
        };
    }
    const charge = Math.max(0, Math.round(slab.charge * 100) / 100);
    return {
        ok: true,
        distanceKm,
        slab: { fromKm: slab.fromKm, toKm: slab.toKm, charge },
        charge,
        customer,
        method,
        originSource: origin.source,
    };
}

module.exports = {
    haversineKm,
    geocodeAddress,
    resolveDeliveryOrigin,
    findSlabForDistance,
    quoteDelivery,
    toCoord,
};
