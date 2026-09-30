const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    // Tenant link — added by Phase 1 SaaS migration. Required for all
    // tenant-scoped reads/writes after the backfill has run. The Default
    // Restaurant created by seedDefaultTenant.js owns all pre-migration data.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true,
        index: true,
    },
    // Branch isolation — a notification belongs to the branch where the
    // triggering event happened (order placed at Durga 1, table request at
    // Durga 2). null = tenant-level (legacy rows, global announcements).
    // Branch-pinned Sub Admins only see notifications matching their branch
    // or tenant-level — enforced by strictBranchFilter in the controller.
    branch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null,
        index: true,
    },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // If null, it's a global/admin notification
  },
  recipientRole: {
    type: String,
    // 'captain' — floor-billing alerts (counter-payment requests) that
    // belong to the captain, not to every waiter at the branch.
    enum: ['admin', 'chef', 'waiter', 'captain', 'customer', 'all'],
    default: 'admin'
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['Order', 'Wallet', 'Points', 'Offer', 'Reward', 'Payment', 'Service', 'System'],
    default: 'System'
  },
  status: {
    type: String,
    enum: ['unread', 'read'],
    default: 'unread'
  },
  meta: {
    orderId: String,
    amount: Number,
    table: String,
    // Floor/section name (Indoor, Outdoor, Terrace…). Carried so the
    // waiter's notification list can be grouped by section: a waiter
    // working Outdoor should be able to see their own floor's alerts
    // without reading every Indoor one. The Requests screen already
    // had floor pills; the notification list had no area data at all,
    // so it couldn't offer the same.
    area: String
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  }
}, { timestamps: true });

// Auto-delete notifications older than 30 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Compound index for efficient querying by recipient/role
notificationSchema.index({ recipient: 1, status: 1 });
notificationSchema.index({ recipientRole: 1, status: 1 });
// Tenant-scoped notification queries (unread count for admin/customer)
notificationSchema.index({ restaurant: 1, recipient: 1, status: 1 });

// BUGS_REPORT #30 — auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
notificationSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('Notification', notificationSchema);
