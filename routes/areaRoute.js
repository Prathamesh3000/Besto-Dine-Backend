const express = require('express');
const router = express.Router();
const { createArea, getAreas, updateArea, deleteArea } = require('../controllers/areaController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');
const ov = require('../validators/ops');

// Public — waiter floor view + customer-facing pages
router.get('/', getAreas);

// Admin only
router.post('/', protect, adminOnly, ov.areaCreate, createArea);
router.put('/:id', protect, adminOnly, ov.areaUpdate, updateArea);
router.delete('/:id', protect, adminOnly, ov.areaIdOnly, deleteArea);

module.exports = router;
