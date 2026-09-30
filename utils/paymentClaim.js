const PaymentClaim = require('../models/paymentClaim');

/**
 * Atomically mark a Razorpay payment id as spent.
 *
 * Returns:
 *   { claimed: true,  claim }                      — first use, proceed
 *   { claimed: true,  claim, replay: true }        — same purpose + ref
 *                                                    already claimed it
 *                                                    (idempotent retry)
 *   { claimed: false, claim }                      — spent elsewhere
 *
 * Relies on the unique index on PaymentClaim.paymentId; the insert is
 * the atomic step, so two concurrent requests can't both win.
 */
async function claimPayment(paymentId, { purpose, ref, razorpayOrderId = null, restaurant = null, user = null, amount = null }) {
    const refStr = String(ref);
    try {
        const claim = await PaymentClaim.create({
            paymentId: String(paymentId),
            razorpayOrderId,
            purpose,
            ref: refStr,
            restaurant,
            user,
            amount,
        });
        return { claimed: true, claim };
    } catch (err) {
        if (err?.code !== 11000) throw err;
        const existing = await PaymentClaim.findOne({ paymentId: String(paymentId) }).lean();
        if (existing && existing.purpose === purpose && existing.ref === refStr) {
            return { claimed: true, claim: existing, replay: true };
        }
        return { claimed: false, claim: existing };
    }
}

// Undo a claim when the operation it guarded failed before any value
// moved, so a legitimate retry (or an orphan refund) isn't blocked.
async function releaseClaim(paymentId, { purpose, ref }) {
    try {
        await PaymentClaim.deleteOne({ paymentId: String(paymentId), purpose, ref: String(ref) });
    } catch { /* best effort — logged by caller if needed */ }
}

async function findClaim(paymentId) {
    return PaymentClaim.findOne({ paymentId: String(paymentId) }).lean();
}

module.exports = { claimPayment, releaseClaim, findClaim };
