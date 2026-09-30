const Razorpay = require('razorpay');
const logger = require('./logger');

/**
 * Razorpay Subscriptions SDK wrapper for BestoDine SaaS billing.
 *
 * Responsibilities:
 *   - Create and cache Razorpay Plan objects for each SubscriptionPlan
 *   - Create and cache Razorpay Customer objects per Restaurant
 *   - Create, fetch, and cancel Razorpay Subscription objects
 *   - Translate our `billingCycle` strings to Razorpay's period/interval
 *
 * The helpers accept plain Mongoose documents and mutate them where
 * appropriate (e.g. stamping `razorpayPlanId` after the first sync).
 * The caller is responsible for `await doc.save()` afterwards.
 *
 * Configuration:
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET — required
 *   RAZORPAY_WEBHOOK_SECRET — used by the webhook signature check
 *
 * When either key is missing, `isBillingConfigured()` returns false and
 * the callers fall back to the legacy "manual plan assignment" flow
 * (no subscription created, tenant gets plan features immediately as
 * if they were on an internal comp).
 */

let _client = null;

function getClient() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        return null;
    }
    if (!_client) {
        _client = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
    }
    return _client;
}

function isBillingConfigured() {
    return !!getClient();
}

// ── Mapping helpers ────────────────────────────────────────────────────

// Map our billingCycle enum onto Razorpay's period.
// Razorpay supports: daily, weekly, monthly, quarterly, yearly.
function toRazorpayPeriod(cycle) {
    switch (cycle) {
        case 'monthly':   return 'monthly';
        case 'quarterly': return 'quarterly';
        case 'yearly':    return 'yearly';
        default:          return 'monthly';
    }
}

// Razorpay amounts are in paise (smallest currency unit).
function toPaise(amount) {
    return Math.round(Number(amount) * 100);
}

// Subscriptions need a total_count — the number of billing cycles the
// subscription runs for. We default to a very high number (effectively
// "until the customer cancels") rather than binding the tenant to a
// fixed term.
const DEFAULT_TOTAL_COUNT = {
    monthly:   120,   // 10 years of monthly charges
    quarterly: 40,    // 10 years of quarterly charges
    yearly:    10,    // 10 years of yearly charges
};

// ── Plan sync ─────────────────────────────────────────────────────────

/**
 * Ensure a SubscriptionPlan has a matching Razorpay Plan object.
 * Mutates `plan.razorpayPlanId` on first sync. Idempotent — if the id
 * already exists, this is a no-op.
 *
 * Returns the plan document (for chaining).
 * Throws if billing is not configured or the API call fails.
 */
async function ensureRazorpayPlan(plan) {
    const client = getClient();
    if (!client) throw new Error('Razorpay billing not configured');
    if (!plan || !plan._id) throw new Error('ensureRazorpayPlan requires a plan doc');

    if (plan.razorpayPlanId) return plan;

    // Free plans (price === 0) deliberately do not get a Razorpay plan
    // — they're comps and should never be auto-charged.
    if (!plan.price || plan.price <= 0) {
        throw new Error('Cannot create Razorpay plan for a zero-price plan');
    }

    try {
        const rzpPlan = await client.plans.create({
            period: toRazorpayPeriod(plan.billingCycle),
            interval: 1,
            item: {
                name: plan.name,
                amount: toPaise(plan.price),
                currency: plan.currency || 'INR',
                description: plan.description || `BestoDine ${plan.name} plan`,
            },
            notes: {
                planSlug: plan.slug,
                planId: plan._id.toString(),
            },
        });

        plan.razorpayPlanId = rzpPlan.id;
        await plan.save();
        logger.info(`Razorpay plan created for "${plan.slug}": ${rzpPlan.id}`);
        return plan;
    } catch (err) {
        // If 401, the Subscriptions product isn't enabled. Let the
        // error propagate with the statusCode so createRazorpaySubscription
        // can catch it and fall back to the Orders API.
        if (err?.statusCode === 401) {
            logger.warn(`Razorpay Plans API returned 401 for "${plan.slug}" — Subscriptions product may not be enabled`);
        }
        throw err;
    }
}

// ── Customer sync ──────────────────────────────────────────────────────

/**
 * Ensure the restaurant has a Razorpay Customer object. Creates one on
 * first call using the owner admin's name/email/mobile. Idempotent.
 *
 * Mutates `restaurant.subscription.razorpayCustomerId`. The caller is
 * responsible for saving the restaurant document.
 */
async function ensureRazorpayCustomer(restaurant, owner) {
    const client = getClient();
    if (!client) throw new Error('Razorpay billing not configured');
    if (!restaurant) throw new Error('ensureRazorpayCustomer requires a restaurant doc');

    if (restaurant.subscription?.razorpayCustomerId) {
        return restaurant.subscription.razorpayCustomerId;
    }

    const email   = owner?.email || restaurant.contactEmail;
    const name    = owner?.name || restaurant.name || 'Restaurant Owner';
    const contact = owner?.mobile || restaurant.contactPhone || undefined;

    let rzpCustomer;
    try {
        rzpCustomer = await client.customers.create({
            name,
            email,
            contact,
            notes: {
                restaurantId: restaurant._id.toString(),
                restaurantSlug: restaurant.slug,
            },
            fail_existing: '0', // string '0' — some SDK versions need this as a string
        });
    } catch (createErr) {
        // "Customer already exists for the merchant" — the customer
        // was created on a previous attempt but the ID wasn't saved
        // (plan assignment failed mid-flow). Fetch the existing
        // customer by email and reuse their ID.
        const desc = createErr?.error?.description || createErr?.message || '';
        if (/already exists/i.test(desc)) {
            logger.info(`Razorpay customer already exists for ${email} — fetching...`);
            try {
                const existing = await client.customers.all({ count: 1 });
                // The customers.all endpoint doesn't filter by email,
                // so we search through recent customers. For a small
                // merchant this is fine; for large ones we'd need the
                // Razorpay search API.
                // Alternative: fetch ALL and find by email
                const allCustomers = await client.customers.all({ count: 100 });
                const match = (allCustomers.items || []).find(
                    c => c.email?.toLowerCase() === email.toLowerCase()
                );
                if (match) {
                    rzpCustomer = match;
                    logger.info(`Found existing Razorpay customer: ${match.id}`);
                } else {
                    // Can't find the customer — rethrow the original error
                    throw createErr;
                }
            } catch (fetchErr) {
                // If fetching also fails, throw the original create error
                if (fetchErr === createErr) throw createErr;
                logger.warn(`Failed to fetch existing customer: ${fetchErr.message}`);
                throw createErr;
            }
        } else {
            throw createErr;
        }
    }

    restaurant.subscription = restaurant.subscription || {};
    restaurant.subscription.razorpayCustomerId = rzpCustomer.id;
    logger.info(`Razorpay customer for "${restaurant.slug}": ${rzpCustomer.id}`);
    return rzpCustomer.id;
}

// ── Subscription create / fetch / cancel ─────────────────────────────

/**
 * Create a new Razorpay subscription for the given (restaurant, plan).
 * Assumes the plan has already been synced and the restaurant has a
 * customer id. Returns `{ id, status, short_url, ... }`.
 *
 * Fallback: if the Subscriptions API returns 401 (feature not
 * provisioned on this Razorpay account), automatically falls back to
 * creating a one-time Razorpay Order via the Orders API (which works
 * on ALL Razorpay accounts). The caller gets back a result with
 * `fallbackOrder: true` + `orderId` instead of `short_url`, and the
 * frontend opens the standard Razorpay Checkout popup.
 */
async function createRazorpaySubscription({ plan, restaurant, customerId }) {
    const client = getClient();
    if (!client) throw new Error('Razorpay billing not configured');

    // Try the Subscriptions API first (requires the Subscriptions
    // product to be enabled on the Razorpay account).
    try {
        if (!plan?.razorpayPlanId) {
            // Plan not yet synced — will trigger ensureRazorpayPlan
            // which may fail if Subscriptions isn't enabled.
            throw { statusCode: 401, error: 'Plan not synced and subscriptions may not be available' };
        }

        if (!customerId) throw new Error('createRazorpaySubscription requires a customerId');

        const totalCount = DEFAULT_TOTAL_COUNT[plan.billingCycle] || DEFAULT_TOTAL_COUNT.monthly;

        const sub = await client.subscriptions.create({
            plan_id: plan.razorpayPlanId,
            customer_notify: 1,
            quantity: 1,
            total_count: totalCount,
            notes: {
                restaurantId: restaurant._id.toString(),
                restaurantSlug: restaurant.slug,
                planSlug: plan.slug,
            },
        });

        return sub;
    } catch (subErr) {
        // If it's NOT a 401, re-throw — it's a real error.
        if (subErr?.statusCode !== 401) throw subErr;

        // ── Fallback: Razorpay Orders API ──────────────────────────
        // The Subscriptions product isn't available, but the Orders
        // API works on every Razorpay account. Create a one-time
        // order for the plan amount. The frontend will open the
        // standard Razorpay Checkout popup (same as customer payments)
        // and the payment.captured webhook will activate the plan.
        logger.warn(
            `Subscriptions API unavailable (401) for ${restaurant.slug} — falling back to Orders API`
        );

        const amountInPaise = toPaise(plan.price);
        const order = await client.orders.create({
            amount: amountInPaise,
            currency: plan.currency || 'INR',
            receipt: `p_${plan.slug.slice(0, 8)}_${Date.now()}`.slice(0, 40),
            notes: {
                type: 'plan_payment',
                restaurantId: restaurant._id.toString(),
                restaurantSlug: restaurant.slug,
                planSlug: plan.slug,
                planName: plan.name,
            },
        });

        logger.info(`Fallback order created for ${restaurant.slug}: ${order.id} (₹${plan.price})`);

        // Return a shape compatible with the subscription result so
        // callers can handle both paths. `fallbackOrder: true` tells
        // the caller to use Checkout instead of short_url redirect.
        return {
            id: order.id,
            status: 'created',
            short_url: '',           // no short_url for orders
            fallbackOrder: true,     // signal to the frontend
            orderId: order.id,
            amount: amountInPaise,
            currency: order.currency,
            key: process.env.RAZORPAY_KEY_ID,
        };
    }
}

/**
 * Cancel an active Razorpay subscription. `cancelAtCycleEnd: true`
 * means the customer keeps their access until the current period
 * ends; the default is immediate cancellation.
 */
async function cancelRazorpaySubscription(subscriptionId, cancelAtCycleEnd = false) {
    const client = getClient();
    if (!client) throw new Error('Razorpay billing not configured');
    if (!subscriptionId) throw new Error('cancelRazorpaySubscription requires an id');

    return client.subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
}

/**
 * Fetch fresh state for a subscription from Razorpay. Used by the
 * reconciliation job to sync our denormalised status fields.
 */
async function fetchRazorpaySubscription(subscriptionId) {
    const client = getClient();
    if (!client) throw new Error('Razorpay billing not configured');
    if (!subscriptionId) return null;

    return client.subscriptions.fetch(subscriptionId);
}

/**
 * List the Razorpay invoices attached to a subscription. Each row
 * carries a `payment_id` once the cycle is paid, which is what the
 * sync flow uses to find the matching captured payment and create a
 * SubscriptionInvoice on our side. Pagination is capped at 100 —
 * subscriptions rarely have more cycles than that mid-flight, and
 * we sync newest-first via `from` if/when we need to handle long-
 * lived tenants.
 */
async function listSubscriptionInvoices(subscriptionId) {
    const client = getClient();
    if (!client) throw new Error('Razorpay billing not configured');
    if (!subscriptionId) return [];

    const result = await client.invoices.all({ subscription_id: subscriptionId, count: 100 });
    return result?.items || [];
}

/**
 * Direct payment fetch by id. Used by the sync flow to materialise
 * the full payment entity (amount, currency, captured_at) we need to
 * persist a SubscriptionInvoice row.
 */
async function fetchRazorpayPayment(paymentId) {
    const client = getClient();
    if (!client) throw new Error('Razorpay billing not configured');
    if (!paymentId) return null;

    return client.payments.fetch(paymentId);
}

module.exports = {
    isBillingConfigured,
    ensureRazorpayPlan,
    ensureRazorpayCustomer,
    createRazorpaySubscription,
    cancelRazorpaySubscription,
    fetchRazorpaySubscription,
    listSubscriptionInvoices,
    fetchRazorpayPayment,
    toRazorpayPeriod,
    toPaise,
};
