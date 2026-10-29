const mongoose = require('mongoose');

// Durable record of an inventory deduction that did not complete cleanly
// when an order moved to 'preparing' (services/inventoryDeductionService.js).
// One row per order. The retry worker (utils/inventoryDeductionRetryJob.js)
// picks up `pending` + `retryable` rows whose nextAttemptAt has passed.
//
//   pending  - waiting for (another) automatic attempt
//   done     - the order's stock is deducted (marker on the order is set)
//   failed   - gave up (attempt cap) or needs a human (partial deduction /
//              item-level problems such as a unit mismatch)
//
// Rows are operational telemetry, so a TTL index drops them after 60 days.
const inventoryDeductionJobSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    order:      { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderId:    { type: String, default: '' },
    state:      { type: String, enum: ['pending', 'done', 'failed'], default: 'pending', index: true },
    // false = an automatic retry cannot help (partial deduction already
    // happened, or the problem is the recipe/inventory data itself).
    retryable:  { type: Boolean, default: true },
    attempts:   { type: Number, default: 0 },
    lastError:  { type: String, default: '' },
    errors:     { type: [mongoose.Schema.Types.Mixed], default: undefined },
    nextAttemptAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    completedAt:   { type: Date, default: null },
}, { timestamps: true });

inventoryDeductionJobSchema.index({ restaurant: 1, order: 1 }, { unique: true });
inventoryDeductionJobSchema.index({ state: 1, retryable: 1, nextAttemptAt: 1 });
inventoryDeductionJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

inventoryDeductionJobSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.models.InventoryDeductionJob
    || mongoose.model('InventoryDeductionJob', inventoryDeductionJobSchema);
