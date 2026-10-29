const express = require('express');
const router = express.Router();
const { protect, adminExclusive } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');
const { featureGate } = require('../middlewares/featureGate');
const c = require('../controllers/developerController');

// Owner-only (API keys and webhook secrets are as sensitive as billing) and
// gated by the `publicApi` plan feature (Gold and above, or the add-on).
router.use(protect, adminExclusive, attachTenant, featureGate('publicApi'));

router.get('/meta', c.meta);

router.get('/api-keys', c.listKeys);
router.post('/api-keys', c.createKey);
router.delete('/api-keys/:id', c.revokeKey);
router.post('/api-keys/:id/rotate', c.rotateKey);

router.get('/webhooks', c.listEndpoints);
router.post('/webhooks', c.createEndpoint);
router.patch('/webhooks/:id', c.updateEndpoint);
router.delete('/webhooks/:id', c.deleteEndpoint);
router.post('/webhooks/:id/rotate-secret', c.rotateEndpointSecret);
router.post('/webhooks/:id/test', c.sendTest);
router.get('/webhooks/:id/deliveries', c.listDeliveries);
router.post('/webhook-deliveries/:id/redeliver', c.redeliver);

module.exports = router;
