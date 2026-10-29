/**
 * Public API v1 — read-only, authenticated with a tenant API key
 * (middlewares/apiKeyAuth.js). Mounted at /api/public/v1 in app.js,
 * outside the staff/customer /api/v1 router (no JWT, no tenant header).
 * See docs/public-api.md.
 */
const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middlewares/apiKeyAuth');
const c = require('../controllers/publicApiController');

// OpenAPI 3.1 description of this API (no auth, static document).
router.get('/openapi.json', (req, res) => res.json(require('../docs/openapi/public-v1.json')));

router.get('/orders', apiKeyAuth('read:orders'), c.listOrders);
router.get('/orders/:id', apiKeyAuth('read:orders'), c.getOrder);
router.get('/menu', apiKeyAuth('read:menu'), c.listMenu);
router.get('/sales/summary', apiKeyAuth('read:sales'), c.salesSummary);
router.get('/inventory/low-stock', apiKeyAuth('read:inventory'), c.lowStock);
router.get('/bookings', apiKeyAuth('read:bookings'), c.listBookings);

// Anything else under /api/public/v1 (including non-GET methods): JSON 404 / 405.
router.use((req, res) => {
    res.status(req.method === 'GET' ? 404 : 405).json({
        success: false,
        code: req.method === 'GET' ? 'ROUTE_NOT_FOUND' : 'METHOD_NOT_ALLOWED',
        message: req.method === 'GET' ? `No route matched ${req.method} ${req.originalUrl}.` : 'The public API is read-only.',
    });
});

module.exports = router;
