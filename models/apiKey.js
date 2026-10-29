const mongoose = require('mongoose');

// Tenant API key for the read-only public API (/api/public/v1).
//
// The full key is `bd_live_<prefix>_<secret>` and is shown to the owner
// exactly once, at creation / rotation. Only `prefix` (public lookup id)
// and `hash` (sha256 of the secret) are stored — see utils/apiKeys.js.
// Never select or return `hash` from a management endpoint.
const SCOPES = ['read:orders', 'read:menu', 'read:sales', 'read:inventory', 'read:bookings'];

const apiKeySchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    name:       { type: String, required: true, trim: true, maxlength: 80 },
    prefix:     { type: String, required: true, unique: true, index: true },
    hash:       { type: String, required: true, select: false },
    scopes:     { type: [{ type: String, enum: SCOPES }], default: [] },
    lastUsedAt: { type: Date, default: null },
    expiresAt:  { type: Date, default: null },
    revokedAt:  { type: Date, default: null },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

apiKeySchema.index({ restaurant: 1, revokedAt: 1, createdAt: -1 });

// Auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
apiKeySchema.plugin(require('../utils/tenantScopePlugin'));

const ApiKey = mongoose.model('ApiKey', apiKeySchema);
ApiKey.SCOPES = SCOPES;
module.exports = ApiKey;
