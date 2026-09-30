const mongoose = require('mongoose');
const Tip = require('../models/tip');
const TipSettlement = require('../models/tipSettlement');
const User = require('../models/user');
const logger = require('../utils/logger');
const { creditWallet } = require('./staffWalletController');

const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');

// Get all pending tips aggregated by waiter (includes captains)
exports.getPendingTipsByWaiter = async (req, res) => {
  try {
    // The Tip model has no `branch` field, but every tip points at a
    // waiter (User) whose `branch` IS pinned. So a Branch Admin should
    // only see tips destined for waiters at their own branch — gate by
    // first resolving the waiter set, then filtering tips against it.
    const tf = tenantFilter(req);
    const pinned = pinnedBranchId(req);

    if (pinned) {
      const branchWaiterIds = await User.find({
        ...tf,
        branch: pinned,
        role: { $in: ['waiter', 'captain'] },
      }).select('_id').lean();
      if (branchWaiterIds.length === 0) {
        return res.status(200).json({ success: true, waiters: [] });
      }
      var waiterScopeFilter = { waiter: { $in: branchWaiterIds.map(w => w._id) } };
    } else {
      var waiterScopeFilter = {};
    }

    // Aggregate pending tips grouped by waiter with real totals
    // (per-tenant, and for pinned admin further constrained to their
    // branch's waiters).
    const aggregated = await Tip.aggregate([
      { $match: { status: 'pending', ...tf, ...waiterScopeFilter } },
      {
        $group: {
          _id: '$waiter',
          pendingCount: { $sum: 1 },
          pendingAmount: { $sum: '$amount' },
          tipIds: { $push: '$_id' },
        }
      }
    ]);

    if (aggregated.length === 0) {
      return res.status(200).json({ success: true, waiters: [] });
    }

    // Populate waiter details and attach individual tips (waiters are
    // also tenant-scoped via User.restaurant set during the backfill).
    const waiterIds = aggregated.map(a => a._id);
    const [waiters, allPendingTips] = await Promise.all([
      User.find({ _id: { $in: waiterIds } }).select('name avatar staffId role').lean(),
      Tip.find({ status: 'pending', waiter: { $in: waiterIds }, ...tf })
        .populate('order', 'orderId table')
        .sort({ createdAt: -1 })
        .lean()
    ]);

    const waiterMap = {};
    for (const w of waiters) waiterMap[w._id.toString()] = w;

    const result = aggregated.map(agg => {
      const w = waiterMap[agg._id.toString()];
      if (!w) return null;
      return {
        _id: agg._id,
        name: w.name,
        avatar: w.avatar,
        staffId: w.staffId,
        role: w.role,
        pendingCount: agg.pendingCount,
        pendingAmount: agg.pendingAmount,
        settleAmount: agg.pendingAmount,
        pendingTips: allPendingTips
          .filter(t => t.waiter.toString() === agg._id.toString())
          .map(t => ({
            _id: t._id,
            amount: t.amount,
            orderId: t.order?.orderId || '—',
            createdAt: t.createdAt
          }))
      };
    }).filter(Boolean);

    res.status(200).json({ success: true, waiters: result });
  } catch (error) {
    logger.error('getPendingTipsByWaiter error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch pending tips' });
  }
};

// Settle tips for a specific waiter — with validation and duplicate prevention
exports.settleTips = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { waiterId, paymentMethod, note } = req.body;

    // ── Validation ──────────────────────────────────────────────────────
    if (!waiterId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'waiterId is required' });
    }
    if (!['Cash', 'Online'].includes(paymentMethod)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'paymentMethod must be Cash or Online' });
    }

    // ── Find pending tips within the transaction (locks them, scoped) ─
    const tf = tenantFilter(req);

    // Branch-pinned admin can only settle tips for waiters at their own
    // branch — block cross-branch settlements before locking any rows.
    const pinned = pinnedBranchId(req);
    if (pinned) {
      const waiter = await User.findOne({ _id: waiterId, ...tf }).select('branch').lean();
      if (!waiter || String(waiter.branch || '') !== String(pinned)) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ success: false, message: 'Waiter does not belong to your branch.' });
      }
    }

    const tipsToSettle = await Tip.find({ waiter: waiterId, status: 'pending', ...tf }).session(session);

    if (tipsToSettle.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'No pending tips to settle for this waiter' });
    }

    // ── Calculate the real amount from DB (never trust frontend amount) ─
    const calculatedAmount = tipsToSettle.reduce((sum, t) => sum + t.amount, 0);

    // ── Create settlement record ────────────────────────────────────────
    const settlement = new TipSettlement({
      waiter: waiterId,
      restaurant: tenantId(req),
      amount: calculatedAmount,
      tipsSettledCount: tipsToSettle.length,
      paymentMethod,
      settledBy: req.user._id,
      note: note || ''
    });
    await settlement.save({ session });

    // ── Update all tips to settled (scoped) ─────────────────────────────
    await Tip.updateMany(
      { _id: { $in: tipsToSettle.map(t => t._id) }, status: 'pending', ...tf },
      { status: 'settled', settlement: settlement._id },
      { session }
    );

    // ── Credit the waiter's in-app wallet (atomic with the settle) ──────
    // Same Mongoose session as the tip update + settlement insert so
    // either everything commits or nothing does — a crash here can't
    // leave the tips marked 'settled' without the wallet credit.
    await creditWallet({
      userId: waiterId,
      restaurantId: tenantId(req),
      amount: calculatedAmount,
      referenceKind: 'TipSettlement',
      referenceId: settlement._id,
      note: `Tip settlement of ${tipsToSettle.length} tip(s) via ${paymentMethod}`,
    }, session);

    // ── Commit transaction ──────────────────────────────────────────────
    await session.commitTransaction();
    session.endSession();

    logger.info(`Tips settled: waiter=${waiterId}, amount=₹${calculatedAmount}, count=${tipsToSettle.length}, by=${req.user._id}`);

    // Populate the settlement for the response
    const populated = await TipSettlement.findById(settlement._id)
      .populate('waiter', 'name avatar branch')
      .populate('settledBy', 'name');

    // WAI-025 — notify the waiter their tip was settled. Bell badge
    // wants a persisted Notification row, real-time toast wants a
    // socket emit on the waiter's user-id room. Best-effort (notify never
    // throws) so a flaky notification path can't roll back the
    // already-committed wallet credit.
    try {
      const { notify } = require('../services/notificationService');
      const EVENTS = require('../realtime/events');
      const tenant = tenantId(req);
      const waiterBranch = populated?.waiter?.branch || null;
      const amountLabel = `₹${calculatedAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
      const countLabel = tipsToSettle.length === 1 ? '1 tip' : `${tipsToSettle.length} tips`;

      await notify({
        restaurant: tenant,
        branch: waiterBranch,
        recipients: waiterId,
        notification: {
          title: `Tip Settled — ${amountLabel}`,
          description: `${amountLabel} credited to your wallet via ${paymentMethod} (${countLabel}).`,
          category: 'Wallet',
          recipientRole: 'waiter',
          priority: 'medium',
          meta: { settlementId: settlement._id.toString(), amount: calculatedAmount, paymentMethod },
        },
        payload: {
          title: 'Tip Settled',
          description: `${amountLabel} credited to your wallet.`,
        },
        // Specialized event for any tip / wallet UI that wants to update
        // its balance + transactions list without a full refetch.
        also: [{
          event: EVENTS.TIP_SETTLED,
          payload: {
            amount: calculatedAmount,
            settlementId: settlement._id,
            paymentMethod,
          },
        }],
      });
    } catch (err) {
      logger.warn('Tip settle notification failed', { error: err.message });
    }

    res.status(200).json({ success: true, settlement: populated });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    logger.error('settleTips error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Settlement failed. No tips were modified.' });
  }
};

// Get tips for the logged-in waiter (their own tips)
exports.getMyTips = async (req, res) => {
  try {
    const waiterId = req.user._id;
    const tf = tenantFilter(req);

    const tips = await Tip.find({ waiter: waiterId, ...tf })
      .populate('order', 'orderId table')
      .sort({ createdAt: -1 })
      .lean();

    // Populate table names (scoped)
    const Table = require('../models/table');
    const tableIds = [...new Set(tips.map(t => t.order?.table?.toString()).filter(Boolean))];
    const tables = await Table.find({ _id: { $in: tableIds }, ...tf }).select('name').lean();
    const tableMap = {};
    for (const t of tables) tableMap[t._id.toString()] = t.name;

    for (const tip of tips) {
      tip.tableName = (tip.order?.table && tableMap[tip.order.table.toString()]) || '—';
    }

    // Calculate stats — refunded tips are shown in the list (for audit
    // trail) but excluded from every "earned" aggregate so the waiter's
    // totals reflect real income, not cancelled orders.
    const earnedTips = tips.filter(t => t.status !== 'refunded');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTips = earnedTips.filter(t => new Date(t.createdAt) >= today);
    const pendingTips = earnedTips.filter(t => t.status === 'pending');
    const settledTips = earnedTips.filter(t => t.status === 'settled');

    // Weekly aggregation (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weeklyTips = earnedTips.filter(t => new Date(t.createdAt) >= weekAgo);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weeklyByDay = {};
    for (const t of weeklyTips) {
      const dayName = days[new Date(t.createdAt).getDay()];
      weeklyByDay[dayName] = (weeklyByDay[dayName] || 0) + t.amount;
    }
    const todayDayName = days[new Date().getDay()];
    const weeklyBreakdown = Object.entries(weeklyByDay).map(([day, amount]) => ({
      day: day === todayDayName ? `${day}(Today)` : day,
      amount: String(amount)
    }));

    res.status(200).json({
      success: true,
      stats: {
        todayTotal: todayTips.reduce((s, t) => s + t.amount, 0),
        todayCount: todayTips.length,
        pendingTotal: pendingTips.reduce((s, t) => s + t.amount, 0),
        pendingCount: pendingTips.length,
        settledTotal: settledTips.reduce((s, t) => s + t.amount, 0),
        settledCount: settledTips.length,
        totalEarned: earnedTips.reduce((s, t) => s + t.amount, 0),
        totalCount: earnedTips.length,
      },
      tips: tips.map(t => ({
        id: t._id,
        table: t.tableName,
        orderId: t.order?.orderId || '—',
        date: new Date(t.createdAt).toISOString().split('T')[0],
        time: new Date(t.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
        amount: String(t.amount),
        status: t.status === 'pending'
          ? 'Pending'
          : t.status === 'refunded'
            ? 'Refunded'
            : 'Settled',
      })),
      weeklyTips: weeklyBreakdown,
    });
  } catch (error) {
    logger.error('getMyTips error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch tips' });
  }
};

// Get settlement history
exports.getSettlementHistory = async (req, res) => {
  try {
    const history = await TipSettlement.find(tenantFilter(req))
      .populate('waiter', 'name avatar staffId role')
      .populate('settledBy', 'name')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, history });
  } catch (error) {
    logger.error('getSettlementHistory error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
};
