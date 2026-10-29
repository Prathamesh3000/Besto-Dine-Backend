/**
 * apiKeyAuth(scope) — authentication for the public API (/api/public/v1).
 *
 *   Authorization: Bearer bd_live_<prefix>_<secret>     (or X-API-Key: ...)
 *
 * Keys are never accepted in the query string (URLs end up in logs).
 *
 * What it does, in order:
 *   1. parse the key, look it up by its public prefix, compare the sha256
 *      of the secret in constant time (a dummy compare runs for unknown
 *      prefixes so timing does not reveal which prefixes exist)
 *   2. reject revoked and expired keys
 *   3. require the route's scope on the key
 *   4. load the key's restaurant like attachTenant does: suspended /
 *      cancelled tenants are blocked (TENANT_SUSPENDED), and the tenant
 *      must still have the `publicApi` feature (a downgraded plan stops
 *      its keys working without deleting them)
 *   5. set req.restaurant / req.branch=null / req.apiKey and run the rest
 *      of the chain inside the request context (utils/requestContext), so
 *      the tenant-scope Mongoose plugin behaves exactly as for staff calls
 *   6. apply the per-key rate limit (utils/rateLimitStore, so it is shared
 *      across instances when REDIS_URL is set)
 *
 * Every public API query still carries `restaurant: req.restaurant._id`
 * explicitly; the context is the safety net, not the mechanism.
 */
'use strict';

const ApiKey = require('../models/apiKey');
const Restaurant = require('../models/restaurant');
const { parseApiKey, verifySecret } = require('../utils/apiKeys');
const { hasFeature } = require('../utils/featureAccess');
const { makeLimiter } = require('../utils/rateLimitStore');
const { runWithContext, contextFromRequest } = require('../utils/requestContext');
const logger = require('../utils/logger');

const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;
// Compared against when the prefix is unknown, to keep timing flat.
const DUMMY_HASH = '0'.repeat(64);

function deny(res, status, code, message) {
    return res.status(status).json({ success: false, code, message });
}

function extractKey(req) {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    const header = req.headers['x-api-key'];
    return typeof header === 'string' ? header.trim() : '';
}

function perKeyLimit() {
    const n = Number(process.env.PUBLIC_API_RATE_LIMIT_PER_MIN);
    return Number.isFinite(n) && n > 0 ? n : 120;
}

let limiter = null;
function getLimiter() {
    if (!limiter) {
        limiter = makeLimiter({
            name: 'public-api-key',
            windowMs: 60 * 1000,
            limit: () => perKeyLimit(),
            keyGenerator: (req) => `key:${req.apiKey ? String(req.apiKey._id) : 'anon'}`,
            message: { success: false, code: 'RATE_LIMITED', message: 'Rate limit exceeded for this API key. Slow down and retry.' },
            standardHeaders: true,
            legacyHeaders: false,
        });
    }
    return limiter;
}

const apiKeyAuth = (scope) => async (req, res, next) => {
    try {
        const raw = extractKey(req);
        if (!raw) return deny(res, 401, 'API_KEY_REQUIRED', 'Send your API key as "Authorization: Bearer bd_live_...".');
        const parsed = parseApiKey(raw);
        if (!parsed) return deny(res, 401, 'API_KEY_INVALID', 'The API key is not valid.');

        const key = await ApiKey.findOne({ prefix: parsed.prefix }).select('+hash').setOptions({ skipTenantScope: true });
        const secretOk = verifySecret(parsed.secret, key ? key.hash : DUMMY_HASH);
        if (!key || !secretOk) return deny(res, 401, 'API_KEY_INVALID', 'The API key is not valid.');
        if (key.revokedAt) return deny(res, 401, 'API_KEY_REVOKED', 'This API key has been revoked.');
        if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
            return deny(res, 401, 'API_KEY_EXPIRED', 'This API key has expired.');
        }
        if (scope && !(key.scopes || []).includes(scope)) {
            return deny(res, 403, 'INSUFFICIENT_SCOPE', `This API key does not have the "${scope}" scope.`);
        }

        const restaurant = await Restaurant.findById(key.restaurant);
        if (!restaurant) return deny(res, 403, 'TENANT_MISSING', 'The restaurant for this key is no longer available.');
        if (restaurant.status === 'suspended' || restaurant.status === 'cancelled') {
            return deny(res, 403, 'TENANT_SUSPENDED', 'This restaurant is currently unavailable.');
        }
        if (!hasFeature(restaurant, 'publicApi')) {
            return deny(res, 403, 'FEATURE_LOCKED', 'The restaurant\'s plan does not include API access.');
        }

        req.restaurant = restaurant;
        req.branch = null;
        req.apiKey = { _id: key._id, name: key.name, prefix: key.prefix, scopes: key.scopes };

        if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
            ApiKey.updateOne({ _id: key._id, restaurant: key.restaurant }, { $set: { lastUsedAt: new Date() } })
                .catch((err) => logger.warn('apiKey.lastUsed.failed', { error: err.message }));
        }

        return runWithContext(contextFromRequest(req), () => getLimiter()(req, res, next));
    } catch (err) {
        logger.error('apiKeyAuth failed', { error: err.message });
        return deny(res, 500, 'AUTH_FAILED', 'Could not authenticate the request.');
    }
};

module.exports = { apiKeyAuth, extractKey, _perKeyLimit: perKeyLimit };
