const Promotion = require('../models/promotion');
const Coupon = require('../models/coupon');
const CouponRedemption = require('../models/couponRedemption');
const Order = require('../models/order');
const User = require('../models/user');
const Wallet = require('../models/wallet');
const MenuItem = require('../models/menuItem');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId, branchScopeClause } = require('../utils/tenantScope');
const { mergedBranchFilter, mergedCustomerBranchFilter, getMainBranchId } = require('../utils/mainBranch');
const { computeCouponDiscount, withCategoryKinds, menuCategoryKind } = require('../utils/couponScope');
const { devError } = require('../utils/AppError');
const { pickAllowed, toPositiveAmount, COUPON_FIELDS, PROMOTION_FIELDS } = require('../utils/bodyAllowlist');
const { resolveOwnedBranch } = require('../utils/branchOwnership');
const { APP_TIMEZONE } = require('../utils/pickupTime');

// ms offset of `timezone` from UTC at instant `date` (east of UTC = +).
const getTimezoneOffsetMs = (timezone, date) => {
    const p = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).reduce((acc, x) => { if (x.type !== 'literal') acc[x.type] = Number(x.value); return acc; }, {});
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
};

// Branch-scope helper for customer-facing promotion / coupon reads.
//
// `mergedCustomerBranchFilter` returns either `{}` (no branch filter)
// or `{ branch: <selected> }` / `{ branch: { $in: [selected, main] } }`
// for branch-scoped callers. That last shape EXCLUDES `branch: null`
// docs — i.e. tenant-level coupons created without an explicit branch.
//
// In practice that means an admin-created "WELCOME10" coupon stored at
// the tenant level is invisible to every customer, which is what the
// "Apply Coupon — no coupons available" report was about. Customers
// SHOULD see tenant-level (shared) coupons in addition to their branch
// + main-branch coupons. Mirror the MenuItem read pattern by widening
// the filter with an `$or` that also matches `branch: null`.
//
// Returns `{}` (no filter — all tenant docs) when the customer is not
// branch-scoped, otherwise an `$or` over [null, ...resolved branches].
const customerBranchFilter = async (req) => {
    const mongoose = require('mongoose');
    // Branch-pinned staff (Branch Admin) get a STRICT filter — they see
    // only their own branch's promotions/coupons. No Main-branch
    // inheritance, no tenant-level (branch:null) leak. Sharing happens
    // explicitly at branch-create via "Copy from Main".
    const pinned = pinnedBranchId(req);
    if (pinned) return branchScopeClause(req, pinned._id || pinned);

    // Tenant owner via admin switcher: `?branch=<id>` narrows STRICTLY
    // to that branch (no null fallback). Without this, switching to
    // "FC Road" in the dropdown still showed every legacy tenant-null
    // promotion — exactly the "promotions 10 in FC Road" leak the user
    // flagged on 2026-05-20. This check runs BEFORE the
    // mergedCustomerBranchFilter because customer flow goes through
    // req.branch (X-Branch-Id header), not the query string, so the two
    // paths never collide.
    const raw = req?.query?.branch;
    if (raw === 'all') return {};
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    if (raw && mongoose.isValidObjectId(raw)) return branchScopeClause(req, raw);

    const merged = await mergedCustomerBranchFilter(req);
    if (!merged || Object.keys(merged).length === 0) return {};
    // merged is either { branch: id } or { branch: { $in: [...] } }.
    // Widen so tenant-level (branch:null) docs come through too for
    // customer-facing flows (guest at a QR-scanned branch sees seeded
    // tenant offers).
    if (merged.branch && typeof merged.branch === 'object' && Array.isArray(merged.branch.$in)) {
        return { branch: { $in: [null, ...merged.branch.$in] } };
    }
    return { branch: { $in: [null, merged.branch] } };
};

// Strict per-tenant branch filter for admin reads (Coupons admin list,
// performance stats, redemptions). Pinned staff see ONLY their branch;
// tenant owners default to everything in the tenant, but honor a
// `?branch=<id>` from the admin switcher so flipping to "Main" in the
// header narrows the view instead of leaking every branch's offers.
const adminBranchFilter = (req) => {
    const mongoose = require('mongoose');
    const pinned = pinnedBranchId(req);
    if (pinned) return branchScopeClause(req, pinned._id || pinned);
    const raw = req?.query?.branch;
    if (raw === 'all') return {};
    if (raw === 'tenant-only' || raw === 'none') return { branch: null };
    // Cast to an ObjectId (not a raw string) so this filter works inside
    // aggregation `$match` stages too. Mongoose auto-casts strings for
    // `.find()` but NOT for `.aggregate()` — a raw-string branch silently
    // matched zero rows in getPerformanceStats (the only aggregate-based
    // offer endpoint), so the Analyze view showed empty/zero data whenever
    // an admin scoped to a specific branch (e.g. "Main") via the switcher,
    // while the coupon list + redemption table (both `.find()`) looked fine.
    // Mirrors strictBranchFilter() in utils/tenantScope.js.
    if (raw && mongoose.isValidObjectId(raw)) return branchScopeClause(req, raw);
    return {};
};

// @desc    Get all active promotions (banners/offers)
// @route   GET /api/promotions
// @access  Public
exports.getActivePromotions = async (req, res) => {
    try {
        const now = new Date();
        const promotions = await Promotion.find({
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
            ...tenantFilter(req),
            ...(await customerBranchFilter(req)),
        }).sort({ displayOrder: 1, createdAt: -1 });

        res.status(200).json({
            success: true,
            count: promotions.length,
            promotions
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching promotions', ...devError(error) });
    }
};

// @desc    Get all active coupons
// @route   GET /api/promotions/coupons/active
// @access  Public
exports.getActiveCoupons = async (req, res) => {
    try {
        const now = new Date();
        const coupons = await Coupon.find({
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
            ...tenantFilter(req),
            ...(await customerBranchFilter(req)),
        }).sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            count: coupons.length,
            coupons
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching coupons', ...devError(error) });
    }
};

// @desc    Validate and Apply Coupon
// @route   POST /api/promotions/apply-coupon
// @access  Private
exports.applyCoupon = async (req, res) => {
    try {
        // ADM-064 — accept an optional items[] array so we can compute
        // the eligible subtotal for scope='food' / 'beverages' coupons.
        // Legacy clients that only send orderValue still work — we
        // synthesize a single pseudo-item from it (scope='all' coupons
        // are unaffected; scoped coupons fall back to "matches every item"
        // until the client upgrades).
        const { code, items } = req.body;
        const userId = req.user?._id;

        if (!code) {
            return res.status(400).json({ success: false, message: 'Please provide a coupon code' });
        }
        // Coerce once: a numeric string ("499") used to flow through as a
        // string (string comparisons against minOrderValue, string
        // pseudo-item price); NaN / Infinity slipped past `<= 0`.
        const orderValue = toPositiveAmount(req.body.orderValue);
        if (orderValue === null) {
            return res.status(400).json({ success: false, message: 'Invalid order value' });
        }

        const coupon = await Coupon.findOne({
            code: code.toUpperCase(),
            isActive: true,
            ...tenantFilter(req),
            ...(await customerBranchFilter(req)),
        });

        if (!coupon) {
            return res.status(404).json({ success: false, message: 'Invalid or inactive coupon code' });
        }

        // Date validity
        const now = new Date();
        if (now < coupon.startDate || now > coupon.endDate) {
            return res.status(400).json({ success: false, message: 'Coupon code has expired' });
        }

        // Time-of-day validation (startTime/endTime)
        if (coupon.startTime && coupon.endTime) {
            const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
            if (currentTime < coupon.startTime || currentTime > coupon.endTime) {
                return res.status(400).json({
                    success: false,
                    message: `This coupon is valid only between ${coupon.startTime} and ${coupon.endTime}`
                });
            }
        }

        // Global usage limit — read-only check. The actual increment +
        // CouponRedemption record happen in orderController.createOrder
        // when the customer ACTUALLY places the order. Doing those writes
        // here used to over-count: every cart abandonment was recorded as
        // a redemption, the global usageCount climbed past real usage,
        // and per-user limits triggered early because the previous
        // attempt's "redemption" was still on file.
        if (coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) {
            return res.status(400).json({ success: false, message: 'Coupon usage limit has been reached' });
        }

        // Per-user usage limit — also read-only here.
        if (userId && coupon.usagePerUser > 0) {
            const userRedemptions = await CouponRedemption.countDocuments({ coupon: coupon._id, user: userId });
            if (userRedemptions >= coupon.usagePerUser) {
                return res.status(400).json({
                    success: false,
                    message: `You can only use this coupon ${coupon.usagePerUser} time${coupon.usagePerUser > 1 ? 's' : ''}`
                });
            }
        }

        // Minimum order check
        if (orderValue < coupon.minOrderValue) {
            return res.status(400).json({
                success: false,
                message: `Minimum order value of ₹${coupon.minOrderValue} required for this coupon`
            });
        }

        // ADM-064 — discount is computed against the items[] slice that
        // matches the coupon's scope ('all' / 'food' / 'beverages'). When
        // the client didn't send items, fall back to a synthetic single
        // pseudo-item carrying the orderValue — scope='all' coupons
        // produce the same answer as before; scoped coupons can't be
        // evaluated correctly without the item breakdown, so they
        // refuse rather than silently over-discount.
        //
        // Decision 6 — each pseudo-item carries the category kind (Food /
        // Drink) the admin set on the menu category. Lines that send a
        // `menuItem` id are resolved against this tenant's menu (the
        // authoritative kind); otherwise a client-sent categoryKind is
        // used (this endpoint is a preview — order create re-prices
        // server-side), else classifyItem falls back to prepStation.
        let discountItems = Array.isArray(items) && items.length > 0
            ? items.map(i => ({
                menuItem: (i && typeof i.menuItem === 'string') ? i.menuItem : undefined,
                categoryKind: i?.categoryKind,
                prepStation: i?.prepStation || 'kitchen',
                price: Number(i?.price) || 0,
                quantity: Number(i?.quantity) || 0,
              }))
            : null;
        if (discountItems && coupon.scope && coupon.scope !== 'all') {
            const mongoose = require('mongoose');
            const ids = [...new Set(discountItems.map(i => i.menuItem).filter(id => id && mongoose.isValidObjectId(id)))];
            const menuById = new Map();
            if (ids.length) {
                const menus = await MenuItem.find({ _id: { $in: ids.slice(0, 500) }, ...tenantFilter(req) })
                    .select('category').populate('category', 'kind').lean();
                for (const m of menus) menuById.set(String(m._id), m);
            }
            // A resolvable menu item overrides whatever kind the client sent.
            discountItems = withCategoryKinds(
                discountItems.map(i => (menuCategoryKind(menuById.get(String(i.menuItem))) ? { ...i, categoryKind: undefined } : i)),
                menuById,
            );
        }
        if (!discountItems && coupon.scope && coupon.scope !== 'all') {
            return res.status(400).json({
                success: false,
                code: 'COUPON_NEEDS_ITEMS',
                message: 'This coupon applies to specific item types — please refresh your cart and try again.',
            });
        }
        if (!discountItems) {
            discountItems = [{ prepStation: 'kitchen', price: orderValue, quantity: 1 }];
        }
        const { discount, eligibleSubtotal } = computeCouponDiscount(coupon, discountItems);
        if (coupon.scope && coupon.scope !== 'all' && eligibleSubtotal <= 0) {
            return res.status(400).json({
                success: false,
                code: 'COUPON_SCOPE_NO_MATCH',
                message: coupon.scope === 'food'
                    ? 'This coupon only applies to food items, none of which are in your cart.'
                    : 'This coupon only applies to beverages, none of which are in your cart.',
            });
        }
        const finalDiscount = Math.min(discount, orderValue);

        res.status(200).json({
            success: true,
            message: 'Coupon applied successfully',
            discount: finalDiscount,
            eligibleSubtotal,
            scope: coupon.scope || 'all',
            coupon: {
                code: coupon.code,
                title: coupon.title,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                scope: coupon.scope || 'all',
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Error applying coupon', ...devError(error) });
    }
};

// @desc    Get Customer CRM Dashboard (Loyalty & History)
// @route   GET /api/crm/customer/:userId
// @access  Private
exports.getCustomerCRM = async (req, res) => {
    try {
        const { userId } = req.params;

        // Wallet + orders restricted to this tenant only.
        const tf = tenantFilter(req);
        const wallet = await Wallet.findOne({ user: userId, ...tf });
        const orders = await Order.find({ user: userId, ...tf }).sort({ createdAt: -1 });

        // The User model is not tenant-scoped, so only reveal the identity
        // of CUSTOMERS with activity (wallet / orders) in the caller's
        // tenant — never another tenant's users or any staff account.
        const user = (wallet || orders.length)
            // AUDIT-EXEMPT: users are platform-wide; reached only after a tenant-scoped wallet/order match
            ? await User.findOne({ _id: userId, role: 'customer' }).select('name email')
            : null;
        if (!user) {
            return res.status(404).json({ success: false, message: 'Customer not found' });
        }
        
        // Calculate insights
        const totalSpent = orders.reduce((acc, o) => acc + (o.total || 0), 0);
        const visitCount = orders.length;

        res.status(200).json({
            success: true,
            customer: {
                id: user._id,
                name: user.name,
                email: user.email,
                points: wallet ? wallet.loyaltyPoints : 0,
                balance: wallet ? wallet.balance : 0,
                totalSpent,
                visitCount,
                history: orders.slice(0, 5) // Recent 5 orders
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching CRM data', ...devError(error) });
    }
};

// @desc    Admin: Create Promotion
// @route   POST /api/promotions
// @access  Admin
exports.createPromotion = async (req, res) => {
    try {
        const { startDate, endDate, title } = req.body || {};

        // Sanity guards — same shape as Coupon. A banner ending before
        // it starts will never show on the customer-facing storefront,
        // and an empty title makes the admin list unreadable.
        if (!title || !String(title).trim()) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
            return res.status(400).json({ success: false, message: 'Start date must be before end date' });
        }

        // Sub Admin owns the promotion at their branch. Tenant owner
        // without an explicit body.branch: default to the MAIN branch
        // so sub-branches inherit it. Owner can still pass body.branch
        // to pin a promotion to a specific branch.
        // body.branch must belong to this tenant (and be the caller's own
        // branch when pinned).
        const branchCheck = await resolveOwnedBranch(req, req.body.branch);
        if (!branchCheck.ok) {
            return res.status(branchCheck.status).json({ success: false, ...(branchCheck.code && { code: branchCheck.code }), message: branchCheck.message });
        }
        let ownerBranch = branchCheck.branchId;
        if (!ownerBranch) ownerBranch = await getMainBranchId(req);
        const promotion = await Promotion.create({
            ...pickAllowed(req.body, PROMOTION_FIELDS),
            restaurant: tenantId(req),
            branch: ownerBranch,
        });
        res.status(201).json({ success: true, promotion });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// Shared coupon-body validator — runs on both create and update so a
// future commit can't sneak past sanity rules by editing a coupon
// instead of creating one. Returns the first failure string or null.
function validateCouponBody(body) {
    const {
        startDate, endDate,
        startTime, endTime,
        discountType, discountValue,
        usageLimit, usagePerUser,
        minOrderValue, maxDiscountAmount,
    } = body || {};

    if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
        return 'Start date must be before end date';
    }
    if (startTime && endTime && String(startTime) >= String(endTime)) {
        return 'Start time must be before end time';
    }
    // Must mirror the enum on the Coupon model — historically this list
    // was `['percentage','flat','amount']` which silently rejected every
    // `fixed_amount` payload the frontend sends, breaking create/update.
    if (discountType !== undefined && !['percentage', 'fixed_amount', 'shipping_discount', 'bogo'].includes(discountType)) {
        return 'Discount type must be "percentage" or "fixed_amount"';
    }
    if (discountValue !== undefined) {
        if (typeof discountValue !== 'number' || discountValue <= 0) {
            return 'Discount value must be greater than 0';
        }
        if (discountType === 'percentage' && discountValue > 100) {
            return 'Percentage discount cannot exceed 100';
        }
    }
    if (usageLimit !== undefined && usageLimit !== null && usageLimit < 0) {
        return 'Usage limit cannot be negative';
    }
    if (usagePerUser !== undefined && usagePerUser !== null && usagePerUser < 0) {
        return 'Usage per user cannot be negative';
    }
    if (minOrderValue !== undefined && minOrderValue !== null && minOrderValue < 0) {
        return 'Minimum order value cannot be negative';
    }
    // `maxDiscountAmount === 0` is the frontend's sentinel for "no cap"
    // (`parseFloat(form.maxDiscount) || 0`). Only reject *negative* values.
    if (maxDiscountAmount !== undefined && maxDiscountAmount !== null && maxDiscountAmount < 0) {
        return 'Max discount cap cannot be negative';
    }
    // Nonsense check — percentage coupon with a max cap below 1% of the
    // min order. Staff probably swapped the two fields. Skip when the cap
    // is 0 (means "no cap" — see the sentinel comment above).
    if (discountType === 'percentage'
        && typeof discountValue === 'number'
        && typeof minOrderValue === 'number'
        && typeof maxDiscountAmount === 'number'
        && maxDiscountAmount > 0
        && minOrderValue > 0
        && maxDiscountAmount < (minOrderValue * discountValue) / 100 / 10) {
        return 'Max discount cap looks too low for this discount %. Check the values.';
    }
    return null;
}

// @desc    Admin: Create Coupon
// @route   POST /api/promotions/coupons
// @access  Admin
exports.createCoupon = async (req, res) => {
    try {
        const { code } = req.body;

        // Shared validation — keeps create and update behaviourally
        // identical so a sane coupon can't be turned insane by an edit.
        const err = validateCouponBody(req.body);
        if (err) return res.status(400).json({ success: false, message: err });

        // A Sub Admin creating a coupon always owns it at their branch.
        // A tenant owner without an explicit body.branch defaults to the
        // MAIN branch so sub-branches inherit the coupon. Owner can
        // still pass body.branch to pin a coupon to a specific branch.
        const branchCheck = await resolveOwnedBranch(req, req.body.branch);
        if (!branchCheck.ok) {
            return res.status(branchCheck.status).json({ success: false, ...(branchCheck.code && { code: branchCheck.code }), message: branchCheck.message });
        }
        let ownerBranch = branchCheck.branchId;
        if (!ownerBranch) ownerBranch = await getMainBranchId(req);

        // Check for duplicate code within the same tenant + branch scope.
        // Branch A and Branch B can both have "WELCOME10".
        if (code) {
            const existing = await Coupon.findOne({
                code: code.toUpperCase(),
                ...tenantFilter(req),
                branch: ownerBranch,
            });
            if (existing) {
                return res.status(409).json({ success: false, message: 'A coupon with this code already exists' });
            }
        }

        // Allowlist — usageCount (server counter), targetUsers (no UI sets
        // it) and restaurant are never taken from the body.
        const coupon = await Coupon.create({
            ...pickAllowed(req.body, COUPON_FIELDS),
            restaurant: tenantId(req),
            branch: ownerBranch,
        });
        res.status(201).json({ success: true, coupon });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Admin: Get all coupons (no date filter)
// @route   GET /api/promotions/coupons
// @access  Admin
exports.getAllCoupons = async (req, res) => {
    try {
        // Branch Admins see ONLY their branch's coupons — Main-branch
        // inheritance is gone (was a leak per user report). Sharing is
        // explicit at branch-create. Tenant owner still sees everything.
        const coupons = await Coupon.find({
            ...tenantFilter(req),
            ...adminBranchFilter(req),
        }).sort({ createdAt: -1 });
        res.status(200).json({ success: true, coupons });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching coupons', ...devError(error) });
    }
};

// @desc    Admin: Update a coupon
// @route   PUT /api/promotions/coupons/:id
// @access  Admin
exports.updateCoupon = async (req, res) => {
    try {
        // Same sanity rules as createCoupon — see validateCouponBody.
        const err = validateCouponBody(req.body);
        if (err) return res.status(400).json({ success: false, message: err });

        const filter = { _id: req.params.id, ...tenantFilter(req), ...strictBranchFilter(req) };
        const updateData = pickAllowed(req.body, COUPON_FIELDS);

        // Re-validate against the MERGED coupon (stored + incoming): a body
        // of only { discountValue: 150 } on a percentage coupon, or only an
        // endDate before the stored startDate, must be refused too.
        const stored = await Coupon.findOne(filter).lean();
        if (!stored) return res.status(404).json({ success: false, message: 'Coupon not found' });
        const mergedErr = validateCouponBody({ ...stored, ...updateData });
        if (mergedErr) return res.status(400).json({ success: false, message: mergedErr });

        if (Object.prototype.hasOwnProperty.call(updateData, 'branch')) {
            // Tenant owner: the new branch must belong to this tenant.
            // Sub Admin: cannot re-assign a coupon to another branch (a
            // different id is refused; own / empty is a no-op).
            const branchCheck = await resolveOwnedBranch(req, updateData.branch);
            if (!branchCheck.ok) {
                return res.status(branchCheck.status).json({ success: false, ...(branchCheck.code && { code: branchCheck.code }), message: branchCheck.message });
            }
            if (pinnedBranchId(req)) delete updateData.branch;
            else updateData.branch = branchCheck.branchId;
        }
        // AUDIT-EXEMPT: `filter` is the tenant/branch-scoped coupon filter used for the findOne above
        const coupon = await Coupon.findOneAndUpdate(
            filter,
            updateData,
            { returnDocument: 'after', runValidators: true }
        );
        if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
        res.status(200).json({ success: true, coupon });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// @desc    Admin: Delete a coupon
// @route   DELETE /api/promotions/coupons/:id
// @access  Admin
exports.deleteCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findOneAndDelete({
            _id: req.params.id,
            ...tenantFilter(req),
            ...strictBranchFilter(req),
        });
        if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
        res.status(200).json({ success: true, message: 'Coupon deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Admin: Get offer performance analytics
// @route   GET /api/promotions/coupons/performance
// @access  Admin
exports.getPerformanceStats = async (req, res) => {
    try {
        const { filter = 'week' } = req.query;

        // Determine date range. Day boundaries, bucket keys/labels and the
        // $dateToString grouping below all use ONE basis — the tenant
        // timezone (APP_TIMEZONE, IST by default) — so a redemption at
        // 06:00 IST lands in "today" whatever the server's own TZ is.
        const dayCount = filter === 'today' ? 1 : filter === 'month' ? 30 : 7;
        const todayKey = new Intl.DateTimeFormat('en-CA', {
            timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const [ty, tm, td] = todayKey.split('-').map(Number);
        // dayUTC(i) = the calendar date of bucket i as a UTC-midnight Date
        // (used only for its Y-M-D / weekday, never as an instant).
        const dayUTC = (i) => new Date(Date.UTC(ty, tm - 1, td - (dayCount - 1) + i));
        const firstDay = dayUTC(0);
        // Instant of local midnight of the first bucket in APP_TIMEZONE.
        const startDate = new Date(firstDay.getTime() - getTimezoneOffsetMs(APP_TIMEZONE, firstDay));
        const dayFmt = { format: '%Y-%m-%d', date: '$createdAt', timezone: APP_TIMEZONE };

        const tf = tenantFilter(req);
        // Strict per-branch analytics — Branch Admin sees only their
        // branch's redemptions. Cross-branch / Main inheritance was a
        // leak per user report.
        const bf = adminBranchFilter(req);

        // Aggregate daily redemption counts and savings (per-tenant, per-branch)
        const dailyAgg = await CouponRedemption.aggregate([
            { $match: { createdAt: { $gte: startDate }, ...tf, ...bf } },
            {
                $group: {
                    _id: { $dateToString: dayFmt },
                    count: { $sum: 1 },
                    savings: { $sum: '$discountAmount' },
                    avgOrderValue: { $avg: '$orderValue' }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Top coupons in period (per-tenant, per-branch)
        const topCouponsAgg = await CouponRedemption.aggregate([
            { $match: { createdAt: { $gte: startDate }, ...tf, ...bf } },
            {
                $group: {
                    _id: '$coupon',
                    code: { $first: '$couponCode' },
                    title: { $first: '$couponTitle' },
                    count: { $sum: 1 },
                    savings: { $sum: '$discountAmount' }
                }
            },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]);

        // Build full date range (fill gaps with zeros)
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const aggMap = {};
        for (const row of dailyAgg) aggMap[row._id] = row;

        const daily = [];
        for (let i = 0; i < dayCount; i++) {
            const d = dayUTC(i);
            const key = d.toISOString().split('T')[0];
            const row = aggMap[key];
            daily.push({
                date: key,
                label: filter === 'month' ? `${d.getUTCDate()}/${d.getUTCMonth() + 1}` : dayNames[d.getUTCDay()],
                count: row ? row.count : 0,
                savings: row ? row.savings : 0
            });
        }

        // Summary
        const totalRedemptions = daily.reduce((s, d) => s + d.count, 0);
        const totalSavings = daily.reduce((s, d) => s + d.savings, 0);

        // Active coupons in scope (drives the "Active Coupons" stat).
        const activeCoupons = await Coupon.find({ isActive: true, ...tf, ...bf });

        // Conversion rate = the share of real orders that actually applied
        // an offer. Numerator = coupon redemptions (one per order that used
        // a coupon); denominator = orders placed in the same window/branch
        // (cancelled excluded). This replaces TWO older, broken formulas:
        //   • the summary card divided redemptions by the admin-set usage
        //     CAP (1000–5000), so it always read ~0% even with real usage;
        //   • the daily chart divided redemptions by the active-coupon
        //     COUNT, peaking at ~33% — so the card and the chart contradicted
        //     each other. Both now share this single, meaningful basis.
        const orderAgg = await Order.aggregate([
            // Held pay-first orders ('awaiting-payment') aren't placed orders yet.
            { $match: { ...tf, ...bf, createdAt: { $gte: startDate }, status: { $nin: ['cancelled', 'awaiting-payment'] } } },
            { $group: { _id: { $dateToString: dayFmt }, count: { $sum: 1 } } }
        ]);
        const orderMap = {};
        for (const row of orderAgg) orderMap[row._id] = row.count;
        const totalOrders = orderAgg.reduce((s, r) => s + r.count, 0);

        // Clamp to 100% — a redeemed order that was later cancelled could
        // otherwise push a single day above its order count.
        const pct = (num, den) => (den > 0 ? Math.min(100, parseFloat(((num / den) * 100).toFixed(1))) : 0);
        const conversionRate = pct(totalRedemptions, totalOrders);

        // Per-day conversion: that day's redemptions / that day's orders.
        const dailyWithConversion = daily.map(d => ({
            ...d,
            orders: orderMap[d.date] || 0,
            conversionRate: pct(d.count, orderMap[d.date] || 0)
        }));

        res.status(200).json({
            success: true,
            summary: {
                totalRedemptions,
                totalSavings,
                conversionRate,
                totalOrders,
                activeCoupons: activeCoupons.length
            },
            daily: dailyWithConversion,
            topCoupons: topCouponsAgg
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching performance stats', ...devError(error) });
    }
};

// @desc    Admin: Get coupon redemption history
// @route   GET /api/promotions/coupons/redemptions
// @access  Admin
exports.getRedemptions = async (req, res) => {
    try {
        const { filter = '', couponId = '' } = req.query;
        // Clamp paging: page >= 1, 1 <= limit <= 100 (page=0 used to reach
        // Mongo as a negative skip → 500).
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (page - 1) * limit;
        if (couponId && !require('mongoose').isValidObjectId(couponId)) {
            return res.status(400).json({ success: false, message: 'Invalid coupon id' });
        }

        const query = { ...tenantFilter(req), ...adminBranchFilter(req) };

        // Date filter
        const now = new Date();
        if (filter === 'today') {
            const start = new Date(now); start.setHours(0, 0, 0, 0);
            query.createdAt = { $gte: start };
        } else if (filter === 'week') {
            const start = new Date(now); start.setDate(start.getDate() - 7);
            query.createdAt = { $gte: start };
        } else if (filter === 'month') {
            const start = new Date(now); start.setMonth(start.getMonth() - 1);
            query.createdAt = { $gte: start };
        }

        // Coupon filter
        if (couponId) {
            query.coupon = couponId;
        }

        const [redemptions, total] = await Promise.all([
            CouponRedemption.find(query)
                .populate('user', 'name email staffId')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            CouponRedemption.countDocuments(query)
        ]);

        res.status(200).json({
            success: true,
            redemptions,
            total,
            page,
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching redemptions', ...devError(error) });
    }
};
