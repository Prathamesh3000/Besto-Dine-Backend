// Wallet recharge: create-order and verify.

const crypto = require('crypto');
const Wallet = require('../../models/wallet');
const Transaction = require('../../models/transaction');
const logger = require('../../utils/logger');
const idGen = require('../../utils/idGenerator');
const { tenantFilter, tenantId } = require('../../utils/tenantScope');
const { checkWalletRechargePayment } = require('../../utils/paymentChecks');
const { claimPayment, releaseClaim } = require('../../utils/paymentClaim');
const {
    fetchPaymentAndOrder,
    razorpay,
    safeEqual,
} = require('./_shared');

// ─── POST /api/razorpay/create-wallet-recharge ─────────────────────────────
// Creates a Razorpay order for wallet recharge (adding money to wallet).
// Similar to create-order but with purpose = 'wallet_recharge'.
//
// Request body: { amount }
// Access: Authenticated users

exports.createWalletRechargeOrder = async (req, res) => {
    try {
        const { amount } = req.body;

        // Razorpay refuses orders under 100 paise — reject before the gateway.
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1) {
            return res.status(400).json({ success: false, message: 'Amount must be at least ₹1' });
        }
        if (amount > 10000) {
            return res.status(400).json({ success: false, message: 'Maximum recharge amount is ₹10,000' });
        }

        const userId = String(req.user.id || req.user._id);
        // Razorpay caps `receipt` at 40 chars. A 24-char Mongo ObjectId +
        // the wrc_/_/Date.now() scaffolding overflowed to 42, so every
        // wallet top-up failed with BAD_REQUEST_ERROR. Keep the last 6
        // hex chars of the user id for traceability and use base36 time
        // so the whole string fits in ~22 chars.
        const shortUid = userId.slice(-6);
        const shortTs = Date.now().toString(36);
        const options = {
            amount: Math.round(amount * 100),
            currency: 'INR',
            receipt: `wrc_${shortUid}_${shortTs}`,
            // Bug #3 — verifyWalletRecharge only credits payments whose
            // server-set order notes carry this purpose + the SAME user
            // (+ tenant), so these notes are the binding contract.
            notes: {
                purpose: 'wallet_recharge',
                userId,
                ...(tenantId(req) ? { restaurantId: String(tenantId(req)) } : {}),
            },
        };

        const razorpayOrder = await razorpay.orders.create(options);
        logger.info(`Wallet recharge order created: amount=₹${amount}, userId=${userId}, rzpOrderId=${razorpayOrder.id}`);

        return res.status(200).json({
            success: true,
            razorpayOrder: {
                id: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                receipt: razorpayOrder.receipt,
            },
            key: process.env.RAZORPAY_KEY_ID,
        });
    } catch (err) {
        // Razorpay client throws a structured error — surface as much
        // of it as possible so we can debug "Failed to create recharge
        // order" instead of guessing at .env / key issues.
        logger.error(`Wallet recharge order error: ${err?.message || err} | statusCode=${err?.statusCode} | desc=${err?.error?.description || ''} | code=${err?.error?.code || ''}`);
        return res.status(500).json({ success: false, message: 'Failed to create recharge order' });
    }
};

// ─── POST /api/razorpay/verify-wallet-recharge ─────────────────────────────
// Verifies a Razorpay payment for wallet recharge and credits the wallet.
//
// Request body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount }
// Access: Authenticated users

exports.verifyWalletRecharge = async (req, res) => {
    try {
        // `amount` from the body is accepted for back-compat but IGNORED
        // for crediting (bug #3): the credit is what Razorpay settled.
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Payment details are required' });
        }

        // ── Signature verification ───────────────────────────────────────
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (!safeEqual(expectedSignature, razorpay_signature)) {
            return res.status(400).json({ success: false, message: 'Payment verification failed' });
        }

        const userId = String(req.user.id || req.user._id);
        const tf = tenantFilter(req);

        // ── Bug #3: server-side truth from Razorpay (fail closed) ────────
        let payment;
        let rzpOrder;
        try {
            ({ payment, rzpOrder } = await fetchPaymentAndOrder(razorpay_payment_id, razorpay_order_id));
        } catch (fetchErr) {
            logger.error('Wallet recharge verify: Razorpay fetch failed', {
                razorpay_payment_id,
                error: fetchErr.message,
            });
            return res.status(502).json({
                success: false,
                code: 'GATEWAY_UNAVAILABLE',
                message: 'Could not confirm the payment with the gateway. Please try again in a moment.',
            });
        }

        const check = checkWalletRechargePayment({
            payment,
            rzpOrder,
            razorpayOrderId: razorpay_order_id,
            userId,
            tenant: tenantId(req),
        });
        if (!check.ok) {
            logger.warn('Wallet recharge verify rejected', { code: check.code, userId, razorpay_payment_id });
            return res.status(check.status).json({ success: false, code: check.code, message: check.message });
        }
        const amount = check.amount;

        // ── Single-use payment id ────────────────────────────────────────
        const claim = await claimPayment(razorpay_payment_id, {
            purpose: 'wallet_recharge',
            ref: userId,
            razorpayOrderId: razorpay_order_id,
            restaurant: tenantId(req) || null,
            user: userId,
            amount,
        });
        if (!claim.claimed) {
            return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used.' });
        }
        if (claim.replay) {
            // Same user retrying the same recharge. The claim is only kept
            // once the wallet was credited (it is released on a failed
            // credit), so a replay must never credit again.
            const already = await Transaction.findOne({ razorpayPaymentId: razorpay_payment_id }).lean();
            const current = await Wallet.findOne({ user: userId, ...tf }).select('balance').lean();
            return res.status(200).json({
                success: true,
                alreadyCredited: true,
                message: `₹${already ? already.amount : amount} added to wallet`,
                newBalance: current ? current.balance : (already ? already.balanceAfter : 0),
            });
        }

        // ── Credit wallet (per-tenant, atomic) ────────────────────────────
        let wallet;
        try {
            wallet = await Wallet.findOneAndUpdate(
                { user: userId, ...tf },
                { $inc: { balance: amount }, $setOnInsert: { loyaltyPoints: 0, restaurant: tenantId(req) } },
                { upsert: true, returnDocument: 'after' }
            );
        } catch (walletErr) {
            await releaseClaim(razorpay_payment_id, { purpose: 'wallet_recharge', ref: userId });
            throw walletErr;
        }
        const balanceBefore = Math.round((wallet.balance - amount) * 100) / 100;

        // ── Record transaction ───────────────────────────────────────────
        // The partial unique index on Transaction.razorpayPaymentId is the
        // second line of defence against a double credit.
        try {
            await Transaction.create({
                user: userId,
                restaurant: tenantId(req),
                type: 'wallet_recharge',
                amount: amount,
                currency: 'INR',
                paymentMethod: 'upi',
                status: 'completed',
                description: `Wallet recharge of ₹${amount}`,
                transactionId: idGen.transactionId(),
                balanceBefore,
                balanceAfter: wallet.balance,
                razorpayPaymentId: razorpay_payment_id,
                razorpayOrderId: razorpay_order_id,
            });
        } catch (txnErr) {
            if (txnErr?.code === 11000 && /razorpayPaymentId/.test(String(txnErr.message))) {
                // Lost a race with a concurrent credit of the same payment —
                // undo our increment.
                await Wallet.findOneAndUpdate({ user: userId, ...tf }, { $inc: { balance: -amount } });
                const current = await Wallet.findOne({ user: userId, ...tf }).select('balance').lean();
                return res.status(200).json({
                    success: true,
                    alreadyCredited: true,
                    message: `₹${amount} added to wallet`,
                    newBalance: current ? current.balance : wallet.balance - amount,
                });
            }
            logger.error('Wallet recharge: transaction record failed (wallet already credited)', {
                userId, razorpay_payment_id, amount, error: txnErr.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: `₹${amount} added to wallet`,
            newBalance: wallet.balance,
        });
    } catch (err) {
        logger.error('Wallet recharge verify error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to verify wallet recharge' });
    }
};
