// Razorpay webhook handler plus plan-payment / subscription event handlers.

const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../../models/order');
const Restaurant = require('../../models/restaurant');
const AuditLog = require('../../models/auditLog');
const SubscriptionInvoice = require('../../models/subscriptionInvoice');
const logger = require('../../utils/logger');
const paymentState = require('../../utils/paymentState');
const { invalidateTenant } = require('../../middlewares/tenantContext');
const { notifyTenantHalted, notifyTenantCancelled } = require('../../utils/alerts');
const { createTipForPaidOrder, revokeTipsForOrder } = require('../../utils/tipHelpers');
const { applyPendingUpgrade, applyPaidPlanUpgrade, applyScheduledDowngrade, pendingPaymentMismatch, localYmd } = require('../../utils/planPaymentApply');
const { orderCheckoutIds, checkCaptureCoversDue, paiseToRupees } = require('../../utils/paymentChecks');
const { claimPayment } = require('../../utils/paymentClaim');
const { roundPaise } = require('../../utils/orderRefund');
const {
    freeTableIfReady,
    settleSiblingDineInRounds,
    settleSplitSiblings,
    markOrderPaidAtomically,
    safeEqual,
    awardLoyaltyPoints,
    broadcastPaymentEvent,
} = require('./_shared');

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
            // Decision 4a: the checkout may be an older one of the order
            // (razorpayOrderIds history), not only the latest.
            order = await Order.findOne({
                $or: [{ razorpayOrderId: rzpOrderId }, { razorpayOrderIds: rzpOrderId }],
            });
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
        const linkedCheckouts = orderCheckoutIds(order);
        if (linkedCheckouts.length && rzpOrderId && !linkedCheckouts.includes(rzpOrderId)) {
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
            const capturedAmount = paiseToRupees(payment.amount);

            // Same coverage rule as verify-payment: an underpaid capture
            // (e.g. a stale checkout after items were added) must not
            // close the bill. Leave the order unpaid for staff to resolve.
            const cover = checkCaptureCoversDue({ order, amount: capturedAmount });
            if (!cover.ok) {
                logger.error('Webhook: captured amount does not cover the amount due — not settling order', {
                    paymentId: payment.id,
                    orderId: order.orderId,
                    captured: capturedAmount,
                    total: order.total,
                    amountPaid: order.amountPaid,
                });
                if (await paymentState.markPaymentFailed(
                    { _id: order._id, ...(order.restaurant ? { restaurant: order.restaurant } : {}) },
                    { reason: 'AMOUNT_MISMATCH', reference: rzpOrderId || '', amount: capturedAmount },
                )) paymentState.emitBillingState(order);
                return res.status(200).json({ status: 'ok' });
            }

            // Bug #10 — a payment id settles at most one order. If it was
            // already claimed for something else, don't apply it here.
            const whClaim = await claimPayment(payment.id, {
                purpose: 'order_payment',
                ref: String(order._id),
                razorpayOrderId: rzpOrderId || null,
                restaurant: order.restaurant || null,
                user: order.user || null,
                amount: capturedAmount,
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

            // Atomic Paid transition — a concurrent duplicate delivery (a
            // claim replay) or a racing verify-payment loses here and runs
            // no side effects. order.total is never rewritten.
            // Status stays 'new' on payment — chef decides when to start
            // cooking via the KDS.
            const paidOrder = await markOrderPaidAtomically(order, {
                paymentId: payment.id,
                razorpayOrderId: rzpOrderId || null,
                capturedAmount,
                priorPaid: cover.priorPaid,
                paidAt: payment.created_at ? new Date(payment.created_at * 1000) : null,
            });
            if (!paidOrder) {
                logger.info('Webhook: order already settled by a concurrent request — skipping side effects', {
                    paymentId: payment.id,
                    orderId: order.orderId,
                });
                return res.status(200).json({ status: 'ok' });
            }
            // Captured after the order was cancelled: recorded + refund
            // request queued (markOrderPaidAtomically); no sale side effects.
            if (paidOrder.paidAfterCancel) {
                logger.warn('Webhook: capture on a cancelled order — refund request queued', {
                    paymentId: payment.id,
                    orderId: paidOrder.orderId,
                });
                return res.status(200).json({ status: 'ok' });
            }

            await awardLoyaltyPoints(paidOrder);

            // Webhook is the safety net when the user closed the tab
            // before verifyPayment ran. Without this call the tip on
            // those orders was never recorded. Idempotent.
            await createTipForPaidOrder(paidOrder, paidOrder.restaurant);

            // Aggregated dine-in bill — same as verifyPayment: this
            // capture covers every unpaid round on the table.
            await settleSiblingDineInRounds(paidOrder, 'online');

            // Mixed-cart checkout: the linked counter-side split doc(s).
            await settleSplitSiblings(paidOrder, 'online');

            // Same table-release path verifyPayment uses. Required here
            // too because the webhook is the only signal we get when the
            // customer's browser tab dies between paying and the verify
            // call landing — without it the table sits stuck at occupied.
            await freeTableIfReady(paidOrder);

            broadcastPaymentEvent(paidOrder, 'Payment Confirmed (Webhook)',
                `₹${paidOrder.amountPaid} payment verified for order ${paidOrder.orderId}`);

        } else if (event === 'payment.failed') {
            // Order.paymentStatus has no 'Failed' state. A failed attempt
            // leaves the order as it was (the customer can retry) — just
            // record it in the log.
            logger.info(`Webhook: Payment failed for order ${order.orderId}`, {
                paymentId: payment.id,
                paymentStatus: order.paymentStatus,
                errorCode: payment.error_code || null,
                errorDescription: payment.error_description || null,
            });
            // Phase 4: reflect it on the payment state block (never
            // downgrades an already-paid order).
            if (await paymentState.markPaymentFailed(
                // Reference-bound: a late failure for an older checkout must not
                // overwrite a newer pending attempt.
                { _id: order._id, ...(order.restaurant ? { restaurant: order.restaurant } : {}),
                    ...(payment.order_id ? { 'payment.reference': payment.order_id } : {}) },
                { reason: payment.error_code || 'payment.failed', reference: payment.order_id || '' },
            )) paymentState.emitBillingState(order);
            // A pay-first order held from the kitchen on an 'online'
            // promise (operations profile) now has a 15-minute retry
            // window before the sweeper may cancel it. No-op for every
            // other order (never held).
            try {
                const { noteOnlinePaymentFailed } = require('../../services/orderHoldService');
                await noteOnlinePaymentFailed(order);
            } catch (holdErr) {
                logger.warn(`Webhook: could not stamp payment failure on held order ${order.orderId}: ${holdErr.message}`);
            }
        } else if (event === 'refund.processed') {
            const refundEntity = parsed.payload?.refund?.entity || null;
            // The refund's own amount — payload.payment.entity.amount is the
            // ORIGINAL capture and would turn every partial refund into a full one.
            const refundAmount = refundEntity ? paiseToRupees(refundEntity.amount) : 0;
            const refundId = refundEntity?.id || null;
            if (!(refundAmount > 0) || !refundId) {
                logger.warn('Webhook: refund.processed without a usable refund entity — ignoring', {
                    orderId: order.orderId,
                    refundId,
                });
                return res.json({ status: 'ok' });
            }
            // Atomic dedupe: the push + increment only applies when this
            // refund id is not yet recorded, so concurrent duplicate
            // deliveries (and refunds already recorded by the admin path)
            // count once.
            const updated = await Order.findOneAndUpdate(
                { _id: order._id, 'refunds.razorpayRefundId': { $ne: refundId } },
                {
                    $inc: { refundedAmount: refundAmount },
                    $push: {
                        refunds: {
                            amount: refundAmount,
                            reason: refundEntity?.notes?.reason || 'Razorpay refund',
                            razorpayRefundId: refundId,
                            source: 'webhook',
                            createdAt: new Date(),
                        },
                    },
                },
                { returnDocument: 'after' }
            );
            if (updated) {
                // Round the running total to paise and flip to Refunded once
                // fully refunded. Conditional on the value we just produced,
                // so a concurrent refund's own pass handles the final state.
                const rounded = roundPaise(updated.refundedAmount);
                const set = { refundedAmount: rounded };
                if (updated.paymentStatus === 'Paid' && rounded >= roundPaise(updated.amountPaid)) {
                    set.paymentStatus = 'Refunded';
                }
                await Order.updateOne(
                    { _id: order._id, refundedAmount: updated.refundedAmount },
                    { $set: set }
                );
            }
            // Revoke still-pending tips so the waiter isn't settled for
            // a refunded transaction. Settled tips are left alone.
            await revokeTipsForOrder(order, { reason: 'razorpay refund webhook' });
            logger.info(`Webhook: refund.processed for order ${order.orderId}, amount ₹${refundAmount}${updated ? '' : ' (already recorded)'}`);
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
            // The charge must actually pay for the pending plan (amount ≥
            // plan price, right order) — otherwise a cheaper charge would
            // unlock whatever plan is pending. Checked when Razorpay sends
            // the payment entity (it normally does on subscription.charged).
            const chargedPayment = payload?.payment?.entity || null;
            const upgradeMismatch = chargedPayment
                ? pendingPaymentMismatch(restaurant.subscription?.pendingUpgrade, chargedPayment)
                : '';
            let upgradeApplied = false;
            if (upgradeMismatch) {
                logger.error(`Subscription charged: payment ${chargedPayment.id} NOT applied to pending upgrade for ${restaurant.slug}: ${upgradeMismatch}`);
            } else {
                upgradeApplied = applyPendingUpgrade(restaurant);
            }
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
            // Also covers the 24h grace period (decision 5): a tenant still
            // `past_due` after a halt is restored, and the scheduled lockout
            // and halt counters are cleared.
            const inHaltGrace = restaurant.status === 'past_due' && previousRzpStatus === 'halted';
            const suspendedForHalt = restaurant.status === 'suspended' && previousRzpStatus === 'halted';
            if (inHaltGrace || suspendedForHalt) {
                restaurant.status = restaurant.subscription.trialEndDate && restaurant.subscription.trialEndDate > new Date()
                    ? 'trial'
                    : 'active';
                restaurant.suspendedAt = undefined;
                restaurant.suspendedReason = '';
            }
            restaurant.subscription.haltedCount = 0;
            restaurant.subscription.firstHaltedAt = undefined;
            restaurant.subscription.scheduledSuspendAt = undefined;
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
                    // Local calendar date — the same basis as the local
                    // midnight `startOfDay` (toISOString() gave the UTC
                    // date, i.e. yesterday east of UTC).
                    const ymd = localYmd(startOfDay);

                    // Period end the charge paid for is the
                    // `sub.current_end` we just set. Period start is
                    // the previous period end if we have one on file
                    // (the old value of currentPeriodEnd before the
                    // update above — we kept it in `previousRzpStatus`
                    // case but not here; read it off the doc fresh).
                    // Fallback to sub.start_at or the charge time.
                    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;
                    const periodStart = sub.start_at ? new Date(sub.start_at * 1000) : new Date();

                    // countDocuments + 1 races with a concurrent invoice for
                    // the same tenant/day: on an invoiceNumber E11000 take the
                    // next slot (bounded, same as applyPaidPlanUpgrade). A
                    // razorpayPaymentId E11000 falls through to the outer
                    // catch as the expected retried-webhook no-op.
                    let invoiceNumber = '';
                    let saved = null;
                    for (let attempt = 0, seq = todayCount + 1; attempt < 50 && !saved; attempt++, seq++) {
                        invoiceNumber = `INV-${ymd}-${String(seq).padStart(4, '0')}`;
                        try {
                            saved = await SubscriptionInvoice.create({
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
                        } catch (insertErr) {
                            if (insertErr?.code === 11000 && /invoiceNumber/.test(insertErr.message || '')) {
                                logger.info(`SubscriptionInvoice number ${invoiceNumber} race-lost for ${restaurant.slug}, retrying`);
                                continue;
                            }
                            throw insertErr;
                        }
                    }
                    if (!saved) {
                        throw new Error(`Could not allocate a unique invoiceNumber after 50 attempts (tenant ${restaurant.slug})`);
                    }
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
            // Decision 5 (2026-10, CRIT-18): no instant lockout. The tenant
            // goes `past_due` (still fully usable) and is suspended 24h
            // after the FIRST halt of this streak by
            // utils/haltedSubscriptionSuspender unless a charge lands first.
            // A redelivered / repeated halt never extends the deadline, and
            // a tenant already suspended for another reason stays suspended.
            const { scheduledSuspendAtFor } = require('../../utils/haltedSubscriptionSuspender');
            const now = new Date();
            restaurant.subscription.haltedCount = (Number(restaurant.subscription.haltedCount) || 0) + 1;
            if (!restaurant.subscription.firstHaltedAt) restaurant.subscription.firstHaltedAt = now;
            if (!restaurant.subscription.scheduledSuspendAt) {
                restaurant.subscription.scheduledSuspendAt = scheduledSuspendAtFor(restaurant.subscription.firstHaltedAt);
            }
            if (restaurant.status !== 'suspended') restaurant.status = 'past_due';
            logger.warn(`Subscription halted for ${restaurant.slug} — past_due, suspension scheduled for ${restaurant.subscription.scheduledSuspendAt.toISOString()}`);
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
