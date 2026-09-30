const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/order');
const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');
const { invalidateTenant } = require('../middlewares/tenantContext');
const Restaurant = require('../models/restaurant');
const AuditLog = require('../models/auditLog');
const SubscriptionInvoice = require('../models/subscriptionInvoice');
const logger = require('../utils/logger');
const { getIO, emitToStaff, emitToAdmin } = require('../utils/socket');
const idGen = require('../utils/idGenerator');
const { getSettings } = require('../utils/settingsCache');
// Phase 4 step 4 — fire email alerts on subscription lifecycle events.
// Imported lazily-safe: utils/alerts.js catches all its own errors so
// failed alert sends can never break webhook processing.
const { notifyTenantHalted, notifyTenantCancelled } = require('../utils/alerts');

const { tenantFilter, tenantId } = require('../utils/tenantScope');
const { resolveLoyaltySettings } = require('../utils/paymentDefaults');
const { createTipForPaidOrder, revokeTipsForOrder } = require('../utils/tipHelpers');
const { freeTableOrUnmergeGroup } = require('../utils/tableMerge');
const { applyPendingUpgrade, applyPaidPlanUpgrade, applyScheduledDowngrade } = require('../utils/planPaymentApply');
const { verifyTypedToken, TOKEN_TYPES } = require('../middlewares/authMiddleware');
const AdvanceBooking = require('../models/advanceBooking');
const {
    checkWalletRechargePayment,
    checkOrderPaymentBinding,
    checkOrphanRefundEligibility,
    isValidCheckoutSignature,
} = require('../utils/paymentChecks');
const { claimPayment, releaseClaim, findClaim } = require('../utils/paymentClaim');

// Verified guest scan-session id from X-Scan-Token (never trusted raw).
// Used to stamp / match the payer of a guest Razorpay checkout.
function verifiedScanSessionId(req) {
    const token = req.headers?.['x-scan-token'];
    if (!token) return null;
    try {
        const decoded = verifyTypedToken(token, TOKEN_TYPES.SCAN);
        const tenant = tenantId(req);
        if (tenant && decoded.restaurantId && String(decoded.restaurantId) !== String(tenant)) return null;
        return decoded.sessionId ? String(decoded.sessionId) : null;
    } catch {
        return null;
    }
}

// Fetch a payment + its Razorpay order. Throws on any gateway failure so
// callers fail CLOSED (bug #10) instead of trusting client data.
async function fetchPaymentAndOrder(paymentId, razorpayOrderId) {
    const payment = await razorpay.payments.fetch(paymentId);
    const orderId = razorpayOrderId || payment?.order_id;
    const rzpOrder = orderId ? await razorpay.orders.fetch(orderId) : null;
    return { payment, rzpOrder };
}

// Free a dine-in table (and every merged sibling) once payment lands
// AND the order has been served. Mirrors the same rule used by
// orderController.updateOrderStatus + customerPayment so admin /
// waiter grids reflect the released table without a fresh fetch.
// Tenant scope comes from the order's own `restaurant` field — never
// from the request — so a webhook (which has no req.user) still
// scopes correctly.
async function freeTableIfReady(order) {
    if (!order || !order.table) return;
    if (order.status !== 'served') return;
    if (order.paymentStatus !== 'Paid') return;
    try {
        const tf = order.restaurant ? { restaurant: order.restaurant } : {};
        const { freedIds } = await freeTableOrUnmergeGroup(order.table, tf);
        const ids = freedIds.length ? freedIds : [order.table];
        const io = getIO();
        for (const id of ids) {
            emitToStaff(io, order.branch || null, EVENTS.TABLE_UPDATED, { tableId: id, status: 'free', restaurant: order.restaurant ? String(order.restaurant) : undefined });
        }
    } catch (err) {
        logger.warn('Razorpay path failed to free table:', err.message);
    }
}

// Settle the OTHER unpaid rounds on a dine-in table when the customer
// pays the aggregated bill. The bill-preview sums every unpaid round on
// the table (independent-orders model), so a single Razorpay capture
// covers the whole table — we must not leave the sibling rounds showing
// "Unpaid". The combined capture is recorded on the order the customer
// paid against (above); siblings are marked Paid with amountPaid 0 (their
// share is already inside that capture) so table revenue isn't
// double-counted. Dine-in only. Best-effort — never block the primary
// settlement on a sibling failure.
async function settleSiblingDineInRounds(order, paymentMethod) {
    if (!order || !order.table || order.type !== 'dine-in') return;
    try {
        const tf = order.restaurant ? { restaurant: order.restaurant } : {};
        const siblings = await Order.find({
            table: order.table,
            _id: { $ne: order._id },
            status: { $in: ['new', 'preparing', 'ready', 'served'] },
            paymentStatus: { $ne: 'Paid' },
            ...tf,
        });
        for (const sib of siblings) {
            sib.paymentStatus = 'Paid';
            sib.paymentMethod = paymentMethod || order.paymentMethod || 'online';
            sib.amountPaid = 0; // covered by the combined capture on `order`
            if (!sib.paidAt) sib.paidAt = new Date();
            await sib.save();
            try { await createTipForPaidOrder(sib, sib.restaurant || order.restaurant); } catch { /* tip best-effort */ }
            await freeTableIfReady(sib);
        }
        if (siblings.length) {
            logger.info(`Settled ${siblings.length} sibling dine-in round(s) with ${order.orderId} on table ${order.table}`);
        }
    } catch (err) {
        logger.warn('Failed to settle sibling dine-in rounds:', err.message);
    }
}

// ─── Razorpay instance ──────────────────────────────────────────────────────
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Constant-time HMAC compare — prevents timing-oracle attacks on the
// signature check. Used by verify-payment, verify-wallet-recharge, and
// the webhook handler.
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ─── Helper: Award loyalty points for a paid order ─────────────────────────
// Tenant context is taken from the order itself (order.restaurant), since
// the create-order flow stamps every order with the active tenant. This
// keeps the helper callable from background reconciliation jobs that
// don't have an Express req object.
async function awardLoyaltyPoints(order) {
    if (!order.user) return;
    const restaurantId = order.restaurant || null;
    const settings = await getSettings(restaurantId);
    const loyalty = resolveLoyaltySettings(settings);
    const { enableLoyalty, minBillToEarn: minBill, pointsPerRupee } = loyalty;

    const pointsEarned = (enableLoyalty && order.total >= minBill)
        ? Math.floor(order.total * pointsPerRupee)
        : 0;

    if (pointsEarned > 0) {
        // Atomic $inc to prevent race conditions with concurrent payments
        const walletFilter = restaurantId ? { user: order.user, restaurant: restaurantId } : { user: order.user };
        const wallet = await Wallet.findOneAndUpdate(
            walletFilter,
            { $inc: { loyaltyPoints: pointsEarned }, $setOnInsert: { balance: 0, restaurant: restaurantId } },
            { upsert: true, returnDocument: 'after' }
        );

        await Transaction.create({
            user: order.user,
            restaurant: restaurantId,
            order: order._id,
            type: 'points_earned',
            amount: pointsEarned,
            paymentMethod: 'points',
            status: 'completed',
            description: `Earned ${pointsEarned} points for order ${order.orderId}`,
            transactionId: idGen.transactionId(),
            balanceBefore: wallet.loyaltyPoints - pointsEarned,
            balanceAfter: wallet.loyaltyPoints,
        });
    }
}

// ─── Helper: Broadcast payment event to the right audience ────────────────
// order:updated goes to staff dashboards + the owning customer's room + the
// per-order room that guest trackers subscribe to. Prevents leaking one
// customer's payment status to every other connected browser.
function broadcastPaymentEvent(order, title, description) {
    try {
        const io = getIO();
        const branchId = order.branch || null;
        // Tenant hint so webhook / background callers (no request
        // context) aren't dropped by the socket tenant guard.
        const restaurant = order.restaurant ? String(order.restaurant) : undefined;
        emitToAdmin(io, branchId, EVENTS.NOTIFICATION_NEW, { title, description, restaurant });
        if (order.user) {
            io.to(order.user.toString()).emit(EVENTS.NOTIFICATION_NEW, {
                title,
                description: description || `Your refund for ${order.orderId} has been processed.`
            });
        }
        const payload = {
            orderId: order.orderId,
            status: order.status,
            paymentStatus: order.paymentStatus
        };
        emitToStaff(io, branchId, EVENTS.ORDER_UPDATED, { ...payload, restaurant });
        if (order.user) io.to(String(order.user)).emit(EVENTS.ORDER_UPDATED, payload);
        if (order.orderId) io.to(`order:${order.orderId}`).emit(EVENTS.ORDER_UPDATED, payload);
    } catch (socketError) {
        logger.warn('Socket.io broadcast failed:', { error: socketError.message });
    }
}

// ─── POST /api/razorpay/create-order ────────────────────────────────────────
// Creates a Razorpay order for the given amount. The frontend uses this
// orderId to open the Razorpay checkout modal.
//
// Request body: { amount (in ₹), cafeOrderId (our Order _id), receipt? }
// Response:     { success, razorpayOrder }

exports.createRazorpayOrder = async (req, res) => {
    try {
        const { amount, cafeOrderId, receipt } = req.body;

        // Validate amount — must be a positive finite number within Razorpay limits
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
            return res.status(400).json({ success: false, message: 'Amount must be a valid number between ₹1 and ₹1,00,00,000' });
        }

        // ── R-04: tenant-ownership gate ──────────────────────────────────
        // The webhook handler below uses `payment.notes.cafeOrderId` to
        // locate our Order. If we let any caller pass *any* cafeOrderId
        // through unchecked, a malicious customer could create a Razorpay
        // order whose notes point at a DIFFERENT tenant's order _id, pay
        // ₹1, and the webhook would flip that foreign order to `Paid`.
        //
        // Two defences here:
        //   (a) When a cafeOrderId is supplied, verify it actually
        //       belongs to the caller's tenant before proceeding.
        //   (b) Stamp `notes.restaurantId` so the webhook can cross-
        //       check tenant consistency even on paths that don't hit
        //       the new `razorpayOrderId` lookup.
        //
        // Deferred-order flows (advance booking, late-create takeaway)
        // legitimately have no cafeOrderId — accept those with just the
        // tenant stamp. Tenant itself is required (attachTenant sets
        const tenant = tenantId(req);
        if (!tenant) {
            return res.status(400).json({
                success: false,
                code: 'TENANT_REQUIRED',
                message: 'Restaurant context is required to create a payment.',
            });
        }
        if (cafeOrderId && cafeOrderId !== 'none') {
            const tf = tenantFilter(req);
            let ownedOrder = null;
            if (mongoose.Types.ObjectId.isValid(cafeOrderId)) {
                ownedOrder = await Order.findOne({ _id: cafeOrderId, ...tf })
                    .select('_id orderId total').lean();
            }
            if (!ownedOrder) {
                ownedOrder = await Order.findOne({ orderId: cafeOrderId, ...tf })
                    .select('_id orderId total').lean();
            }
            if (!ownedOrder) {
                logger.warn('createRazorpayOrder: cafeOrderId not owned by caller — blocking', {
                    cafeOrderId,
                    tenant: String(tenant),
                    userId: req.user?._id || null,
                });
                return res.status(404).json({
                    success: false,
                    code: 'ORDER_NOT_FOUND',
                    message: 'Order not found for this restaurant.',
                });
            }
            if (typeof ownedOrder.total === 'number' && amount < ownedOrder.total - 1) {
                return res.status(400).json({
                    success: false,
                    code: 'AMOUNT_MISMATCH',
                    message: `Payment amount ₹${amount} does not cover order total ₹${ownedOrder.total}.`,
                });
            }
        }

        const options = {
            amount: Math.round(amount * 100), // Razorpay expects paise
            currency: 'INR',
            receipt: receipt || `rcpt_${cafeOrderId || 'new'}_${Date.now()}`,
            notes: {
                cafeOrderId: cafeOrderId || 'none',
                // R-04: authoritative tenant marker for the webhook.
                restaurantId: String(tenant),
                purpose: 'cafe_order',
            },
        };
        // Bugs #4 / #10 — stamp WHO is paying so verify (deferred
        // binding) and orphan-refund can prove the payment belongs to
        // the caller. Razorpay notes values must be strings.
        const payerId = req.user?._id || req.user?.id;
        if (payerId) {
            options.notes.userId = String(payerId);
            options.notes.payerRole = String(req.user?.role || '');
        }
        const scanSessionId = verifiedScanSessionId(req);
        if (scanSessionId) options.notes.scanSessionId = scanSessionId;

        const razorpayOrder = await razorpay.orders.create(options);

        // R-04: immediately stamp `razorpayOrderId` onto the cafe order
        // under tenant scope. That makes the globally-unique Razorpay ID
        // the authoritative lookup key in the webhook handler — which no
        // longer has to trust the client-supplied notes.cafeOrderId to
        // find the right order. Wrapped so a stamp failure never blocks
        // the checkout; webhook still has `notes.restaurantId` as backup.
        if (cafeOrderId && mongoose.Types.ObjectId.isValid(cafeOrderId)) {
            try {
                await Order.findOneAndUpdate(
                    { _id: cafeOrderId, ...tenantFilter(req) },
                    { razorpayOrderId: razorpayOrder.id }
                );
            } catch (stampErr) {
                logger.warn('Failed to stamp razorpayOrderId on cafe order (non-fatal)', {
                    cafeOrderId,
                    rzpOrderId: razorpayOrder.id,
                    error: stampErr.message,
                });
            }
        }

        logger.info(`Razorpay order created: amount=₹${amount}, cafeOrderId=${cafeOrderId || 'none'}, rzpOrderId=${razorpayOrder.id}, tenant=${tenant}`);

        return res.status(200).json({
            success: true,
            razorpayOrder: {
                id: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                receipt: razorpayOrder.receipt,
            },
            key: process.env.RAZORPAY_KEY_ID, // frontend needs this to open checkout
        });
    } catch (err) {
        logger.error('Razorpay create order error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Failed to create payment order' });
    }
};

// ─── POST /api/razorpay/verify-payment ──────────────────────────────────────
// Verifies the Razorpay payment signature, then updates the cafe order's
// payment status to 'Paid' and triggers loyalty point earning.
//
// Request body: {
//   razorpay_order_id, razorpay_payment_id, razorpay_signature,
//   cafeOrderId (our Order _id)
// }
exports.verifyPayment = async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            cafeOrderId,
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Payment details are required' });
        }

        // ── Signature verification ────────────────────────────────────────
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (!safeEqual(expectedSignature, razorpay_signature)) {
            return res.status(400).json({ success: false, message: 'Payment verification failed — invalid signature' });
        }

        // No cafe order to settle (e.g. advance-booking pre-check): the
        // signature check above is the whole contract. Nothing is marked
        // paid here — the booking endpoint re-verifies server-side.
        if (!cafeOrderId) {
            return res.status(200).json({
                success: true,
                message: 'Payment verified successfully',
                paymentId: razorpay_payment_id,
            });
        }

        // ── Locate the cafe order (tenant-scoped) ─────────────────────────
        const tf = tenantFilter(req);
        let order = null;
        if (mongoose.Types.ObjectId.isValid(cafeOrderId)) {
            order = await Order.findOne({ _id: cafeOrderId, ...tf });
        }
        if (!order) {
            order = await Order.findOne({ orderId: cafeOrderId, ...tf });
        }
        if (!order) {
            return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found for this restaurant.' });
        }

        // Idempotent replay: the same payment already settled this order
        // (earlier verify, webhook or reconciliation).
        if (order.paymentStatus === 'Paid') {
            if (order.razorpayPaymentId === razorpay_payment_id) {
                return res.status(200).json({
                    success: true,
                    message: 'Payment verified successfully',
                    paymentId: razorpay_payment_id,
                });
            }
            return res.status(409).json({
                success: false,
                code: 'ORDER_ALREADY_PAID',
                message: 'This order is already paid. Please contact staff about this payment.',
            });
        }

        // ── Bug #10: fetch from Razorpay — fail CLOSED ────────────────────
        let payment;
        let rzpOrder;
        try {
            ({ payment, rzpOrder } = await fetchPaymentAndOrder(razorpay_payment_id, razorpay_order_id));
        } catch (fetchErr) {
            logger.error('verifyPayment: Razorpay fetch failed — refusing to mark order paid', {
                razorpay_payment_id,
                orderId: order.orderId,
                error: fetchErr.message,
            });
            return res.status(502).json({
                success: false,
                code: 'GATEWAY_UNAVAILABLE',
                message: 'Could not confirm the payment with the gateway. Please try again in a moment.',
            });
        }

        const binding = checkOrderPaymentBinding({
            order,
            payment,
            rzpOrder,
            razorpayOrderId: razorpay_order_id,
            tenant: tenantId(req),
        });
        if (!binding.ok) {
            logger.warn('verifyPayment: payment/order binding rejected', {
                code: binding.code,
                orderId: order.orderId,
                razorpay_order_id,
                razorpay_payment_id,
            });
            return res.status(binding.status).json({ success: false, code: binding.code, message: binding.message });
        }

        // ── Payment id is single-use across orders ────────────────────────
        // Legacy guard for payments settled before the claim ledger.
        const usedElsewhere = await Order.exists({
            razorpayPaymentId: razorpay_payment_id,
            _id: { $ne: order._id },
        });
        if (usedElsewhere) {
            return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used for another order.' });
        }
        const claim = await claimPayment(razorpay_payment_id, {
            purpose: 'order_payment',
            ref: String(order._id),
            razorpayOrderId: razorpay_order_id,
            restaurant: order.restaurant || tenantId(req) || null,
            user: order.user || null,
            amount: binding.amount,
        });
        if (!claim.claimed) {
            return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_USED', message: 'This payment has already been used.' });
        }

        const reconciledAmount = binding.amount;
        const priorPaid = binding.priorPaid;
        order.paymentStatus = 'Paid';
        if (priorPaid > 0 && priorPaid < order.total) {
            order.paymentMethod = 'mixed';
            order.amountPaid = Math.round((priorPaid + reconciledAmount) * 100) / 100;
            order.walletAmountPaid = priorPaid;
        } else {
            order.paymentMethod = 'online';
            order.amountPaid = reconciledAmount;
        }
        order.razorpayOrderId = razorpay_order_id;
        order.razorpayPaymentId = razorpay_payment_id;
        if (!order.paidAt) order.paidAt = new Date();
        try {
            await order.save();
        } catch (saveErr) {
            await releaseClaim(razorpay_payment_id, { purpose: 'order_payment', ref: String(order._id) });
            throw saveErr;
        }

        // ── Side effects — best effort; the order is already settled ─────
        try {
            await awardLoyaltyPoints(order);

            // Record the waiter's tip (idempotent). Must run on this path
            // too — otherwise Razorpay-paid orders bypass the PATCH status
            // handler and never produce a Tip.
            await createTipForPaidOrder(order, order.restaurant || tenantId(req));

            // Aggregated dine-in bill: this capture covers every unpaid
            // round on the table, so settle the siblings too.
            await settleSiblingDineInRounds(order, 'online');

            // Release the table if the order was already served.
            await freeTableIfReady(order);

            // Persist only — the live events go out via broadcastPaymentEvent.
            await notify({
                restaurant: order.restaurant || tenantId(req),
                branch: order.branch || null,
                notification: {
                    recipientRole: 'admin',
                    title: 'Payment Confirmed',
                    description: `Online payment of ₹${order.total} received for order ${order.orderId}`,
                    category: 'Payment',
                    priority: 'medium',
                    meta: { orderId: order.orderId, amount: order.total },
                },
            });

            broadcastPaymentEvent(order, 'Payment Confirmed',
                `Online payment of ₹${order.total} received for ${order.orderId}`);
        } catch (sideErr) {
            logger.warn('verifyPayment: post-payment side effect failed (order already Paid)', {
                orderId: order.orderId,
                error: sideErr.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Payment verified successfully',
            paymentId: razorpay_payment_id,
        });
    } catch (err) {
        logger.error('Razorpay verify error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Payment verification failed' });
    }
};

// ─── POST /api/razorpay/webhook ────────────────────────────────────────────
// Server-to-server webhook called by Razorpay. Handles payment.captured and
// payment.failed events. This catches payments where the frontend crashed
// after Razorpay debited the customer but before verifyPayment was called.
//
/**
 * ── WEBHOOK HANDLER (ROBUST SAFETY NET) ──────────────────────────────
 * Ensures DB is updated even if user closes tab after payment.
 */
exports.handleWebhook = async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const signature = req.headers['x-razorpay-signature'];

        // ── R-03: webhook retry-storm protection ────────────────────────
        // Razorpay retries any non-2xx response for up to 24 hours with
        // exponential backoff. A single bad webhook (invalid signature,
        // malformed body, missing header) previously returned 4xx and
        // produced a retry flood that spammed logs and the DB.
        //
        // Policy going forward:
        //   - Receipt-layer failures (bad sig / bad JSON / missing
        //     header) → log at ERROR (so ops see them) and return 200.
        //     Razorpay retrying won't help — the next delivery will
        //     fail identically, and a real attacker can't brute-force
        //     HMAC-SHA256 anyway.
        //   - Only a MISSING `RAZORPAY_WEBHOOK_SECRET` env var returns
        //     500, because that IS a transient ops issue that benefits
        //     from Razorpay's retry window to not lose events while
        //     the secret is being deployed.
        //
        // Forensic context is included in every drop log so a security
        // team can pivot on: remote IP, signature length, body size,
        // event ID (when parseable). That's enough to correlate with
        // upstream logs without leaking internal state back to callers.
        const forensic = {
            remoteIp: req.ip,
            bodyBytes: Buffer.isBuffer(req.body) ? req.body.length : null,
            sigLen: typeof signature === 'string' ? signature.length : null,
            userAgent: req.headers['user-agent'] || null,
        };

        // 1. Signature Verification — MANDATORY when secret is configured
        if (!webhookSecret) {
            // Keep the 5xx here: we WANT Razorpay to retry until ops
            // rolls out the secret; otherwise we permanently lose the
            // event. Razorpay's 24h retry window covers most incidents.
            logger.error('RAZORPAY_WEBHOOK_SECRET not configured — rejecting webhook', forensic);
            return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
        }
        if (!signature) {
            // No sig header at all → almost certainly not Razorpay (or a
            // broken proxy stripping headers). Drop with 200 + error log.
            logger.error('Webhook received without x-razorpay-signature header — dropping (not retrying)', forensic);
            return res.status(200).json({ status: 'ok' });
        }

        // server.js mounts express.raw() for this route so req.body is a
        // Buffer containing the exact bytes Razorpay signed. Fall back to
        // JSON.stringify only if some reverse-proxy layer parsed ahead of
        // us — warn loudly because that path is signature-fragile.
        let rawBody;
        let parsed;
        if (Buffer.isBuffer(req.body)) {
            rawBody = req.body.toString('utf8');
            try { parsed = JSON.parse(rawBody); }
            catch (e) {
                // Malformed JSON — retrying won't fix it. Log and drop.
                logger.error('Webhook body not valid JSON — dropping (not retrying)', {
                    ...forensic,
                    parseError: e.message,
                });
                return res.status(200).json({ status: 'ok' });
            }
        } else {
            logger.warn('Webhook body was parsed before signature verification — check express.raw() mount', forensic);
            parsed = req.body;
            rawBody = JSON.stringify(req.body);
        }

        const expectedSig = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');

        if (!safeEqual(expectedSig, signature)) {
            // Signature mismatch. Retry won't help (HMAC is deterministic),
            // and a brute-force attacker against SHA-256 isn't a real
            // threat. Log at ERROR so ops SIEM pipelines catch it —
            // sustained mismatches indicate either a rotated secret that
            // wasn't deployed, a misconfigured reverse proxy mangling the
            // body, or a real probe/attack. Whichever it is, replying 200
            // prevents the retry storm; the log is the signal.
            logger.error('Webhook signature mismatch — dropping (not retrying)', {
                ...forensic,
                event: parsed?.event || null,
                eventId: parsed?.id || null,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // 2. Route by event family. Payment events (`payment.*`,
        //    `refund.*`) are about per-order transactions and look at
        //    payload.payment.entity. Subscription events (`subscription.*`)
        //    are about SaaS billing and look at payload.subscription.entity.
        const event = parsed.event;

        if (event && event.startsWith('subscription.')) {
            await handleSubscriptionEvent(event, parsed.payload);
            return res.json({ status: 'ok' });
        }

        // 3. Payment / refund events (existing flow)
        const payment = parsed.payload?.payment?.entity;
        if (!payment) return res.status(200).json({ status: 'ok' });

        // ADM-105 / ADM-106 — fallback-orders subscription path.
        // When the Subscriptions API isn't enabled on the Razorpay
        // account, tenantBillingController.upgradePlan falls back to
        // a one-time Orders API call stamped with notes.type ===
        // 'plan_payment'. Those payments don't belong to any cafe
        // Order, so they need a dedicated branch BEFORE the
        // order-lookup code below runs (which would 404 and skip the
        // invoice creation entirely).
        if (event === 'payment.captured' && payment.notes?.type === 'plan_payment') {
            await handlePlanPaymentCaptured(payment, parsed);
            return res.json({ status: 'ok' });
        }

        const cafeOrderId = payment.notes?.cafeOrderId || payment.notes?.orderId;
        // R-04 — authoritative tenant tag stamped at createRazorpayOrder
        // time. Absent on payments created before this fix shipped; those
        // fall back to the razorpayOrderId-only path below.
        const notesRestaurantId = payment.notes?.restaurantId || null;
        const rzpOrderId = payment.order_id;

        // ── R-04: safe, tenant-aware order lookup ────────────────────────
        // The old flow searched globally by cafeOrderId, then by orderId
        // string, then by razorpayOrderId. A malicious customer could
        // create a Razorpay order whose `notes.cafeOrderId` pointed at
        // ANOTHER tenant's order _id, pay a nominal amount, and the
        // webhook would happily flip that foreign order to Paid.
        //
        // New lookup order, safest first:
        //   1. `razorpayOrderId` — globally unique across our entire
        //      platform Razorpay account. Stamped onto the cafe order
        //      inside createRazorpayOrder under tenant scope, so a match
        //      here is canonically the right order.
        //   2. `_id` or `orderId` string via notes, BUT ONLY if the
        //      payment's notes carry a `restaurantId` that matches the
        //      found order's tenant. Without that tag, we refuse — the
        //      webhook can't tell a legitimate tenant-A payment from an
        //      attacker who guessed tenant-B's _id.
        //
        // Every failure path returns 200 per R-03 so Razorpay doesn't
        // retry-storm; the logs carry the forensics.
        let order = null;
        let lookupPath = null;

        if (rzpOrderId) {
            order = await Order.findOne({ razorpayOrderId: rzpOrderId });
            if (order) lookupPath = 'razorpayOrderId';
        }

        if (!order && cafeOrderId && cafeOrderId !== 'none') {
            if (!notesRestaurantId || !mongoose.Types.ObjectId.isValid(notesRestaurantId)) {
                // Legacy pre-R-04 payment (no tenant tag) AND the cafe
                // order doesn't have razorpayOrderId stamped yet. Refuse
                // rather than risk cross-tenant misapplication. Admin can
                // reconcile manually from the Razorpay dashboard.
                logger.error('Webhook: refusing cafeOrderId lookup without notes.restaurantId — cannot safely disambiguate tenant', {
                    cafeOrderId,
                    rzpOrderId,
                    event: parsed.event,
                });
            } else {
                const scopedFilter = { restaurant: notesRestaurantId };
                if (mongoose.Types.ObjectId.isValid(cafeOrderId)) {
                    order = await Order.findOne({ _id: cafeOrderId, ...scopedFilter });
                    if (order) lookupPath = '_id+notes.restaurantId';
                }
                if (!order) {
                    order = await Order.findOne({ orderId: cafeOrderId, ...scopedFilter });
                    if (order) lookupPath = 'orderId+notes.restaurantId';
                }
            }
        }

        if (!order) {
            logger.warn('Webhook: no order match after all lookups', {
                rzpOrderId,
                cafeOrderId,
                notesRestaurantId,
                event: parsed.event,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // ── Tenant consistency (defense-in-depth) ────────────────────────
        // Even on the "authoritative" razorpayOrderId path, if the payment
        // carries a `notes.restaurantId` it MUST match order.restaurant.
        // Catches the (very) unlikely case where a prior bug wrote the
        // wrong razorpayOrderId onto a cafe order, or where a future
        // payment ID collision could occur.
        if (notesRestaurantId && order.restaurant && String(order.restaurant) !== String(notesRestaurantId)) {
            logger.error('Webhook: tenant mismatch between order and payment notes — rejecting', {
                orderId: order.orderId,
                orderTenant: String(order.restaurant),
                notesTenant: String(notesRestaurantId),
                rzpOrderId,
                lookupPath,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // Razorpay order_id consistency — the order's stored razorpayOrderId
        // (if any) must agree with what the webhook claims. Mismatch means
        // we found the order via notes.cafeOrderId but it's been linked to
        // a different Razorpay checkout, so this webhook isn't for this
        // order. Drop quietly.
        if (order.razorpayOrderId && rzpOrderId && order.razorpayOrderId !== rzpOrderId) {
            logger.warn('Webhook: Razorpay order_id mismatch with stored value — rejecting', {
                orderId: order.orderId,
                expected: order.razorpayOrderId,
                got: rzpOrderId,
                lookupPath,
            });
            return res.status(200).json({ status: 'ok' });
        }

        // 4. Handle Events
        if (event === 'payment.captured' && order.paymentStatus !== 'Paid') {
            // Bug #10 — a payment id settles at most one order. If it was
            // already claimed for something else, don't apply it here.
            const whClaim = await claimPayment(payment.id, {
                purpose: 'order_payment',
                ref: String(order._id),
                razorpayOrderId: rzpOrderId || null,
                restaurant: order.restaurant || null,
                user: order.user || null,
                amount: payment.amount / 100,
            });
            if (!whClaim.claimed) {
                logger.error('Webhook: payment already claimed elsewhere — not applying to order', {
                    paymentId: payment.id,
                    orderId: order.orderId,
                    claimPurpose: whClaim.claim?.purpose,
                    claimRef: whClaim.claim?.ref,
                });
                return res.status(200).json({ status: 'ok' });
            }
            const capturedAmount = payment.amount / 100;
            order.paymentStatus = 'Paid';
            order.paymentMethod = 'online';
            order.razorpayPaymentId = payment.id;
            order.amountPaid = capturedAmount;
            // Reconcile total with the actual captured amount so the
            // order details modal's Total/Amount Paid pair agrees. See
            // verifyPayment above for the full rationale.
            order.total = capturedAmount;
            if (!order.paidAt) {
                order.paidAt = payment.created_at
                    ? new Date(payment.created_at * 1000)
                    : new Date();
            }

            // Status stays 'new' on payment — chef decides when to start
            // cooking via the KDS. See verifyPayment for the full rationale.

            await order.save();
            await awardLoyaltyPoints(order);

            // Webhook is the safety net when the user closed the tab
            // before verifyPayment ran. Without this call the tip on
            // those orders was never recorded. Idempotent.
            await createTipForPaidOrder(order, order.restaurant);

            // Same table-release path verifyPayment uses. Required here
            // too because the webhook is the only signal we get when the
            // customer's browser tab dies between paying and the verify
            // call landing — without it the table sits stuck at occupied.
            await freeTableIfReady(order);

            broadcastPaymentEvent(order, 'Payment Confirmed (Webhook)',
                `₹${order.amountPaid} payment verified for order ${order.orderId}`);

        } else if (event === 'payment.failed') {
            order.paymentStatus = 'Failed';
            await order.save();
            logger.info(`Webhook: Payment failed for order ${order.orderId}`);
        } else if (event === 'refund.processed') {
            const refundAmount = (payment.amount || 0) / 100;
            const refundId = parsed.payload?.refund?.entity?.id || payment.id || null;
            // Dedupe webhook retries — if we already recorded this refund
            // id, skip. Prevents double-counting when Razorpay retries.
            const alreadyRecorded = refundId && (order.refunds || []).some(r => r.razorpayRefundId === refundId);
            if (!alreadyRecorded) {
                order.refundedAmount = (order.refundedAmount || 0) + refundAmount;
                if (order.refundedAmount >= order.amountPaid) {
                    order.paymentStatus = 'Refunded';
                }
                order.refunds = order.refunds || [];
                order.refunds.push({
                    amount: refundAmount,
                    reason: parsed.payload?.refund?.entity?.notes?.reason || 'Razorpay refund',
                    razorpayRefundId: refundId,
                    source: 'webhook',
                    createdAt: new Date(),
                });
                await order.save();
            }
            // Revoke still-pending tips so the waiter isn't settled for
            // a refunded transaction. Settled tips are left alone.
            await revokeTipsForOrder(order, { reason: 'razorpay refund webhook' });
            logger.info(`Webhook: refund.processed for order ${order.orderId}, amount ₹${refundAmount}`);
        }

        return res.json({ status: 'ok' });
    } catch (err) {
        logger.error('Webhook handler error:', { error: err.message });
        // Always return 200 to prevent Razorpay retries on our errors
        return res.json({ status: 'ok' });
    }
};

// ─── Subscription webhook handler ──────────────────────────────────────
//
// Handles the SaaS billing lifecycle events fired by Razorpay:
//
//   subscription.charged    — a recurring charge succeeded. Update the
//                             denormalised `currentPeriodEnd`, stamp
//                             `lastChargedAt`, and if the tenant was
//                             previously suspended for non-payment,
//                             automatically reactivate them.
//
//   subscription.halted     — Razorpay gave up retrying a failed charge.
//                             Suspend the tenant so their staff is
//                             locked out until they pay.
//
//   subscription.cancelled  — the customer (or Super Admin) cancelled.
//                             Mark status but DO NOT suspend — they may
//                             still have paid time remaining.
//
//   subscription.completed  — all billing cycles finished. Treat the
//                             same as cancelled.
//
//   subscription.pending / subscription.authenticated — just sync status.
//
// We never THROW out of the event handler — all paths return so the
// outer webhook handler can still respond 200 to Razorpay (Razorpay
// retries aggressively on non-200s and we don't want a DB hiccup to
// cause a retry storm).
// ADM-105 / ADM-106 — fallback-orders plan payment confirmation.
//
// When Razorpay's Subscriptions API is disabled on the merchant
// account, tenantBillingController.upgradePlan falls back to a
// one-time Razorpay Order stamped with notes.type === 'plan_payment'.
// That order has no matching cafe Order doc, so the generic
// payment.captured handler in handleWebhook would 404 it and skip
// applying the plan + creating an invoice — which is exactly the
// "invoice not generating even after payment" symptom in ADM-106.
//
// This handler:
//   1. Looks up the tenant from notes.restaurantId.
//   2. Applies the stashed pendingUpgrade — same path the
//      subscription.charged handler uses.
//   3. Creates a SubscriptionInvoice so /admin/subscription can show
//      the receipt and the user can download a PDF.
async function handlePlanPaymentCaptured(payment, parsed) {
    try {
        const notesRestaurantId = payment.notes?.restaurantId;
        if (!notesRestaurantId || !mongoose.Types.ObjectId.isValid(notesRestaurantId)) {
            logger.warn('plan-payment webhook: missing or invalid notes.restaurantId', {
                paymentId: payment.id,
                notes: payment.notes,
            });
            return;
        }

        const restaurant = await Restaurant.findById(notesRestaurantId);
        if (!restaurant) {
            logger.warn(`plan-payment webhook: no restaurant ${notesRestaurantId} for payment ${payment.id}`);
            return;
        }

        await applyPaidPlanUpgrade({
            restaurant,
            payment,
            logTag: 'plan-payment webhook',
        });
    } catch (err) {
        logger.error(`plan-payment webhook handler error: ${err.message}`);
    }
}

async function handleSubscriptionEvent(event, payload) {
    const sub = payload?.subscription?.entity;
    if (!sub) {
        logger.warn(`Webhook ${event}: no subscription entity in payload`);
        return;
    }

    const subscriptionId = sub.id;
    // Look up the restaurant by the LIVE subscriptionId or by the
    // pending upgrade's subscriptionId — for a fresh upgrade the
    // pending block holds the new sub id (the live field still points
    // at the old / empty sub).
    const restaurant = await Restaurant.findOne({
        $or: [
            { 'subscription.razorpaySubscriptionId': subscriptionId },
            { 'subscription.pendingUpgrade.razorpaySubscriptionId': subscriptionId },
        ],
    });
    if (!restaurant) {
        logger.warn(`Webhook ${event}: no restaurant matches subscription ${subscriptionId}`);
        return;
    }

    const previousStatus = restaurant.status;
    const previousRzpStatus = restaurant.subscription?.razorpayStatus;

    // Always sync the most recent Razorpay-reported status.
    restaurant.subscription = restaurant.subscription || {};
    restaurant.subscription.razorpayStatus = sub.status || event.replace('subscription.', '');

    switch (event) {
        case 'subscription.charged': {
            // ADM-105 — first-charge confirmation. Apply the pending
            // plan upgrade now that the customer has actually paid.
            // Safe to call repeatedly (no-op once pendingUpgrade is
            // cleared, so retried webhooks don't double-apply).
            const upgradeApplied = applyPendingUpgrade(restaurant);
            if (upgradeApplied) {
                logger.info(`Subscription charged: applied pending upgrade for ${restaurant.slug} → ${restaurant.subscription.planName}`);
            }

            // `current_end` is a unix seconds timestamp of the next billing date.
            if (sub.current_end) {
                restaurant.subscription.currentPeriodEnd = new Date(sub.current_end * 1000);
            }
            restaurant.subscription.lastChargedAt = new Date();
            // If the tenant was previously suspended for non-payment
            // (razorpayStatus === 'halted'), auto-reactivate now that
            // the charge has gone through.
            if (restaurant.status === 'suspended' && previousRzpStatus === 'halted') {
                restaurant.status = restaurant.subscription.trialEndDate && restaurant.subscription.trialEndDate > new Date()
                    ? 'trial'
                    : 'active';
                restaurant.suspendedAt = undefined;
                restaurant.suspendedReason = '';
            }
            logger.info(`Subscription charged for ${restaurant.slug}: next ${sub.current_end ? new Date(sub.current_end * 1000).toISOString() : 'n/a'}`);

            // Phase 5 step 5 — persist the charge as a
            // SubscriptionInvoice row so the tenant (and Super Admin)
            // can list / download it later as a PDF.
            //
            // Razorpay's subscription.charged payload includes BOTH
            // `payload.subscription.entity` (which we're already using
            // via `sub`) AND `payload.payment.entity` with the actual
            // charge details. We best-effort create the invoice here —
            // if it fails (missing payment entity, DB error, unique
            // collision from a retried webhook), we log and continue
            // without breaking the webhook response.
            try {
                const pmt = payload?.payment?.entity;
                if (pmt && pmt.id) {
                    // Per-day, per-tenant invoice counter. Cheap
                    // enough to just count existing rows for today —
                    // we're nowhere near scale where this would be a
                    // hotspot.
                    const startOfDay = new Date();
                    startOfDay.setHours(0, 0, 0, 0);
                    const todayCount = await SubscriptionInvoice.countDocuments({
                        restaurant: restaurant._id,
                        createdAt: { $gte: startOfDay },
                    });
                    const ymd = startOfDay.toISOString().slice(0, 10).replace(/-/g, '');
                    const invoiceNumber = `INV-${ymd}-${String(todayCount + 1).padStart(4, '0')}`;

                    // Period end the charge paid for is the
                    // `sub.current_end` we just set. Period start is
                    // the previous period end if we have one on file
                    // (the old value of currentPeriodEnd before the
                    // update above — we kept it in `previousRzpStatus`
                    // case but not here; read it off the doc fresh).
                    // Fallback to sub.start_at or the charge time.
                    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;
                    const periodStart = sub.start_at ? new Date(sub.start_at * 1000) : new Date();

                    await SubscriptionInvoice.create({
                        restaurant: restaurant._id,
                        restaurantName: restaurant.name,
                        invoiceNumber,
                        planName: restaurant.subscription?.planName || '',
                        planSlug: restaurant.subscription?.planSlug || '',
                        amount: pmt.amount || 0,
                        currency: pmt.currency || 'INR',
                        periodStart,
                        periodEnd,
                        razorpayPaymentId: pmt.id,
                        razorpaySubscriptionId: sub.id,
                        status: 'paid',
                        paidAt: pmt.created_at ? new Date(pmt.created_at * 1000) : new Date(),
                    });
                    logger.info(`SubscriptionInvoice created for ${restaurant.slug}: ${invoiceNumber}`);
                } else {
                    logger.warn(`subscription.charged for ${restaurant.slug} had no payment entity — skipping invoice creation`);
                }
            } catch (invoiceErr) {
                // E11000 on razorpayPaymentId unique index is the
                // expected no-op when Razorpay retries a webhook.
                // Anything else is unexpected and should be logged.
                if (invoiceErr?.code === 11000) {
                    logger.info(`SubscriptionInvoice already exists for payment ${payload?.payment?.entity?.id} — retry deduped`);
                } else {
                    logger.error(`SubscriptionInvoice create failed for ${restaurant.slug}: ${invoiceErr.message}`);
                }
            }
            break;
        }

        case 'subscription.halted': {
            restaurant.status = 'suspended';
            restaurant.suspendedAt = new Date();
            restaurant.suspendedReason = 'Payment failed — subscription halted by Razorpay';
            logger.warn(`Subscription halted for ${restaurant.slug} — tenant auto-suspended`);
            break;
        }

        case 'subscription.cancelled':
        case 'subscription.completed': {
            // Don't auto-suspend. The tenant may still have paid access
            // until `currentPeriodEnd`. An operator can choose to
            // explicitly suspend via the Super Admin portal.
            restaurant.subscription.razorpayStatus = 'cancelled';
            logger.info(`Subscription ${event} for ${restaurant.slug} — keeping access until period end`);

            // ADM-106 follow-up — if this cancellation/completion was
            // driven by a scheduled downgrade (we cancelled with
            // cancel_at_cycle_end:true after approving a downgrade
            // request), apply the new plan now. `force: true` because
            // we trust the Razorpay event timing — Razorpay only
            // fires `completed` once the actual cycle has ended.
            if (event === 'subscription.completed' && restaurant.subscription?.scheduledDowngrade?.planSlug) {
                const result = applyScheduledDowngrade(restaurant, { force: true });
                if (result.applied) {
                    logger.info(`Scheduled downgrade applied for ${restaurant.slug} → ${restaurant.subscription.planName}`);
                }
            }
            break;
        }

        case 'subscription.pending':
        case 'subscription.authenticated':
        case 'subscription.activated':
            // Status already synced above — nothing extra to do.
            break;

        default:
            logger.info(`Webhook ${event} for ${restaurant.slug} — no action`);
    }

    await restaurant.save();
    // Status may have flipped (e.g. subscription.halted → suspended):
    // drop the cached tenant so the next request sees it immediately.
    invalidateTenant(restaurant._id);

    // Webhook events have no authenticated user — write a system audit
    // entry with `actor: null` and a synthetic origin tag so operators
    // can still trace what happened. Failure here must never break
    // webhook processing.
    try {
        await AuditLog.create({
            actor: null,
            actorEmail: 'razorpay-webhook',
            actorRole: 'system',
            action: event,
            targetType: 'restaurant',
            targetId: restaurant._id,
            targetName: restaurant.name,
            details: {
                subscriptionId,
                razorpayStatus: restaurant.subscription.razorpayStatus,
                previousStatus,
                newStatus: restaurant.status,
            },
            userAgent: 'Razorpay-Webhook',
        });
    } catch (auditErr) {
        logger.warn(`Audit write failed for ${event}: ${auditErr.message}`);
    }

    // Phase 4 step 4 — fire alert emails AFTER the tenant has been
    // persisted and audited, so recipients see the final state. Both
    // notifiers are idempotent (cooldown window via the audit log) so
    // retried webhooks can't spam. Any failure is swallowed inside
    // utils/alerts.js — it must never break webhook processing.
    if (event === 'subscription.halted') {
        notifyTenantHalted(restaurant).catch(() => {});
    } else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
        notifyTenantCancelled(restaurant).catch(() => {});
    }
}

// ─── POST /api/razorpay/refund ─────────────────────────────────────────────
// Processes a refund for a paid order. Supports full and partial refunds.
// - Online payments: refund via Razorpay API
// - Wallet payments: credit back to wallet
// - Cash payments: just marks order as refunded (manual cash handling)
//
// Request body: { orderId, amount, reason }
// Access: Admin only

exports.refundPayment = async (req, res) => {
    try {
        const { orderId, amount, reason } = req.body;

        if (!orderId) {
            return res.status(400).json({ success: false, message: 'Order ID is required' });
        }
        // Validate amount — required, must be a positive finite number
        if (amount === undefined || amount === null || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Refund amount is required and must be a positive number' });
        }

        const tf = tenantFilter(req);
        let order = mongoose.Types.ObjectId.isValid(orderId)
            ? await Order.findOne({ _id: orderId, ...tf })
            : null;
        if (!order) order = await Order.findOne({ orderId, ...tf });

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        if (order.paymentStatus !== 'Paid') {
            return res.status(400).json({ success: false, message: 'Only paid orders can be refunded' });
        }

        const refundAmount = amount;
        const alreadyRefunded = order.refundedAmount || 0;
        const maxRefundable = order.amountPaid - alreadyRefunded;

        if (refundAmount <= 0 || refundAmount > maxRefundable) {
            return res.status(400).json({
                success: false,
                message: `Refund amount must be between ₹1 and ₹${maxRefundable}`
            });
        }

        let razorpayRefundId = null;

        // ── Process refund based on settings and payment method (per-tenant) ──
        const settings = await getSettings(req);
        const loyalty = resolveLoyaltySettings(settings);
        const refundMode = loyalty.refundMode;

        // Step 1: External API call (Razorpay) — must happen OUTSIDE the DB session
        //         because we can't roll back an external API call.
        if (order.paymentMethod === 'online' && order.razorpayPaymentId && refundMode === 'original') {
            try {
                const refund = await razorpay.refunds.create({
                    payment_id: order.razorpayPaymentId,
                    amount: Math.round(refundAmount * 100),
                    notes: { reason: reason || 'Refund', orderId: order.orderId },
                });
                razorpayRefundId = refund.id;
                logger.info(`Razorpay refund initiated: ${razorpayRefundId} for ₹${refundAmount}`);
            } catch (rzpErr) {
                logger.error('Razorpay API Refund Error:', { error: rzpErr.message, description: rzpErr.description });
                return res.status(400).json({
                    success: false,
                    message: 'Refund could not be processed via payment gateway. Please try again or contact support.'
                });
            }
        } else if (order.paymentMethod === 'online' && !order.razorpayPaymentId) {
            return res.status(400).json({ success: false, message: 'Online payment record has no transaction ID to refund' });
        } else if (order.user && (order.paymentMethod === 'Wallet' || refundMode === 'wallet') && !order.restaurant) {
            return res.status(400).json({ success: false, message: 'Cannot process wallet refund — order has no restaurant context' });
        }

        // Step 2: All DB writes in a transaction session for atomicity.
        //         If any write fails, everything rolls back.
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                // ── Update order ──────────────────────────────────────────
                order.refundedAmount = alreadyRefunded + refundAmount;
                order.paymentStatus = order.refundedAmount >= order.amountPaid ? 'Refunded' : 'Paid';
                order.refunds = order.refunds || [];
                order.refunds.push({
                    amount: refundAmount,
                    reason: reason || '',
                    razorpayRefundId: razorpayRefundId || null,
                    actor: req.user?._id || req.user?.id || null,
                    actorName: req.user?.name || '',
                    source: 'admin',
                    createdAt: new Date(),
                });
                await order.save({ session });

                // ── Credit wallet if wallet refund ────────────────────────
                if (order.user && (order.paymentMethod === 'Wallet' || refundMode === 'wallet')) {
                    const walletScope = { user: order.user, restaurant: order.restaurant };
                    await Wallet.findOneAndUpdate(
                        walletScope,
                        { $inc: { balance: refundAmount }, $setOnInsert: { restaurant: order.restaurant } },
                        { upsert: true, returnDocument: 'after', session }
                    );
                    logger.info(`Wallet refund credited: ₹${refundAmount} to user ${order.user}`);
                }

                // ── Deduct loyalty points proportionally ──────────────────
                if (order.user) {
                    const pointsToDeduct = Math.floor(refundAmount * loyalty.pointsPerRupee);
                    if (pointsToDeduct > 0) {
                        await Wallet.findOneAndUpdate(
                            { user: order.user, loyaltyPoints: { $gte: pointsToDeduct }, ...tf },
                            { $inc: { loyaltyPoints: -pointsToDeduct } },
                            { session }
                        );
                    }
                }

                // ── Record transaction ────────────────────────────────────
                if (order.user) {
                    const wallet = await Wallet.findOne({ user: order.user, ...tf }).session(session);
                    const currentBalance = wallet ? wallet.balance : 0;
                    const isWalletRefund = (order.paymentMethod === 'Wallet' || refundMode === 'wallet');
                    const balanceBefore = isWalletRefund ? currentBalance - refundAmount : currentBalance;

                    await Transaction.create([{
                        user: order.user,
                        restaurant: order.restaurant || tenantId(req),
                        order: order._id,
                        type: 'refund',
                        amount: refundAmount,
                        paymentMethod: order.paymentMethod === 'online' ? 'upi' : order.paymentMethod.toLowerCase(),
                        status: 'completed',
                        description: `Refund of ₹${refundAmount} for order ${order.orderId}: ${reason || 'No reason'}`,
                        transactionId: idGen.transactionId(),
                        balanceBefore,
                        balanceAfter: currentBalance,
                    }], { session });
                }
            });
        } finally {
            await session.endSession();
        }

        // Revoke still-pending tips so the waiter isn't settled for a
        // refunded transaction. Settled tips are left alone.
        await revokeTipsForOrder(order, { reason: `admin refund: ${reason || 'no reason'}` });

        // Step 3: Notifications — outside the session (non-critical, best-effort)
        const notifTenant = order.restaurant || tenantId(req);
        // Persist only — the live events go out via broadcastPaymentEvent.
        await notify({
            restaurant: notifTenant,
            branch: order.branch || null,
            notification: {
                recipientRole: 'admin',
                title: 'Refund Processed',
                description: `₹${refundAmount} refunded for order ${order.orderId}`,
                category: 'Payment',
                priority: 'medium',
                meta: { orderId: order.orderId, amount: refundAmount },
            },
        });

        if (order.user) {
            await notify({
                restaurant: notifTenant,
                branch: null,
                notification: {
                    recipient: order.user,
                    recipientRole: 'customer',
                    title: 'Refund Processed',
                    description: `₹${refundAmount} has been refunded to your ${refundMode === 'wallet' ? 'wallet' : 'original payment method'}.`,
                    category: 'Wallet',
                    priority: 'medium',
                    meta: { orderId: order.orderId, amount: refundAmount },
                },
            });
        }

        broadcastPaymentEvent(order, 'Refund Processed',
            `₹${refundAmount} refunded for ${order.orderId}. Mode: ${refundMode}`);

        return res.status(200).json({
            success: true,
            message: `₹${refundAmount} refunded successfully`,
            refundedAmount: order.refundedAmount,
            razorpayRefundId,
        });
    } catch (err) {
        logger.error('Refund error:', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Failed to process refund' });
    }
};

// ─── POST /api/razorpay/orphan-refund ──────────────────────────────────────
// Refund a Razorpay payment that was captured but for which no cafe Order
// document exists (because order creation failed AFTER charge — typically
// a stock shortage, total tampering check, or coupon expiry that fires
// inside POST /orders). Without this endpoint the customer is left with a
// charge on their card and no order, and our prior UX told them to copy a
// raw Razorpay payment_id and email it to support.
//
// Flow:
//   1. Verify the payment belongs to the caller's tenant via the
//      `notes.restaurantId` we stamped in createRazorpayOrder.
//   2. Verify it was captured and isn't already refunded.
//   3. Issue a full refund through Razorpay.
//   4. Notify admin (high-priority Payment notification + socket push)
//      so staff know to investigate the underlying cause (stock, etc.).
//
// Body: { razorpay_payment_id, reason? }
// Access: optionalAuth — guests on QR scan need this path too.
exports.refundOrphanPayment = async (req, res) => {
    try {
        const { razorpay_payment_id, reason } = req.body;
        if (!razorpay_payment_id || typeof razorpay_payment_id !== 'string') {
            return res.status(400).json({
                success: false,
                code: 'PAYMENT_ID_REQUIRED',
                message: 'Payment id is required',
            });
        }

        const tenant = tenantId(req);
        if (!tenant) {
            return res.status(400).json({
                success: false,
                code: 'TENANT_REQUIRED',
                message: 'Restaurant context is required to issue a refund.',
            });
        }

        // Pull the payment AND its Razorpay order so we can (a) confirm
        // tenancy + payer via the server-set notes we stamped at
        // create-order time, and (b) read the captured amount + any prior
        // refunds. Both are needed to bound the refund and stop
        // double-refunds on retry.
        let payment;
        let rzpOrder;
        try {
            ({ payment, rzpOrder } = await fetchPaymentAndOrder(razorpay_payment_id, null));
        } catch (fetchErr) {
            logger.warn('Orphan-refund: failed to fetch payment from Razorpay', {
                payment_id: razorpay_payment_id,
                error: fetchErr.message,
            });
            return res.status(404).json({
                success: false,
                code: 'PAYMENT_NOT_FOUND',
                message: 'Payment record could not be located.',
            });
        }

        // Bug #4 — the caller must prove the payment is theirs: a valid
        // checkout signature (only the paying browser has it), or the
        // payer identity stamped in the order notes (logged-in user id /
        // verified guest scan session). Also: same tenant, a cafe-order
        // checkout that was never bound to an order, and recent.
        const { razorpay_order_id: bodyOrderId, razorpay_signature: bodySignature } = req.body || {};
        const signatureValid = !!(bodyOrderId && bodySignature
            && payment?.order_id === bodyOrderId
            && isValidCheckoutSignature({
                razorpayOrderId: bodyOrderId,
                razorpayPaymentId: razorpay_payment_id,
                signature: bodySignature,
                secret: process.env.RAZORPAY_KEY_SECRET,
            }));
        const eligibility = checkOrphanRefundEligibility({
            payment,
            rzpOrder,
            tenant,
            caller: {
                userId: req.user?._id || req.user?.id || null,
                scanSessionId: verifiedScanSessionId(req),
            },
            signatureValid,
        });
        if (!eligibility.ok) {
            logger.warn('Orphan-refund: refused', {
                payment_id: razorpay_payment_id,
                code: eligibility.code,
                tenant: String(tenant),
            });
            return res.status(eligibility.status).json({
                success: false,
                code: eligibility.code,
                message: eligibility.message,
            });
        }

        if (payment.status !== 'captured') {
            // 'authorized' / 'created' / 'failed' / 'refunded' — only a
            // captured payment is refundable. If it's already refunded
            // (status 'refunded'), we still return success so the client
            // can show its "refund underway" message idempotently.
            if (payment.status === 'refunded' || (payment.amount_refunded || 0) >= payment.amount) {
                return res.status(200).json({
                    success: true,
                    alreadyRefunded: true,
                    refundedAmount: (payment.amount_refunded || payment.amount) / 100,
                });
            }
            return res.status(400).json({
                success: false,
                code: 'PAYMENT_NOT_REFUNDABLE',
                message: `Payment is in '${payment.status}' state and cannot be refunded.`,
            });
        }

        const refundableAmount = Math.max(0, (payment.amount || 0) - (payment.amount_refunded || 0));
        if (refundableAmount <= 0) {
            return res.status(200).json({
                success: true,
                alreadyRefunded: true,
                refundedAmount: (payment.amount_refunded || 0) / 100,
            });
        }

        // Bug #4 — an "orphan" must really be an orphan: refuse if ANY
        // order, wallet transaction, advance booking or payment claim
        // references this payment (or its Razorpay order). Otherwise a
        // customer could pay, eat, and refund themselves.
        const rzpOrderId = payment.order_id || null;
        const orderRefs = [{ razorpayPaymentId: razorpay_payment_id }];
        if (rzpOrderId) orderRefs.push({ razorpayOrderId: rzpOrderId });
        const bookingRefs = [{ 'payment.razorpayPaymentId': razorpay_payment_id }];
        if (rzpOrderId) {
            bookingRefs.push({ 'payment.razorpayOrderId': rzpOrderId });
            bookingRefs.push({ 'payment.remainingRazorpayOrderId': rzpOrderId });
        }
        const txnRefs = [{ razorpayPaymentId: razorpay_payment_id }];
        if (rzpOrderId) txnRefs.push({ razorpayOrderId: rzpOrderId });
        const [orderRef, txnRef, bookingRef, existingClaim] = await Promise.all([
            Order.exists({ $or: orderRefs }),
            Transaction.exists({ $or: txnRefs }),
            AdvanceBooking.exists({ $or: bookingRefs }),
            findClaim(razorpay_payment_id),
        ]);
        if (orderRef || txnRef || bookingRef || (existingClaim && existingClaim.purpose !== 'orphan_refund')) {
            logger.warn('Orphan-refund: payment is referenced — refusing', {
                payment_id: razorpay_payment_id,
                order: !!orderRef, transaction: !!txnRef, booking: !!bookingRef,
                claim: existingClaim?.purpose || null,
            });
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_IN_USE',
                message: 'This payment is linked to an order or booking. Please contact staff.',
            });
        }
        // Claim the payment for the refund so a concurrent verify /
        // booking / recharge can't spend it while the refund is in flight.
        const refundClaim = await claimPayment(razorpay_payment_id, {
            purpose: 'orphan_refund',
            ref: razorpay_payment_id,
            razorpayOrderId: rzpOrderId,
            restaurant: tenant,
            user: req.user?._id || null,
            amount: refundableAmount / 100,
        });
        if (!refundClaim.claimed) {
            return res.status(409).json({
                success: false,
                code: 'PAYMENT_IN_USE',
                message: 'This payment is linked to an order or booking. Please contact staff.',
            });
        }

        // Issue the refund. Notes carry our reason + tenant + the
        // friendlier user-supplied cause so the audit log on the
        // Razorpay dashboard reads like a story instead of a guid.
        let refund;
        try {
            refund = await razorpay.refunds.create({
                payment_id: razorpay_payment_id,
                amount: refundableAmount,
                notes: {
                    type: 'orphan_refund',
                    reason: String(reason || 'Order creation failed after payment'),
                    restaurantId: String(tenant),
                },
            });
        } catch (rzpErr) {
            await releaseClaim(razorpay_payment_id, { purpose: 'orphan_refund', ref: razorpay_payment_id });
            logger.error('Orphan-refund: Razorpay refund call failed', {
                payment_id: razorpay_payment_id,
                error: rzpErr.message,
                description: rzpErr.description,
            });
            return res.status(502).json({
                success: false,
                code: 'GATEWAY_REFUND_FAILED',
                message: 'Refund could not be processed via the payment gateway. Please contact support.',
            });
        }

        const refundedRupees = refundableAmount / 100;

        // Admin notification — high priority, Payment category, so the
        // alert surfaces in the existing admin notification stream. The
        // staff need to investigate WHY the order failed (out-of-stock,
        // mispriced item, tampered total) so the next customer doesn't
        // hit the same dead end. Wrapped so notification failure can't
        // hide the refund success from the customer.
        await notify({
            restaurant: tenant,
            branch: req.branch?._id || null,
            audience: 'admin',
            notification: {
                recipient: null,                 // tenant-wide admin alert
                recipientRole: 'admin',
                category: 'Payment',
                priority: 'high',
                title: 'Order failed after payment — auto-refund issued',
                description:
                    `A customer was charged ₹${refundedRupees.toFixed(2)} but the order could not be saved` +
                    `${reason ? ` (${reason})` : ''}. Razorpay refund initiated automatically. ` +
                    'Check inventory / pricing — the next customer will hit the same block.',
                meta: {
                    amount: refundedRupees,
                    orderId: refund.id,         // refund id stands in for orderId in the meta slot
                },
            },
            payload: {
                title: 'Order failed after payment',
                description: `₹${refundedRupees.toFixed(2)} auto-refunded. Investigate cause.`,
                category: 'Payment',
                priority: 'high',
            },
        });

        logger.info('Orphan-refund issued', {
            payment_id: razorpay_payment_id,
            refund_id: refund.id,
            amount: refundedRupees,
            tenant: String(tenant),
            reason: reason || '(none)',
        });

        return res.status(200).json({
            success: true,
            refundedAmount: refundedRupees,
            refundId: refund.id,
        });
    } catch (err) {
        logger.error('Orphan-refund error:', { error: err.message, stack: err.stack });
        return res.status(500).json({
            success: false,
            code: 'REFUND_FAILED',
            message: 'We could not start the automatic refund. Please contact support.',
        });
    }
};

// ─── POST /api/razorpay/create-wallet-recharge ─────────────────────────────
// Creates a Razorpay order for wallet recharge (adding money to wallet).
// Similar to create-order but with purpose = 'wallet_recharge'.
//
// Request body: { amount }
// Access: Authenticated users

exports.createWalletRechargeOrder = async (req, res) => {
    try {
        const { amount } = req.body;

        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be a valid positive number' });
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

// ─── GET /api/razorpay/reconcile ───────────────────────────────────────────
// Finds orders stuck in 'Pending' for too long and checks Razorpay for the
// actual payment status. Auto-updates orders if payment was captured.
//
// Access: Admin only

exports.reconcilePayments = async (req, res) => {
    try {
        const staleMinutes = Math.max(1, Math.min(1440, parseInt(req.query.minutes) || 30));
        const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

        // Admin-triggered reconciliation — scoped to tenant.
        const staleOrders = await Order.find({
            paymentStatus: 'Pending',
            razorpayOrderId: { $exists: true, $ne: null },
            createdAt: { $lt: cutoff },
            ...tenantFilter(req),
        });

        const results = [];

        for (const order of staleOrders) {
            try {
                // Fetch payments for this Razorpay order
                const payments = await razorpay.orders.fetchPayments(order.razorpayOrderId);
                const captured = payments.items?.find(p => p.status === 'captured');
                const reconClaim = captured ? await claimPayment(captured.id, {
                    purpose: 'order_payment',
                    ref: String(order._id),
                    razorpayOrderId: order.razorpayOrderId,
                    restaurant: order.restaurant || null,
                    user: order.user || null,
                    amount: captured.amount / 100,
                }) : null;

                if (captured && !reconClaim.claimed) {
                    results.push({ orderId: order.orderId, status: 'payment_used_elsewhere' });
                } else if (captured) {
                    order.paymentStatus = 'Paid';
                    order.paymentMethod = 'online';
                    order.amountPaid = captured.amount / 100;
                    order.razorpayPaymentId = captured.id;
                    if (!order.paidAt) {
                        order.paidAt = captured.created_at
                            ? new Date(captured.created_at * 1000)
                            : new Date();
                    }
                    // Status stays as-is — chef owns the new→preparing
                    // transition. See verifyPayment for the full rationale.
                    await order.save();

                    await awardLoyaltyPoints(order);

                    results.push({ orderId: order.orderId, status: 'recovered', amount: order.amountPaid });
                    logger.info(`Reconciled: order ${order.orderId} marked as Paid`);
                } else {
                    results.push({ orderId: order.orderId, status: 'still_pending' });
                }
            } catch (fetchErr) {
                results.push({ orderId: order.orderId, status: 'error', error: fetchErr.message });
                logger.warn(`Reconcile error for ${order.orderId}:`, { error: fetchErr.message });
            }
        }

        return res.status(200).json({
            success: true,
            checked: staleOrders.length,
            results,
        });
    } catch (err) {
        logger.error('Reconciliation error:', { error: err.message });
        return res.status(500).json({ success: false, message: 'Reconciliation failed' });
    }
};

// ─── Scheduled reconciliation (runs every 30 minutes) ──────────────────────
// Called from server.js via setInterval. Not an HTTP handler.

exports.runScheduledReconciliation = async () => {
    try {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000);

        // Scope by restaurant to respect tenant isolation and use per-tenant Razorpay keys if needed.
        const restaurants = await Restaurant.find({ status: { $in: ['active', 'trial'] } }).select('_id slug').lean();

        let totalChecked = 0;
        for (const restaurant of restaurants) {
            try {
                const staleOrders = await Order.find({
                    restaurant: restaurant._id,
                    paymentStatus: 'Pending',
                    razorpayOrderId: { $exists: true, $ne: null },
                    createdAt: { $lt: cutoff },
                });

                for (const order of staleOrders) {
                    try {
                        const payments = await razorpay.orders.fetchPayments(order.razorpayOrderId);
                        const captured = payments.items?.find(p => p.status === 'captured');
                        const reconClaim = captured ? await claimPayment(captured.id, {
                            purpose: 'order_payment',
                            ref: String(order._id),
                            razorpayOrderId: order.razorpayOrderId,
                            restaurant: order.restaurant || null,
                            user: order.user || null,
                            amount: captured.amount / 100,
                        }) : null;
                        if (captured && !reconClaim.claimed) {
                            logger.warn(`Auto-reconcile: payment ${captured.id} already claimed elsewhere — skipping ${order.orderId}`);
                        } else if (captured) {
                            order.paymentStatus = 'Paid';
                            order.paymentMethod = 'online';
                            order.amountPaid = captured.amount / 100;
                            order.razorpayPaymentId = captured.id;
                            if (!order.paidAt) {
                                order.paidAt = captured.created_at
                                    ? new Date(captured.created_at * 1000)
                                    : new Date();
                            }
                            // Status stays as-is — chef owns the new→preparing
                            // transition. See verifyPayment for the full rationale.
                            await order.save();
                            await awardLoyaltyPoints(order);
                            logger.info(`Auto-reconciled: order ${order.orderId} (${restaurant.slug}) marked as Paid`);
                        }
                    } catch (fetchErr) {
                        logger.warn(`Auto-reconcile error for ${order.orderId}:`, { error: fetchErr.message });
                    }
                }
                totalChecked += staleOrders.length;
            } catch (restaurantErr) {
                logger.warn(`Reconciliation error for restaurant ${restaurant.slug}:`, { error: restaurantErr.message });
            }
        }

        if (totalChecked > 0) {
            logger.info(`Reconciliation complete: checked ${totalChecked} stale orders across ${restaurants.length} restaurants`);
        }
    } catch (err) {
        logger.error('Scheduled reconciliation error:', { error: err.message });
    }
};
