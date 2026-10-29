const mongoose = require('mongoose');
const User = require('../models/user');
const Order = require('../models/order');
const Wallet = require('../models/wallet');
const AdvanceBooking = require('../models/advanceBooking');
const Reservation = require('../models/reservation');
const logger = require('../utils/logger');

const { tenantFilter, pinnedBranchId, strictBranchFilter } = require('../utils/tenantScope');
const { devError } = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// Tag assignment — centralized so rules are consistent everywhere
const assignTag = (orderCount, totalSpent) => {
    if (orderCount >= 10 || totalSpent >= 20000) return 'VIP';
    if (orderCount >= 3 || totalSpent >= 5000) return 'Regular';
    return 'New';
};

// @desc    Admin: Get all customers with stats
// @route   GET /api/crm/customers
// @access  Admin
exports.getAllCustomers = asyncHandler(async (req, res) => {
    const restaurantId = req.restaurant?._id || null;
    const tenantMatch = restaurantId ? { restaurant: restaurantId } : {};

    // Branch-aware Order filter: a Branch Admin's CRM shows ONLY
    // customers who have ordered at THEIR branch. Main-branch
    // inheritance was removed per user report ("CRM leak") — chain
    // regulars now appear only in the branches they actually visit.
    // User docs themselves are tenant-level; visibility is decided
    // by where their orders exist.
    const branchMatch = strictBranchFilter(req);
    const orderScopeMatch = { ...tenantMatch, ...branchMatch };
    const isPinned = !!pinnedBranchId(req);

    // Aggregation pipeline — lookups are filtered by tenant + branch.
    const [customerData, guestOrders, todayNewCount] = await Promise.all([
        // Customers (User) are platform-global; the orders/wallet $lookups
        // below are tenant(+branch)-scoped and the post-lookup $match
        // drops customers with no activity in this tenant.
        // AUDIT-EXEMPT: global User collection, tenant-scoped via $lookup
        User.aggregate([
            { $match: { role: 'customer' } },
            { $sort: { createdAt: -1 } },
            // Lookup orders per customer (scoped to tenant + branch)
            // AUDIT-EXEMPT: sub-pipeline $match spreads orderScopeMatch (tenant + branch)
            { $lookup: {
                from: 'orders',
                let: { uid: '$_id' },
                pipeline: [
                    { $match: { $expr: { $eq: ['$user', '$$uid'] }, ...orderScopeMatch } }
                ],
                as: 'orders'
            }},
            // Lookup wallet per customer (tenant-scoped; wallet is not
            // branch-scoped — it's a tenant-level balance for the user).
            // AUDIT-EXEMPT: sub-pipeline $match spreads tenantMatch (restaurant)
            { $lookup: {
                from: 'wallets',
                let: { uid: '$_id' },
                pipeline: [
                    { $match: { $expr: { $eq: ['$user', '$$uid'] }, ...tenantMatch } }
                ],
                as: 'wallet'
            }},
            { $addFields: {
                wallet: { $arrayElemAt: ['$wallet', 0] },
                orderCount: { $size: '$orders' },
                // Lifetime value counts real orders only: not cancelled, and not a
                // pay-first order still held until paid ('awaiting-payment').
                totalSpent: { $sum: { $map: {
                    input: '$orders',
                    as: 'o',
                    in: { $cond: [{ $in: ['$$o.status', ['cancelled', 'awaiting-payment']] }, 0, { $ifNull: ['$$o.total', 0] }] },
                } } },
                lastOrderDate: { $max: '$orders.createdAt' },
            }},
            // Visibility: a Sub Admin only sees customers who have
            // ordered at their branch. Tenant owner sees anyone with
            // activity (order or wallet) in the tenant.
            { $match: isPinned
                ? { orderCount: { $gt: 0 } }
                : { $or: [{ orderCount: { $gt: 0 } }, { wallet: { $ne: null } }] }
            },
            { $project: {
                password: 0,
                'orders.items': 0, // Don't send full item arrays to list view
            }}
        ]),
        Order.countDocuments({ user: null, ...orderScopeMatch }),
        // "New this week" — last 7 days rolling. For pinned admins
        // we approximate by customers whose FIRST order at this
        // branch landed within the window. For tenant owner, count
        // customers who joined in the same window.
        (() => {
            const weekAgo = new Date();
            weekAgo.setHours(0, 0, 0, 0);
            weekAgo.setDate(weekAgo.getDate() - 7);
            return isPinned
                ? Order.distinct('user', {
                      ...orderScopeMatch,
                      createdAt: { $gte: weekAgo }
                  }).then(ids => ids.filter(Boolean).length)
                // #30 — was a platform-wide count of every new customer.
                // Restrict to customers with activity (order or wallet)
                // in THIS tenant, matching the list's visibility rule.
                : Promise.all([
                      Order.distinct('user', { ...orderScopeMatch }),
                      Wallet.distinct('user', { ...tenantMatch }),
                  ]).then(([orderUsers, walletUsers]) =>
                      // AUDIT-EXEMPT: User is global; the _id set comes from the tenant-scoped distincts above
                      User.countDocuments({
                          role: 'customer',
                          createdAt: { $gte: weekAgo },
                          _id: { $in: [...orderUsers, ...walletUsers].filter(Boolean) },
                      }));
        })()
    ]);

    const customers = customerData.map(c => ({
        id: c._id,
        name: c.name,
        email: c.email,
        phone: c.mobile || 'N/A',
        visitCount: c.orderCount,
        lastVisit: c.lastOrderDate ? new Date(c.lastOrderDate).toLocaleDateString('en-US') : 'Never',
        spending: c.totalSpent || 0,
        tagCategory: assignTag(c.orderCount, c.totalSpent || 0),
        status: c.status === 'active' ? 'Active' : 'Inactive',
        loyaltyPoints: c.wallet?.loyaltyPoints || 0,
        walletBalance: c.wallet?.balance || 0,
        memberSince: new Date(c.createdAt).toLocaleDateString('en-US'),
        allergy: c.allergy || ''
    }));

    const totalCustomers = customers.length;
    const activeCustomers = customers.filter(c => c.status === 'Active').length;

    res.status(200).json({
        success: true,
        stats: {
            totalCustomers,
            activeCustomers,
            loggedIn: activeCustomers,
            guestUsers: guestOrders,
            newCustomers: todayNewCount
        },
        customers
    });
}, 'Failed to fetch customers');

// @desc    Admin: Get customer detail with orders, bookings, visits, preferences, suggestions
// @route   GET /api/crm/customers/:id
// @access  Admin
exports.getCustomerDetail = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: 'Invalid customer ID' });
    }

    // Customers are platform-global; tenant ownership is enforced below
    // (404 unless the customer has activity in this tenant).
    // AUDIT-EXEMPT: global User doc, ownership checked after the tenant-scoped sub-queries
    const customer = await User.findById(id).select('-password');
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    // Sub-queries are scoped to the current tenant + the caller's
    // own branch (strict). A Branch Admin sees only this customer's
    // history at THEIR branch — Main-branch inheritance was removed
    // per user report. Wallet is tenant-level (not branch-scoped).
    const tf = tenantFilter(req);
    const bf = strictBranchFilter(req);
    const [wallet, orders, advanceBookings] = await Promise.all([
        Wallet.findOne({ user: id, ...tf }),
        Order.find({ user: id, ...tf, ...bf }).populate('table', 'name').sort({ createdAt: -1 }),
        AdvanceBooking.find({ user: id, ...tf, ...bf })
            .populate('hall', 'name')
            .populate('package', 'name')
            // CRM-04 — table bookings render "table" as the key venue
            // info; without populating `tables` the customer profile
            // shows "Hotel Tip Top" / "No Package" and the actual
            // reserved table (IN-02, etc.) is invisible. Populate
            // here so the formatter below can surface the name.
            .populate('tables', 'name')
            .sort({ createdAt: -1 })
    ]);

    // #30 — a customer with no footprint in this tenant (or, for a
    // branch-pinned admin, this branch) must not be viewable by id:
    // the profile carries global PII (name / email / mobile).
    // The wallet is tenant-level, so it is footprint only for a tenant-wide
    // caller — never for a branch-pinned admin.
    const walletFootprint = !!wallet && !pinnedBranchId(req);
    if (!walletFootprint && orders.length === 0 && advanceBookings.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const formattedOrders = orders.map(o => ({
        id: o.orderId,
        date: new Date(o.createdAt).toLocaleDateString('en-US'),
        createdAt: o.createdAt,
        preparationStartedAt: o.preparationStartedAt || null,
        preparationCompletedAt: o.preparationCompletedAt || null,
        updatedAt: o.updatedAt,
        type: o.type === 'dine-in' ? 'Dine-in' : 'Takeaway',
        items: (o.items || []).map(item => ({
            name: item.name,
            qty: item.quantity,
            price: item.price * (item.quantity || 1)
        })),
        moreItems: Math.max(0, (o.items || []).length - 3),
        total: o.total,
        status: o.status,
        table: o.table?.name || 'Takeaway'
    }));

    const formattedBookings = advanceBookings.map(b => {
        // CRM-04 — for table bookings, expose the reserved table name(s)
        // so the admin can answer "which table?" from the customer
        // profile without opening the booking detail modal.
        // `tables` is populated above; defensive against legacy
        // records where it might still be unpopulated ObjectIds.
        const tableNames = Array.isArray(b.tables)
            ? b.tables
                .map(t => (t && typeof t === 'object' ? t.name : null))
                .filter(Boolean)
            : [];
        return {
            // CRM-04 — show the real, full bookingId (e.g.
            // BKT-260526-AC148C) so the admin can cross-reference
            // with /admin/bookings, support tickets, and emails.
            // The previous abbreviated `BKG-D3B7` was a 4-char
            // slice of the Mongo _id, not the user-facing ID.
            id: b.bookingId || `BKG-${b._id.toString().slice(-4).toUpperCase()}`,
            date: new Date(b.bookingDate).toLocaleDateString('en-US'),
            eventName: b.specialEvent !== 'None' ? b.specialEvent : (b.bookingType === 'hall' ? 'Hall Booking' : 'Table Reservation'),
            status: b.status,
            guests: `${b.guestCount} people`,
            package: b.package?.name || 'No Package',
            total: b.payment?.totalAmount || 0,
            advancePaid: b.payment?.advancePaid || 0,
            bookingType: b.bookingType,
            bookingTime: b.bookingTime || null,
            hall: b.hall?.name || null,
            tables: tableNames,                        // ["IN-02"] for table bookings
            tableLabel: tableNames.join(', ') || null, // "IN-02" — convenience for UI
        };
    });

    // Visit History — orders + completed advance bookings
    const visits = orders.map(o => ({
        date: new Date(o.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        timestamp: o.createdAt,
        table: o.table?.name || 'Takeaway',
        duration: '-',
        type: o.type === 'dine-in' ? 'Dine-in' : 'Takeaway'
    }));

    advanceBookings.filter(b => b.status === 'Completed').forEach(b => {
        visits.push({
            date: new Date(b.bookingDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
            timestamp: b.bookingDate,
            table: b.hall?.name || 'Reserved Table',
            duration: '-',
            type: b.bookingType === 'hall' ? 'Event' : 'Reservation'
        });
    });

    // Sort by timestamp (reliable) instead of parsed display string
    visits.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Preferences — derived from order patterns
    const itemCounts = {};
    orders.forEach(o => {
        (o.items || []).forEach(item => {
            itemCounts[item.name] = (itemCounts[item.name] || 0) + (item.quantity || 0);
        });
    });
    const topItems = Object.entries(itemCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }));

    // Lifetime value / average exclude cancelled orders and pay-first
    // orders still held until paid ('awaiting-payment').
    const spendOrders = orders.filter(o => o.status !== 'cancelled' && o.status !== 'awaiting-payment');
    const totalSpent = spendOrders.reduce((sum, o) => sum + (o.total || 0), 0);
    const completedBookings = advanceBookings.filter(b => b.status === 'Completed').length;

    const preferences = {
        favoriteItems: topItems,
        allergy: customer.allergy || '',
        preferredPayment: getMostFrequent(orders.map(o => o.paymentMethod).filter(Boolean)),
        preferredOrderType: getMostFrequent(orders.map(o => o.type)),
        avgOrderValue: spendOrders.length > 0 ? Math.round(totalSpent / spendOrders.length) : 0
    };

    // Suggestions — from order notes
    const suggestions = orders
        .filter(o => o.note && o.note.trim())
        .map(o => ({
            id: o.orderId,
            date: new Date(o.createdAt).toLocaleDateString('en-US'),
            text: o.note,
            type: o.type === 'dine-in' ? 'Dine-in' : 'Takeaway'
        }));

    res.status(200).json({
        success: true,
        customer: {
            name: customer.name,
            avatar: customer.avatar || null,
            tag: assignTag(orders.length, totalSpent),
            phone: customer.mobile || 'N/A',
            email: customer.email,
            address: 'N/A',
            dob: 'N/A',
            anniversary: 'N/A',
            memberSince: new Date(customer.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
            totalVisits: orders.length + completedBookings,
            totalSpend: totalSpent,
            loyaltyPoints: wallet?.loyaltyPoints || 0,
            walletBalance: wallet?.balance || 0,
            allergy: customer.allergy || ''
        },
        orders: formattedOrders,
        bookings: formattedBookings,
        visits,
        preferences,
        suggestions
    });
}, 'Failed to fetch customer detail');

// Helper: get most frequent value in array
function getMostFrequent(arr) {
    if (!arr.length) return 'N/A';
    const freq = {};
    arr.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
    return Object.entries(freq).sort(([, a], [, b]) => b - a)[0]?.[0] || 'N/A';
}
