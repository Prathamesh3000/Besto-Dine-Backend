const express = require('express');
const router = express.Router();
const { createArea, getAreas, updateArea, deleteArea } = require('../controllers/areaController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');

// Public — waiter floor view + customer-facing pages
router.get('/', getAreas);

// Admin only
router.post('/', protect, adminOnly, createArea);
router.put('/:id', protect, adminOnly, updateArea);
router.delete('/:id', protect, adminOnly, deleteArea);

module.exports = router;
