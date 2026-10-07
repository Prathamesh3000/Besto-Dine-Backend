const Wallet = require('../models/wallet');
const Transaction = require('../models/transaction');
const crypto = require('crypto');
const mongoose = require('mongoose');
const logger = require('../utils/logger');
const idGen = require('../utils/idGenerator');

const { tenantFilter, tenantId, strictBranchFilter, pinnedBranchId } = require('../utils/tenantScope');
const { releaseTableIfSettled } = require('../utils/tableOccupancy');

// ADM-057 — when an admin blocks/suspends a customer's wallet via the
// three-dots menu on /admin/wallet, the customer's pay / points calls
// must refuse the operation. Returns the wallet doc when active so the
// caller doesn't pay a second read tax; returns null when there's no
// wallet yet (legitimate first-time path for addPoints' upsert).
async function assertWalletActiveOrNull(userId, tf) {
  const wallet = await Wallet.findOne({ user: userId, ...tf }).select('status');
  if (!wallet) return null;
  if (wallet.status === 'active') return wallet;
  const reason = wallet.status === 'blocked'
    ? 'Your wallet is blocked. Please contact support.'
    : 'Your wallet is temporarily suspended. Please contact support.';
  const err = new Error(reason);
  err.code = wallet.status === 'blocked' ? 'WALLET_BLOCKED' : 'WALLET_SUSPENDED';
  err.httpStatus = 403;
  throw err;
}

// Get wallet balance for current user
exports.getWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const tf = tenantFilter(req);
    let wallet = await Wallet.findOne({ user: userId, ...tf });

    // Auto-create wallet if not exists (per-tenant)
    if (!wallet) {
      wallet = new Wallet({ user: userId, restaurant: tenantId(req) });
      await wallet.save();
    }

    // Fetch recent transactions (per-tenant)
    const transactions = await Transaction.find({ user: userId, ...tf }).sort({ createdAt: -1 }).limit(10);
    
    res.status(200).json({ 
      success: true, 
      balance: wallet.balance,
      loyaltyPoints: wallet.loyaltyPoints,
      transactions: transactions.map(t => ({
        id: t._id,
        orderId: t.order,
        type: t.type === 'points_earned' ? 'earned' : 'used',
        label: t.description || (t.type === 'points_earned' ? 'Points Earned' : 'Wallet Used'),
        time: new Date(t.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        date: new Date(t.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        points: t.amount,
        paymentMethod: t.paymentMethod,
        status: t.status
      }))
    });
  } catch (error) {
    logger.error('Error fetching wallet:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch wallet info' });
  }
};

// Add loyalty points manually — ADMIN ONLY (bug #2).
//
// The route is gated by auth.adminOnly; the role check below is
// defence-in-depth so a future route change can't silently re-open
// self-service point minting. Customers earn points exclusively through
// server-computed paths (razorpayController.awardLoyaltyPoints /
// orderController on payment), never through this endpoint.
exports.addPoints = async (req, res) => {
  try {
    const { points, description } = req.body;

    const isAdmin = ['admin', 'manager'].includes(req.user?.role);
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied. Admin only.' });
    }

    // Input validation
    if (points === undefined || points === null || typeof points !== 'number' || !Number.isFinite(points)) {
      return res.status(400).json({ success: false, message: 'Points must be a valid number' });
    }
    if (points <= 0) {
      return res.status(400).json({ success: false, message: 'Points must be a positive number' });
    }
    if (points > 10000) {
      return res.status(400).json({ success: false, message: 'Points cannot exceed 10,000 per transaction' });
    }

    // targetUserId is honoured only for admins (guaranteed above).
    const targetUserId = req.body.targetUserId;
    if (targetUserId !== undefined && targetUserId !== null && !mongoose.Types.ObjectId.isValid(String(targetUserId))) {
      return res.status(400).json({ success: false, message: 'Invalid targetUserId' });
    }
    const userId = targetUserId ? String(targetUserId) : req.user.id;
    const tf = tenantFilter(req);
    const restaurant = tenantId(req);

    // Loyalty points belong to customers only (same rule as adjustWallet)
    // — without this a manager could mint points onto their own account
    // (the default target) and redeem them into wallet balance.
    const targetUser = await require('../models/user').findById(userId).select('role').lean();
    if (!targetUser || targetUser.role !== 'customer') {
      return res.status(400).json({ success: false, message: 'Points can only be added to customer accounts' });
    }

    // ADM-057 — refuse if admin has blocked/suspended this wallet.
    try { await assertWalletActiveOrNull(userId, tf); }
    catch (gateErr) {
      return res.status(gateErr.httpStatus || 403).json({
        success: false, code: gateErr.code, message: gateErr.message,
      });
    }

    // Atomic $inc to prevent race conditions with concurrent addPoints calls
    const wallet = await Wallet.findOneAndUpdate(
      { user: userId, ...tf },
      { $inc: { loyaltyPoints: points }, $setOnInsert: { balance: 0, restaurant } },
      { upsert: true, returnDocument: 'after' }
    );

    await Transaction.create({
      user: userId,
      restaurant,
      branch: pinnedBranchId(req) || null,
      type: 'points_earned',
      amount: points,
      paymentMethod: 'points',
      description: description || `Admin credit ${points} points`,
      transactionId: idGen.transactionId(),
      balanceBefore: wallet.loyaltyPoints - points,
      balanceAfter: wallet.loyaltyPoints,
    });

    res.status(200).json({ success: true, points: wallet.loyaltyPoints });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to add points' });
  }
};

// Get admin stats for all wallets
exports.getAdminWalletStats = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
    const skip = (page - 1) * limit;

    // Run paginated wallets, recent transactions, and aggregated stats in parallel
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tf = tenantFilter(req);
    // Transactions are branch-scoped (stamped at creation). Wallets are
    // tenant-level (one balance per user per tenant) — for Sub Admins,
    // the "customers" list is filtered to users who have at least one
    // transaction at this branch.
    const bf = strictBranchFilter(req);
    const isPinned = !!pinnedBranchId(req);

    // For Sub Admins: limit the wallets list to customers active at
    // this branch. Tenant owner sees all.
    let walletUserFilter = {};
    if (isPinned) {
      const activeUsers = await Transaction.distinct('user', { ...tf, ...bf });
      walletUserFilter = { user: { $in: activeUsers.filter(Boolean) } };
    }

    const [wallets, totalWalletCount, transactions, txnAgg, todayAgg] = await Promise.all([
      Wallet.find({ ...tf, ...walletUserFilter }).populate('user', 'name email mobile').skip(skip).limit(limit).lean(),
      Wallet.countDocuments({ ...tf, ...walletUserFilter }),
      Transaction.find({ ...tf, ...bf }).sort({ createdAt: -1 }).limit(50).populate('user', 'name').lean(),
      // Aggregated totals — single pass, scoped to branch
      Transaction.aggregate([
        { $match: { status: 'completed', ...tf, ...bf } },
        { $group: {
          _id: null,
          totalRecharge: { $sum: { $cond: [{ $eq: ['$type', 'wallet_recharge'] }, '$amount', 0] } },
          totalSpent: { $sum: { $cond: [{ $in: ['$type', ['order_payment']] }, { $abs: '$amount' }, 0] } },
          count: { $sum: 1 }
        }}
      ]),
      // Today's stats — scoped to branch
      Transaction.aggregate([
        { $match: { createdAt: { $gte: today }, ...tf, ...bf } },
        { $group: {
          _id: null,
          count: { $sum: 1 },
          totalValue: { $sum: { $abs: '$amount' } },
          volume: { $sum: { $cond: [{ $ne: ['$type', 'points_earned'] }, { $abs: '$amount' }, 0] } }
        }}
      ])
    ]);

    // Wallet balance aggregation — same user filter as above for pinned.
    const walletBalanceAgg = await Wallet.aggregate([
      { $match: { ...tf, ...walletUserFilter } },
      { $group: { _id: null, total: { $sum: '$balance' }, active: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } } } }
    ]);
    const walletTotals = walletBalanceAgg[0] || { total: 0, active: 0 };
    const txnTotals = txnAgg[0] || { totalRecharge: 0, totalSpent: 0, count: 0 };
    const todayTotals = todayAgg[0] || { count: 0, totalValue: 0, volume: 0 };

    // ADM-057 — per-customer stats for the cards on this page.
    // Without this, Total Recharge / Total Spent / Transactions /
    // Last Transaction render blank because the wallet doc itself
    // carries no transaction history (only running balances). One
    // bounded aggregate (scoped to the user ids on this page) is
    // cheap and avoids N+1 per-customer queries.
    const pageUserIds = wallets.map(w => w.user?._id).filter(Boolean);
    let perUserStatsMap = new Map();
    if (pageUserIds.length > 0) {
      const perUserAgg = await Transaction.aggregate([
        { $match: { user: { $in: pageUserIds }, status: 'completed', ...tf, ...bf } },
        { $sort: { createdAt: -1 } },
        { $group: {
          _id: '$user',
          // totalRecharge = sum of wallet top-ups (admin credits + Razorpay
          // recharges all land as type=wallet_recharge with positive amount).
          totalRecharge: { $sum: { $cond: [{ $eq: ['$type', 'wallet_recharge'] }, '$amount', 0] } },
          // totalSpent = money out via order payment. amount is stored as a
          // signed number depending on direction, so we $abs to be safe.
          totalSpent:    { $sum: { $cond: [{ $eq: ['$type', 'order_payment'] }, { $abs: '$amount' }, 0] } },
          // 'wallet_status_change' is an audit-only zero-amount row; exclude
          // it from the transaction COUNT so the card reflects real activity.
          txCount:       { $sum: { $cond: [{ $ne: ['$type', 'wallet_status_change'] }, 1, 0] } },
          lastAt:        { $first: '$createdAt' },
          lastType:      { $first: '$type' },
          lastAmount:    { $first: '$amount' },
        }}
      ]);
      perUserStatsMap = new Map(perUserAgg.map(s => [String(s._id), s]));
    }
    const fmtTxLabel = (s) => {
      if (!s?.lastAt) return '';
      const d = new Date(s.lastAt);
      const when = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      const verb = s.lastType === 'wallet_recharge' ? 'Credit'
                 : s.lastType === 'order_payment'   ? 'Debit'
                 : s.lastType === 'points_earned'   ? 'Points +'
                 : s.lastType === 'points_redeemed' ? 'Points −'
                 : s.lastType === 'refund'          ? 'Refund'
                 : '';
      const amt = Math.abs(Number(s.lastAmount) || 0);
      return verb ? `${when} · ${verb} ₹${amt.toFixed(0)}` : when;
    };

    res.status(200).json({
      success: true,
      stats: {
        totalWalletBalance: walletTotals.total,
        activeCustomers: walletTotals.active,
        totalCustomers: totalWalletCount,
        totalRecharge: txnTotals.totalRecharge,
        totalSpent: txnTotals.totalSpent,
        avgBalance: totalWalletCount > 0 ? (walletTotals.total / totalWalletCount) : 0,
        totalTransactions: txnTotals.count,
        todaysTransactions: todayTotals.count,
        todaysTransactionsValue: todayTotals.totalValue,
        todaysVolume: todayTotals.volume
      },
      customers: wallets.map(w => {
        const s = perUserStatsMap.get(String(w.user?._id)) || {};
        return {
          id: w._id,
          userId: w.user?._id,
          name: w.user?.name || 'Guest',
          email: w.user?.email || 'N/A',
          phone: w.user?.mobile || 'N/A',
          status: w.status === 'active' ? 'Active' : w.status === 'blocked' ? 'Blocked' : 'Inactive',
          currentBalance: w.balance,
          loyaltyPoints: w.loyaltyPoints,
          memberSince: new Date(w.createdAt).toLocaleDateString(),
          // ADM-057 — per-customer stats for the dashboard card. Defaults
          // ensure the card never renders "undefined" for a customer with
          // no transactions yet.
          totalRecharge:   Number(s.totalRecharge || 0),
          totalSpent:      Number(s.totalSpent || 0),
          transactions:    Number(s.txCount || 0),
          lastTransaction: fmtTxLabel(s) || '—',
        };
      }),
      recentTransactions: transactions.map(t => ({
        id: t.transactionId,
        customerName: t.user?.name || 'Guest',
        description: t.description || t.type.replace(/_/g, ' '),
        type: t.amount < 0 || ['order_payment', 'points_redeemed'].includes(t.type) ? 'Debit' : 'Credit',
        category: t.type === 'order_payment' ? 'Order' : t.type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        amount: t.amount || 0,
        balanceBefore: t.balanceBefore || 0,
        balanceAfter: t.balanceAfter || 0,
        time: new Date(t.createdAt).toLocaleString('en-IN'),
        status: t.status === 'completed' ? 'Success' : t.status.charAt(0).toUpperCase() + t.status.slice(1)
      }))
    });
  } catch (error) {
    logger.error('Admin wallet stats error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch admin wallet stats' });
  }
};

// Admin: Adjust wallet balance or points for a specific user
exports.adjustWallet = async (req, res) => {
  try {
    const { targetUserId, amount, type, action, description } = req.body;

    if (!targetUserId || amount === undefined || !type || !action) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    const targetUser = await require('../models/user').findById(targetUserId).select('role').lean();
    if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });
    // Wallets / loyalty points belong to customers — never credit a
    // staff or foreign-tenant admin account by id.
    if (targetUser.role !== 'customer') {
      return res.status(400).json({ success: false, message: 'Points and balance can only be adjusted for customers' });
    }

    const multiplier = action === 'deduct' ? -1 : 1;
    const change = numAmount * multiplier;

    // Build atomic update based on type
    const incField = type === 'points' ? 'loyaltyPoints' : 'balance';
    const updateOp = { $inc: { [incField]: change } };

    // For deductions, ensure balance doesn't go negative (scoped to tenant)
    const tf = tenantFilter(req);
    const query = { user: targetUserId, ...tf };
    if (action === 'deduct') {
      query[incField] = { $gte: numAmount };
    }

    let wallet = await Wallet.findOneAndUpdate(query, updateOp, { returnDocument: 'after' });

    // If wallet doesn't exist, create it (for 'add' only)
    if (!wallet && action !== 'deduct') {
      wallet = await Wallet.create({ user: targetUserId, restaurant: tenantId(req), [incField]: change });
    }

    if (!wallet) {
      return res.status(400).json({ success: false, message: `Insufficient ${type} for deduction` });
    }

    const beforeValue = type === 'balance'
      ? (wallet.balance - change)
      : (wallet.loyaltyPoints - change);

    // Record transaction with error handling.
    // Units: an admin POINTS deduction is stored as type 'points_redeemed'
    // with a NEGATIVE amount in POINTS (same convention as points spent on
    // an order / booking). Positive points_redeemed rows are customer
    // conversions and carry the RUPEES credited to the wallet. Reports
    // tell the two apart by sign (see getWalletReports).
    try {
      await Transaction.create({
        user: targetUserId,
        restaurant: tenantId(req),
        branch: pinnedBranchId(req) || null,
        type: type === 'balance' ? (action === 'add' ? 'wallet_recharge' : 'order_payment') : (action === 'add' ? 'points_earned' : 'points_redeemed'),
        amount: change,
        paymentMethod: type === 'balance' ? 'wallet' : 'points',
        description: description || `Admin ${action} ${numAmount} ${type}`,
        transactionId: idGen.transactionId(),
        balanceBefore: beforeValue,
        balanceAfter: type === 'balance' ? wallet.balance : wallet.loyaltyPoints,
        status: 'completed'
      });
    } catch (txnErr) {
      // Rollback the wallet change if transaction recording fails
      logger.error('Transaction recording failed, rolling back:', { error: txnErr.message });
      await Wallet.findOneAndUpdate({ user: targetUserId, ...tf }, { $inc: { [incField]: -change } });
      return res.status(500).json({ success: false, message: 'Failed to record transaction. Adjustment rolled back.' });
    }

    res.status(200).json({
      success: true,
      message: `${type} updated successfully`,
      newBalance: wallet.balance,
      newPoints: wallet.loyaltyPoints
    });
  } catch (error) {
    logger.error('Wallet adjustment error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to adjust wallet' });
  }
};

// GET /wallet/admin/customers?q= — customer picker for the admin
// "Add Points Manually" modal (Settings → Wallet). Returns up to 20
// customers matching name / email / mobile who have activity in THIS
// tenant (a wallet here or at least one order here), so an admin can
// never enumerate another restaurant's customers. The CRM list isn't
// reused because it is gated by the separate `crm` plan feature and has
// no server-side search (it aggregates every customer).
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
exports.searchWalletCustomers = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) {
      return res.status(200).json({ success: true, customers: [] });
    }
    const User = require('../models/user');
    const Order = require('../models/order');
    const rx = new RegExp(escapeRegex(q), 'i');
    // AUDIT-EXEMPT: customers are platform-global; filtered to tenant activity below
    const candidates = await User.find({
      role: 'customer',
      $or: [{ name: rx }, { email: rx }, { mobile: rx }],
    }).select('name email mobile').limit(200).lean();
    if (!candidates.length) return res.status(200).json({ success: true, customers: [] });

    const ids = candidates.map((u) => u._id);
    const tf = tenantFilter(req);
    const [wallets, orderUsers] = await Promise.all([
      Wallet.find({ user: { $in: ids }, ...tf }).select('user loyaltyPoints balance status').lean(),
      Order.distinct('user', { user: { $in: ids }, ...tf }),
    ]);
    const walletByUser = new Map(wallets.map((w) => [String(w.user), w]));
    const orderSet = new Set(orderUsers.filter(Boolean).map(String));

    const customers = candidates
      .filter((u) => walletByUser.has(String(u._id)) || orderSet.has(String(u._id)))
      .slice(0, 20)
      .map((u) => {
        const w = walletByUser.get(String(u._id));
        return {
          _id: u._id,
          name: u.name || '',
          email: u.email || '',
          mobile: u.mobile || '',
          loyaltyPoints: w?.loyaltyPoints || 0,
          balance: w?.balance || 0,
          walletStatus: w?.status || null,
        };
      });
    res.status(200).json({ success: true, customers });
  } catch (error) {
    logger.error('Wallet customer search error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to search customers' });
  }
};

// ADM-057 — admin sets a customer wallet's status. The three-dots menu
// in /admin/wallet uses this to flip a customer between Active, Inactive
// (suspended), and Blocked. Before this endpoint existed, the menu was
// dead — its click handler called adjustWallet with amount=0 and a
// "Status changed to X" description, which just created a noise
// transaction row without actually persisting any status change.
//
// Status mapping (schema enum values are lower-case):
//   'active'    — wallet usable
//   'suspended' — temporarily disabled, can be reactivated
//   'blocked'   — disabled, manual review required to lift
exports.setWalletStatus = async (req, res) => {
  try {
    const { targetUserId, status } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId is required' });
    }
    const allowed = ['active', 'blocked', 'suspended'];
    const next = String(status || '').toLowerCase();
    if (!allowed.includes(next)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${allowed.join(', ')}` });
    }

    const tf = tenantFilter(req);
    const wallet = await Wallet.findOneAndUpdate(
      { user: targetUserId, ...tf },
      { $set: { status: next } },
      { returnDocument: 'after' }
    );
    if (!wallet) {
      return res.status(404).json({ success: false, message: 'Wallet not found for this customer' });
    }

    // Audit trail — record the status change as a zero-amount Transaction
    // so the admin's manual-history view shows who flipped what and when.
    try {
      await Transaction.create({
        user: targetUserId,
        restaurant: tenantId(req),
        branch: pinnedBranchId(req) || null,
        type: 'wallet_status_change',
        amount: 0,
        paymentMethod: 'wallet',
        description: `Wallet status changed to ${next} by ${req.user?.name || req.user?.email || 'admin'}`,
        transactionId: idGen.transactionId(),
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance,
        status: 'completed',
      });
    } catch (txnErr) {
      // Audit row failure is non-fatal — the status change is the
      // primary contract here, the row is for traceability.
      logger.warn('Wallet status audit row failed:', { error: txnErr.message });
    }

    res.status(200).json({ success: true, status: wallet.status });
  } catch (error) {
    logger.error('setWalletStatus error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update wallet status' });
  }
};

// Pay for an order using wallet
exports.payWithWallet = async (req, res) => {
  try {
    const { orderId, amount, description } = req.body;
    const userId = req.user.id;
    const tf = tenantFilter(req);

    // ADM-057 — wallet must be active.
    try { await assertWalletActiveOrNull(userId, tf); }
    catch (gateErr) {
      return res.status(gateErr.httpStatus || 403).json({
        success: false, code: gateErr.code, message: gateErr.message,
      });
    }

    // ── R-05: authoritative order-based pricing + idempotency ───────
    //
    // The old implementation deducted whatever `amount` the client
    // sent, against any `orderId` the client supplied, and never
    // updated the order. Consequences:
    //   (a) Client can post `amount: 1` for a ₹500 order → wallet
    //       charged ₹1 while the bill is still unpaid — free meal.
    //   (b) Client can post another tenant's / user's orderId — the
    //       debit is attributed to a foreign order (data pollution +
    //       potential cross-tenant analytics leak).
    //   (c) Two successive calls (retry / double-click / replay)
    //       double-charge the wallet for a single order — the true
    //       "double-spend" R-05 describes at the business level.
    //
    // Fix: orderId is required, looked up under tenant + user scope,
    // the payable delta is computed from `order.total - order.amountPaid`
    // server-side, the wallet debit and the order update happen in ONE
    // MongoDB transaction (see below — this also closes the concurrent
    // double-charge of the same order), and any call against an
    // already-Paid order short-circuits to 200. The atomic
    // `balance: {$gte}` guard still stops concurrent pays for DIFFERENT
    // orders from overdrawing the wallet.
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        code: 'ORDER_REQUIRED',
        message: 'A valid orderId is required to pay from wallet.',
      });
    }
    const clientAmount = Number(amount);
    if (!Number.isFinite(clientAmount) || clientAmount <= 0) {
      return res.status(400).json({
        success: false,
        code: 'AMOUNT_INVALID',
        message: 'Amount must be a positive number.',
      });
    }
    // Server-authoritative deduction — rounded to paise.
    const deductAmount = Math.round(clientAmount * 100) / 100;
    const Order = require('../models/order');

    // ── Atomic claim + debit (one MongoDB transaction) ───────────────
    // Everything below — reading the order, checking what is still
    // payable, applying the payment to the order, debiting the wallet
    // and writing the ledger row — runs in ONE transaction.
    //
    // Previously the order was read, the wallet debited (atomic $gte
    // guard on the BALANCE only) and the order saved afterwards. Two
    // concurrent pays for the same unpaid order both passed the "not yet
    // paid" check and both debited: the customer was charged twice for
    // one bill. Now:
    //   • the order update is conditional (not Paid, not cancelled and
    //     amountPaid + amount ≤ total), and
    //   • two transactions touching the same order conflict; MongoDB
    //     aborts one (WriteConflict) and withTransaction retries it,
    //     which then re-reads the order, finds it Paid and answers the
    //     idempotent "alreadyPaid" 200 — with no second debit.
    // A failure anywhere (insufficient balance, ledger write) rolls the
    // whole thing back, so wallet, order and ledger always agree.
    const reply = (status, body) => { const e = new Error('payWithWallet reply'); e.reply = { status, body }; return e; };
    let outcome = null;
    let settledOrder = null; // { _id, table, branch, restaurant } when this pay settled the bill
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        outcome = null;
        settledOrder = null;
        const order = await Order.findOne({ _id: orderId, ...tf }).session(session);
        if (!order) {
          throw reply(404, { success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found for this restaurant.' });
        }
        // Only the order's owner (or a guest order with no user,
        // legitimate pre-auth flows) can pay from a user wallet. Staff-
        // driven order settlement uses a different endpoint.
        if (order.user && String(order.user) !== String(userId)) {
          throw reply(403, { success: false, code: 'ORDER_NOT_YOURS', message: 'You cannot pay for another user\'s order.' });
        }
        // Idempotency: already paid → 200 with alreadyPaid flag. Safe to
        // replay a frontend retry that saw the network drop AFTER the
        // server succeeded (or a concurrent duplicate); no second debit.
        if (order.paymentStatus === 'Paid') {
          throw reply(200, { success: true, alreadyPaid: true, message: 'Order already paid.', orderId: order.orderId });
        }
        if (order.status === 'cancelled') {
          throw reply(400, { success: false, code: 'ORDER_CANCELLED', message: 'Cannot pay a cancelled order.' });
        }

        // Authoritative payable — the server decides, not the client.
        const orderTotal = Math.round(Number(order.total || 0) * 100) / 100;
        const paidSoFar = Math.round(Number(order.amountPaid || 0) * 100) / 100;
        const payable = Math.round((orderTotal - paidSoFar) * 100) / 100;
        if (payable <= 0) {
          // Defensive — legacy / data-inconsistent rows.
          throw reply(200, { success: true, alreadyPaid: true, message: 'Nothing to pay on this order.', orderId: order.orderId });
        }
        // Partial payments are allowed, over-payment never. A mismatch
        // means the client is out of sync — no silent substitution.
        if (deductAmount > payable + 0.01) {
          throw reply(400, {
            success: false,
            code: 'AMOUNT_EXCEEDS_PAYABLE',
            message: `Amount (₹${deductAmount.toFixed(2)}) exceeds what's payable (₹${payable.toFixed(2)}).`,
            payable,
          });
        }

        // ── Claim the payment on the order (conditional) ─────────────
        const newAmountPaid = Math.round((paidSoFar + deductAmount) * 100) / 100;
        const fullyPaid = newAmountPaid >= orderTotal - 0.01;
        const orderSet = {
          amountPaid: newAmountPaid,
          paymentMethod: 'wallet',
          paymentStatus: fullyPaid ? 'Paid' : 'Partially Paid',
        };
        if (fullyPaid && !order.paidAt) orderSet.paidAt = new Date();
        const claim = await Order.updateOne(
          {
            _id: order._id,
            ...tf,
            paymentStatus: { $ne: 'Paid' },
            status: { $ne: 'cancelled' },
            $expr: {
              $lte: [
                { $add: [{ $ifNull: ['$amountPaid', 0] }, deductAmount] },
                { $add: [{ $ifNull: ['$total', 0] }, 0.01] },
              ],
            },
          },
          { $set: orderSet },
          { session },
        );
        if (claim.matchedCount !== 1) {
          // Changed under us — let the caller retry against fresh state.
          throw reply(409, {
            success: false,
            code: 'ORDER_PAYMENT_CONFLICT',
            message: 'This order was updated by another payment. Please refresh and try again.',
          });
        }

        // ── Atomic wallet debit with balance-gte guard ───────────────
        const wallet = await Wallet.findOneAndUpdate(
          { user: userId, balance: { $gte: deductAmount }, ...tf },
          { $inc: { balance: -deductAmount } },
          { returnDocument: 'after', session },
        );
        if (!wallet) {
          const exists = await Wallet.findOne({ user: userId, ...tf }).session(session);
          if (!exists) {
            throw reply(404, { success: false, code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });
          }
          throw reply(400, { success: false, code: 'INSUFFICIENT_BALANCE', message: 'Insufficient wallet balance.' });
        }
        const balanceBefore = Math.round((wallet.balance + deductAmount) * 100) / 100;

        // ── Ledger row (same transaction) ────────────────────────────
        // Branch from the tenant-scoped order (audit finding A-27).
        const txnBranch = order.branch || pinnedBranchId(req) || null;
        const [transaction] = await Transaction.create([{
          user: userId,
          restaurant: tenantId(req),
          branch: txnBranch,
          order: order._id,
          type: 'order_payment',
          amount: -deductAmount, // Debit
          currency: 'INR',
          paymentMethod: 'wallet',
          description: (typeof description === 'string' && description) || `Payment for order ${order.orderId}`,
          transactionId: idGen.transactionId(),
          balanceBefore,
          balanceAfter: wallet.balance,
          status: 'completed',
        }], { session });

        outcome = {
          success: true,
          message: fullyPaid ? 'Payment successful' : 'Partial payment applied',
          newBalance: wallet.balance,
          transactionId: transaction.transactionId,
          orderPaid: fullyPaid,
          paymentStatus: orderSet.paymentStatus,
        };
        if (fullyPaid && order.table) {
          settledOrder = { _id: order._id, table: order.table, branch: order.branch, restaurant: order.restaurant };
        }
      });
    } catch (err) {
      if (err && err.reply) {
        return res.status(err.reply.status).json(err.reply.body);
      }
      throw err;
    } finally {
      await session.endSession();
    }

    // Table-status rule: the bill is settled → free the dine-in table now
    // (unless another order on it is still unpaid). After the commit, so
    // a rolled-back payment never frees a table. Best-effort.
    if (settledOrder) {
      try {
        await releaseTableIfSettled(settledOrder, tf, {
          branch: settledOrder.branch || null, restaurant: settledOrder.restaurant,
        });
      } catch (relErr) {
        logger.warn('Failed to free table after wallet payment:', relErr.message);
      }
    }

    return res.status(200).json(outcome);

  } catch (error) {
    logger.error('Wallet payment error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to process wallet payment' });
  }
};

// Get manual points adjustment history (admin)
exports.getManualPointsHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = {
      description: { $regex: /admin/i },
      type: { $in: ['points_earned', 'points_redeemed'] },
      ...tenantFilter(req),
      ...strictBranchFilter(req),
    };

    const total = await Transaction.countDocuments(filter);
    const actions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'name email');

    res.status(200).json({
      success: true,
      actions: actions.map(a => ({
        id: a.transactionId,
        customer: a.user?.name || 'Unknown',
        customerId: a.user?._id,
        action: a.amount >= 0 ? 'Add' : 'Deduct',
        points: a.amount >= 0 ? `+${a.amount}` : `${a.amount}`,
        reason: a.description || '',
        by: 'Admin',
        time: new Date(a.createdAt).toLocaleString('en-IN')
      })),
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    logger.error('Manual points history error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch manual points history' });
  }
};

// Helper: get date range from filter string
function getDateRange(filter, customFrom, customTo) {
  const now = new Date();
  let start, end;

  switch (filter) {
    case 'Today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end = new Date(start);
      end.setDate(end.getDate() + 1);
      break;
    case 'Yesterday':
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      start = new Date(end);
      start.setDate(start.getDate() - 1);
      break;
    case 'This Week':
      start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
      end = new Date(now);
      end.setDate(end.getDate() + 1);
      break;
    case 'This Month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now);
      end.setDate(end.getDate() + 1);
      break;
    case 'This Year':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now);
      end.setDate(end.getDate() + 1);
      break;
    case 'Custom':
      start = customFrom ? new Date(customFrom) : new Date(0);
      end = customTo ? new Date(customTo) : new Date();
      end.setDate(end.getDate() + 1);
      break;
    default:
      start = new Date(0);
      end = new Date(now);
      end.setDate(end.getDate() + 1);
  }
  return { start, end };
}

// Wallet Reports: Comprehensive wallet analytics (admin)
exports.getWalletReports = async (req, res) => {
  try {
    const { report, filter, customFrom, customTo } = req.query;
    const { start, end } = getDateRange(filter, customFrom, customTo);
    const tf = tenantFilter(req);
    // Transactions are branch-scoped. For a Sub Admin, all report
    // aggregations filter to their branch. Wallet documents stay tenant-
    // level (one balance per user per tenant) — for pinned users, wallet
    // totals are limited to users with activity at this branch.
    const bf = strictBranchFilter(req);
    const isPinned = !!pinnedBranchId(req);
    const dateFilter = { createdAt: { $gte: start, $lt: end }, ...tf, ...bf };

    // Build a user filter for wallet queries when the caller is pinned,
    // so the wallet-side numbers reflect this branch's customer base.
    let walletUserFilter = {};
    if (isPinned) {
      const activeUsers = await Transaction.distinct('user', { ...tf, ...bf });
      walletUserFilter = { user: { $in: activeUsers.filter(Boolean) } };
    }
    const walletScope = { ...tf, ...walletUserFilter };

    switch (report) {
      case 'Wallet Balance Summary': {
        const wallets = await Wallet.find(walletScope).populate('user', 'name');
        const totalBalance = wallets.reduce((s, w) => s + (w.balance || 0), 0);
        const activeWallets = wallets.filter(w => w.balance > 0).length;
        const avgBalance = wallets.length > 0 ? totalBalance / wallets.length : 0;
        const highest = wallets.reduce((max, w) => Math.max(max, w.balance || 0), 0);

        // Distribution buckets
        // Contiguous (lo, hi] edges so fractional balances (₹500.50) land
        // in exactly one bucket and the counts always sum to totalWallets.
        const buckets = [
          { label: '₹0-500', lo: -Infinity, hi: 500 },
          { label: '₹501-2000', lo: 500, hi: 2000 },
          { label: '₹2001-5000', lo: 2000, hi: 5000 },
          { label: '₹5001+', lo: 5000, hi: Infinity }
        ];
        const distribution = buckets.map(b => {
          const count = wallets.filter(w => (w.balance || 0) > b.lo && (w.balance || 0) <= b.hi).length;
          return {
            label: b.label,
            count,
            percent: wallets.length > 0 ? Math.round((count / wallets.length) * 100) : 0
          };
        });

        return res.json({
          success: true,
          data: { totalBalance, activeWallets, avgBalance: Math.round(avgBalance * 100) / 100, highest, distribution, totalWallets: wallets.length }
        });
      }

      case 'Points Issued vs Redeemed': {
        // Unit normalisation: `points_earned.amount` is stored in POINTS
        // (e.g., 245). `points_redeemed` has two shapes:
        //   amount > 0 — customer conversion; RUPEES credited to the
        //                wallet (₹87.7 for 877 points) → divide by ptr
        //   amount < 0 — points spent on an order / booking or an admin
        //                deduction; already in POINTS → |amount|
        // Mixing the two (dividing everything by ptr) reported an admin
        // deduction of 100 points as 1,000 points redeemed.
        const { getSettings: _getSettings } = require('../utils/settingsCache');
        const _settings = await _getSettings(req);
        const ptr = _settings?.wallet?.pointsToRupee || 0.1;

        const issued = await Transaction.aggregate([
          { $match: { ...dateFilter, type: 'points_earned', status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]);
        // Points equivalent of one points_redeemed row (see above).
        const redeemedPointsExpr = { $cond: [
          { $gt: ['$amount', 0] },
          ptr > 0 ? { $divide: ['$amount', ptr] } : 0,
          { $abs: '$amount' },
        ] };
        const redeemed = await Transaction.aggregate([
          { $match: { ...dateFilter, type: 'points_redeemed', status: 'completed' } },
          { $group: { _id: null, total: { $sum: redeemedPointsExpr }, count: { $sum: 1 } } }
        ]);

        const totalIssued = Math.round(issued[0]?.total || 0);
        const totalRedeemed = Math.round(redeemed[0]?.total || 0);

        // Top redeemers — also normalised to points
        const topRedeemers = await Transaction.aggregate([
          { $match: { ...dateFilter, type: 'points_redeemed', status: 'completed' } },
          { $group: { _id: '$user', totalRedeemed: { $sum: redeemedPointsExpr } } },
          { $sort: { totalRedeemed: -1 } },
          { $limit: 5 },
          { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userInfo' } },
          { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
          { $project: { name: { $ifNull: ['$userInfo.name', 'Unknown'] }, totalRedeemed: 1 } }
        ]);

        return res.json({
          success: true,
          data: {
            totalIssued,
            totalRedeemed,
            netOutstanding: totalIssued - totalRedeemed,
            topRedeemers: topRedeemers.map((r, i) => ({
              rank: i + 1,
              name: r.name,
              pts: Math.round(r.totalRedeemed),
            }))
          }
        });
      }

      case 'Expired Points Report': {
        // Since we don't track point expiry individually, we estimate from settings (per-tenant)
        const { getSettings } = require('../utils/settingsCache');
        const settings = await getSettings(req);
        const expiryDays = settings?.wallet?.pointsExpiryDays || 365;

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() - expiryDays);

        // Points earned before expiry date that were never redeemed (per-tenant)
        const oldPoints = await Transaction.aggregate([
          { $match: { type: 'points_earned', status: 'completed', createdAt: { $lt: expiryDate }, ...tf, ...bf } },
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, total: { $sum: '$amount' }, users: { $addToSet: '$user' } } },
          { $sort: { _id: -1 } },
          { $limit: 6 }
        ]);

        const totalExpired = oldPoints.reduce((s, p) => s + p.total, 0);
        const affectedUsers = new Set(oldPoints.flatMap(p => p.users.map(String))).size;
        const monthlyExpiry = oldPoints.length > 0 ? Math.round(totalExpired / Math.max(oldPoints.length, 1)) : 0;

        const sett = await getSettings(req);
        const ptr = sett?.wallet?.pointsToRupee || 0.1;

        return res.json({
          success: true,
          data: {
            totalExpired,
            monthlyExpiry,
            affectedUsers,
            valueLost: Math.round(totalExpired * ptr * 100) / 100,
            breakdown: oldPoints.map(p => ({
              month: p._id,
              points: p.total
            }))
          }
        });
      }

      case 'Refunds to Wallet Report': {
        // Only count refunds that actually credited the customer's wallet.
        // `processOrderRefund` records every refund as a 'refund'
        // Transaction regardless of channel (UPI / cash / wallet) and
        // stamps the ORIGINAL payment method, not the destination. The
        // signal that the wallet was actually credited is
        // `balanceAfter > balanceBefore`. Refunds returned to UPI or
        // cash leave balanceBefore === balanceAfter and must be
        // excluded from this report.
        const refunds = await Transaction.find({
          ...dateFilter,
          type: 'refund',
          status: 'completed',
          $expr: { $gt: ['$balanceAfter', '$balanceBefore'] },
        })
          .sort({ createdAt: -1 })
          .populate('user', 'name');

        const totalRefunds = refunds.length;
        const totalAmount = refunds.reduce((s, r) => s + Math.abs(r.amount || 0), 0);
        const avgRefund = totalRefunds > 0 ? Math.round((totalAmount / totalRefunds) * 100) / 100 : 0;

        // Group by description/reason
        const reasonMap = {};
        refunds.forEach(r => {
          const reason = r.description || 'Other';
          if (!reasonMap[reason]) reasonMap[reason] = { count: 0, amount: 0 };
          reasonMap[reason].count++;
          reasonMap[reason].amount += Math.abs(r.amount || 0);
        });

        return res.json({
          success: true,
          data: {
            totalRefunds,
            totalAmount: Math.round(totalAmount * 100) / 100,
            avgRefund,
            breakdown: Object.entries(reasonMap).map(([reason, data]) => ({
              reason,
              count: data.count,
              amount: Math.round(data.amount * 100) / 100
            }))
          }
        });
      }

      case 'Top Wallet Users': {
        const wallets = await Wallet.find(walletScope)
          .sort({ balance: -1 })
          .limit(10)
          .populate('user', 'name email');

        const userIds = wallets.map(w => w.user?._id).filter(Boolean);

        const txnStats = await Transaction.aggregate([
          { $match: { user: { $in: userIds }, status: 'completed', ...tf, ...bf } },
          { $group: {
            _id: '$user',
            txnCount: { $sum: 1 },
            // "Recharge" = anything that adds money to the wallet:
            // explicit top-ups, redeemed loyalty points, and refunds
            // that were credited back to the wallet. Mirrors the
            // input/output model used in Wallet Liability Report so the
            // two reports tell the same story.
            totalRecharge: { $sum: { $cond: [
              { $or: [
                { $eq: ['$type', 'wallet_recharge'] },
                // Only positive rows (rupees credited by a conversion);
                // negative rows are points spent / admin deductions.
                { $and: [
                  { $eq: ['$type', 'points_redeemed'] },
                  { $gt: ['$amount', 0] },
                ]},
                { $and: [
                  { $eq: ['$type', 'refund'] },
                  { $gt: ['$balanceAfter', '$balanceBefore'] },
                ]},
              ]},
              { $abs: '$amount' },
              0,
            ]}},
            // "Spent" = only orders actually paid FROM the wallet.
            // Cash/UPI/card-paid orders create order_payment rows too
            // and must not inflate this number.
            totalSpent: { $sum: { $cond: [
              { $and: [
                { $eq: ['$type', 'order_payment'] },
                { $eq: ['$paymentMethod', 'wallet'] },
              ]},
              { $abs: '$amount' },
              0,
            ]}},
          }}
        ]);

        const statsMap = {};
        txnStats.forEach(s => { statsMap[s._id.toString()] = s; });

        return res.json({
          success: true,
          data: {
            users: wallets.map((w, i) => {
              const uid = w.user?._id?.toString();
              const s = statsMap[uid] || { txnCount: 0, totalRecharge: 0, totalSpent: 0 };
              return {
                rank: i + 1,
                name: w.user?.name || 'Unknown',
                balance: w.balance,
                transactions: s.txnCount,
                recharge: Math.round(s.totalRecharge * 100) / 100,
                spent: Math.round(s.totalSpent * 100) / 100
              };
            })
          }
        });
      }

      case 'Wallet Liability Report': {
        const wallets = await Wallet.find(walletScope).lean();
        const totalLiability = wallets.reduce((s, w) => s + (w.balance || 0), 0);

        // Monthly growth: compare with last month
        const lastMonthStart = new Date();
        lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
        lastMonthStart.setDate(1);
        const thisMonthStart = new Date();
        thisMonthStart.setDate(1);
        thisMonthStart.setHours(0, 0, 0, 0);

        // ── INPUTS to the wallet balance pool ──────────────────────────
        // The customer's wallet balance can grow from THREE channels:
        //   1. `wallet_recharge`              — explicit top-up
        //   2. `refund` where wallet got the credit (balance changed)
        //   3. `points_redeemed`              — points → rupees conversion
        // Earlier code only counted (1), which made utilisationRate
        // exceed 100% on any tenant whose customers ever paid by points.
        // ── OUTPUTS ────────────────────────────────────────────────────
        // Only `order_payment` rows whose paymentMethod === 'wallet'
        // actually deducted from the balance. Cash/UPI/card-paid orders
        // also produce `order_payment` Transactions and must NOT be
        // counted as wallet spend.

        const inputMatch = (range) => ({
          $or: [
            { type: 'wallet_recharge', status: 'completed', ...range, ...tf, ...bf },
            // amount > 0 only: negative rows are points units, not rupees.
            { type: 'points_redeemed', status: 'completed', amount: { $gt: 0 }, ...range, ...tf, ...bf },
            { type: 'refund', status: 'completed', ...range, ...tf, ...bf,
              $expr: { $gt: ['$balanceAfter', '$balanceBefore'] } },
          ],
        });
        const spendMatch = (range) => ({
          type: 'order_payment', status: 'completed', paymentMethod: 'wallet',
          ...range, ...tf, ...bf,
        });

        const monthlyRange = { createdAt: { $gte: lastMonthStart, $lt: thisMonthStart } };

        const lastMonthInputs = await Transaction.aggregate([
          { $match: inputMatch(monthlyRange) },
          { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
        ]);
        const lastMonthSpend = await Transaction.aggregate([
          { $match: spendMatch(monthlyRange) },
          { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
        ]);

        const monthlyGrowth = (lastMonthInputs[0]?.total || 0) - (lastMonthSpend[0]?.total || 0);
        const growthPercent = totalLiability > 0 ? Math.round((monthlyGrowth / totalLiability) * 1000) / 10 : 0;

        // Total ever credited vs spent
        const allInputs = await Transaction.aggregate([
          { $match: inputMatch({}) },
          { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
        ]);
        const allSpent = await Transaction.aggregate([
          { $match: spendMatch({}) },
          { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
        ]);

        const totalEverRecharged = allInputs[0]?.total || 0;
        const totalEverSpent = allSpent[0]?.total || 0;
        const utilizationRate = totalEverRecharged > 0 ? Math.round((totalEverSpent / totalEverRecharged) * 1000) / 10 : 0;

        let riskLevel = 'Low Risk';
        if (totalLiability > 100000) riskLevel = 'High Risk';
        else if (totalLiability > 50000) riskLevel = 'Medium Risk';

        const projected = totalLiability + monthlyGrowth;

        return res.json({
          success: true,
          data: {
            totalLiability: Math.round(totalLiability * 100) / 100,
            monthlyGrowth: Math.round(monthlyGrowth * 100) / 100,
            growthPercent,
            projected: Math.round(projected * 100) / 100,
            utilizationRate,
            riskLevel
          }
        });
      }

      default:
        return res.status(400).json({ success: false, message: 'Invalid report type' });
    }
  } catch (error) {
    logger.error('Wallet report error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
};

// Redeem loyalty points to wallet balance
exports.redeemPoints = async (req, res) => {
  try {
    const { points } = req.body;
    const userId = req.user.id;

    if (!points || points <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid points amount' });
    }

    // Get conversion rate from settings (per-tenant, cached)
    const { getSettings } = require('../utils/settingsCache');
    const settings = await getSettings(req);
    const pointsToRupee = settings?.wallet?.pointsToRupee || 0.1; // default: 10 points = ₹1

    const rupeesEarned = Math.round(points * pointsToRupee * 100) / 100;

    // H2: Atomic points check + deduction to prevent double-spend (per-tenant)
    const tf = tenantFilter(req);

    // ADM-057 — wallet must be active.
    try { await assertWalletActiveOrNull(userId, tf); }
    catch (gateErr) {
      return res.status(gateErr.httpStatus || 403).json({
        success: false, code: gateErr.code, message: gateErr.message,
      });
    }

    const wallet = await Wallet.findOneAndUpdate(
      { user: userId, loyaltyPoints: { $gte: points }, ...tf },
      { $inc: { loyaltyPoints: -points, balance: rupeesEarned } },
      { returnDocument: 'after' }
    );

    if (!wallet) {
      const exists = await Wallet.findOne({ user: userId, ...tf });
      if (!exists) {
        return res.status(404).json({ success: false, message: 'Wallet not found' });
      }
      return res.status(400).json({ success: false, message: 'Insufficient loyalty points' });
    }

    const pointsBefore = wallet.loyaltyPoints + points;
    const balanceBefore = wallet.balance - rupeesEarned;

    // Record transaction
    const transaction = new Transaction({
      user: userId,
      restaurant: tenantId(req),
      branch: pinnedBranchId(req) || null,
      type: 'points_redeemed',
      amount: rupeesEarned,
      paymentMethod: 'points',
      description: `Redeemed ${points} points for ₹${rupeesEarned}`,
      transactionId: idGen.transactionId(),
      balanceBefore,
      balanceAfter: wallet.balance,
      status: 'completed'
    });
    await transaction.save();

    res.status(200).json({
      success: true,
      message: `Redeemed ${points} points for ₹${rupeesEarned}`,
      pointsRedeemed: points,
      rupeesAdded: rupeesEarned,
      newBalance: wallet.balance,
      newPoints: wallet.loyaltyPoints,
    });
  } catch (error) {
    logger.error('Points redemption error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to redeem points' });
  }
};
