const express = require('express');
const router = express.Router();
const lc = require('../controllers/ledgerController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const { attachTenant } = require('../middlewares/tenantContext');

// Ledger-lite + expenses (Plan 3B.3). Admin / manager only.
router.use(protect, adminOnly, attachTenant);

router.get('/accounts', lc.accounts);
router.get('/accounts/:code/ledger', lc.accountLedger);
router.post('/post-day', lc.postDay);
router.get('/trial-balance', lc.trialBalance);
router.get('/pnl', lc.pnl);

router.get('/expenses', lc.listExpenses);
router.post('/expenses', lc.createExpense);
router.post('/expenses/:id/void', lc.voidExpense);

module.exports = router;
