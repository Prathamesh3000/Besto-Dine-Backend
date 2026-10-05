const mongoose = require('mongoose');
const StaffWallet = require('../models/staffWallet');
const StaffWalletTransaction = require('../models/staffWalletTransaction');
const StaffWithdrawal = require('../models/staffWithdrawal');
const logger = require('../utils/logger');
const User = require('../models/user');
const { tenantFilter, tenantId, pinnedBranchId } = require('../utils/tenantScope');
const { notify } = require('../services/notificationService');
const EVENTS = require('../realtime/events');

// Roles that are allowed to own a staff wallet. Chefs / admins do not
// receive customer tips so they don't need one — keeping the eligible
// set narrow is also a defence against an unrelated user accidentally
// auto-creating a wallet just by hitting GET /staff-wallet/me.
const WALLET_ROLES = new Set(['waiter', 'captain']);

// Smallest withdrawal the model accepts (StaffWithdrawal.amount min).
const MIN_WITHDRAWAL = 1;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Branch scope for the admin withdrawal endpoints. StaffWithdrawal has
 * no branch field, so a branch-pinned admin is limited to withdrawals of
 * staff whose User.branch is their pinned branch (same rule as tip
 * settlement). Returns {} for a tenant-wide admin.
 */
async function withdrawalBranchScope(req) {
    const pinned = pinnedBranchId(req);
    if (!pinned) return {};
    const staff = await User.find({ ...tenantFilter(req), branch: pinned }).select('_id').lean();
    return { user: { $in: staff.map((u) => u._id) } };
}

/**
 * Idempotently fetch (or create) the wallet doc for a given staff user.
 * Caller must run this inside an open Mongoose session if balance
 * mutations are about to follow — atomicity guarantees come from the
 * caller, not from this helper.
 */
async function getOrCreateWallet({ userId, restaurantId, session }) {
    if (!userId || !restaurantId) {
        throw new Error('getOrCreateWallet: userId and restaurantId required');
    }
    const existing = await StaffWallet.findOne({ user: userId, restaurant: restaurantId }).session(session || null);
    if (existing) return existing;
    const wallet = new StaffWallet({
        user: userId,
        restaurant: restaurantId,
        balance: 0,
        lifetimeCredits: 0,
        lifetimeDebits: 0,
    });
    await wallet.save({ session: session || null });
    return wallet;
}

/**
 * Credit a staff wallet — used by tip settlement to push money in.
 * Atomic: balance update + ledger row in one transaction.
 *
 * Returns the updated wallet doc (post-credit).
 */
async function creditWallet({ userId, restaurantId, amount, referenceKind, referenceId, note }, session) {
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('creditWallet: amount must be > 0');
    }
    const wallet = await getOrCreateWallet({ userId, restaurantId, session });
    // Round to the paisa so the ledger row matches the balance exactly.
    amount = round2(amount);
    wallet.balance = round2(wallet.balance + amount);
    wallet.lifetimeCredits = round2(wallet.lifetimeCredits + amount);
    await wallet.save({ session });

    await new StaffWalletTransaction({
        restaurant: restaurantId,
        wallet: wallet._id,
        user: userId,
        type: 'tip-credit',
        direction: 'credit',
        amount,
        balanceAfter: wallet.balance,
        referenceKind: referenceKind || 'TipSettlement',
        referenceId: referenceId || null,
        note: note || '',
    }).save({ session });

    return wallet;
}

// ─── Waiter-facing: GET /staff-wallet/me ──────────────────────────────────
exports.getMyWallet = async (req, res) => {
    try {
        if (!WALLET_ROLES.has(req.user?.role)) {
            return res.status(403).json({ success: false, message: 'Wallet is only available for waiter and captain roles.' });
        }
        const userId = req.user._id;
        const restaurantId = tenantId(req);
        const wallet = await getOrCreateWallet({ userId, restaurantId });

        const [transactions, withdrawals] = await Promise.all([
            StaffWalletTransaction.find({ user: userId, ...tenantFilter(req) })
                .sort({ createdAt: -1 })
                .limit(50)
                .lean(),
            StaffWithdrawal.find({ user: userId, ...tenantFilter(req) })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
        ]);

        const pendingWithdrawalAmount = withdrawals
            .filter((w) => w.status === 'pending')
            .reduce((s, w) => s + w.amount, 0);

        res.status(200).json({
            success: true,
            wallet: {
                _id: wallet._id,
                balance: wallet.balance,
                lifetimeCredits: wallet.lifetimeCredits,
                lifetimeDebits: wallet.lifetimeDebits,
                status: wallet.status,
                pendingWithdrawalAmount,
            },
            transactions,
            withdrawals,
        });
    } catch (err) {
        logger.error('getMyWallet error:', { error: err.message });
        res.status(500).json({ success: false, message: 'Failed to fetch wallet' });
    }
};

// ─── Waiter-facing: POST /staff-wallet/withdraw ───────────────────────────
exports.requestWithdrawal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        if (!WALLET_ROLES.has(req.user?.role)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(403).json({ success: false, message: 'Withdrawals are only allowed for waiter / captain.' });
        }

        const { amount, method, upiId, bankName, accountHolder, accountNumber, ifsc, note } = req.body || {};
        const numericAmount = Math.round(Number(amount) * 100) / 100;
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
        }
        if (numericAmount < MIN_WITHDRAWAL) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: `Minimum withdrawal is ₹${MIN_WITHDRAWAL}.` });
        }
        if (!['Cash', 'UPI', 'Bank'].includes(method)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: "Method must be 'Cash', 'UPI' or 'Bank'." });
        }

        // Per-method validation. UPI must look UPI-like (loose check —
        // exhaustive validation is the bank's job at payout time, not
        // ours). Bank requires the basic three fields the admin will
        // need to make the actual transfer.
        if (method === 'UPI') {
            if (!upiId || typeof upiId !== 'string' || !/^[\w.\-]{2,}@[\w]{2,}$/.test(upiId.trim())) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ success: false, message: 'Please enter a valid UPI ID (eg. name@upi).' });
            }
        }
        if (method === 'Bank') {
            if (!accountNumber || !ifsc || !accountHolder) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ success: false, message: 'Bank withdrawals need account holder, account number and IFSC.' });
            }
        }

        const userId = req.user._id;
        const restaurantId = tenantId(req);
        const wallet = await getOrCreateWallet({ userId, restaurantId, session });

        if (wallet.status !== 'active') {
            await session.abortTransaction();
            session.endSession();
            return res.status(403).json({ success: false, message: 'Your wallet is currently frozen. Please contact admin.' });
        }
        if (numericAmount > wallet.balance) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: `Insufficient balance. Available: ₹${wallet.balance.toFixed(2)}` });
        }

        // Reserve the amount immediately so two rapid taps can't double-
        // spend the same balance. Reject path refunds; pay path is a no-op
        // (the debit is already real).
        wallet.balance = Math.round((wallet.balance - numericAmount) * 100) / 100;
        wallet.lifetimeDebits = Math.round((wallet.lifetimeDebits + numericAmount) * 100) / 100;
        await wallet.save({ session });

        const withdrawal = new StaffWithdrawal({
            restaurant: restaurantId,
            user: userId,
            wallet: wallet._id,
            amount: numericAmount,
            method,
            upiId: method === 'UPI' ? String(upiId).trim() : undefined,
            bankName: method === 'Bank' ? String(bankName || '').trim() : undefined,
            accountHolder: method === 'Bank' ? String(accountHolder).trim() : undefined,
            accountNumber: method === 'Bank' ? String(accountNumber).trim() : undefined,
            ifsc: method === 'Bank' ? String(ifsc).trim().toUpperCase() : undefined,
            note: note ? String(note).trim().slice(0, 300) : undefined,
            status: 'pending',
        });
        await withdrawal.save({ session });

        await new StaffWalletTransaction({
            restaurant: restaurantId,
            wallet: wallet._id,
            user: userId,
            type: 'withdrawal-debit',
            direction: 'debit',
            amount: numericAmount,
            balanceAfter: wallet.balance,
            referenceKind: 'StaffWithdrawal',
            referenceId: withdrawal._id,
            note: `Withdrawal requested via ${method}`,
        }).save({ session });

        await session.commitTransaction();
        session.endSession();

        // Notify admins so they can act on it. We persist the
        // Notification AND fire a socket so dashboards open right now
        // see it instantly. Sent after the commit (notify never throws),
        // so a notification failure can't roll back the withdrawal.
        await notify({
            restaurant: restaurantId,
            branch: null,
            audience: 'admin',
            event: EVENTS.STAFF_WITHDRAWAL_NEW,
            notification: {
                title: 'Tip Withdrawal Requested',
                description: `${req.user.name || 'A staff member'} requested ₹${numericAmount.toFixed(0)} via ${method}.`,
                category: 'Payment',
                recipientRole: 'admin',
                priority: 'medium',
                meta: { withdrawalId: withdrawal._id.toString(), amount: numericAmount, method },
            },
            payload: {
                withdrawalId: withdrawal._id.toString(),
                userId: userId.toString(),
                amount: numericAmount,
                method,
            },
        });

        logger.info(`Staff withdrawal requested: user=${userId} amount=₹${numericAmount} method=${method}`);

        const populated = await StaffWithdrawal.findById(withdrawal._id)
            .populate('user', 'name avatar staffId role')
            .lean();
        res.status(201).json({
            success: true,
            withdrawal: populated,
            wallet: { balance: wallet.balance },
        });
    } catch (err) {
        try { await session.abortTransaction(); } catch { /* already aborted */ }
        session.endSession();
        logger.error('requestWithdrawal error:', { error: err.message });
        res.status(500).json({ success: false, message: 'Failed to request withdrawal.' });
    }
};

// ─── Admin-facing: GET /staff-wallet/withdrawals ──────────────────────────
exports.listWithdrawals = async (req, res) => {
    try {
        const status = ['pending', 'paid', 'rejected'].includes(req.query.status)
            ? req.query.status
            : null;
        const scope = await withdrawalBranchScope(req);
        const filter = { ...tenantFilter(req), ...scope };
        if (status) filter.status = status;

        const withdrawals = await StaffWithdrawal.find(filter)
            .populate('user', 'name avatar staffId role')
            .populate('handledBy', 'name')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();

        // Aggregate counts so the admin badge can show "5 pending"
        // without a second round-trip.
        const counts = await StaffWithdrawal.aggregate([
            { $match: { ...tenantFilter(req), ...scope } },
            { $group: { _id: '$status', n: { $sum: 1 } } },
        ]);
        const pendingCount = counts.find((c) => c._id === 'pending')?.n || 0;

        res.status(200).json({ success: true, withdrawals, pendingCount });
    } catch (err) {
        logger.error('listWithdrawals error:', { error: err.message });
        res.status(500).json({ success: false, message: 'Failed to fetch withdrawals' });
    }
};

// ─── Admin-facing: POST /staff-wallet/withdrawals/:id/approve ─────────────
// Admin marks the withdrawal as paid (cash handed over / UPI transfer
// done outside the app). Just flips status — no balance change because
// the request-time debit was already permanent.
exports.approveWithdrawal = async (req, res) => {
    try {
        const { id } = req.params;
        const { txnRef } = req.body || {};
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal id' });
        }
        const scoped = { _id: id, ...tenantFilter(req), ...(await withdrawalBranchScope(req)) };
        // Atomic pending → paid transition: a concurrent approve or reject
        // that already moved the row out of 'pending' makes this a no-op.
        const set = { status: 'paid', handledBy: req.user._id, handledAt: new Date() };
        if (txnRef) set.txnRef = String(txnRef).trim().slice(0, 100);
        const w = await StaffWithdrawal.findOneAndUpdate(
            { ...scoped, status: 'pending' },
            { $set: set },
            { returnDocument: 'after', runValidators: true },
        );
        if (!w) {
            const existing = await StaffWithdrawal.findOne(scoped).select('status').lean();
            if (!existing) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
            return res.status(409).json({ success: false, message: `Already ${existing.status}, cannot approve again.` });
        }

        // Notify the waiter so their app updates instantly.
        await notify({
            restaurant: w.restaurant,
            recipients: w.user,
            event: EVENTS.STAFF_WITHDRAWAL_UPDATED,
            notification: {
                title: 'Withdrawal Paid',
                description: `Your withdrawal of ₹${w.amount.toFixed(0)} has been marked as paid by the admin.`,
                category: 'Payment',
                recipientRole: 'waiter',
                priority: 'medium',
                meta: { withdrawalId: w._id.toString(), amount: w.amount },
            },
            payload: { withdrawalId: w._id.toString(), status: 'paid' },
        });

        logger.info(`Staff withdrawal approved: id=${w._id} by=${req.user._id}`);
        res.status(200).json({ success: true, withdrawal: w });
    } catch (err) {
        logger.error('approveWithdrawal error:', { error: err.message });
        res.status(500).json({ success: false, message: 'Failed to approve withdrawal' });
    }
};

// ─── Admin-facing: POST /staff-wallet/withdrawals/:id/reject ──────────────
// Refunds the held amount back to the waiter's balance and stamps the
// rejection reason for audit. Atomic: balance restore + ledger row in
// one transaction so a crash mid-update can't leave the wallet short.
exports.rejectWithdrawal = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;
        const { reason } = req.body || {};
        if (!mongoose.Types.ObjectId.isValid(id)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: 'Invalid withdrawal id' });
        }
        const tf = tenantFilter(req);
        const scoped = { _id: id, ...tf, ...(await withdrawalBranchScope(req)) };
        // Atomic pending → rejected claim inside the transaction: a
        // concurrent approve (or reject) can no longer also win, because
        // whichever write lands second no longer matches status 'pending'.
        const w = await StaffWithdrawal.findOneAndUpdate(
            { ...scoped, status: 'pending' },
            { $set: {
                status: 'rejected',
                rejectReason: reason ? String(reason).trim().slice(0, 300) : 'No reason provided',
                handledBy: req.user._id,
                handledAt: new Date(),
            } },
            { returnDocument: 'after', session },
        );
        if (!w) {
            const existing = await StaffWithdrawal.findOne(scoped).select('status').session(session).lean();
            await session.abortTransaction();
            session.endSession();
            if (!existing) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
            return res.status(409).json({ success: false, message: `Already ${existing.status}, cannot reject.` });
        }

        const wallet = await StaffWallet.findOne({ _id: w.wallet, ...tf }).session(session);
        if (!wallet) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ success: false, message: 'Wallet not found' });
        }
        wallet.balance = Math.round((wallet.balance + w.amount) * 100) / 100;
        wallet.lifetimeDebits = Math.round((wallet.lifetimeDebits - w.amount) * 100) / 100;
        if (wallet.lifetimeDebits < 0) wallet.lifetimeDebits = 0;   // guard against drift
        await wallet.save({ session });

        await new StaffWalletTransaction({
            restaurant: w.restaurant,
            wallet: wallet._id,
            user: w.user,
            type: 'withdrawal-refund',
            direction: 'credit',
            amount: w.amount,
            balanceAfter: wallet.balance,
            referenceKind: 'StaffWithdrawal',
            referenceId: w._id,
            note: `Withdrawal rejected: ${w.rejectReason}`,
        }).save({ session });

        await session.commitTransaction();
        session.endSession();

        // Sent after the commit (notify never throws) so a notification
        // failure can't roll back the refund.
        await notify({
            restaurant: w.restaurant,
            recipients: w.user,
            event: EVENTS.STAFF_WITHDRAWAL_UPDATED,
            notification: {
                title: 'Withdrawal Rejected',
                description: `Your withdrawal of ₹${w.amount.toFixed(0)} was declined. Balance refunded.`,
                category: 'Payment',
                recipientRole: 'waiter',
                priority: 'medium',
                meta: { withdrawalId: w._id.toString(), amount: w.amount, reason: w.rejectReason },
            },
            payload: { withdrawalId: w._id.toString(), status: 'rejected', amount: w.amount },
        });

        logger.info(`Staff withdrawal rejected: id=${w._id} by=${req.user._id} amount=₹${w.amount}`);
        res.status(200).json({ success: true, withdrawal: w, wallet: { balance: wallet.balance } });
    } catch (err) {
        try { await session.abortTransaction(); } catch { /* already aborted */ }
        session.endSession();
        logger.error('rejectWithdrawal error:', { error: err.message });
        res.status(500).json({ success: false, message: 'Failed to reject withdrawal' });
    }
};

// Exposed so tipController can credit on settle inside its own transaction.
module.exports.creditWallet = creditWallet;
module.exports.getOrCreateWallet = getOrCreateWallet;
