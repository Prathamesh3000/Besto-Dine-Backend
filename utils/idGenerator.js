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

const getDatePart = () => {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
};

const shortUuid = () => uuidv4().replace(/-/g, '').slice(0, 6).toUpperCase();

const generate = (prefix) => `${prefix}-${getDatePart()}-${shortUuid()}`;

module.exports = {
    /** Dine-in order: ORD-260407-A3X2K9 */
    orderId: () => generate('ORD'),

    /** Takeaway order: ORT-260407-B7M1P4 */
    takeawayOrderId: () => generate('ORT'),

    /** Kiosk order (any type): KSK-260407-Z4Y8L2.
     *  Distinct prefix lets staff spot kiosk-originated orders in the
     *  admin Orders tab and gives the customer a recognisable token
     *  format (e.g. K4Y8L2) on the OrderToken screen. */
    kioskOrderId: () => generate('KSK'),

    /** Table booking: BKT-260407-C9N3Q8 */
    tableBookingId: () => generate('BKT'),

    /** Hall booking: BKH-260407-D2R5S1 */
    hallBookingId: () => generate('BKH'),

    /** Transaction: TXN-260407-E6T8U3 */
    transactionId: () => generate('TXN'),

    /** Generic with custom prefix */
    generate,
};
