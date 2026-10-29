/**
 * Developers admin API: tenant API keys and outbound webhooks.
 *
 * Mounted at /api/v1/developer behind
 *   protect -> adminExclusive (restaurant owner) -> attachTenant -> featureGate('publicApi')
 *
 * Secrets: an API key's full value and a webhook's signing secret are
 * returned ONCE (create / rotate). List and get responses never include
 * the key hash or any secret.
 */
'use strict';

const mongoose = require('mongoose');
const ApiKey = require('../models/apiKey');
const WebhookEndpoint = require('../models/webhookEndpoint');
const WebhookDelivery = require('../models/webhookDelivery');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { tenantId } = require('../utils/tenantScope');
const { generateApiKey } = require('../utils/apiKeys');
const { validateWebhookUrl } = require('../utils/safeHttpPost');
const { newSecret, newEventId, buildEnvelope, attemptDelivery } = require('../utils/webhookService');

const MAX_ACTIVE_KEYS = 20;
const MAX_ENDPOINTS = 10;
const MAX_EXPIRY_DAYS = 3650;

const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) && mongoose.isValidObjectId(v);

function keyView(k) {
    return {
        id: String(k._id),
        name: k.name,
        prefix: k.prefix,
        masked: `bd_live_${k.prefix}_${'*'.repeat(8)}`,
        scopes: k.scopes || [],
        lastUsedAt: k.lastUsedAt || null,
        expiresAt: k.expiresAt || null,
        revokedAt: k.revokedAt || null,
        status: k.revokedAt ? 'revoked' : (k.expiresAt && new Date(k.expiresAt) <= new Date() ? 'expired' : 'active'),
        createdAt: k.createdAt,
    };
}

function endpointView(e) {
    return {
        id: String(e._id),
        url: e.url,
        description: e.description || '',
        events: e.events || [],
        active: !!e.active,
        consecutiveFailures: e.consecutiveFailures || 0,
        disabledAt: e.disabledAt || null,
        disabledReason: e.disabledReason || '',
        createdAt: e.createdAt,
    };
}

function deliveryView(d) {
    return {
        id: String(d._id),
        endpointId: String(d.endpoint),
        eventId: d.eventId,
        type: d.type,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt : null,
        responseCode: d.responseCode ?? null,
        lastError: d.lastError || '',
        createdAt: d.createdAt,
        deliveredAt: d.deliveredAt || null,
    };
}

function cleanScopes(input) {
    if (!Array.isArray(input) || !input.length) throw AppError.badRequest('Pick at least one scope.', 'INVALID_SCOPES');
    const bad = input.filter((s) => !ApiKey.SCOPES.includes(s));
    if (bad.length) throw AppError.badRequest(`Unknown scope: ${bad.join(', ')}`, 'INVALID_SCOPES');
    return [...new Set(input)];
}

function cleanEvents(input) {
    if (!Array.isArray(input) || !input.length) throw AppError.badRequest('Pick at least one event.', 'INVALID_EVENTS');
    const bad = input.filter((s) => !WebhookEndpoint.EVENTS.includes(s));
    if (bad.length) throw AppError.badRequest(`Unknown event: ${bad.join(', ')}`, 'INVALID_EVENTS');
    return [...new Set(input)];
}

function cleanUrl(input) {
    const v = validateWebhookUrl(input);
    if (!v.ok) throw AppError.badRequest(v.error, 'INVALID_WEBHOOK_URL');
    return v.url.toString();
}

function cleanText(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// ─── Meta ───────────────────────────────────────────────────────────────

exports.meta = (req, res) => {
    res.json({ success: true, scopes: ApiKey.SCOPES, events: WebhookEndpoint.EVENTS });
};

// ─── API keys ───────────────────────────────────────────────────────────

exports.listKeys = asyncHandler(async (req, res) => {
    const keys = await ApiKey.find({ restaurant: tenantId(req) }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, keys: keys.map(keyView) });
}, 'Failed to list API keys');

exports.createKey = asyncHandler(async (req, res) => {
    const name = cleanText(req.body?.name, 80);
    if (!name) throw AppError.badRequest('Give the key a name.', 'NAME_REQUIRED');
    const scopes = cleanScopes(req.body?.scopes);
    let expiresAt = null;
    if (req.body?.expiresInDays != null && req.body.expiresInDays !== '') {
        const days = Number(req.body.expiresInDays);
        if (!Number.isFinite(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
            throw AppError.badRequest(`expiresInDays must be between 1 and ${MAX_EXPIRY_DAYS}.`, 'INVALID_EXPIRY');
        }
        expiresAt = new Date(Date.now() + days * 86400000);
    }
    const active = await ApiKey.countDocuments({ restaurant: tenantId(req), revokedAt: null });
    if (active >= MAX_ACTIVE_KEYS) {
        throw AppError.conflict(`You can have at most ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`, 'KEY_LIMIT');
    }
    const { key, prefix, hash } = generateApiKey();
    const doc = await ApiKey.create({
        restaurant: tenantId(req), name, prefix, hash, scopes, expiresAt, createdBy: req.user?._id || null,
    });
    // `key` is shown exactly once.
    res.status(201).json({ success: true, key, apiKey: keyView(doc) });
}, 'Failed to create API key');

exports.revokeKey = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('API key not found', 'KEY_NOT_FOUND');
    const doc = await ApiKey.findOneAndUpdate(
        { _id: req.params.id, restaurant: tenantId(req), revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { returnDocument: 'after' },
    );
    if (!doc) throw AppError.notFound('API key not found or already revoked', 'KEY_NOT_FOUND');
    res.json({ success: true, apiKey: keyView(doc) });
}, 'Failed to revoke API key');

// Rotate: same record (id, name, scopes, expiry), brand-new prefix + secret.
// The old secret stops working immediately.
exports.rotateKey = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('API key not found', 'KEY_NOT_FOUND');
    const { key, prefix, hash } = generateApiKey();
    const doc = await ApiKey.findOneAndUpdate(
        { _id: req.params.id, restaurant: tenantId(req), revokedAt: null },
        { $set: { prefix, hash, lastUsedAt: null } },
        { returnDocument: 'after' },
    );
    if (!doc) throw AppError.notFound('API key not found or revoked', 'KEY_NOT_FOUND');
    res.json({ success: true, key, apiKey: keyView(doc) });
}, 'Failed to rotate API key');

// ─── Webhook endpoints ──────────────────────────────────────────────────

exports.listEndpoints = asyncHandler(async (req, res) => {
    const rows = await WebhookEndpoint.find({ restaurant: tenantId(req) }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, endpoints: rows.map(endpointView) });
}, 'Failed to list webhooks');

exports.createEndpoint = asyncHandler(async (req, res) => {
    const url = cleanUrl(req.body?.url);
    const events = cleanEvents(req.body?.events);
    const count = await WebhookEndpoint.countDocuments({ restaurant: tenantId(req) });
    if (count >= MAX_ENDPOINTS) {
        throw AppError.conflict(`You can have at most ${MAX_ENDPOINTS} webhook endpoints.`, 'ENDPOINT_LIMIT');
    }
    const secret = newSecret();
    const doc = await WebhookEndpoint.create({
        restaurant: tenantId(req), url, events, secret,
        description: cleanText(req.body?.description, 200), createdBy: req.user?._id || null,
    });
    // `secret` is shown exactly once.
    res.status(201).json({ success: true, secret, endpoint: endpointView(doc) });
}, 'Failed to create webhook');

exports.updateEndpoint = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    const body = req.body || {};
    const set = {};
    if (body.url !== undefined) set.url = cleanUrl(body.url);
    if (body.events !== undefined) set.events = cleanEvents(body.events);
    if (body.description !== undefined) set.description = cleanText(body.description, 200);
    if (body.active !== undefined) {
        set.active = body.active === true;
        if (set.active) { set.consecutiveFailures = 0; set.disabledAt = null; set.disabledReason = ''; }
    }
    if (!Object.keys(set).length) throw AppError.badRequest('Nothing to update.', 'NO_CHANGES');
    const doc = await WebhookEndpoint.findOneAndUpdate(
        { _id: req.params.id, restaurant: tenantId(req) }, { $set: set }, { returnDocument: 'after' },
    );
    if (!doc) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    res.json({ success: true, endpoint: endpointView(doc) });
}, 'Failed to update webhook');

exports.deleteEndpoint = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    const doc = await WebhookEndpoint.findOneAndDelete({ _id: req.params.id, restaurant: tenantId(req) });
    if (!doc) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    await WebhookDelivery.deleteMany({ endpoint: doc._id, restaurant: tenantId(req), status: 'pending' });
    res.json({ success: true });
}, 'Failed to delete webhook');

exports.rotateEndpointSecret = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    const secret = newSecret();
    const doc = await WebhookEndpoint.findOneAndUpdate(
        { _id: req.params.id, restaurant: tenantId(req) }, { $set: { secret } }, { returnDocument: 'after' },
    );
    if (!doc) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    res.json({ success: true, secret, endpoint: endpointView(doc) });
}, 'Failed to rotate webhook secret');

// Send a signed `webhook.test` event right now and report the result.
// A test never retries and never counts towards auto-disable.
exports.sendTest = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    const ep = await WebhookEndpoint.findOne({ _id: req.params.id, restaurant: tenantId(req) }).select('+secret');
    if (!ep) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    const eventId = newEventId();
    const delivery = await WebhookDelivery.create({
        restaurant: tenantId(req), endpoint: ep._id, eventId, type: 'webhook.test',
        payload: buildEnvelope(eventId, 'webhook.test', { message: 'This is a test event from BestoDine.' }),
        status: 'pending', nextAttemptAt: new Date(Date.now() + 2 * 60 * 1000), // keeps the retry job off it
    });
    const result = await attemptDelivery(delivery, { ...ep.toObject(), active: true }, { countFailure: false, retry: false });
    res.json({ success: true, result: { ok: result.ok, status: result.status, error: result.error }, delivery: deliveryView(delivery) });
}, 'Failed to send test event');

exports.listDeliveries = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('Webhook not found', 'ENDPOINT_NOT_FOUND');
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = { restaurant: tenantId(req), endpoint: req.params.id };
    if (['pending', 'success', 'failed'].includes(req.query.status)) filter.status = req.query.status;
    const rows = await WebhookDelivery.find(filter).select('-payload').sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, deliveries: rows.map(deliveryView) });
}, 'Failed to list deliveries');

// Re-send a past delivery (same event id and payload) with a fresh retry budget.
exports.redeliver = asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw AppError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
    const delivery = await WebhookDelivery.findOne({ _id: req.params.id, restaurant: tenantId(req) });
    if (!delivery) throw AppError.notFound('Delivery not found', 'DELIVERY_NOT_FOUND');
    const ep = await WebhookEndpoint.findOne({ _id: delivery.endpoint, restaurant: tenantId(req) }).select('+secret');
    if (!ep) throw AppError.notFound('The webhook for this delivery no longer exists', 'ENDPOINT_NOT_FOUND');
    if (!ep.active) throw AppError.conflict('This webhook is disabled. Re-enable it first.', 'ENDPOINT_DISABLED');
    delivery.attempts = 0;
    delivery.status = 'pending';
    delivery.nextAttemptAt = new Date(Date.now() + 2 * 60 * 1000); // keeps the retry job off it meanwhile
    await delivery.save();
    const result = await attemptDelivery(delivery, ep.toObject(), { countFailure: false });
    res.json({ success: true, result: { ok: result.ok, status: result.status, error: result.error }, delivery: deliveryView(delivery) });
}, 'Failed to redeliver');

exports._views = { keyView, endpointView, deliveryView };
