/**
 * seedRecipes.js
 *
 * One-shot seed that wires every existing MenuItem in a tenant to a
 * recipe pulled from inventory. The flow:
 *
 *   1. Resolve the target tenant (TENANT_SLUG env or the first restaurant
 *      sorted by createdAt — matches how seedDefaultTenant picks).
 *   2. Walk MenuItem.find({ restaurant: tenant }) and base-match each
 *      item's name against RECIPE_BLUEPRINTS (handles seedMenuItems'
 *      "Cappuccino 49" suffixed naming).
 *   3. If the menu item has no exact blueprint, fall back to a
 *      category-level default so every item still gets a recipe.
 *   4. For every ingredient referenced by the chosen recipe, ensure the
 *      Inventory document exists in this tenant; create it lazily from
 *      INVENTORY_CATALOG with sensible defaults if it's missing.
 *   5. Upsert the Recipe doc — re-running the script is safe and only
 *      mutates rows whose ingredient list changed.
 *
 * Run:
 *   cd Backend
 *   node Seed/seedRecipes.js                  # default tenant
 *   TENANT_SLUG=<slug> node Seed/seedRecipes.js   # specific tenant
 *
 * Required env: MONGO_URL (already in Backend/.env). The script never
 * deletes existing recipes; it upserts. Stale ingredient links from
 * older runs are replaced by the new ingredient list (Mongo $set).
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const MenuItem = require('../models/menuItem');
const Inventory = require('../models/inventory');
const Recipe = require('../models/recipe');
const Restaurant = require('../models/restaurant');
// Required so Mongoose can resolve the populate('category') lookup below.
// Without this require, the Category model isn't registered on the
// connection and `MenuItem.find(...).populate('category')` throws
// MissingSchemaError.
require('../models/category');

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY CATALOG — superset of items the recipes reference. Every
// row mirrors seedInventory.js where overlap exists; the rest are
// extras (Honey, Cocoa, Maida-as-Pasta-proxy, etc.) that the recipe
// blueprints below pull from. The script lazy-creates only the rows
// that are missing in the target tenant, so running this on a tenant
// that already ran seedInventory is non-destructive.
// ─────────────────────────────────────────────────────────────────────────────
const INVENTORY_CATALOG = {
    // Raw Ingredients
    'All-Purpose Flour (Maida)':   { category: 'Raw Ingredients', unit: 'kg', currentStock: 45, minStock: 10, maxStock: 100, costPerUnit: 42 },
    'Whole Wheat Flour (Atta)':    { category: 'Raw Ingredients', unit: 'kg', currentStock: 30, minStock: 8,  maxStock: 80,  costPerUnit: 38 },
    'Basmati Rice':                { category: 'Raw Ingredients', unit: 'kg', currentStock: 50, minStock: 15, maxStock: 120, costPerUnit: 95 },
    'Sugar':                       { category: 'Raw Ingredients', unit: 'kg', currentStock: 20, minStock: 5,  maxStock: 60,  costPerUnit: 45 },
    'Salt (Iodised)':              { category: 'Raw Ingredients', unit: 'kg', currentStock: 12, minStock: 3,  maxStock: 30,  costPerUnit: 22 },
    'Onions':                      { category: 'Raw Ingredients', unit: 'kg', currentStock: 25, minStock: 10, maxStock: 50,  costPerUnit: 35 },
    'Tomatoes':                    { category: 'Raw Ingredients', unit: 'kg', currentStock: 15, minStock: 8,  maxStock: 40,  costPerUnit: 40 },
    'Paneer':                      { category: 'Raw Ingredients', unit: 'kg', currentStock: 6,  minStock: 3,  maxStock: 20,  costPerUnit: 340 },
    'Pizza Dough Base (12")':      { category: 'Raw Ingredients', unit: 'pcs',currentStock: 40, minStock: 15, maxStock: 100, costPerUnit: 35 },
    'Honey':                       { category: 'Raw Ingredients', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 10,  costPerUnit: 380 },
    'Cocoa Powder':                { category: 'Raw Ingredients', unit: 'kg', currentStock: 2,  minStock: 1,  maxStock: 6,   costPerUnit: 520 },
    'Oats':                        { category: 'Raw Ingredients', unit: 'kg', currentStock: 5,  minStock: 2,  maxStock: 15,  costPerUnit: 180 },
    'Quinoa':                      { category: 'Raw Ingredients', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 480 },
    'Chickpeas (Kabuli Chana)':    { category: 'Raw Ingredients', unit: 'kg', currentStock: 5,  minStock: 2,  maxStock: 15,  costPerUnit: 110 },
    'Yellow Lentils (Toor Dal)':   { category: 'Raw Ingredients', unit: 'kg', currentStock: 8,  minStock: 3,  maxStock: 20,  costPerUnit: 150 },
    'Black Lentils (Urad Dal)':    { category: 'Raw Ingredients', unit: 'kg', currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 140 },
    'Corn Kernels (Sweet)':        { category: 'Raw Ingredients', unit: 'kg', currentStock: 4,  minStock: 2,  maxStock: 10,  costPerUnit: 160 },
    'Sprouts (Mixed)':             { category: 'Raw Ingredients', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 120 },
    'Broccoli':                    { category: 'Raw Ingredients', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 220 },

    // Dairy & Eggs
    'Full Cream Milk':             { category: 'Dairy & Eggs', unit: 'L',     currentStock: 20, minStock: 10, maxStock: 50,  costPerUnit: 60 },
    'Butter (Unsalted)':           { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 5,  minStock: 2,  maxStock: 15,  costPerUnit: 480 },
    'Eggs (Farm Fresh)':           { category: 'Dairy & Eggs', unit: 'dozen', currentStock: 10, minStock: 4,  maxStock: 25,  costPerUnit: 72 },
    'Mozzarella Cheese':           { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 4,  minStock: 2,  maxStock: 12,  costPerUnit: 520 },
    'Fresh Cream':                 { category: 'Dairy & Eggs', unit: 'L',     currentStock: 3,  minStock: 2,  maxStock: 10,  costPerUnit: 280 },
    'Cheese Slices':               { category: 'Dairy & Eggs', unit: 'pack',  currentStock: 8,  minStock: 3,  maxStock: 20,  costPerUnit: 110 },
    'Condensed Milk':              { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 240 },

    // Spices & Seasonings
    'Red Chilli Powder':           { category: 'Spices & Seasonings', unit: 'kg', currentStock: 3,   minStock: 1,   maxStock: 10, costPerUnit: 280 },
    'Turmeric Powder':             { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 1,   maxStock: 8,  costPerUnit: 200 },
    'Garam Masala':                { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1.5, minStock: 0.5, maxStock: 5,  costPerUnit: 450 },
    'Black Pepper (Ground)':       { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.5, maxStock: 4,  costPerUnit: 680 },
    'Cumin Seeds (Jeera)':         { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 6,  costPerUnit: 320 },
    'Saffron (Kesar)':             { category: 'Spices & Seasonings', unit: 'g',  currentStock: 50,  minStock: 10,  maxStock: 200,costPerUnit: 45 },
    'Italian Herbs Mix':           { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 720 },
    'Schezwan Sauce':              { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 1,   maxStock: 6,  costPerUnit: 260 },
    'Green Chilli':                { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 1,   maxStock: 5,  costPerUnit: 100 },

    // Oils & Sauces
    'Refined Sunflower Oil':       { category: 'Oils & Sauces', unit: 'L',  currentStock: 15, minStock: 5, maxStock: 40, costPerUnit: 150 },
    'Olive Oil (Extra Virgin)':    { category: 'Oils & Sauces', unit: 'L',  currentStock: 3,  minStock: 1, maxStock: 10, costPerUnit: 750 },
    'Soy Sauce':                   { category: 'Oils & Sauces', unit: 'L',  currentStock: 4,  minStock: 1, maxStock: 10, costPerUnit: 180 },
    'Tomato Ketchup':              { category: 'Oils & Sauces', unit: 'kg', currentStock: 5,  minStock: 2, maxStock: 15, costPerUnit: 120 },
    'Mayonnaise':                  { category: 'Oils & Sauces', unit: 'kg', currentStock: 3,  minStock: 1, maxStock: 10, costPerUnit: 210 },
    'Pizza Sauce':                 { category: 'Oils & Sauces', unit: 'kg', currentStock: 4,  minStock: 1, maxStock: 10, costPerUnit: 200 },
    'Pasta White Sauce':           { category: 'Oils & Sauces', unit: 'kg', currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 240 },
    'Pesto Sauce':                 { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 1, maxStock: 6,  costPerUnit: 380 },
    'Peri Peri Seasoning':         { category: 'Oils & Sauces', unit: 'kg', currentStock: 1,  minStock: 0.5, maxStock: 4, costPerUnit: 420 },
    'Chocolate Syrup':             { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 1, maxStock: 6,  costPerUnit: 320 },

    // Beverages
    'Coca Cola (300ml)':           { category: 'Beverages', unit: 'bottle', currentStock: 48, minStock: 20, maxStock: 120, costPerUnit: 20 },
    'Mineral Water (1L)':          { category: 'Beverages', unit: 'bottle', currentStock: 60, minStock: 24, maxStock: 150, costPerUnit: 15 },
    'Fresh Orange Juice Pulp':     { category: 'Beverages', unit: 'L',      currentStock: 5,  minStock: 2,  maxStock: 15,  costPerUnit: 180 },
    'Coffee Beans (Arabica)':      { category: 'Beverages', unit: 'kg',     currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 850 },
    'Tea Leaves (Assam Premium)':  { category: 'Beverages', unit: 'kg',     currentStock: 2,  minStock: 1,  maxStock: 6,   costPerUnit: 420 },
    'Green Tea Leaves':            { category: 'Beverages', unit: 'kg',     currentStock: 1,  minStock: 0.5,maxStock: 4,   costPerUnit: 680 },
    'Mango Pulp':                  { category: 'Beverages', unit: 'kg',     currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 220 },
    'Strawberry Pulp':             { category: 'Beverages', unit: 'kg',     currentStock: 2,  minStock: 1,  maxStock: 6,   costPerUnit: 280 },
    'Vanilla Ice Cream':           { category: 'Beverages', unit: 'L',      currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 240 },
    'Oreo Biscuits':               { category: 'Beverages', unit: 'pack',   currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 80 },
    'Lemon Iced Tea Concentrate':  { category: 'Beverages', unit: 'L',      currentStock: 2,  minStock: 1,  maxStock: 6,   costPerUnit: 220 },

    // Bakery Items
    'Burger Buns':                 { category: 'Bakery Items', unit: 'pcs',  currentStock: 50, minStock: 20, maxStock: 100, costPerUnit: 12 },
    'Sandwich Bread (White)':      { category: 'Bakery Items', unit: 'pack', currentStock: 8,  minStock: 3,  maxStock: 20,  costPerUnit: 45 },
    'Tortilla Wraps':              { category: 'Bakery Items', unit: 'pack', currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 110 },
    'Pasta (Penne)':               { category: 'Bakery Items', unit: 'kg',   currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 180 },
    'Pasta (Fusilli)':             { category: 'Bakery Items', unit: 'kg',   currentStock: 4,  minStock: 2,  maxStock: 12,  costPerUnit: 180 },
    'Pasta (Macaroni)':            { category: 'Bakery Items', unit: 'kg',   currentStock: 4,  minStock: 2,  maxStock: 12,  costPerUnit: 170 },
    'Hakka Noodles (Dry)':         { category: 'Bakery Items', unit: 'kg',   currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 140 },
    'Brownie Mix':                 { category: 'Bakery Items', unit: 'kg',   currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 380 },

    // Frozen Goods
    'Frozen French Fries':         { category: 'Frozen Goods', unit: 'kg', currentStock: 10, minStock: 4, maxStock: 25, costPerUnit: 140 },
    'Frozen Peas':                 { category: 'Frozen Goods', unit: 'kg', currentStock: 5,  minStock: 2, maxStock: 15, costPerUnit: 110 },
    'Aloo Tikki Patty (Frozen)':   { category: 'Frozen Goods', unit: 'pcs',currentStock: 60, minStock: 20,maxStock: 150,costPerUnit: 14 },
    'Veg Patty (Frozen)':          { category: 'Frozen Goods', unit: 'pcs',currentStock: 50, minStock: 20,maxStock: 120,costPerUnit: 18 },
    'Spring Roll Sheets':          { category: 'Frozen Goods', unit: 'pack',currentStock: 4, minStock: 1, maxStock: 10, costPerUnit: 160 },

    // Fruits & Vegetables
    'Capsicum (Mixed)':            { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 80 },
    'Mushrooms (Button)':          { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 180 },
    'Lemons':                      { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4, minStock: 2, maxStock: 10, costPerUnit: 60 },
    'Coriander (Fresh)':           { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 2, minStock: 1, maxStock: 5,  costPerUnit: 50 },
    'Mint Leaves':                 { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 1, minStock: 0.5,maxStock: 3, costPerUnit: 60 },
    'Ginger-Garlic Paste':         { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 140 },
    'Spinach (Palak)':             { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 50 },
    'Carrots':                     { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4, minStock: 2, maxStock: 10, costPerUnit: 45 },
    'Potatoes':                    { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 20,minStock: 8, maxStock: 50, costPerUnit: 30 },
    'Lettuce':                     { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 2, minStock: 1, maxStock: 5,  costPerUnit: 90 },
    'Cucumber':                    { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4, minStock: 1, maxStock: 10, costPerUnit: 40 },
    'Mixed Fruits (Seasonal)':     { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5, minStock: 2, maxStock: 15, costPerUnit: 120 },
    'Eggplant (Brinjal)':          { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 50 },
};

// ─────────────────────────────────────────────────────────────────────────────
// RECIPE BLUEPRINTS — keyed by the EXACT base name in
// seedMenuItems.categoryItemNames. Quantities are per single serving
// (recipe yield = 1). Units must be convertible to the inventory unit
// (kg↔g, L↔mL, pcs/dozen/pack/bottle stay as-is).
//
// Where we don't have an exact ingredient (e.g. "ginger" alone), we
// use the closest existing item (Ginger-Garlic Paste). This keeps the
// catalog tight and avoids creating dozens of single-use SKUs.
// ─────────────────────────────────────────────────────────────────────────────
const g = (name, quantity, unit) => ({ name, quantity, unit });

const RECIPE_BLUEPRINTS = {
    // ── Pizza ────────────────────────────────────────────────────────
    'Classic Margherita': [
        g('Pizza Dough Base (12")', 1, 'pcs'), g('Pizza Sauce', 80, 'g'),
        g('Mozzarella Cheese', 100, 'g'), g('Italian Herbs Mix', 2, 'g'),
    ],
    'Farmhouse Special': [
        g('Pizza Dough Base (12")', 1, 'pcs'), g('Pizza Sauce', 80, 'g'),
        g('Mozzarella Cheese', 90, 'g'), g('Capsicum (Mixed)', 40, 'g'),
        g('Mushrooms (Button)', 30, 'g'), g('Onions', 30, 'g'),
        g('Tomatoes', 30, 'g'), g('Italian Herbs Mix', 2, 'g'),
    ],
    'Spicy Paneer Pizza': [
        g('Pizza Dough Base (12")', 1, 'pcs'), g('Pizza Sauce', 70, 'g'),
        g('Mozzarella Cheese', 80, 'g'), g('Paneer', 80, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Red Chilli Powder', 3, 'g'),
    ],
    'Veggie Supreme': [
        g('Pizza Dough Base (12")', 1, 'pcs'), g('Pizza Sauce', 80, 'g'),
        g('Mozzarella Cheese', 100, 'g'), g('Capsicum (Mixed)', 40, 'g'),
        g('Mushrooms (Button)', 30, 'g'), g('Corn Kernels (Sweet)', 30, 'g'),
        g('Onions', 30, 'g'),
    ],
    'Double Cheese Pizza': [
        g('Pizza Dough Base (12")', 1, 'pcs'), g('Pizza Sauce', 70, 'g'),
        g('Mozzarella Cheese', 200, 'g'), g('Cheese Slices', 1, 'pack'),
    ],

    // ── Burger ───────────────────────────────────────────────────────
    'Crunchy Veg Burger': [
        g('Burger Buns', 1, 'pcs'), g('Veg Patty (Frozen)', 1, 'pcs'),
        g('Mayonnaise', 25, 'g'), g('Lettuce', 20, 'g'), g('Tomatoes', 20, 'g'),
    ],
    'Paneer Peri Peri Burger': [
        g('Burger Buns', 1, 'pcs'), g('Paneer', 90, 'g'),
        g('Peri Peri Seasoning', 4, 'g'), g('Mayonnaise', 25, 'g'),
        g('Lettuce', 20, 'g'),
    ],
    'Cheese Jumbo Burger': [
        g('Burger Buns', 1, 'pcs'), g('Veg Patty (Frozen)', 1, 'pcs'),
        g('Cheese Slices', 1, 'pack'), g('Mozzarella Cheese', 30, 'g'),
        g('Mayonnaise', 25, 'g'), g('Lettuce', 20, 'g'),
    ],
    'Classic Aloo Tikki': [
        g('Burger Buns', 1, 'pcs'), g('Aloo Tikki Patty (Frozen)', 1, 'pcs'),
        g('Mayonnaise', 20, 'g'), g('Tomatoes', 20, 'g'), g('Onions', 20, 'g'),
    ],
    'Double Patty Burger': [
        g('Burger Buns', 1, 'pcs'), g('Veg Patty (Frozen)', 2, 'pcs'),
        g('Cheese Slices', 1, 'pack'), g('Mayonnaise', 30, 'g'),
        g('Lettuce', 20, 'g'),
    ],

    // ── Biryani ──────────────────────────────────────────────────────
    'Hyderabadi Veg Biryani': [
        g('Basmati Rice', 200, 'g'), g('Onions', 60, 'g'),
        g('Tomatoes', 40, 'g'), g('Capsicum (Mixed)', 40, 'g'),
        g('Frozen Peas', 30, 'g'), g('Garam Masala', 5, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'), g('Coriander (Fresh)', 5, 'g'),
    ],
    'Lucknowi Dum Biryani': [
        g('Basmati Rice', 200, 'g'), g('Paneer', 80, 'g'),
        g('Onions', 60, 'g'), g('Garam Masala', 6, 'g'),
        g('Saffron (Kesar)', 0.3, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Saffron Paneer Biryani': [
        g('Basmati Rice', 200, 'g'), g('Paneer', 100, 'g'),
        g('Saffron (Kesar)', 0.5, 'g'), g('Onions', 50, 'g'),
        g('Garam Masala', 5, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Mushroom Matka Biryani': [
        g('Basmati Rice', 200, 'g'), g('Mushrooms (Button)', 80, 'g'),
        g('Onions', 50, 'g'), g('Garam Masala', 5, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Kashmiri Pulav': [
        g('Basmati Rice', 200, 'g'), g('Mixed Fruits (Seasonal)', 50, 'g'),
        g('Saffron (Kesar)', 0.3, 'g'), g('Onions', 30, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],

    // ── Chinese ──────────────────────────────────────────────────────
    'Veg Manchurian Dry': [
        g('All-Purpose Flour (Maida)', 80, 'g'), g('Capsicum (Mixed)', 40, 'g'),
        g('Onions', 40, 'g'), g('Soy Sauce', 20, 'mL'),
        g('Ginger-Garlic Paste', 10, 'g'), g('Refined Sunflower Oil', 40, 'mL'),
    ],
    'Veg Fried Rice': [
        g('Basmati Rice', 180, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Frozen Peas', 30, 'g'),
        g('Soy Sauce', 20, 'mL'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Hakka Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Onions', 30, 'g'),
        g('Soy Sauce', 25, 'mL'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Schezwan Fried Rice': [
        g('Basmati Rice', 180, 'g'), g('Schezwan Sauce', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Onions', 30, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Honey Chilli Potato': [
        g('Frozen French Fries', 150, 'g'), g('Honey', 20, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Soy Sauce', 15, 'mL'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],

    // ── South Indian ─────────────────────────────────────────────────
    'Masala Dosa': [
        g('All-Purpose Flour (Maida)', 100, 'g'), g('Black Lentils (Urad Dal)', 30, 'g'),
        g('Potatoes', 100, 'g'), g('Onions', 30, 'g'),
        g('Turmeric Powder', 2, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Rava Idli': [
        g('All-Purpose Flour (Maida)', 100, 'g'), g('Salt (Iodised)', 2, 'g'),
        g('Refined Sunflower Oil', 15, 'mL'),
    ],
    'Meduvada': [
        g('Black Lentils (Urad Dal)', 100, 'g'), g('Onions', 20, 'g'),
        g('Green Chilli', 3, 'g'), g('Refined Sunflower Oil', 50, 'mL'),
    ],
    'Onion Uttapam': [
        g('All-Purpose Flour (Maida)', 100, 'g'), g('Onions', 60, 'g'),
        g('Tomatoes', 30, 'g'), g('Coriander (Fresh)', 5, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Paper Plain Dosa': [
        g('All-Purpose Flour (Maida)', 100, 'g'), g('Black Lentils (Urad Dal)', 30, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],

    // ── North Indian ─────────────────────────────────────────────────
    'Paneer Tikka Masala': [
        g('Paneer', 150, 'g'), g('Tomatoes', 60, 'g'),
        g('Onions', 40, 'g'), g('Fresh Cream', 30, 'mL'),
        g('Garam Masala', 5, 'g'), g('Red Chilli Powder', 3, 'g'),
    ],
    'Dal Makhani Royale': [
        g('Black Lentils (Urad Dal)', 100, 'g'), g('Butter (Unsalted)', 30, 'g'),
        g('Fresh Cream', 30, 'mL'), g('Tomatoes', 40, 'g'),
        g('Ginger-Garlic Paste', 10, 'g'), g('Garam Masala', 4, 'g'),
    ],
    'Mix Veg Kadhai': [
        g('Capsicum (Mixed)', 60, 'g'), g('Tomatoes', 50, 'g'),
        g('Onions', 40, 'g'), g('Paneer', 50, 'g'),
        g('Garam Masala', 4, 'g'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Shahi Paneer': [
        g('Paneer', 150, 'g'), g('Fresh Cream', 50, 'mL'),
        g('Tomatoes', 40, 'g'), g('Onions', 30, 'g'),
        g('Garam Masala', 4, 'g'),
    ],
    'Malai Kofta': [
        g('Paneer', 100, 'g'), g('All-Purpose Flour (Maida)', 30, 'g'),
        g('Fresh Cream', 50, 'mL'), g('Tomatoes', 40, 'g'),
        g('Garam Masala', 4, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],

    // ── Sandwich ─────────────────────────────────────────────────────
    'Bombay Grilled Sandwich': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Mozzarella Cheese', 30, 'g'),
        g('Tomatoes', 30, 'g'), g('Cucumber', 20, 'g'), g('Onions', 20, 'g'),
        g('Butter (Unsalted)', 15, 'g'),
    ],
    'Cheese Chilli Toast': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Mozzarella Cheese', 50, 'g'),
        g('Capsicum (Mixed)', 20, 'g'), g('Green Chilli', 3, 'g'),
        g('Butter (Unsalted)', 15, 'g'),
    ],
    'Paneer Club Sandwich': [
        g('Sandwich Bread (White)', 0.3, 'pack'), g('Paneer', 80, 'g'),
        g('Lettuce', 20, 'g'), g('Mayonnaise', 20, 'g'),
        g('Tomatoes', 20, 'g'),
    ],
    'Veg Mayo Sandwich': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Mayonnaise', 30, 'g'),
        g('Lettuce', 20, 'g'), g('Tomatoes', 20, 'g'),
        g('Cucumber', 20, 'g'),
    ],
    'Corn & Spinach Toast': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Corn Kernels (Sweet)', 50, 'g'),
        g('Spinach (Palak)', 30, 'g'), g('Mozzarella Cheese', 30, 'g'),
        g('Butter (Unsalted)', 15, 'g'),
    ],

    // ── Wraps ────────────────────────────────────────────────────────
    'Paneer Tikka Wrap': [
        g('Tortilla Wraps', 1, 'pack'), g('Paneer', 100, 'g'),
        g('Onions', 30, 'g'), g('Capsicum (Mixed)', 20, 'g'),
        g('Mayonnaise', 20, 'g'), g('Garam Masala', 3, 'g'),
    ],
    'Falafel Veggie Wrap': [
        g('Tortilla Wraps', 1, 'pack'), g('Chickpeas (Kabuli Chana)', 80, 'g'),
        g('Lettuce', 20, 'g'), g('Tomatoes', 20, 'g'),
        g('Mayonnaise', 20, 'g'),
    ],
    'Cheese Corn Roll': [
        g('Tortilla Wraps', 1, 'pack'), g('Corn Kernels (Sweet)', 50, 'g'),
        g('Mozzarella Cheese', 50, 'g'), g('Mayonnaise', 20, 'g'),
    ],
    'Mexican Bean Wrap': [
        g('Tortilla Wraps', 1, 'pack'), g('Chickpeas (Kabuli Chana)', 60, 'g'),
        g('Tomatoes', 30, 'g'), g('Onions', 20, 'g'),
        g('Red Chilli Powder', 3, 'g'),
    ],
    'Veggie Kathi Roll': [
        g('Tortilla Wraps', 1, 'pack'), g('Capsicum (Mixed)', 30, 'g'),
        g('Onions', 30, 'g'), g('Paneer', 50, 'g'),
        g('Garam Masala', 3, 'g'),
    ],

    // ── Salads ───────────────────────────────────────────────────────
    'Garden Fresh Salad': [
        g('Lettuce', 50, 'g'), g('Tomatoes', 50, 'g'),
        g('Cucumber', 50, 'g'), g('Onions', 20, 'g'),
        g('Lemons', 20, 'g'), g('Olive Oil (Extra Virgin)', 10, 'mL'),
    ],
    'Greek Feta Salad': [
        g('Lettuce', 50, 'g'), g('Tomatoes', 50, 'g'),
        g('Cucumber', 30, 'g'), g('Mozzarella Cheese', 40, 'g'),
        g('Olive Oil (Extra Virgin)', 15, 'mL'), g('Black Pepper (Ground)', 1, 'g'),
    ],
    'Sprouted Moong Salad': [
        g('Sprouts (Mixed)', 100, 'g'), g('Onions', 20, 'g'),
        g('Tomatoes', 20, 'g'), g('Lemons', 20, 'g'),
        g('Coriander (Fresh)', 5, 'g'),
    ],
    'Caesar Veg Salad': [
        g('Lettuce', 70, 'g'), g('Mayonnaise', 30, 'g'),
        g('Mozzarella Cheese', 20, 'g'), g('Olive Oil (Extra Virgin)', 10, 'mL'),
    ],
    'Fruit Salad with Cream': [
        g('Mixed Fruits (Seasonal)', 150, 'g'), g('Fresh Cream', 50, 'mL'),
        g('Sugar', 15, 'g'),
    ],

    // ── Pasta ────────────────────────────────────────────────────────
    'Penne Arrabbiata': [
        g('Pasta (Penne)', 100, 'g'), g('Pizza Sauce', 60, 'g'),
        g('Tomatoes', 40, 'g'), g('Red Chilli Powder', 3, 'g'),
        g('Olive Oil (Extra Virgin)', 15, 'mL'), g('Italian Herbs Mix', 2, 'g'),
    ],
    'White Sauce Pasta': [
        g('Pasta (Penne)', 100, 'g'), g('Pasta White Sauce', 80, 'g'),
        g('Mozzarella Cheese', 30, 'g'), g('Black Pepper (Ground)', 1, 'g'),
    ],
    'Fusilli Pesto': [
        g('Pasta (Fusilli)', 100, 'g'), g('Pesto Sauce', 50, 'g'),
        g('Olive Oil (Extra Virgin)', 10, 'mL'), g('Mozzarella Cheese', 20, 'g'),
    ],
    'Mixed Sauce Pasta': [
        g('Pasta (Penne)', 100, 'g'), g('Pasta White Sauce', 40, 'g'),
        g('Pizza Sauce', 40, 'g'), g('Mozzarella Cheese', 30, 'g'),
    ],
    'Mac & Cheese': [
        g('Pasta (Macaroni)', 100, 'g'), g('Mozzarella Cheese', 80, 'g'),
        g('Full Cream Milk', 80, 'mL'), g('Butter (Unsalted)', 15, 'g'),
    ],

    // ── Noodles ──────────────────────────────────────────────────────
    'Classic Hakka Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Soy Sauce', 25, 'mL'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Schezwan Special Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Schezwan Sauce', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Garlic Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Ginger-Garlic Paste', 20, 'g'),
        g('Soy Sauce', 20, 'mL'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Singapore Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Turmeric Powder', 2, 'g'),
        g('Soy Sauce', 20, 'mL'),
    ],
    'Paneer Noodles': [
        g('Hakka Noodles (Dry)', 100, 'g'), g('Paneer', 80, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Soy Sauce', 20, 'mL'),
    ],

    // ── Starters ─────────────────────────────────────────────────────
    'Hara Bhara Kabab': [
        g('Spinach (Palak)', 80, 'g'), g('Frozen Peas', 60, 'g'),
        g('Potatoes', 50, 'g'), g('Garam Masala', 3, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Crispy Corn': [
        g('Corn Kernels (Sweet)', 120, 'g'), g('All-Purpose Flour (Maida)', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Refined Sunflower Oil', 40, 'mL'),
    ],
    'Veg Lollipop': [
        g('All-Purpose Flour (Maida)', 80, 'g'), g('Frozen Peas', 50, 'g'),
        g('Carrots', 30, 'g'), g('Refined Sunflower Oil', 40, 'mL'),
    ],
    'Spring Rolls': [
        g('Spring Roll Sheets', 1, 'pack'), g('Carrots', 40, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Soy Sauce', 15, 'mL'),
        g('Refined Sunflower Oil', 40, 'mL'),
    ],
    'Mushroom Tikka': [
        g('Mushrooms (Button)', 150, 'g'), g('Onions', 30, 'g'),
        g('Garam Masala', 4, 'g'), g('Red Chilli Powder', 2, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],

    // ── Main Course ──────────────────────────────────────────────────
    'Kadhai Paneer': [
        g('Paneer', 150, 'g'), g('Capsicum (Mixed)', 50, 'g'),
        g('Tomatoes', 40, 'g'), g('Onions', 30, 'g'),
        g('Garam Masala', 4, 'g'),
    ],
    'Baingan Bharta': [
        g('Eggplant (Brinjal)', 200, 'g'), g('Onions', 50, 'g'),
        g('Tomatoes', 40, 'g'), g('Garam Masala', 3, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Jeera Aloo': [
        g('Potatoes', 200, 'g'), g('Cumin Seeds (Jeera)', 5, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'), g('Coriander (Fresh)', 5, 'g'),
    ],
    'Yellow Dal Tadka': [
        g('Yellow Lentils (Toor Dal)', 100, 'g'), g('Onions', 30, 'g'),
        g('Tomatoes', 30, 'g'), g('Cumin Seeds (Jeera)', 3, 'g'),
        g('Turmeric Powder', 2, 'g'),
    ],
    'Palak Paneer': [
        g('Paneer', 100, 'g'), g('Spinach (Palak)', 150, 'g'),
        g('Onions', 30, 'g'), g('Fresh Cream', 30, 'mL'),
        g('Garam Masala', 4, 'g'),
    ],

    // ── Healthy Food ─────────────────────────────────────────────────
    'Quinoa Bowl': [
        g('Quinoa', 100, 'g'), g('Capsicum (Mixed)', 30, 'g'),
        g('Carrots', 30, 'g'), g('Olive Oil (Extra Virgin)', 10, 'mL'),
    ],
    'Boiled Veggies with Herbs': [
        g('Carrots', 80, 'g'), g('Frozen Peas', 50, 'g'),
        g('Capsicum (Mixed)', 50, 'g'), g('Italian Herbs Mix', 2, 'g'),
        g('Olive Oil (Extra Virgin)', 10, 'mL'),
    ],
    'Protein Rich Sprouts': [
        g('Sprouts (Mixed)', 150, 'g'), g('Onions', 30, 'g'),
        g('Lemons', 20, 'g'), g('Coriander (Fresh)', 5, 'g'),
    ],
    'Oatmeal Porridge': [
        g('Oats', 80, 'g'), g('Full Cream Milk', 200, 'mL'),
        g('Sugar', 15, 'g'), g('Honey', 10, 'g'),
    ],
    'Steamed Broccoli Salad': [
        g('Broccoli', 150, 'g'), g('Olive Oil (Extra Virgin)', 10, 'mL'),
        g('Black Pepper (Ground)', 1, 'g'), g('Lemons', 15, 'g'),
    ],

    // ── Desserts ─────────────────────────────────────────────────────
    'Gulab Jamun': [
        g('All-Purpose Flour (Maida)', 60, 'g'), g('Condensed Milk', 80, 'g'),
        g('Sugar', 60, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Chocolate Lava Cake': [
        g('Brownie Mix', 80, 'g'), g('Butter (Unsalted)', 30, 'g'),
        g('Eggs (Farm Fresh)', 0.083, 'dozen'), g('Cocoa Powder', 15, 'g'),
        g('Sugar', 30, 'g'),
    ],
    'Rasmalai': [
        g('Paneer', 100, 'g'), g('Full Cream Milk', 150, 'mL'),
        g('Sugar', 30, 'g'), g('Saffron (Kesar)', 0.1, 'g'),
    ],
    'Fruit Custard': [
        g('Mixed Fruits (Seasonal)', 100, 'g'), g('Full Cream Milk', 200, 'mL'),
        g('Sugar', 30, 'g'),
    ],
    'Brownie with Fudge': [
        g('Brownie Mix', 100, 'g'), g('Butter (Unsalted)', 30, 'g'),
        g('Eggs (Farm Fresh)', 0.083, 'dozen'), g('Chocolate Syrup', 30, 'g'),
    ],

    // ── Ice Cream ────────────────────────────────────────────────────
    'Vanilla Scoop': [
        g('Vanilla Ice Cream', 100, 'mL'),
    ],
    'Chocolate Belgium': [
        g('Vanilla Ice Cream', 100, 'mL'), g('Cocoa Powder', 10, 'g'),
        g('Chocolate Syrup', 15, 'g'),
    ],
    'Strawberry Swirl': [
        g('Vanilla Ice Cream', 100, 'mL'), g('Strawberry Pulp', 30, 'g'),
    ],
    'Butterscotch Crunch': [
        g('Vanilla Ice Cream', 100, 'mL'), g('Sugar', 15, 'g'),
        g('Butter (Unsalted)', 5, 'g'),
    ],
    'Mango Delight': [
        g('Vanilla Ice Cream', 100, 'mL'), g('Mango Pulp', 50, 'g'),
    ],

    // ── Milkshakes ───────────────────────────────────────────────────
    'Classic Vanilla Shake': [
        g('Full Cream Milk', 200, 'mL'), g('Vanilla Ice Cream', 50, 'mL'),
        g('Sugar', 15, 'g'),
    ],
    'Strong Cold Coffee': [
        g('Full Cream Milk', 200, 'mL'), g('Coffee Beans (Arabica)', 12, 'g'),
        g('Sugar', 15, 'g'),
    ],
    'Oreo Shake': [
        g('Full Cream Milk', 200, 'mL'), g('Vanilla Ice Cream', 50, 'mL'),
        g('Oreo Biscuits', 0.3, 'pack'), g('Sugar', 10, 'g'),
    ],
    'Chocolate Smoothie': [
        g('Full Cream Milk', 200, 'mL'), g('Cocoa Powder', 15, 'g'),
        g('Sugar', 20, 'g'), g('Chocolate Syrup', 15, 'g'),
    ],
    'Mango Shake': [
        g('Full Cream Milk', 200, 'mL'), g('Mango Pulp', 80, 'g'),
        g('Sugar', 15, 'g'),
    ],

    // ── Cold Drinks ──────────────────────────────────────────────────
    'Lemon Iced Tea': [
        g('Lemon Iced Tea Concentrate', 50, 'mL'), g('Lemons', 20, 'g'),
        g('Sugar', 15, 'g'), g('Mineral Water (1L)', 0.25, 'bottle'),
    ],
    'Fresh Lime Soda': [
        g('Lemons', 30, 'g'), g('Sugar', 15, 'g'),
        g('Mineral Water (1L)', 0.25, 'bottle'),
    ],
    'Coke / Pepsi': [
        g('Coca Cola (300ml)', 1, 'bottle'),
    ],
    'Cold Coffee with Ice Cream': [
        g('Full Cream Milk', 180, 'mL'), g('Coffee Beans (Arabica)', 12, 'g'),
        g('Sugar', 15, 'g'), g('Vanilla Ice Cream', 50, 'mL'),
    ],
    'Virgin Mojito': [
        g('Lemons', 30, 'g'), g('Sugar', 20, 'g'),
        g('Mint Leaves', 5, 'g'), g('Mineral Water (1L)', 0.25, 'bottle'),
    ],

    // ── Coffee ───────────────────────────────────────────────────────
    'Cappuccino': [
        g('Coffee Beans (Arabica)', 10, 'g'), g('Full Cream Milk', 100, 'mL'),
        g('Sugar', 5, 'g'),
    ],
    'Cafe Latte': [
        g('Coffee Beans (Arabica)', 10, 'g'), g('Full Cream Milk', 150, 'mL'),
    ],
    'Espresso Shot': [
        g('Coffee Beans (Arabica)', 10, 'g'),
    ],
    'Irish Coffee': [
        g('Coffee Beans (Arabica)', 10, 'g'), g('Full Cream Milk', 100, 'mL'),
        g('Fresh Cream', 30, 'mL'), g('Sugar', 8, 'g'),
    ],
    'Mocha': [
        g('Coffee Beans (Arabica)', 10, 'g'), g('Full Cream Milk', 100, 'mL'),
        g('Cocoa Powder', 10, 'g'), g('Sugar', 10, 'g'),
    ],

    // ── Tea ──────────────────────────────────────────────────────────
    'Masala Chai': [
        g('Tea Leaves (Assam Premium)', 5, 'g'), g('Full Cream Milk', 100, 'mL'),
        g('Sugar', 10, 'g'), g('Garam Masala', 1, 'g'),
        g('Ginger-Garlic Paste', 2, 'g'),
    ],
    'Ginger Lemon Tea': [
        g('Tea Leaves (Assam Premium)', 5, 'g'), g('Ginger-Garlic Paste', 5, 'g'),
        g('Lemons', 15, 'g'), g('Sugar', 8, 'g'),
    ],
    'Green Tea': [
        g('Green Tea Leaves', 3, 'g'),
    ],
    'Honey Lemon Tea': [
        g('Tea Leaves (Assam Premium)', 5, 'g'), g('Lemons', 15, 'g'),
        g('Honey', 15, 'g'),
    ],
    'Kullad Chai': [
        g('Tea Leaves (Assam Premium)', 5, 'g'), g('Full Cream Milk', 100, 'mL'),
        g('Sugar', 10, 'g'),
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY FALLBACK — when a menu item's base name doesn't match any
// blueprint exactly (custom item, typo, future addition), we use a
// reasonable per-category recipe so every item still gets stock
// tracking. The script logs which items fell back so the admin can
// curate them later.
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_FALLBACKS = {
    'Pizza':         RECIPE_BLUEPRINTS['Veggie Supreme'],
    'Burger':        RECIPE_BLUEPRINTS['Cheese Jumbo Burger'],
    'Biryani':       RECIPE_BLUEPRINTS['Hyderabadi Veg Biryani'],
    'Chinese':       RECIPE_BLUEPRINTS['Veg Fried Rice'],
    'South Indian':  RECIPE_BLUEPRINTS['Masala Dosa'],
    'North Indian':  RECIPE_BLUEPRINTS['Paneer Tikka Masala'],
    'Sandwich':      RECIPE_BLUEPRINTS['Bombay Grilled Sandwich'],
    'Wraps':         RECIPE_BLUEPRINTS['Paneer Tikka Wrap'],
    'Salads':        RECIPE_BLUEPRINTS['Garden Fresh Salad'],
    'Pasta':         RECIPE_BLUEPRINTS['White Sauce Pasta'],
    'Noodles':       RECIPE_BLUEPRINTS['Classic Hakka Noodles'],
    'Starters':      RECIPE_BLUEPRINTS['Crispy Corn'],
    'Main Course':   RECIPE_BLUEPRINTS['Kadhai Paneer'],
    'Healthy Food':  RECIPE_BLUEPRINTS['Quinoa Bowl'],
    'Desserts':      RECIPE_BLUEPRINTS['Brownie with Fudge'],
    'Ice Cream':     RECIPE_BLUEPRINTS['Vanilla Scoop'],
    'Milkshakes':    RECIPE_BLUEPRINTS['Classic Vanilla Shake'],
    'Cold Drinks':   RECIPE_BLUEPRINTS['Fresh Lime Soda'],
    'Coffee':        RECIPE_BLUEPRINTS['Cappuccino'],
    'Tea':           RECIPE_BLUEPRINTS['Masala Chai'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Strip the trailing " <number>" that seedMenuItems.js appends. Keeps
// "Espresso Shot" and "Cappuccino 49" both resolvable to their base.
function baseMenuName(name) {
    return String(name || '').replace(/\s+\d+$/, '').trim();
}

// Generate a fresh INV-XXX itemId that doesn't collide with any
// existing inventory row (itemId is globally unique on the Inventory
// model). We scan once and increment locally as we lazy-create.
async function makeItemIdFactory() {
    const existing = await Inventory.find({}).select('itemId').lean();
    let maxN = 0;
    for (const row of existing) {
        const m = /^INV-(\d+)$/.exec(row.itemId || '');
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > maxN) maxN = n;
        }
    }
    let counter = maxN + 1;
    return () => {
        const id = `INV-${String(counter).padStart(3, '0')}`;
        counter += 1;
        return id;
    };
}

async function resolveTenant() {
    const slug = process.env.TENANT_SLUG;
    if (slug) {
        const t = await Restaurant.findOne({ slug });
        if (!t) throw new Error(`No restaurant found with slug "${slug}"`);
        return t;
    }
    const t = await Restaurant.findOne({}).sort({ createdAt: 1 });
    if (!t) throw new Error('No Restaurant document exists. Run seedDefaultTenant first.');
    return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.MONGO_URL) {
        console.error('❌ MONGO_URL is not set. Add it to Backend/.env first.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URL);
    console.log('✔ Connected to MongoDB');

    const tenant = await resolveTenant();
    console.log(`✔ Tenant: ${tenant.name} (${tenant.slug || tenant._id})`);

    // 1) Cache existing inventory for this tenant by lowercase name. We
    //    don't filter by tenant on itemId conflicts because itemId is
    //    globally unique — the factory above handles uniqueness.
    const existingInv = await Inventory.find({ restaurant: tenant._id }).lean();
    const invByName = new Map(existingInv.map(i => [i.name.toLowerCase(), i]));
    console.log(`  ${existingInv.length} inventory item(s) already exist for this tenant`);

    const nextItemId = await makeItemIdFactory();

    // Lazy-create inventory rows referenced by recipes. Returns a Map
    // ingredient-name → inventoryItem _id used by the recipe upserts.
    async function ensureInventory(neededNames) {
        const idByName = new Map();
        let createdCount = 0;
        for (const name of neededNames) {
            const lc = name.toLowerCase();
            const cached = invByName.get(lc);
            if (cached) {
                idByName.set(name, cached._id);
                continue;
            }
            const blueprint = INVENTORY_CATALOG[name];
            if (!blueprint) {
                console.warn(`  ⚠ Recipe references "${name}" but it's not in INVENTORY_CATALOG — skipping`);
                continue;
            }
            const created = await Inventory.create({
                restaurant: tenant._id,
                itemId: nextItemId(),
                name,
                ...blueprint,
                adjustmentHistory: blueprint.currentStock > 0 ? [{
                    type: 'restock',
                    quantity: blueprint.currentStock,
                    previousStock: 0,
                    newStock: blueprint.currentStock,
                    reason: 'Initial stock — seedRecipes auto-create',
                    date: new Date(),
                }] : [],
                lastRestocked: blueprint.currentStock > 0 ? new Date() : undefined,
            });
            invByName.set(lc, created.toObject());
            idByName.set(name, created._id);
            createdCount += 1;
        }
        return { idByName, createdCount };
    }

    // 2) Walk every menu item for the tenant and upsert its recipe.
    const menuItems = await MenuItem.find({ restaurant: tenant._id })
        .populate('category', 'name')
        .lean();
    console.log(`  ${menuItems.length} menu item(s) in this tenant`);

    if (menuItems.length === 0) {
        console.log('No menu items to process. Run seedMenuItems first.');
        await mongoose.disconnect();
        process.exit(0);
    }

    const stats = {
        recipesUpserted: 0,
        usedExactBlueprint: 0,
        usedCategoryFallback: 0,
        skippedNoBlueprint: 0,
        inventoryCreated: 0,
        ingredientsMissing: 0,
    };

    for (const mi of menuItems) {
        const baseName = baseMenuName(mi.name);
        const categoryName = mi.category?.name || '';
        let blueprint = RECIPE_BLUEPRINTS[baseName];
        let usedFallback = false;
        if (!blueprint) {
            blueprint = CATEGORY_FALLBACKS[categoryName];
            if (blueprint) usedFallback = true;
        }

        if (!blueprint) {
            stats.skippedNoBlueprint += 1;
            console.warn(`  ⚠ Skipped "${mi.name}" — no blueprint or category fallback for category "${categoryName}"`);
            continue;
        }

        // Ensure every ingredient exists in this tenant's inventory.
        const neededNames = [...new Set(blueprint.map(b => b.name))];
        const { idByName, createdCount } = await ensureInventory(neededNames);
        stats.inventoryCreated += createdCount;

        const recipeIngredients = [];
        for (const b of blueprint) {
            const invId = idByName.get(b.name);
            if (!invId) { stats.ingredientsMissing += 1; continue; }
            recipeIngredients.push({
                inventoryItem: invId,
                quantity: b.quantity,
                unit: b.unit,
            });
        }

        if (recipeIngredients.length === 0) {
            console.warn(`  ⚠ Skipped "${mi.name}" — every ingredient was missing from INVENTORY_CATALOG`);
            stats.skippedNoBlueprint += 1;
            continue;
        }

        // Upsert: replace the ingredient list every run so corrections
        // to RECIPE_BLUEPRINTS roll forward without manual cleanup.
        await Recipe.findOneAndUpdate(
            { restaurant: tenant._id, menuItem: mi._id, branch: null },
            {
                $set: {
                    restaurant: tenant._id,
                    menuItem: mi._id,
                    branch: null,
                    ingredients: recipeIngredients,
                    yield: 1,
                    notes: usedFallback
                        ? `Auto-seeded from category fallback (${categoryName}). Edit me from Inventory → Recipes for accuracy.`
                        : 'Auto-seeded from RECIPE_BLUEPRINTS.',
                },
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );

        stats.recipesUpserted += 1;
        if (usedFallback) stats.usedCategoryFallback += 1;
        else stats.usedExactBlueprint += 1;
    }

    // 3) Summary
    console.log('\n📊 Seed Summary');
    console.log(`   Tenant:               ${tenant.name}`);
    console.log(`   Menu items processed: ${menuItems.length}`);
    console.log(`   Recipes upserted:     ${stats.recipesUpserted}`);
    console.log(`     ↳ exact blueprint:  ${stats.usedExactBlueprint}`);
    console.log(`     ↳ category fallback:${stats.usedCategoryFallback}`);
    console.log(`   Skipped (no recipe):  ${stats.skippedNoBlueprint}`);
    console.log(`   Inventory auto-added: ${stats.inventoryCreated}`);
    if (stats.ingredientsMissing) {
        console.log(`   ⚠ Ingredient links missing: ${stats.ingredientsMissing} (rows lacking INVENTORY_CATALOG entry)`);
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedRecipes failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
