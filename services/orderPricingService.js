/**
 * orderPricingService — authoritative money math for orders.
 *
 * Extracted from controllers/orderController.js (BUGS_REPORT #31). The
 * createOrder pricing phases (cart pricing, toppings/sizes validation,
 * delivery fee, coupon, loyalty points, wallet split, total sanity check,
 * tax breakdown) live here unchanged. Validation failures are thrown as
 * OrderHttpError with the exact response bodies the controller used to
 * send inline.
 *
 * Also home to the append-items bill recompute (see
 * recomputeBillAfterAppend) which fixes appended items skipping
 * GST / service charge / additional charges.
 */
const Wallet = require('../models/wallet');
const logger = require('../utils/logger');
const { getSettings } = require('../utils/settingsCache');
const { tenantFilter, pinnedBranchId } = require('../utils/tenantScope');
const { resolveLoyaltySettings } = require('../utils/paymentDefaults');
const { toTaxConfig } = require('../utils/billing');
const { menuCategoryKind } = require('../utils/couponScope');
const { httpError } = require('./orderErrors');
const { lineItemsSubtotal, recomputeBillAfterAppend, billOrderType, billFieldsForNewOrder, round2 } = require('./orderBillMath');

// Validate every selectedTopping against the menu item's real toppings list.
function validateSelectedToppings(items, menuById) {
  // Validate every selectedTopping against the menu item's real
  // toppings list. A malicious client could otherwise tack a zero-price
  // entry onto a premium addon and the computedTotal check above would
  // still pass (it trusts the client-supplied price). We reject the
  // whole order on any mismatch rather than silently stripping.
  for (const item of items) {
    if (!Array.isArray(item.selectedToppings) || item.selectedToppings.length === 0) continue;
    const menu = item.menuItem && menuById.get(String(item.menuItem));
    if (!menu) {
      throw httpError(400, { success: false, message: `Unknown menu item in cart: ${item.name || item.menuItem}` });
    }
    const canonical = new Map((menu.toppings || []).map(t => [String(t.name).trim().toLowerCase(), Number(t.price)]));
    for (const st of item.selectedToppings) {
      const key = String(st?.name || '').trim().toLowerCase();
      const claimed = Number(st?.price);
      const real = canonical.get(key);
      if (!key || real === undefined) {
        throw httpError(400, { success: false, message: `Invalid topping "${st?.name || ''}" for ${menu.name}` });
      }
      // Allow a 1-paise rounding window — client math on floats can
      // otherwise diverge by a cent.
      if (!Number.isFinite(claimed) || Math.abs(claimed - real) > 0.01) {
        throw httpError(400, { success: false, message: `Topping price mismatch for "${st.name}" on ${menu.name}` });
      }
    }
  }
}

// Canonical per-unit price of one cart / append line: the resolved
// (branch / offer-aware) finalPrice, or — when the client picked a size —
// that size's menu price with the item's offer applied, rounded to paise.
// Never the client-sent price. Unknown size → 400 INVALID_SIZE.
function canonicalUnitPrice(menu, resolved, item) {
  let unitPrice = Number(resolved.finalPrice) || 0;

  // Size variant: if the client picked a size, use that size's
  // canonical price from the menu doc — never the client-sent one.
  const firstSize = Array.isArray(item.selectedSizes) && item.selectedSizes.length
    ? item.selectedSizes[0]
    : null;
  if (firstSize && firstSize.name) {
    const wantedName = String(firstSize.name).trim().toLowerCase();
    const canonicalSize = Array.isArray(menu.sizes)
      ? menu.sizes.find(s => String(s.name).trim().toLowerCase() === wantedName)
      : null;
    if (!canonicalSize || !Number.isFinite(Number(canonicalSize.price))) {
      throw httpError(400, {
        success: false,
        code: 'INVALID_SIZE',
        message: `Unknown size "${firstSize.name}" for ${menu.name}`,
      });
    }
    unitPrice = Number(canonicalSize.price);
    // Sizes carry the BASE price; the menu item's `offerPercentage`
    // applies on top, exactly like for the default unit price. Without
    // this discount step, picking "Regular" on a discounted item
    // would charge the pre-offer base price and the cart total
    // (which sees finalPrice on the storefront) would trip
    // TOTAL_TAMPERED below for every legitimate order. Round to the
    // same 2-dp precision the storefront uses to keep the totals
    // strictly comparable.
    const offerPct = Number(resolved.offerPercentage) || 0;
    if (offerPct > 0) {
      unitPrice = Math.round((unitPrice - (unitPrice * offerPct / 100)) * 100) / 100;
    }
  }
  return unitPrice;
}

// R-01: price every cart line from canonical menu data. Mutates each
// item's price/quantity to the canonical values; returns the subtotal.
function priceCartItems(items, menuById, pricingBranchId) {
  const { resolvePrice } = require('../utils/priceResolver');

  let authoritativeSubtotal = 0;
  for (const item of items) {
    const menu = item.menuItem && menuById.get(String(item.menuItem));
    if (!menu) {
      throw httpError(400, {
        success: false,
        code: 'ITEM_NOT_FOUND',
        message: `Unknown menu item in cart: ${item.name || item.menuItem}`,
      });
    }
    const resolved = resolvePrice(menu, pricingBranchId);
    const unitPrice = canonicalUnitPrice(menu, resolved, item);

    // Toppings were already validated canonical above — sum them here
    // against the same canonical values to avoid re-trusting client input.
    const canonicalToppings = new Map(
      (menu.toppings || []).map(t => [String(t.name).trim().toLowerCase(), Number(t.price)])
    );
    const toppingsSum = Array.isArray(item.selectedToppings)
      ? item.selectedToppings.reduce((s, t) => {
        const k = String(t?.name || '').trim().toLowerCase();
        return s + (Number(canonicalToppings.get(k)) || 0);
      }, 0)
      : 0;

    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    if (qty > 999) {
      throw httpError(400, {
        success: false,
        code: 'QUANTITY_EXCEEDED',
        message: `Quantity ${qty} for "${menu.name}" exceeds the per-item limit.`,
      });
    }

    authoritativeSubtotal += (unitPrice + toppingsSum) * qty;

    // Stamp the canonical per-unit price + quantity back onto the
    // cart item so what we save matches what we just priced. Toppings
    // stay in selectedToppings[]; item.price is the per-unit menu
    // price only (matches the schema's existing semantics).
    item.price = unitPrice;
    item.quantity = qty;
  }
  authoritativeSubtotal = Math.round(authoritativeSubtotal * 100) / 100;
  return authoritativeSubtotal;
}

// Authoritative delivery fee (never trust the client's charge).
async function resolveDeliveryFee(req, { wantsDelivery, deliveryReq, branchId, cleanDeliveryAddress, settings, authoritativeSubtotal }) {
  // ── Authoritative delivery fee ──────────────────────────────────
  // Never trust the client's delivery charge. When delivery was
  // requested, the customer told us which km range covers their
  // address (deliveryReq.slab.{fromKm,toKm}); we re-derive the charge
  // from the tenant's Settings.delivery.slabs and snapshot it onto the
  // order so a later edit of the slab table can't retro-change the bill.
  let authoritativeDeliveryFee = 0;
  let authoritativeDeliverySlab = null;
  let authoritativeDeliveryDistance = null;   // km, when measured
  let authoritativeDeliveryCoords = null;     // customer { lat, lng }
  if (wantsDelivery) {
    const deliveryCfg = settings?.delivery || {};
    if (!deliveryCfg.enabled) {
      throw httpError(400, { success: false, code: 'DELIVERY_DISABLED', message: 'Home delivery is not available right now.' });
    }
    const slabs = Array.isArray(deliveryCfg.slabs) ? deliveryCfg.slabs : [];
    if (slabs.length === 0) {
      throw httpError(400, { success: false, code: 'DELIVERY_NO_SLABS', message: 'No delivery ranges are configured. Please contact the restaurant.' });
    }
    // Measure the distance server-side (branch/restaurant coordinates →
    // customer coordinates or geocoded address, haversine). The client's
    // distance / slab is only used when measuring isn't possible
    // (restaurant location not configured, or the address can't be
    // geocoded) — the legacy manual-slab path.
    let matched = null;
    const { quoteDelivery } = require('../utils/deliveryDistance');
    const quote = await quoteDelivery({
      req,
      settings,
      branchId: branchId || null,
      lat: deliveryReq.lat,
      lng: deliveryReq.lng,
      address: cleanDeliveryAddress,
    });
    if (quote.ok) {
      matched = quote.slab;
      authoritativeDeliveryDistance = quote.distanceKm;
      authoritativeDeliveryCoords = quote.customer;
    } else if (!quote.fallback) {
      throw httpError(400, { success: false, code: quote.code, message: quote.message });
    }
    if (!matched) {
      // Fallback: match the slab the customer selected. Prefer an exact
      // (fromKm,toKm) match; fall back to the slab index when supplied.
      const reqSlab = deliveryReq.slab || {};
      const reqFrom = Number(reqSlab.fromKm);
      const reqTo = Number(reqSlab.toKm);
      matched = slabs.find(s =>
        Number(s.fromKm) === reqFrom && Number(s.toKm) === reqTo
      );
      if (!matched && Number.isInteger(deliveryReq.slabIndex) && slabs[deliveryReq.slabIndex]) {
        matched = slabs[deliveryReq.slabIndex];
      }
    }
    if (!matched) {
      throw httpError(400, { success: false, code: 'DELIVERY_SLAB_INVALID', message: 'The selected delivery range is no longer available. Please re-select your distance.' });
    }
    authoritativeDeliveryFee = Math.max(0, Math.round((Number(matched.charge) || 0) * 100) / 100);
    authoritativeDeliverySlab = {
      fromKm: Number(matched.fromKm),
      toKm: Number(matched.toKm),
      charge: authoritativeDeliveryFee,
    };
    // Optional minimum-cart gate.
    const minOrder = Number(deliveryCfg.minOrderValue) || 0;
    if (minOrder > 0 && authoritativeSubtotal < minOrder) {
      throw httpError(400, {
        success: false,
        code: 'DELIVERY_MIN_ORDER',
        message: `Home delivery requires a minimum order of ₹${minOrder.toFixed(2)}. Your items total ₹${authoritativeSubtotal.toFixed(2)}.`,
      });
    }
  }
  return {
    authoritativeDeliveryFee,
    authoritativeDeliverySlab,
    authoritativeDeliveryDistance,
    authoritativeDeliveryCoords,
  };
}

// Look a coupon up within the caller's tenant AND branch scope — the
// same visibility rules as the checkout pre-check
// (promotionController.applyCoupon / customerBranchFilter):
//   • branch-pinned staff  → only their branch's coupons;
//   • customers / guests ordering at a branch → tenant-level coupons,
//     that branch's, or the main branch's (inherited);
//   • unpinned staff, or no branch context → any coupon of the tenant.
// `branchId` is the order's branch (the table's branch for dine-in).
async function findCouponInScope(Coupon, req, code, branchId) {
  const base = { code, isActive: true, ...tenantFilter(req) };
  const pinned = pinnedBranchId(req);
  if (pinned) return Coupon.findOne({ ...base, branch: pinned }).lean();
  const isStaff = !!(req.user && req.user.role && req.user.role !== 'customer');
  const orderBranch = branchId || req.branch?._id || null;
  if (isStaff || !orderBranch) return Coupon.findOne(base).lean();

  const coupon = await Coupon.findOne({ ...base, branch: { $in: [null, orderBranch] } }).lean();
  if (coupon) return coupon;
  // Only pay for the main-branch lookup when the code exists elsewhere.
  const elsewhere = await Coupon.findOne({ ...base, branch: { $nin: [null, orderBranch] } }).lean();
  if (!elsewhere) return null;
  const { getMainBranchId } = require('../utils/mainBranch');
  const main = await getMainBranchId(req);
  if (!main || String(main) === String(orderBranch)) return null;
  return Coupon.findOne({ ...base, branch: main }).lean();
}

// Server-side coupon validation for a new cart.
async function resolveCartCoupon(req, { items, menuById, authoritativeSubtotal, branchId }) {
  // ── Server-side coupon validation ───────────────────────────────
  // Mirrors applyCouponToOrder's logic: look up Coupon, verify scope /
  // dates / minOrderValue, recompute discount server-side. A
  // client-supplied couponDiscount is always ignored.
  let authoritativeCouponCode = '';
  let authoritativeCouponDiscount = 0;
  // Coupon redemption requires a customer identity so usage limits +
  // abuse tracking have something to key against. Guest QR-scan
  // diners (no req.user) silently drop any couponCode in the payload
  // — the Cart UI hides the coupon section for them, but a tampered
  // client could still POST one. Staff-placed orders are treated as
  // "on behalf of a known guest" and keep coupon support.
  const isGuestPlacer = !req.user;
  const rawCouponCode = (!isGuestPlacer && typeof req.body.couponCode === 'string')
    ? req.body.couponCode.trim().toUpperCase()
    : '';
  let couponId;
  if (rawCouponCode) {
    const Coupon = require('../models/coupon');
    const coupon = await findCouponInScope(Coupon, req, rawCouponCode, branchId);
    if (!coupon) {
      throw httpError(400, {
        success: false,
        code: 'COUPON_INVALID',
        message: 'Invalid or inactive coupon code.',
      });
    }
    const nowTs = new Date();
    if (coupon.startDate && nowTs < new Date(coupon.startDate)) {
      throw httpError(400, {
        success: false,
        code: 'COUPON_NOT_STARTED',
        message: 'Coupon is not yet active.',
      });
    }
    if (coupon.endDate && nowTs > new Date(coupon.endDate)) {
      throw httpError(400, {
        success: false,
        code: 'COUPON_EXPIRED',
        message: 'Coupon has expired.',
      });
    }
    // Time-of-day window (e.g. a 12:00–15:00 lunch deal) — same rule as
    // the checkout pre-check (promotionController.applyCoupon), which a
    // client can skip by posting straight to POST /orders.
    if (coupon.startTime && coupon.endTime) {
      const currentTime = nowTs.getHours().toString().padStart(2, '0') + ':' + nowTs.getMinutes().toString().padStart(2, '0');
      if (currentTime < coupon.startTime || currentTime > coupon.endTime) {
        throw httpError(400, {
          success: false,
          code: 'COUPON_TIME_WINDOW',
          message: `This coupon is valid only between ${coupon.startTime} and ${coupon.endTime}.`,
        });
      }
    }
    // Per-customer limit (usagePerUser) — counted from the redemption
    // ledger. Re-checked inside the order transaction
    // (orderCreateService.persistOrderDocs) so two concurrent orders
    // can't both slip under the limit.
    const customerId = req.user && req.user.role === 'customer' ? (req.user._id || req.user.id) : null;
    if (customerId && coupon._id && Number(coupon.usagePerUser) > 0) {
      const CouponRedemption = require('../models/couponRedemption');
      const used = await CouponRedemption.countDocuments({ coupon: coupon._id, user: customerId });
      if (used >= coupon.usagePerUser) {
        throw httpError(400, {
          success: false,
          code: 'COUPON_USER_LIMIT',
          message: `You can only use this coupon ${coupon.usagePerUser} time${coupon.usagePerUser > 1 ? 's' : ''}.`,
        });
      }
    }
    if (coupon.minOrderValue && authoritativeSubtotal < coupon.minOrderValue) {
      throw httpError(400, {
        success: false,
        code: 'COUPON_MIN_ORDER',
        message: `Minimum order value of ₹${coupon.minOrderValue} required for this coupon.`,
      });
    }
    // ADM-064 — restrict the discount to the eligible items when the
    // coupon has a scope (food / beverages). The minOrderValue check
    // above still uses the full subtotal because the coupon's threshold
    // is about *qualifying* for the offer, not what gets discounted.
    const { computeCouponDiscount } = require('../utils/couponScope');
    const scopedItems = items.map((it) => {
      const m = menuById.get(String(it.menuItem));
      return {
        // Decision 6 — the category's Food / Drink kind wins over the
        // prep-station fallback (a Coke routed to the counter is a beverage).
        categoryKind: menuCategoryKind(m) || undefined,
        prepStation: (m?.prepStation || 'kitchen'),
        price: Number(it.price) || 0,
        quantity: Number(it.quantity) || 0,
      };
    });
    const { discount, eligibleSubtotal: eligible } = computeCouponDiscount(coupon, scopedItems);
    if (coupon.scope && coupon.scope !== 'all' && eligible <= 0) {
      throw httpError(400, {
        success: false,
        code: 'COUPON_SCOPE_NO_MATCH',
        message: coupon.scope === 'food'
          ? 'This coupon only applies to food items.'
          : 'This coupon only applies to beverages.',
      });
    }
    // shipping_discount / bogo aren't priced at create time (handled elsewhere).
    authoritativeCouponDiscount = Math.min(Math.max(0, discount), authoritativeSubtotal);
    authoritativeCouponCode = coupon.code;
    couponId = coupon._id;
  }
  // couponId pins the exact coupon doc for the in-transaction usage
  // write (codes are only unique per tenant + branch).
  return { authoritativeCouponCode, authoritativeCouponDiscount, couponId };
}

// Server-side loyalty-points validation.
async function resolvePointsRedemption(req, { validUserId, settings, authoritativeSubtotal, authoritativeCouponDiscount }) {
  // ── Server-side loyalty-points validation ───────────────────────
  // pointsRedeemed is clamped to the customer's actual wallet balance
  // and converted to rupees using tenant settings — never the
  // client's claimed value. Guests (no login) can't redeem points.
  let authoritativePointsRedeemed = 0;
  let authoritativePointsValue = 0;                 // rupees the points are worth
  // Whole points only — a fractional request (10.7) would leave a
  // fractional points balance behind.
  const requestedPoints = Math.floor(Number(req.body.pointsRedeemed) || 0);
  if (requestedPoints > 0) {
    if (!req.user || !validUserId) {
      throw httpError(400, {
        success: false,
        code: 'POINTS_REQUIRES_LOGIN',
        message: 'Please log in to redeem loyalty points.',
      });
    }
    const wallet = await Wallet.findOne({
      user: validUserId,
      ...tenantFilter(req),
    }).lean();
    const available = Math.max(0, Math.floor(Number(wallet?.loyaltyPoints) || 0));
    authoritativePointsRedeemed = Math.min(requestedPoints, available);
    const { pointsToRupee } = resolveLoyaltySettings(settings);
    const rate = Number(pointsToRupee) || 0;
    authoritativePointsValue = Math.round(authoritativePointsRedeemed * rate * 100) / 100;
    // Don't let points push the post-coupon bill below zero, nor pay
    // more than the tenant's Settings.wallet.maxRedeemPercent (default
    // 50 %) of the subtotal.
    const rawPct = Number(settings?.wallet?.maxRedeemPercent);
    const maxRedeemPercent = settings?.wallet?.maxRedeemPercent != null && Number.isFinite(rawPct)
      ? Math.min(100, Math.max(0, rawPct))
      : 50;
    const maxRedeemableRupees = Math.max(0, Math.min(
      authoritativeSubtotal - authoritativeCouponDiscount,
      Math.round(authoritativeSubtotal * maxRedeemPercent) / 100,
    ));
    if (authoritativePointsValue > maxRedeemableRupees) {
      authoritativePointsRedeemed = rate > 0
        ? Math.floor((maxRedeemableRupees / rate) + 1e-9)
        : 0;
      authoritativePointsValue = Math.min(
        maxRedeemableRupees,
        Math.round(authoritativePointsRedeemed * rate * 100) / 100,
      );
    }
  }
  return { authoritativePointsRedeemed, authoritativePointsValue };
}

// Wallet rupee payment (split-rail with Razorpay) — balance check only.
async function resolveWalletPayment(req, { validUserId }) {
  // ── Wallet rupee payment (split-rail with Razorpay) ─────────────
  // walletAmountPaid is the rupee portion of a split payment paid
  // from the customer's wallet.balance — NOT a discount. It doesn't
  // reduce serverMinTotal; it just records how much of the bill
  // came from the wallet rail vs. Razorpay.
  //
  // Validate that the customer actually has the balance to cover it
  // BEFORE we save the order. The frontend separately calls
  // walletAPI.payWithWallet to do the deduction; this field is the
  // breakdown record on the order.
  let authoritativeWalletPaid = 0;
  const requestedWalletPaid = Number(req.body.walletAmountPaid) || 0;
  if (requestedWalletPaid > 0) {
    if (!req.user || !validUserId) {
      throw httpError(400, {
        success: false,
        code: 'WALLET_REQUIRES_LOGIN',
        message: 'Please log in to pay with wallet balance.',
      });
    }
    const wallet = await Wallet.findOne({
      user: validUserId,
      ...tenantFilter(req),
    }).lean();
    const available = Math.max(0, Number(wallet?.balance) || 0);
    if (available < requestedWalletPaid) {
      throw httpError(400, {
        success: false,
        code: 'WALLET_INSUFFICIENT',
        message: `Wallet balance of ₹${available.toFixed(2)} is less than the requested ₹${requestedWalletPaid.toFixed(2)}.`,
      });
    }
    authoritativeWalletPaid = Math.round(requestedWalletPaid * 100) / 100;
  }
  return authoritativeWalletPaid;
}

// Final total sanity check (client total vs server minimum).
function checkClientTotal({ total, authoritativeSubtotal, authoritativeCouponDiscount, authoritativePointsValue, authoritativeTip, authoritativeDeliveryFee }) {
  // ── Final total sanity check ────────────────────────────────────
  // serverMinTotal = subtotal - coupon - points + tip + delivery —
  // the bill BEFORE taxes / charges. A client total below it means the
  // cart itself was tampered (or is stale): 400 TOTAL_TAMPERED. The
  // taxes / service charge / additional charges on top of it are
  // enforced afterwards by computeTaxBreakdown (400 TOTAL_MISMATCH).
  const serverMinTotal = Math.round(
    (authoritativeSubtotal - authoritativeCouponDiscount - authoritativePointsValue + authoritativeTip + authoritativeDeliveryFee) * 100
  ) / 100;
  const clientTotal = Number(total);
  if (!Number.isFinite(clientTotal) || clientTotal < serverMinTotal - 1) {
    throw httpError(400, {
      success: false,
      code: 'TOTAL_TAMPERED',
      message: 'Order total does not match the server-calculated price. Please refresh your cart and try again.',
    });
  }
  // Cap absurdly large client totals — a tax ceiling > 100% of
  // subtotal is almost certainly garbage; fall back to the server-
  // computed minimum so we never charge more than the authoritative
  // figure allows.
  const maxReasonableTotal = serverMinTotal + authoritativeSubtotal;
  let authoritativeTotal = clientTotal > maxReasonableTotal
    ? serverMinTotal
    : Math.round(clientTotal * 100) / 100;
  return { serverMinTotal, authoritativeTotal, clientTotal };
}

// Roles whose createOrder calls are staff-placed (POS / admin "Add
// takeaway order"). Mirrors STAFF_CALLER_ROLES in orderCreateService.
const STAFF_CALLER_ROLES = new Set(['waiter', 'captain', 'manager', 'admin', 'superadmin']);

// Authoritative tax & charge breakdown + the enforced order total.
//
// Returns the breakdown to stamp on the order and the total to store:
//   • customer-originated orders (web / QR / kiosk, every order type):
//     the client total may not be more than ₹1 below the server bill
//     (400 TOTAL_MISMATCH). Otherwise the stored total IS the server
//     bill — except kiosk, which collects payment BEFORE the order is
//     created, so it keeps the (≥ server bill − ₹1) amount it charged.
//   • staff-placed orders keep the permissive rule (client total ≥
//     serverMinTotal, takeaway clamped down): staff tools apply ad-hoc
//     discounts client-side (e.g. the admin takeaway modal's Discount).
async function computeTaxBreakdown(req, {
  type, deliveryReq, resolvedSource, authoritativeSubtotal, authoritativeTotal,
  authoritativeCouponDiscount, authoritativePointsValue, authoritativeTip,
  authoritativeDeliveryFee, serverMinTotal, clientTotal,
}) {
  // ── Authoritative tax & charge breakdown ────────────────────────
  // The server computes the tax lines itself rather than taking the
  // browser's word for them:
  //
  //   1. Service charge is suppressed for takeaway / delivery here, on
  //      the server, so no client can bill for table service that was
  //      never rendered — regardless of what the cart sent.
  //   2. The breakdown is STAMPED on the order, so the bill is an
  //      immutable record (an admin editing the GST rate later does
  //      not rewrite historical bills).
  //   3. The total is enforced against it. Until this was tightened,
  //      only takeaway was reconciled (clamped DOWN); a dine-in client
  //      could send subtotal-only as its total and the order stored
  //      that, dropping GST / service charge / additional charges from
  //      the amount due. The frontend computes the same bill with the
  //      mirror Frontend/src/utils/billing.js, so legitimate carts send
  //      exactly the server total.
  let taxBreakdown = {
    gst: 0, gstPercentage: 0,
    serviceCharge: 0, serviceChargePercentage: 0,
    additionalCharges: [], additionalChargesTotal: 0,
  };
  let serverBill;
  try {
    const { computeBill: computeServerBill, toTaxConfig } = require('../utils/billing');
    const taxSettings = await getSettings(req);
    serverBill = computeServerBill({
      subtotal: authoritativeSubtotal,
      taxConfig: toTaxConfig(taxSettings?.taxes),
      orderType: deliveryReq?.requested ? 'delivery' : type,
      // The coupon must go IN (not be subtracted afterwards): GST is
      // levied on the discounted value (subtotal − coupon).
      couponDiscount: authoritativeCouponDiscount,
      pointsRedeemed: authoritativePointsValue,
      tipAmount: authoritativeTip,
      deliveryFee: authoritativeDeliveryFee,
    });
  } catch (err) {
    // Never block an order on a settings read (createOrder has already
    // read the same cached settings once, so this is not expected). A
    // missing breakdown degrades to zeros and the client-bound total.
    logger.warn('Tax breakdown computation failed; storing zeros:', err.message);
    return { taxBreakdown, authoritativeTotal };
  }

  taxBreakdown = {
    gst: serverBill.gst,
    gstPercentage: serverBill.gstPct,
    serviceCharge: serverBill.serviceCharge,
    serviceChargePercentage: serverBill.serviceChargePct,
    additionalCharges: serverBill.additionalCharges,
    additionalChargesTotal: serverBill.additionalChargesTotal,
  };

  // The full server bill: GST on (subtotal − coupon), service and
  // additional charges on the gross subtotal, then coupon and points
  // off, tip and delivery on — all inside utils/billing.computeBill.
  const exactTotal = serverBill.total;

  const isStaffCaller = !!(req.user && STAFF_CALLER_ROLES.has(req.user.role));
  if (isStaffCaller) {
    // Legacy staff semantics: takeaway / delivery have no service
    // charge, so a stale total above the bill is clamped down.
    if (type === 'takeaway' && !serverBill.serviceChargeApplies
      && exactTotal >= serverMinTotal - 1 && authoritativeTotal > exactTotal + 1) {
      logger.warn(`createOrder: ${type} client total ₹${authoritativeTotal} exceeds server bill ₹${exactTotal} — clamping (service charge does not apply)`);
      authoritativeTotal = exactTotal;
    }
    return { taxBreakdown, authoritativeTotal };
  }

  // Compare against what the client actually sent (checkClientTotal
  // caps absurdly large totals down to serverMinTotal, which must not
  // turn an inflated total into a "too low" rejection).
  const sentTotal = Number.isFinite(Number(clientTotal)) ? Number(clientTotal) : authoritativeTotal;
  if (sentTotal < exactTotal - 1) {
    logger.warn(`createOrder: ${type}/${resolvedSource} client total ₹${sentTotal} is below the server bill ₹${exactTotal} — rejecting`);
    throw httpError(400, {
      success: false,
      code: 'TOTAL_MISMATCH',
      message: 'Order total does not match the server-calculated bill (taxes and charges). Please refresh your cart and try again.',
      expectedTotal: exactTotal,
    });
  }

  if (resolvedSource === 'kiosk') {
    // Paid before the order exists — keep what was charged (never
    // below the server bill by more than the ₹1 rounding window).
    return { taxBreakdown, authoritativeTotal: authoritativeTotal >= exactTotal - 1 ? authoritativeTotal : exactTotal };
  }

  if (Math.abs(authoritativeTotal - exactTotal) > 0.009) {
    logger.warn(`createOrder: ${type}/${resolvedSource} client total ₹${authoritativeTotal} differs from server bill ₹${exactTotal} — storing the server bill`);
  }
  return { taxBreakdown, authoritativeTotal: exactTotal };
}

// Enrich items with vegType, category name, prepStation + prep time snapshot.
function enrichCartItems(items, menuById) {
  // Enrich items with vegType, category name, and prepStation snapshot
  // so the chef dashboard can display/filter and the kitchen-bypass
  // logic below has authoritative routing data on each line item.
  //
  // prepStation resolution uses a heuristic fallback so common
  // ready-to-serve items (Red Bull, water, Coke, packaged ice cream)
  // route to the counter even when an admin hasn't explicitly tagged
  // the menu item yet — the schema default 'kitchen' is treated as
  // "unconfigured" and overridden when the name clearly indicates
  // a counter / bar item. See utils/prepStationInfer.js for rules.
  //
  // Display fields come from the canonical MenuItem, never the client:
  // the line name (a client could otherwise print "Lobster Thermidor"
  // on the KOT / bill / invoice at Paneer Tikka's price), the size and
  // topping names (as spelled on the menu doc), category and vegType.
  // A cart line without a `name` is therefore fine.
  const { resolveOrderItemStation } = require('../utils/prepStationInfer');
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const enrichedItems = items.map((item) => {
    const menu = item.menuItem && menuById.get(String(item.menuItem));
    const canonicalName = (menu?.name && String(menu.name)) || (typeof item.name === 'string' ? item.name : '');
    const canonicalCategory = menu?.category?.name || (typeof item.category === 'string' ? item.category : '') || '';
    const resolvedStation = resolveOrderItemStation({
      menuItem: menu,
      fallbackName: canonicalName,
      fallbackCategory: canonicalCategory,
    });
    // Sizes: priceCartItems prices (and validates) only the FIRST
    // selected size, so that is the one recorded — renamed to the menu
    // doc's spelling. Toppings were validated against the menu by
    // validateSelectedToppings; record the canonical name + price.
    let selectedSizes = Array.isArray(item.selectedSizes) ? item.selectedSizes : [];
    if (menu && selectedSizes.length) {
      const first = selectedSizes[0] || {};
      const canonicalSize = (menu.sizes || []).find((sz) => norm(sz.name) === norm(first.name));
      selectedSizes = canonicalSize
        ? [{
          ...(first.id ? { id: String(first.id) } : {}),
          name: canonicalSize.name,
          priceDetails: first.priceDetails,
        }]
        : [];
    }
    let selectedToppings = Array.isArray(item.selectedToppings) ? item.selectedToppings : [];
    if (menu && selectedToppings.length) {
      const byName = new Map((menu.toppings || []).map((t) => [norm(t.name), t]));
      selectedToppings = selectedToppings
        .map((st) => {
          const t = byName.get(norm(st?.name));
          return t ? { ...(st?.id ? { id: String(st.id) } : {}), name: t.name, price: Number(t.price) } : null;
        })
        .filter(Boolean);
    }
    // Snapshot prep time from the menu item so a later edit in Menu
    // Management can't retro-shift this order's chef-queue position.
    // Clamp to the schema range; fall back to the schema default
    // when the menu item is missing or has no value yet.
    const menuPrep = Number(menu?.prepTimeMinutes);
    const prepTimeMinutes = Number.isFinite(menuPrep) && menuPrep >= 0
      ? Math.min(menuPrep, 240)
      : 15;
    return {
      ...item,
      name: canonicalName,
      selectedSizes,
      selectedToppings,
      vegType: menu?.vegType || item.vegType || '',
      category: canonicalCategory,
      // Decision 6 — Food / Drink kind snapshot for coupon scoping.
      categoryKind: menuCategoryKind(menu) || undefined,
      prepStation: resolvedStation,
      prepTimeMinutes,
    };
  });
  return enrichedItems;
}

// Pre-flight stock shortage → the 400 body createOrder / append send.
function insufficientStockBody(stockCheck) {
  const headline = stockCheck.shortages
    .slice(0, 3)
    .map(s => `${s.name} (need ${s.needed} ${s.unit}, have ${s.available} ${s.unit})`)
    .join('; ');
  return {
    success: false,
    code: 'INSUFFICIENT_STOCK',
    message: `Out of stock: ${headline}${stockCheck.shortages.length > 3 ? ` and ${stockCheck.shortages.length - 3} more` : ''}.`,
    shortages: stockCheck.shortages,
  };
}

// Validate + canonically price the items a waiter appends to an order.
// Returns the enriched line items and the bare item delta (no tax).
//
// Same rules as createOrder's priceCartItems: every line must resolve to
// an orderable menu item of this tenant (unknown / foreign / missing id,
// archived or out-of-window item → 400 — never a client-priced line), the
// size price + offer is charged when a size is picked, toppings are
// charged at their menu price, and a line holds at most 999.
function buildAppendItems(items, menuById, branch) {
  const { resolvePrice } = require('../utils/priceResolver');
  const { menuItemUnavailableReason, MAX_LINE_QUANTITY } = require('./orderHelpers');
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  // One timestamp for the whole batch so the chef card groups it.
  const now = new Date();
  let deltaTotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const menu = item.menuItem && menuById.get(String(item.menuItem));
    if (!menu) {
      throw httpError(400, { success: false, code: 'ITEM_NOT_FOUND', message: `Unknown menu item: ${item.name || item.menuItem || '(none)'}` });
    }
    const unavailable = menuItemUnavailableReason(menu, now);
    if (unavailable) {
      throw httpError(400, { success: false, code: 'ITEM_UNAVAILABLE', message: `${menu.name} is ${unavailable}.` });
    }
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    if (qty > MAX_LINE_QUANTITY) {
      throw httpError(400, {
        success: false,
        code: 'QUANTITY_EXCEEDED',
        message: `Quantity ${qty} for "${menu.name}" exceeds the per-item limit.`,
      });
    }
    const unitPrice = canonicalUnitPrice(menu, resolvePrice(menu, branch), item);

    const canonical = new Map((menu.toppings || []).map(t => [norm(t.name), t]));
    const selectedToppings = [];
    if (Array.isArray(item.selectedToppings)) {
      for (const st of item.selectedToppings) {
        const key = norm(st?.name);
        const real = canonical.get(key);
        if (!key || !real) {
          throw httpError(400, { success: false, message: `Invalid topping "${st?.name || ''}" for ${menu.name}` });
        }
        if (!Number.isFinite(Number(st.price)) || Math.abs(Number(st.price) - Number(real.price)) > 0.01) {
          throw httpError(400, { success: false, message: `Topping price mismatch for "${st.name}" on ${menu.name}` });
        }
        selectedToppings.push({ ...(st?.id ? { id: String(st.id) } : {}), name: real.name, price: Number(real.price) });
      }
    }
    const toppingSum = selectedToppings.reduce((sum, t) => sum + t.price, 0);
    deltaTotal += (unitPrice + toppingSum) * qty;

    // Record only the size that was priced (the first), as spelled on
    // the menu doc — mirrors enrichCartItems.
    let selectedSizes = [];
    const firstSize = Array.isArray(item.selectedSizes) && item.selectedSizes.length ? item.selectedSizes[0] : null;
    if (firstSize && firstSize.name) {
      const canonicalSize = (menu.sizes || []).find((sz) => norm(sz.name) === norm(firstSize.name));
      if (canonicalSize) {
        selectedSizes = [{
          ...(firstSize.id ? { id: String(firstSize.id) } : {}),
          name: canonicalSize.name,
          priceDetails: firstSize.priceDetails,
        }];
      }
    }

    const menuPrep = Number(menu.prepTimeMinutes);
    const prepTimeMinutes = Number.isFinite(menuPrep) && menuPrep >= 0
      ? Math.min(menuPrep, 240)
      : 15;
    enrichedItems.push({
      menuItem: item.menuItem,
      // Canonical menu name / category / vegType (never the client's label).
      name: menu.name || '',
      price: unitPrice,
      quantity: qty,
      category: menu.category?.name || item.category || '',
      // Decision 6 — Food / Drink kind snapshot for coupon scoping.
      categoryKind: menuCategoryKind(menu) || undefined,
      vegType: menu.vegType || item.vegType || '',
      selectedToppings,
      selectedSizes,
      instructions: item.instructions || '',
      prepTimeMinutes,
      // Explicit timestamp so the chef card can split the newly-added
      // items from the original order. Every line of one append batch
      // shares the same moment so the batch stays grouped.
      addedAt: now,
    });
  }
  deltaTotal = Math.round(deltaTotal * 100) / 100;
  return { enrichedItems, deltaTotal };
}

/**
 * Apply recomputeBillAfterAppend to a (mongoose) order in place. Call it
 * AFTER the new items were merged into order.items and BEFORE save.
 * Falls back to the old "add the bare item delta" arithmetic if the
 * tenant settings can't be read — an append is never blocked on it.
 */
async function applyAppendToBill(req, order, subtotalBefore, fallbackDelta) {
  try {
    const settings = await getSettings(req);
    const next = recomputeBillAfterAppend({
      bill: order,
      subtotalBefore,
      subtotalAfter: lineItemsSubtotal(order.items),
      taxConfig: toTaxConfig(settings?.taxes),
      orderType: billOrderType(order),
    });
    order.total = next.total;
    order.gst = next.gst;
    order.gstPercentage = next.gstPercentage;
    order.serviceCharge = next.serviceCharge;
    order.serviceChargePercentage = next.serviceChargePercentage;
    order.additionalCharges = next.additionalCharges;
    order.additionalChargesTotal = next.additionalChargesTotal;
  } catch (err) {
    logger.warn('Append bill recompute failed; adding bare item delta:', err.message);
    order.total = Number((order.total + fallbackDelta).toFixed(2));
  }
}

/**
 * Stamp the full bill (GST / service charge / additional charges) on a
 * NEW order built from already-priced line items — used by the repeat
 * flows, which used to store the bare item subtotal as the total.
 * Falls back to the bare subtotal if tenant settings can't be read.
 *
 * `bareSiblingSubtotal` — mixed kitchen + counter repeat: the counter
 * items went to their own doc at their bare subtotal (like createOrder's
 * split), so this doc carries the tax lines of the WHOLE repeat and its
 * total is the full bill minus that bare counter amount. The two docs
 * then sum to exactly the bill of the combined cart.
 */
async function applyNewOrderBill(req, order, { bareSiblingSubtotal = 0 } = {}) {
  const extra = Math.max(0, Number(bareSiblingSubtotal) || 0);
  const subtotal = lineItemsSubtotal(order.items) + extra;
  try {
    const settings = await getSettings(req);
    const next = billFieldsForNewOrder({
      subtotal,
      taxConfig: toTaxConfig(settings?.taxes),
      orderType: billOrderType(order),
    });
    order.total = round2(next.total - extra);
    order.gst = next.gst;
    order.gstPercentage = next.gstPercentage;
    order.serviceCharge = next.serviceCharge;
    order.serviceChargePercentage = next.serviceChargePercentage;
    order.additionalCharges = next.additionalCharges;
    order.additionalChargesTotal = next.additionalChargesTotal;
  } catch (err) {
    logger.warn('New-order bill compute failed; using bare subtotal:', err.message);
    order.total = round2(subtotal - extra);
  }
}

module.exports = {
  validateSelectedToppings,
  priceCartItems,
  resolveDeliveryFee,
  resolveCartCoupon,
  resolvePointsRedemption,
  resolveWalletPayment,
  checkClientTotal,
  computeTaxBreakdown,
  enrichCartItems,
  insufficientStockBody,
  buildAppendItems,
  recomputeBillAfterAppend,
  applyAppendToBill,
  applyNewOrderBill,
  billOrderType,
};
