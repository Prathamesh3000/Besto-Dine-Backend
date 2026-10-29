const mongoose = require('mongoose');

// A tenant's outbound webhook subscription. `secret` signs every delivery
// (utils/webhookSigner.js) and is returned to the owner only at creation
// (and on explicit rotate); list/get responses omit it.
const EVENTS = ['order.created', 'order.paid', 'order.cancelled', 'refund.created', 'booking.created', 'stock.low'];

const webhookEndpointSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    url:        { type: String, required: true, trim: true, maxlength: 500 },
    description:{ type: String, default: '', trim: true, maxlength: 200 },
    secret:     { type: String, required: true, select: false },
    events:     { type: [{ type: String, enum: EVENTS }], default: [] },
    active:     { type: Boolean, default: true },
    consecutiveFailures: { type: Number, default: 0 },
    disabledAt: { type: Date, default: null },
    disabledReason: { type: String, default: '' },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

webhookEndpointSchema.index({ restaurant: 1, active: 1 });

webhookEndpointSchema.plugin(require('../utils/tenantScopePlugin'));

const WebhookEndpoint = mongoose.model('WebhookEndpoint', webhookEndpointSchema);
WebhookEndpoint.EVENTS = EVENTS;
module.exports = WebhookEndpoint;
