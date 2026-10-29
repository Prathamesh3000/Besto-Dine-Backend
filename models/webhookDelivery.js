const mongoose = require('mongoose');

// One attempt-series to deliver one event to one endpoint. Created by
// utils/webhookService.emitWebhookEvent, retried by the scheduled job.
// Ephemeral: a TTL index drops rows after 30 days.
const webhookDeliverySchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    endpoint:   { type: mongoose.Schema.Types.ObjectId, ref: 'WebhookEndpoint', required: true },
    eventId:    { type: String, required: true },
    type:       { type: String, required: true },
    payload:    { type: mongoose.Schema.Types.Mixed, required: true },
    status:     { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    attempts:   { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    responseCode:  { type: Number, default: null },
    lastError:  { type: String, default: '' },
    deliveredAt:{ type: Date, default: null },
}, { timestamps: true });

webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
webhookDeliverySchema.index({ restaurant: 1, endpoint: 1, createdAt: -1 });
webhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

webhookDeliverySchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('WebhookDelivery', webhookDeliverySchema);
