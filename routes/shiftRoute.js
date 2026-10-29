const express = require('express');
const router = express.Router();
const shiftController = require('../controllers/shiftController');
const { protect, adminOnly, staffOnly, captainOrAdmin } = require('../middlewares/authMiddleware');
const ov = require('../validators/ops');

// Captain shift handover (Phase 6): summary, then confirm with a note.
router.get('/handover', protect, captainOrAdmin, shiftController.getHandover);
router.post('/handover', protect, captainOrAdmin, ov.shiftHandover, shiftController.confirmHandover);
router.get('/my', protect, shiftController.getMyShifts);
// Attendance is for staff only — customers / superadmins are refused.
router.post('/clock-in', protect, staffOnly, ov.shiftNote, shiftController.clockIn);
router.post('/clock-out', protect, staffOnly, ov.shiftNote, shiftController.clockOut);

// Admin-only — force close a stuck active shift (e.g. waiter forgot
// to clock out) and manually fire the auto-closer sweep.
router.post('/admin/run-autoclose', protect, adminOnly, shiftController.runAutoCloseNow);
router.post('/:id/force-clockout', protect, adminOnly, ov.shiftNote, shiftController.forceClockOut);
// ADM-070 — admin view of any staff member's shift history.
router.get('/staff/:userId', protect, adminOnly, shiftController.getStaffShifts);

module.exports = router;
