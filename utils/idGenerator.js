/**
 * Unified ID Generator for BestoDine
 *
 * All human-readable IDs follow the pattern:
 *   {PREFIX}-{YYMMDD}-{SHORT_UUID}
 *
 * Examples:
 *   ORD-260407-A3X2K9        (dine-in order)
 *   ORT-260407-B7M1P4        (takeaway order)
 *   KSK-260407-Z4Y8L2        (kiosk order — dine-in or takeaway)
 *   BKT-260407-C9N3Q8        (table booking)
 *   BKH-260407-D2R5S1        (hall booking)
 *   TXN-260407-E6T8U3        (transaction)
 *   EMP-001                   (staff — sequential, unchanged)
 */

const { v4: uuidv4 } = require('uuid');

const DEFAULT_TZ = 'Asia/Kolkata';

// YYMMDD in the restaurant's IANA time zone (not the server's), so an order
// placed after midnight local time never carries yesterday's date on a UTC host.
const getDatePart = (timeZone, now = new Date()) => {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timeZone || DEFAULT_TZ, year: '2-digit', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
    } catch (_) {
        // Invalid zone string stored on the tenant — fall back, never throw.
        parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: DEFAULT_TZ, year: '2-digit', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
    }
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}${get('month')}${get('day')}`;
};

const shortUuid = () => uuidv4().replace(/-/g, '').slice(0, 6).toUpperCase();

const generate = (prefix, timeZone) => `${prefix}-${getDatePart(timeZone)}-${shortUuid()}`;

module.exports = {
    /** Dine-in order: ORD-260407-A3X2K9 */
    orderId: (tz) => generate('ORD', tz),

    /** Takeaway order: ORT-260407-B7M1P4 */
    takeawayOrderId: (tz) => generate('ORT', tz),

    /** Kiosk order (any type): KSK-260407-Z4Y8L2.
     *  Distinct prefix lets staff spot kiosk-originated orders in the
     *  admin Orders tab and gives the customer a recognisable token
     *  format (e.g. K4Y8L2) on the OrderToken screen. */
    kioskOrderId: (tz) => generate('KSK', tz),

    /** Table booking: BKT-260407-C9N3Q8 */
    tableBookingId: () => generate('BKT'),

    /** Hall booking: BKH-260407-D2R5S1 */
    hallBookingId: () => generate('BKH'),

    /** Transaction: TXN-260407-E6T8U3 */
    transactionId: () => generate('TXN'),

    /** Generic with custom prefix */
    generate,
    getDatePart,
};
