const express = require('express');
const router = express.Router();
const shiftController = require('../controllers/shiftController');
const { protect, adminOnly, staffOnly } = require('../middlewares/authMiddleware');

router.get('/my', protect, shiftController.getMyShifts);
// Attendance is for staff only — customers / superadmins are refused.
router.post('/clock-in', protect, staffOnly, shiftController.clockIn);
router.post('/clock-out', protect, staffOnly, shiftController.clockOut);

// Admin-only — force close a stuck active shift (e.g. waiter forgot
// to clock out) and manually fire the auto-closer sweep.
router.post('/admin/run-autoclose', protect, adminOnly, shiftController.runAutoCloseNow);
router.post('/:id/force-clockout', protect, adminOnly, shiftController.forceClockOut);
// ADM-070 — admin view of any staff member's shift history.
router.get('/staff/:userId', protect, adminOnly, shiftController.getStaffShifts);

module.exports = router;
