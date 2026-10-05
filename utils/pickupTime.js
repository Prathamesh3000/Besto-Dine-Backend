// Shared helpers for interpreting a customer's pickup-time string
// ("11:00 AM") as an absolute Date. Used by orderController for the
// scheduled-takeaway gating + customer tracking page, and by the
// scheduledTakeawayReleaser for the KDS pop-in.
//
// Why a util instead of `setHours()`:
// `new Date(createdAt).setHours(11, 0)` interprets 11:00 in the SERVER'S
// local timezone. Render runs containers in UTC, so a customer who
// asked for "11:00 AM" (intended as IST) had their pickup parsed as
// 11:00 UTC = 4:30 PM IST — a 5.5-hour drift. That made:
//   - the customer tracking page say "Kitchen starts at 4:00 PM"
//   - the chef KDS hide the order (it looked 5 hrs in the future)
//
// The fix: pin the parse to the tenant's timezone via APP_TIMEZONE
// (default 'Asia/Kolkata' since today's deployment is India-only).
// Override per-environment when a tenant ships in another zone.

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const SCHEDULED_LEAD_MIN = 30;

// A pickup slot earlier than createdAt by no more than this is today's
// (just-passed) slot, not tomorrow's — see parsePickupAt. The customer
// app only offers future same-day slots, so a genuine next-day wrap
// ("01:00 AM" ordered late at night) is many hours in the past.
const PAST_SLOT_GRACE_MS = 2 * 60 * 60 * 1000;

// Returns the UTC ms offset between a wall-clock instant and the same
// instant when interpreted in `timezone`. Positive when the timezone is
// east of UTC. We use Intl.DateTimeFormat to read the wall-clock parts
// of `dateUTC` AS rendered in the target zone, then diff back to UTC.
function getTimezoneOffsetMs(timezone, dateUTC) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(dateUTC).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});
    const asUTC = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
    );
    return asUTC - dateUTC.getTime();
}

// Parse `pickupTime` (a string like "02:30 PM") into an absolute Date
// using the order's createdAt for the calendar day basis. The customer
// picked the time in the cafe's local clock, so we interpret it in
// `APP_TIMEZONE`, not the server's local zone. Returns null when the
// order has no pickup time or the string is malformed.
function parsePickupAt(order) {
    if (!order || !order.pickupTime || !order.createdAt) return null;
    const m = String(order.pickupTime).trim().match(/^(\d{1,2})[:.](\d{2})\s*(AM|PM)?$/i);
    if (!m) return null;
    let hour = Number(m[1]);
    const min = Number(m[2]);
    const ampm = (m[3] || '').toUpperCase();
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    if (hour > 23 || min > 59) return null;

    const createdAt = new Date(order.createdAt);

    // Read the calendar date AS rendered in the tenant timezone — the
    // customer placed the order on that wall-clock day. Without this,
    // an order placed at 11:30 PM UTC for an "01:00 AM" pickup would
    // anchor to the previous IST day and the next-day wrap below would
    // push it 24 h further than intended.
    const dayDtf = new Intl.DateTimeFormat('en-US', {
        timeZone: APP_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const dayParts = dayDtf.formatToParts(createdAt).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});

    // Build the pickup wall-clock as a tentative UTC instant, then
    // subtract the tenant timezone's offset at that instant to get the
    // true UTC moment.
    const tentativeUTC = Date.UTC(
        Number(dayParts.year),
        Number(dayParts.month) - 1,
        Number(dayParts.day),
        hour, min, 0,
    );
    const offsetMs = getTimezoneOffsetMs(APP_TIMEZONE, new Date(tentativeUTC));
    let pickupUTC = tentativeUTC - offsetMs;

    // Same-day-by-default: when the parsed pickup falls well before
    // createdAt (e.g. order placed at 11 PM with pickup "01:00 AM"
    // meaning next-day), bump forward by a day. Without this the
    // pickup would land in the past and the chef KDS would surface
    // the order immediately.
    //
    // A slot only slightly in the past is TODAY's slot: the takeaway
    // order is saved after payment, so picking "01:30 PM" at 13:28 and
    // paying at 13:31 stores createdAt after the slot. That order is
    // due now (overdue), not tomorrow.
    if (pickupUTC < createdAt.getTime() - PAST_SLOT_GRACE_MS) {
        pickupUTC += 24 * 60 * 60 * 1000;
    }
    return new Date(pickupUTC);
}

// Returns true when a takeaway order is still in its "scheduled"
// window — pickup is far enough in the future that the chef
// shouldn't see it yet.
function isScheduledTakeaway(order, leadMin = SCHEDULED_LEAD_MIN) {
    if (!order || order.type !== 'takeaway') return false;
    const pickupAt = parsePickupAt(order);
    if (!pickupAt) return false;
    const releaseAt = pickupAt.getTime() - (leadMin * 60 * 1000);
    return releaseAt > Date.now();
}

// Threshold for the URGENT badge — pickup is this close (or already
// past). Spec'd at 10 min.
const URGENT_THRESHOLD_MIN = 10;

// Sum the per-item prep snapshots × quantity. Returns minutes.
// Falls back to a flat default when an order has no items captured
// (defensive — shouldn't happen for a real takeaway).
function totalPrepMinutes(order) {
    const items = Array.isArray(order?.items) ? order.items : [];
    if (!items.length) return SCHEDULED_LEAD_MIN;
    let sum = 0;
    for (const it of items) {
        const per = Number(it?.prepTimeMinutes);
        const qty = Number(it?.quantity) || 1;
        sum += (Number.isFinite(per) && per >= 0 ? per : 15) * qty;
    }
    return sum;
}

// The instant at which the chef should START cooking so the food is
// fresh at pickup. = pickupTime − totalPrepMinutes. Returns null when
// the order has no parseable pickup time.
function computePrepStartAt(order) {
    const pickupAt = parsePickupAt(order);
    if (!pickupAt) return null;
    const minutes = totalPrepMinutes(order);
    return new Date(pickupAt.getTime() - minutes * 60 * 1000);
}

// Bucket a takeaway order into the chef-dashboard column it belongs
// in right now. Dine-in orders are always 'ready_to_prepare' (the
// customer is at the table — start cooking immediately).
//
//   scheduled         pickupTime is far enough out that cooking
//                     hasn't started yet (now < prepStartAt). Card
//                     lives in the "Upcoming Orders" column.
//   ready_to_prepare  now >= prepStartAt; chef should accept and
//                     start. Card lives in "Prepare Now".
//   preparing         chef accepted; order.status === 'preparing'.
//   ready_for_pickup  cooking done; order.status === 'ready'.
//
// `cancelled` and `served` aren't returned by getKitchenOrders so
// they never reach this helper.
function computeQueueBucket(order, now = Date.now()) {
    if (!order) return 'ready_to_prepare';
    if (order.status === 'preparing') return 'preparing';
    if (order.status === 'ready')     return 'ready_for_pickup';
    if (order.type !== 'takeaway')    return 'ready_to_prepare';
    const prepStart = computePrepStartAt(order);
    if (!prepStart) return 'ready_to_prepare';
    return now < prepStart.getTime() ? 'scheduled' : 'ready_to_prepare';
}

// Time-to-pickup in minutes (positive = future, negative = already
// past pickup). Null when not parseable.
function minutesToPickup(order, now = Date.now()) {
    const pickupAt = parsePickupAt(order);
    if (!pickupAt) return null;
    return Math.round((pickupAt.getTime() - now) / 60000);
}

// Urgent when pickup is within URGENT_THRESHOLD_MIN, regardless of
// the current bucket (or already past pickup but order not yet
// ready). Dine-in orders fall back to the legacy "ready > 10 min" rule.
function isUrgentTakeaway(order, now = Date.now()) {
    if (order?.type !== 'takeaway') return false;
    const m = minutesToPickup(order, now);
    if (m === null) return false;
    return m <= URGENT_THRESHOLD_MIN;
}

module.exports = {
    APP_TIMEZONE,
    SCHEDULED_LEAD_MIN,
    URGENT_THRESHOLD_MIN,
    parsePickupAt,
    isScheduledTakeaway,
    totalPrepMinutes,
    computePrepStartAt,
    computeQueueBucket,
    minutesToPickup,
    isUrgentTakeaway,
};
