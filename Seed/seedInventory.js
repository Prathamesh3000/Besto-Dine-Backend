const mongoose = require('mongoose');
require('dotenv').config();
const Inventory = require('../models/inventory');

const inventoryItems = [
    // ─── Raw Ingredients ─────────────────────────────────────────────────────
    {
        itemId: 'INV-001', name: 'All-Purpose Flour (Maida)', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 45, minStock: 10, maxStock: 100, costPerUnit: 42,
        supplier: { name: 'Shree Traders', contact: '9876543210' },
        expiryDate: new Date('2026-09-15')
    },
    {
        itemId: 'INV-002', name: 'Whole Wheat Flour (Atta)', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 30, minStock: 8, maxStock: 80, costPerUnit: 38,
        supplier: { name: 'Shree Traders', contact: '9876543210' },
        expiryDate: new Date('2026-08-20')
    },
    {
        itemId: 'INV-003', name: 'Basmati Rice', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 50, minStock: 15, maxStock: 120, costPerUnit: 95,
        supplier: { name: 'Agro Fresh Pvt Ltd', contact: '9823456789' },
        expiryDate: new Date('2027-01-10')
    },
    {
        itemId: 'INV-004', name: 'Sugar', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 20, minStock: 5, maxStock: 60, costPerUnit: 45,
        supplier: { name: 'Shree Traders', contact: '9876543210' },
        expiryDate: new Date('2027-03-01')
    },
    {
        itemId: 'INV-005', name: 'Salt (Iodised)', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 12, minStock: 3, maxStock: 30, costPerUnit: 22,
        supplier: { name: 'Shree Traders', contact: '9876543210' },
        expiryDate: new Date('2028-01-01')
    },
    {
        itemId: 'INV-006', name: 'Onions', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 25, minStock: 10, maxStock: 50, costPerUnit: 35,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' }
    },
    {
        itemId: 'INV-007', name: 'Tomatoes', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 15, minStock: 8, maxStock: 40, costPerUnit: 40,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' }
    },
    {
        itemId: 'INV-008', name: 'Chicken (Boneless)', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 8, minStock: 5, maxStock: 30, costPerUnit: 320,
        supplier: { name: 'Al-Noor Meats', contact: '9845678901' },
        expiryDate: new Date('2026-04-02')
    },
    {
        itemId: 'INV-009', name: 'Paneer', category: 'Raw Ingredients',
        unit: 'kg', currentStock: 6, minStock: 3, maxStock: 20, costPerUnit: 340,
        supplier: { name: 'Amul Distributor', contact: '9867890123' },
        expiryDate: new Date('2026-04-05')
    },
    {
        itemId: 'INV-010', name: 'Pizza Dough Base (12")', category: 'Raw Ingredients',
        unit: 'pcs', currentStock: 40, minStock: 15, maxStock: 100, costPerUnit: 35,
        supplier: { name: 'Baker Street Supplies', contact: '9890123456' },
        expiryDate: new Date('2026-04-10')
    },

    // ─── Dairy & Eggs ────────────────────────────────────────────────────────
    {
        itemId: 'INV-011', name: 'Full Cream Milk', category: 'Dairy & Eggs',
        unit: 'L', currentStock: 20, minStock: 10, maxStock: 50, costPerUnit: 60,
        supplier: { name: 'Amul Distributor', contact: '9867890123' },
        expiryDate: new Date('2026-04-03')
    },
    {
        itemId: 'INV-012', name: 'Butter (Unsalted)', category: 'Dairy & Eggs',
        unit: 'kg', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 480,
        supplier: { name: 'Amul Distributor', contact: '9867890123' },
        expiryDate: new Date('2026-06-15')
    },
    {
        itemId: 'INV-013', name: 'Eggs (Farm Fresh)', category: 'Dairy & Eggs',
        unit: 'dozen', currentStock: 10, minStock: 4, maxStock: 25, costPerUnit: 72,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' },
        expiryDate: new Date('2026-04-12')
    },
    {
        itemId: 'INV-014', name: 'Mozzarella Cheese', category: 'Dairy & Eggs',
        unit: 'kg', currentStock: 4, minStock: 2, maxStock: 12, costPerUnit: 520,
        supplier: { name: 'Amul Distributor', contact: '9867890123' },
        expiryDate: new Date('2026-05-20')
    },
    {
        itemId: 'INV-015', name: 'Fresh Cream', category: 'Dairy & Eggs',
        unit: 'L', currentStock: 3, minStock: 2, maxStock: 10, costPerUnit: 280,
        supplier: { name: 'Amul Distributor', contact: '9867890123' },
        expiryDate: new Date('2026-04-08')
    },

    // ─── Spices & Seasonings ─────────────────────────────────────────────────
    {
        itemId: 'INV-016', name: 'Red Chilli Powder', category: 'Spices & Seasonings',
        unit: 'kg', currentStock: 3, minStock: 1, maxStock: 10, costPerUnit: 280,
        supplier: { name: 'Everest Spice Depot', contact: '9834567890' },
        expiryDate: new Date('2027-02-01')
    },
    {
        itemId: 'INV-017', name: 'Turmeric Powder', category: 'Spices & Seasonings',
        unit: 'kg', currentStock: 2, minStock: 1, maxStock: 8, costPerUnit: 200,
        supplier: { name: 'Everest Spice Depot', contact: '9834567890' },
        expiryDate: new Date('2027-02-01')
    },
    {
        itemId: 'INV-018', name: 'Garam Masala', category: 'Spices & Seasonings',
        unit: 'kg', currentStock: 1.5, minStock: 0.5, maxStock: 5, costPerUnit: 450,
        supplier: { name: 'Everest Spice Depot', contact: '9834567890' },
        expiryDate: new Date('2026-12-01')
    },
    {
        itemId: 'INV-019', name: 'Black Pepper (Ground)', category: 'Spices & Seasonings',
        unit: 'kg', currentStock: 1, minStock: 0.5, maxStock: 4, costPerUnit: 680,
        supplier: { name: 'Everest Spice Depot', contact: '9834567890' },
        expiryDate: new Date('2027-06-01')
    },
    {
        itemId: 'INV-020', name: 'Cumin Seeds (Jeera)', category: 'Spices & Seasonings',
        unit: 'kg', currentStock: 2, minStock: 0.5, maxStock: 6, costPerUnit: 320,
        supplier: { name: 'Everest Spice Depot', contact: '9834567890' },
        expiryDate: new Date('2027-04-15')
    },

    // ─── Oils & Sauces ──────────────────────────────────────────────────────
    {
        itemId: 'INV-021', name: 'Refined Sunflower Oil', category: 'Oils & Sauces',
        unit: 'L', currentStock: 15, minStock: 5, maxStock: 40, costPerUnit: 150,
        supplier: { name: 'Fortune Wholesale', contact: '9856789012' },
        expiryDate: new Date('2027-01-30')
    },
    {
        itemId: 'INV-022', name: 'Olive Oil (Extra Virgin)', category: 'Oils & Sauces',
        unit: 'L', currentStock: 3, minStock: 1, maxStock: 10, costPerUnit: 750,
        supplier: { name: 'Borges Import House', contact: '9878901234' },
        expiryDate: new Date('2027-03-15')
    },
    {
        itemId: 'INV-023', name: 'Soy Sauce', category: 'Oils & Sauces',
        unit: 'L', currentStock: 4, minStock: 1, maxStock: 10, costPerUnit: 180,
        supplier: { name: 'Ching\'s Distributor', contact: '9889012345' },
        expiryDate: new Date('2027-05-01')
    },
    {
        itemId: 'INV-024', name: 'Tomato Ketchup', category: 'Oils & Sauces',
        unit: 'kg', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 120,
        supplier: { name: 'Kissan Wholesale', contact: '9801234567' },
        expiryDate: new Date('2027-02-01')
    },
    {
        itemId: 'INV-025', name: 'Mayonnaise', category: 'Oils & Sauces',
        unit: 'kg', currentStock: 3, minStock: 1, maxStock: 10, costPerUnit: 210,
        supplier: { name: 'Veeba Distributor', contact: '9812346789' },
        expiryDate: new Date('2026-08-20')
    },

    // ─── Beverages ───────────────────────────────────────────────────────────
    {
        itemId: 'INV-026', name: 'Coca Cola (300ml)', category: 'Beverages',
        unit: 'bottle', currentStock: 48, minStock: 20, maxStock: 120, costPerUnit: 20,
        supplier: { name: 'Coca Cola Distributor', contact: '9823456000' },
        expiryDate: new Date('2026-12-31')
    },
    {
        itemId: 'INV-027', name: 'Mineral Water (1L)', category: 'Beverages',
        unit: 'bottle', currentStock: 60, minStock: 24, maxStock: 150, costPerUnit: 15,
        supplier: { name: 'Bisleri Depot', contact: '9834560001' },
        expiryDate: new Date('2027-06-01')
    },
    {
        itemId: 'INV-028', name: 'Fresh Orange Juice Pulp', category: 'Beverages',
        unit: 'L', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 180,
        supplier: { name: 'Tropicana Supplier', contact: '9845670002' },
        expiryDate: new Date('2026-04-15')
    },
    {
        itemId: 'INV-029', name: 'Coffee Beans (Arabica)', category: 'Beverages',
        unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8, costPerUnit: 850,
        supplier: { name: 'Blue Tokai Supply', contact: '9856780003' },
        expiryDate: new Date('2026-10-01')
    },
    {
        itemId: 'INV-030', name: 'Tea Leaves (Assam Premium)', category: 'Beverages',
        unit: 'kg', currentStock: 2, minStock: 1, maxStock: 6, costPerUnit: 420,
        supplier: { name: 'Tata Tea Wholesale', contact: '9867890004' },
        expiryDate: new Date('2027-01-01')
    },

    // ─── Packaging ───────────────────────────────────────────────────────────
    {
        itemId: 'INV-031', name: 'Takeaway Boxes (Large)', category: 'Packaging',
        unit: 'pack', currentStock: 15, minStock: 5, maxStock: 50, costPerUnit: 180,
        supplier: { name: 'EcoPack India', contact: '9878900005' }
    },
    {
        itemId: 'INV-032', name: 'Takeaway Boxes (Small)', category: 'Packaging',
        unit: 'pack', currentStock: 20, minStock: 5, maxStock: 50, costPerUnit: 120,
        supplier: { name: 'EcoPack India', contact: '9878900005' }
    },
    {
        itemId: 'INV-033', name: 'Paper Napkins', category: 'Packaging',
        unit: 'pack', currentStock: 25, minStock: 8, maxStock: 60, costPerUnit: 65,
        supplier: { name: 'EcoPack India', contact: '9878900005' }
    },
    {
        itemId: 'INV-034', name: 'Disposable Cups (250ml)', category: 'Packaging',
        unit: 'pack', currentStock: 10, minStock: 4, maxStock: 30, costPerUnit: 90,
        supplier: { name: 'EcoPack India', contact: '9878900005' }
    },
    {
        itemId: 'INV-035', name: 'Aluminium Foil Roll', category: 'Packaging',
        unit: 'pcs', currentStock: 6, minStock: 2, maxStock: 15, costPerUnit: 250,
        supplier: { name: 'EcoPack India', contact: '9878900005' }
    },

    // ─── Cleaning Supplies ───────────────────────────────────────────────────
    {
        itemId: 'INV-036', name: 'Dish Wash Liquid', category: 'Cleaning Supplies',
        unit: 'L', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 145,
        supplier: { name: 'Vim Wholesale', contact: '9889010006' }
    },
    {
        itemId: 'INV-037', name: 'Floor Cleaner (Pine)', category: 'Cleaning Supplies',
        unit: 'L', currentStock: 4, minStock: 2, maxStock: 12, costPerUnit: 110,
        supplier: { name: 'Lizol Distributor', contact: '9890120007' }
    },
    {
        itemId: 'INV-038', name: 'Hand Sanitizer', category: 'Cleaning Supplies',
        unit: 'L', currentStock: 3, minStock: 1, maxStock: 8, costPerUnit: 220,
        supplier: { name: 'Dettol Supplier', contact: '9801230008' }
    },

    // ─── Frozen Goods ────────────────────────────────────────────────────────
    {
        itemId: 'INV-039', name: 'Frozen French Fries', category: 'Frozen Goods',
        unit: 'kg', currentStock: 10, minStock: 4, maxStock: 25, costPerUnit: 140,
        supplier: { name: 'McCain Frozen Foods', contact: '9812340009' },
        expiryDate: new Date('2026-11-30')
    },
    {
        itemId: 'INV-040', name: 'Frozen Peas', category: 'Frozen Goods',
        unit: 'kg', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 110,
        supplier: { name: 'Safal Distributor', contact: '9823450010' },
        expiryDate: new Date('2026-10-15')
    },

    // ─── Bakery Items ────────────────────────────────────────────────────────
    {
        itemId: 'INV-041', name: 'Burger Buns', category: 'Bakery Items',
        unit: 'pcs', currentStock: 50, minStock: 20, maxStock: 100, costPerUnit: 12,
        supplier: { name: 'Modern Bakery', contact: '9834560011' },
        expiryDate: new Date('2026-04-03')
    },
    {
        itemId: 'INV-042', name: 'Sandwich Bread (White)', category: 'Bakery Items',
        unit: 'pack', currentStock: 8, minStock: 3, maxStock: 20, costPerUnit: 45,
        supplier: { name: 'Modern Bakery', contact: '9834560011' },
        expiryDate: new Date('2026-04-04')
    },
    {
        itemId: 'INV-043', name: 'Puff Pastry Sheets', category: 'Bakery Items',
        unit: 'pack', currentStock: 4, minStock: 2, maxStock: 12, costPerUnit: 180,
        supplier: { name: 'Baker Street Supplies', contact: '9890123456' },
        expiryDate: new Date('2026-05-01')
    },

    // ─── Fruits & Vegetables ─────────────────────────────────────────────────
    {
        itemId: 'INV-044', name: 'Capsicum (Mixed)', category: 'Fruits & Vegetables',
        unit: 'kg', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 80,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' }
    },
    {
        itemId: 'INV-045', name: 'Mushrooms (Button)', category: 'Fruits & Vegetables',
        unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8, costPerUnit: 180,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' }
    },
    {
        itemId: 'INV-046', name: 'Lemons', category: 'Fruits & Vegetables',
        unit: 'kg', currentStock: 4, minStock: 2, maxStock: 10, costPerUnit: 60,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' }
    },
    {
        itemId: 'INV-047', name: 'Coriander (Fresh)', category: 'Fruits & Vegetables',
        unit: 'kg', currentStock: 2, minStock: 1, maxStock: 5, costPerUnit: 50,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' }
    },
    {
        itemId: 'INV-048', name: 'Ginger-Garlic Paste', category: 'Fruits & Vegetables',
        unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8, costPerUnit: 140,
        supplier: { name: 'Fresh Farms Daily', contact: '9812345678' },
        expiryDate: new Date('2026-05-10')
    },

    // ─── Kitchen Equipment ───────────────────────────────────────────────────
    {
        itemId: 'INV-049', name: 'LPG Gas Cylinder (Commercial)', category: 'Kitchen Equipment',
        unit: 'pcs', currentStock: 3, minStock: 1, maxStock: 6, costPerUnit: 1800,
        supplier: { name: 'HP Gas Agency', contact: '9845670012' }
    },
    {
        itemId: 'INV-050', name: 'Kitchen Towel Roll', category: 'Kitchen Equipment',
        unit: 'pcs', currentStock: 8, minStock: 3, maxStock: 20, costPerUnit: 85,
        supplier: { name: 'EcoPack India', contact: '9878900005' }
    },

    // ─── Low stock items (for testing alerts) ────────────────────────────────
    {
        itemId: 'INV-051', name: 'Saffron (Kesar)', category: 'Spices & Seasonings',
        unit: 'g', currentStock: 5, minStock: 10, maxStock: 50, costPerUnit: 45,
        supplier: { name: 'Kashmir Spice Traders', contact: '9801230099' },
        expiryDate: new Date('2027-06-01')
    },
    {
        itemId: 'INV-052', name: 'Truffle Oil', category: 'Oils & Sauces',
        unit: 'mL', currentStock: 50, minStock: 100, maxStock: 500, costPerUnit: 12,
        supplier: { name: 'Borges Import House', contact: '9878901234' },
        expiryDate: new Date('2026-12-01')
    },

    // ─── Out of stock items (for testing alerts) ─────────────────────────────
    {
        itemId: 'INV-053', name: 'Wasabi Paste', category: 'Spices & Seasonings',
        unit: 'g', currentStock: 0, minStock: 50, maxStock: 200, costPerUnit: 8,
        supplier: { name: 'Asian Imports Co.', contact: '9812340088' },
        expiryDate: new Date('2026-09-01')
    },
    {
        itemId: 'INV-054', name: 'Edible Gold Leaf', category: 'Other',
        unit: 'pack', currentStock: 0, minStock: 2, maxStock: 10, costPerUnit: 1500,
        supplier: { name: 'Luxury Kitchen Supplies', contact: '9823450077' }
    }
];

const seedInventory = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('✔ Connected to MongoDB for inventory seeding...');

        await Inventory.deleteMany({});
        console.log('🗑  Cleared existing inventory.');

        // Add initial adjustment history for items with stock > 0
        const itemsWithHistory = inventoryItems.map(item => ({
            ...item,
            adjustmentHistory: item.currentStock > 0 ? [{
                type: 'restock',
                quantity: item.currentStock,
                previousStock: 0,
                newStock: item.currentStock,
                reason: 'Initial stock — seed data',
                date: new Date()
            }] : [],
            lastRestocked: item.currentStock > 0 ? new Date() : undefined
        }));

        await Inventory.insertMany(itemsWithHistory);
        console.log(`✔ Successfully seeded ${itemsWithHistory.length} inventory items!`);

        // Print summary
        const inStock = itemsWithHistory.filter(i => i.currentStock > i.minStock).length;
        const lowStock = itemsWithHistory.filter(i => i.currentStock > 0 && i.currentStock <= i.minStock).length;
        const outOfStock = itemsWithHistory.filter(i => i.currentStock <= 0).length;
        const totalValue = itemsWithHistory.reduce((sum, i) => sum + (i.currentStock * i.costPerUnit), 0);

        console.log(`\n📊 Seed Summary:`);
        console.log(`   In Stock:     ${inStock}`);
        console.log(`   Low Stock:    ${lowStock}`);
        console.log(`   Out of Stock: ${outOfStock}`);
        console.log(`   Total Value:  ₹${totalValue.toLocaleString('en-IN')}`);
        console.log(`   Categories:   ${[...new Set(itemsWithHistory.map(i => i.category))].length}`);
        console.log(`   Suppliers:    ${[...new Set(itemsWithHistory.map(i => i.supplier.name))].length}`);

        process.exit();
    } catch (err) {
        console.error('❌ Inventory Seeding Error:', err);
        process.exit(1);
    }
};

seedInventory();
