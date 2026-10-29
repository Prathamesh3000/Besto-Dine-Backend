// Thin aggregator. The Razorpay controller was split into cohesive modules
// under controllers/razorpay/ (behaviour unchanged); this file re-exports
// every name it exported before so routes, services, jobs and tests that
// require('../controllers/razorpayController') keep working untouched.
//
//   razorpay/_shared.js      settlement + gateway helpers shared by the modules
//   razorpay/orderPayment.js create-order, verify-payment, create-order checkout check
//   razorpay/webhook.js      webhook handler + plan-payment / subscription events
//   razorpay/refunds.js      admin refund + guest orphan-payment refund
//   razorpay/wallet.js       wallet recharge create / verify
//   razorpay/reconcile.js    reconciliation endpoint, scheduled job, order recovery

const orderPayment = require('./razorpay/orderPayment');
const webhook = require('./razorpay/webhook');
const refunds = require('./razorpay/refunds');
const wallet = require('./razorpay/wallet');
const reconcile = require('./razorpay/reconcile');
const shared = require('./razorpay/_shared');

exports.createRazorpayOrder = orderPayment.createRazorpayOrder;
exports.verifyPayment = orderPayment.verifyPayment;
exports.verifyCheckoutForNewOrder = orderPayment.verifyCheckoutForNewOrder;
exports.handleWebhook = webhook.handleWebhook;
exports.refundPayment = refunds.refundPayment;
exports.refundOrphanPayment = refunds.refundOrphanPayment;
exports.createWalletRechargeOrder = wallet.createWalletRechargeOrder;
exports.verifyWalletRecharge = wallet.verifyWalletRecharge;
exports.reconcilePayments = reconcile.reconcilePayments;
exports.runScheduledReconciliation = reconcile.runScheduledReconciliation;
exports.recoverCapturedPaymentForOrder = reconcile.recoverCapturedPaymentForOrder;

// Test seam: sibling settlement helpers (heldOrderAudit.test.js).
exports._settleSplitSiblings = shared.settleSplitSiblings;
exports._settleSiblingDineInRounds = shared.settleSiblingDineInRounds;
