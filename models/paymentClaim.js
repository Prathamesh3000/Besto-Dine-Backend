const mongoose = require('mongoose');

// Single-use ledger for Razorpay payment ids.
//
// Every server path that turns a Razorpay payment into value (marking a
// cafe order Paid, crediting a wallet recharge, paying an advance
// booking) must first insert a claim here. The unique index on
// `paymentId` makes the claim atomic: two concurrent requests replaying
// the same payment id can't both win, and a payment that already paid
// for order A can never be presented again for order B or as a wallet
// top-up. No TTL — a payment id is single-use forever.
//
// `purpose` + `ref` identify what the payment was spent on so a retry
// of the SAME logical operation (network retry of verify for the same
// order) can be recognised as idempotent instead of being rejected.
const paymentClaimSchema = new mongoose.Schema({
    paymentId: {
        type: String,
        required: true,
        unique: true,
    },
    razorpayOrderId: { type: String, default: null },
    purpose: {
        type: String,
        // 'orphan_refund' reserves a payment while its automatic refund
        // is issued so nothing can spend it concurrently.
        enum: ['order_payment', 'wallet_recharge', 'advance_booking', 'orphan_refund'],
        required: true,
    },
    // Order _id / user id / booking id — whatever the purpose spends on.
    ref: { type: String, required: true },
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        default: null,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    amount: { type: Number, default: null }, // rupees
}, { timestamps: true });

paymentClaimSchema.index({ razorpayOrderId: 1 });

module.exports = mongoose.model('PaymentClaim', paymentClaimSchema);
