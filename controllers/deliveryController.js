const { getSettings } = require('../utils/settingsCache');
const { quoteDelivery } = require('../utils/deliveryDistance');
const logger = require('../utils/logger');

// @desc    Measure the home-delivery distance + fee for an address/location
// @route   POST /api/v1/orders/delivery-quote
// @access  Public (guest takeaway checkout allowed)
//
// Body: { lat?, lng?, address?, branchId? }
// The checkout calls this whenever the customer enters an address or taps
// "Use my location", so the fee shown in the bill summary is the same one
// createOrder will charge (createOrder re-runs the same quote itself — it
// never trusts a client-supplied distance or fee).
exports.getDeliveryQuote = async (req, res) => {
    try {
        const { lat, lng, address, branchId } = req.body || {};
        const cleanAddress = String(address || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 500);
        if ((lat == null || lng == null) && !cleanAddress) {
            return res.status(400).json({ success: false, code: 'DELIVERY_LOCATION_REQUIRED', message: 'Enter an address or share your location.' });
        }
        const settings = await getSettings(req);
        const quote = await quoteDelivery({ req, settings, branchId, lat, lng, address: cleanAddress });
        if (!quote.ok) {
            // 200 with success:false for the "can't measure" fallbacks so
            // the checkout can quietly show the manual distance picker.
            return res.status(quote.fallback ? 200 : 400).json({ success: false, ...quote });
        }
        return res.json({
            success: true,
            distanceKm: quote.distanceKm,
            slab: quote.slab,
            charge: quote.charge,
            location: quote.customer,
            method: quote.method,
            originSource: quote.originSource,
        });
    } catch (err) {
        logger.error('getDeliveryQuote error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Could not calculate delivery charge.' });
    }
};
