const express = require('express');
const router = express.Router();
const { makeLimiter } = require('../utils/rateLimitStore');
const printController = require('../controllers/printController');
const { protect, adminOnly, restrictTo, noWaiterBilling } = require('../middlewares/authMiddleware');
const ov = require('../validators/ops');

// A test page per click is plenty; stops a stuck button from spooling
// paper out of a kitchen printer.
const testPrintLimiter = makeLimiter({ name: 'print-test',
    windowMs: 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many test prints. Please wait a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Agent pairing + status (Settings → Printers)
router.post('/agent-key', protect, adminOnly, printController.issueAgentKey);
router.delete('/agent-key', protect, adminOnly, printController.revokeAgentKey);
router.get('/agent-status', protect, adminOnly, printController.agentStatus);
router.get('/jobs', protect, adminOnly, printController.listJobs);
router.post('/test', protect, adminOnly, testPrintLimiter, ov.printTest, printController.testPrint);

// Staff-safe printer status + job read-back for the waiter / captain app
// (agent-status and the job list above stay admin-only).
router.get('/status', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), noWaiterBilling, printController.staffStatus);
router.get('/jobs/:id', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), noWaiterBilling, printController.getJob);

// On-demand bill to the counter printer — same audience as reprint-kot.
router.post('/orders/:id/bill', protect, restrictTo('waiter', 'captain', 'admin', 'manager'), noWaiterBilling, printController.printBill);

module.exports = router;
