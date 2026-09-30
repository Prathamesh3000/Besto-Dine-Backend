/**
 * seedFullInventoryAndRecipes.js
 *
 * Comprehensive single-shot seed that wires every menu item created by
 * seedFullCategories.js + seedFullMenu.js + seedNonVegMenu.js to:
 *   1. A complete Inventory catalog covering every raw material, dairy
 *      item, spice, sauce, oil, packaged drink, packaging and cleaning
 *      supply that the recipes reference.
 *   2. A Recipe row mapping the menu item to exact ingredient quantities
 *      so the kitchen "preparing" hook in inventoryController auto-deducts
 *      stock on order.
 *
 * Idempotent — every run upserts:
 *   - Inventory: matched by (restaurant, name); creates missing rows
 *     with INV-XXX itemIds that don't collide with the existing series.
 *   - Recipes: matched by (restaurant, menuItem, branch=null); replaces
 *     ingredient list every run so corrections roll forward.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullInventoryAndRecipes.js
 *   TENANT_SLUG=<slug> node Seed/seedFullInventoryAndRecipes.js
 *
 * Pre-requisites for full coverage:
 *   - A Restaurant document must exist (run seedDefaultTenant.js first
 *     if seeding fresh).
 *   - seedFullCategories.js → seedFullMenu.js → seedNonVegMenu.js must
 *     have populated the categories and menu items for the tenant.
 *     (This script is safe to run before any of those — it will simply
 *     report 0 recipes wired and only seed inventory.)
 *
 * Menu items without an exact recipe blueprint fall back to a curated
 * per-category recipe so every item still gets stock tracking. The
 * script logs which items used the fallback so the admin can curate
 * them later.
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Inventory = require('../models/inventory');
const Recipe = require('../models/recipe');
const MenuItem = require('../models/menuItem');
// Required so populate('category') resolves on the open connection.
require('../models/category');

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY CATALOG
//
// Every ingredient referenced by RECIPES below MUST exist as a key here.
// Categories must match the Inventory enum; units must match the
// Inventory enum (kg, g, L, mL, pcs, dozen, box, pack, bottle, can).
// Recipes can use a kg-priced item with a "g" line and the controller
// converts kg↔g, L↔mL automatically.
// ─────────────────────────────────────────────────────────────────────────────
const INVENTORY = {
    // ── Raw Ingredients — flours, rice, dals, sugars, salts ────────────
    'All-Purpose Flour (Maida)':     { category: 'Raw Ingredients', unit: 'kg', currentStock: 50, minStock: 10, maxStock: 120, costPerUnit: 42 },
    'Whole Wheat Flour (Atta)':      { category: 'Raw Ingredients', unit: 'kg', currentStock: 40, minStock: 10, maxStock: 100, costPerUnit: 38 },
    'Basmati Rice':                  { category: 'Raw Ingredients', unit: 'kg', currentStock: 60, minStock: 15, maxStock: 150, costPerUnit: 95 },
    'Idli Rice':                     { category: 'Raw Ingredients', unit: 'kg', currentStock: 25, minStock: 8,  maxStock: 60,  costPerUnit: 70 },
    'Quinoa':                        { category: 'Raw Ingredients', unit: 'kg', currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 480 },
    'Oats':                          { category: 'Raw Ingredients', unit: 'kg', currentStock: 10, minStock: 3,  maxStock: 25,  costPerUnit: 180 },
    'Mixed Millets':                 { category: 'Raw Ingredients', unit: 'kg', currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 120 },
    'Sugar':                         { category: 'Raw Ingredients', unit: 'kg', currentStock: 30, minStock: 8,  maxStock: 80,  costPerUnit: 45 },
    'Jaggery':                       { category: 'Raw Ingredients', unit: 'kg', currentStock: 5,  minStock: 1,  maxStock: 15,  costPerUnit: 80 },
    'Salt (Iodised)':                { category: 'Raw Ingredients', unit: 'kg', currentStock: 15, minStock: 4,  maxStock: 40,  costPerUnit: 22 },
    'Black Salt':                    { category: 'Raw Ingredients', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5,   costPerUnit: 60 },

    // ── Raw Ingredients — pulses, sprouts ──────────────────────────────
    'Yellow Lentils (Toor Dal)':     { category: 'Raw Ingredients', unit: 'kg', currentStock: 12, minStock: 4,  maxStock: 30,  costPerUnit: 150 },
    'Black Lentils (Urad Dal)':      { category: 'Raw Ingredients', unit: 'kg', currentStock: 10, minStock: 3,  maxStock: 25,  costPerUnit: 140 },
    'Black Whole Urad Dal':          { category: 'Raw Ingredients', unit: 'kg', currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 160 },
    'Moong Dal (Yellow Split)':      { category: 'Raw Ingredients', unit: 'kg', currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 130 },
    'Rajma (Kidney Beans)':          { category: 'Raw Ingredients', unit: 'kg', currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 160 },
    'Chickpeas (Kabuli Chana)':      { category: 'Raw Ingredients', unit: 'kg', currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 110 },
    'Moong Sprouts':                 { category: 'Raw Ingredients', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 120 },
    'Chana Sprouts':                 { category: 'Raw Ingredients', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 130 },

    // ── Raw Ingredients — paneer, dough bases, pre-made bases ──────────
    'Paneer':                        { category: 'Raw Ingredients', unit: 'kg', currentStock: 10, minStock: 4,  maxStock: 25,  costPerUnit: 340 },
    'Khoya (Mawa)':                  { category: 'Raw Ingredients', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 380 },
    'Pizza Dough Base (7")':         { category: 'Raw Ingredients', unit: 'pcs',currentStock: 50, minStock: 15, maxStock: 120, costPerUnit: 25 },
    'Pizza Dough Base (10")':        { category: 'Raw Ingredients', unit: 'pcs',currentStock: 40, minStock: 12, maxStock: 100, costPerUnit: 35 },
    'Pizza Dough Base (12")':        { category: 'Raw Ingredients', unit: 'pcs',currentStock: 30, minStock: 10, maxStock: 80,  costPerUnit: 50 },
    'Sambar (Ready)':                { category: 'Raw Ingredients', unit: 'L',  currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 100 },
    'Rasam (Ready)':                 { category: 'Raw Ingredients', unit: 'L',  currentStock: 5,  minStock: 1,  maxStock: 12,  costPerUnit: 90 },
    'Coconut Chutney':               { category: 'Raw Ingredients', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 180 },
    'Coconut (Grated)':              { category: 'Raw Ingredients', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 180 },
    'Tamarind Pulp':                 { category: 'Raw Ingredients', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5,   costPerUnit: 220 },

    // ── Raw Ingredients — non-veg proteins ─────────────────────────────
    'Chicken (Boneless)':            { category: 'Raw Ingredients', unit: 'kg', currentStock: 12, minStock: 5,  maxStock: 30,  costPerUnit: 320 },
    'Chicken (with Bone)':           { category: 'Raw Ingredients', unit: 'kg', currentStock: 10, minStock: 4,  maxStock: 25,  costPerUnit: 240 },
    'Chicken Winglets':              { category: 'Raw Ingredients', unit: 'kg', currentStock: 5,  minStock: 2,  maxStock: 15,  costPerUnit: 280 },
    'Whole Chicken':                 { category: 'Raw Ingredients', unit: 'kg', currentStock: 8,  minStock: 3,  maxStock: 20,  costPerUnit: 220 },
    'Chicken Breast':                { category: 'Raw Ingredients', unit: 'kg', currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 380 },
    'Chicken Mince':                 { category: 'Raw Ingredients', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 300 },
    'Mutton':                        { category: 'Raw Ingredients', unit: 'kg', currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 680 },
    'Basa Fish (Boneless)':          { category: 'Raw Ingredients', unit: 'kg', currentStock: 5,  minStock: 2,  maxStock: 12,  costPerUnit: 320 },

    // ── Dairy & Eggs ───────────────────────────────────────────────────
    'Full Cream Milk':               { category: 'Dairy & Eggs', unit: 'L',     currentStock: 30, minStock: 12, maxStock: 80,  costPerUnit: 60 },
    'Butter (Unsalted)':             { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 480 },
    'Ghee':                          { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 580 },
    'Yogurt (Curd)':                 { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 8,  minStock: 3,  maxStock: 20,  costPerUnit: 80 },
    'Hung Yogurt':                   { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 120 },
    'Fresh Cream':                   { category: 'Dairy & Eggs', unit: 'L',     currentStock: 5,  minStock: 2,  maxStock: 12,  costPerUnit: 280 },
    'Whipped Cream':                 { category: 'Dairy & Eggs', unit: 'L',     currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 320 },
    'Eggs (Farm Fresh)':             { category: 'Dairy & Eggs', unit: 'dozen', currentStock: 15, minStock: 5,  maxStock: 40,  costPerUnit: 72 },
    'Egg Whites (Liquid)':           { category: 'Dairy & Eggs', unit: 'L',     currentStock: 2,  minStock: 0.5,maxStock: 5,   costPerUnit: 240 },
    'Mozzarella Cheese':             { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 520 },
    'Cheddar Cheese':                { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 580 },
    'Parmesan Cheese':               { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 2,  minStock: 0.5,maxStock: 5,   costPerUnit: 980 },
    'Feta Cheese':                   { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 2,  minStock: 0.5,maxStock: 5,   costPerUnit: 720 },
    'Cheese Slices':                 { category: 'Dairy & Eggs', unit: 'pack',  currentStock: 10, minStock: 4,  maxStock: 25,  costPerUnit: 110 },
    'Condensed Milk':                { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 240 },
    'Vanilla Ice Cream':             { category: 'Dairy & Eggs', unit: 'L',     currentStock: 5,  minStock: 2,  maxStock: 12,  costPerUnit: 240 },
    'Strawberry Ice Cream':          { category: 'Dairy & Eggs', unit: 'L',     currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 260 },
    'Chocolate Ice Cream':           { category: 'Dairy & Eggs', unit: 'L',     currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 260 },
    'Butterscotch Ice Cream':        { category: 'Dairy & Eggs', unit: 'L',     currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 260 },
    'Mango Ice Cream':               { category: 'Dairy & Eggs', unit: 'L',     currentStock: 3,  minStock: 1,  maxStock: 8,   costPerUnit: 280 },
    'Shrikhand':                     { category: 'Dairy & Eggs', unit: 'kg',    currentStock: 2,  minStock: 0.5,maxStock: 5,   costPerUnit: 280 },

    // ── Spices & Seasonings ────────────────────────────────────────────
    'Red Chilli Powder':             { category: 'Spices & Seasonings', unit: 'kg', currentStock: 4,   minStock: 1,   maxStock: 10, costPerUnit: 280 },
    'Kashmiri Chilli Powder':        { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 6,  costPerUnit: 380 },
    'Turmeric Powder':               { category: 'Spices & Seasonings', unit: 'kg', currentStock: 3,   minStock: 1,   maxStock: 8,  costPerUnit: 200 },
    'Coriander Powder':              { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 6,  costPerUnit: 220 },
    'Garam Masala':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 5,  costPerUnit: 450 },
    'Tandoori Masala':               { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 5,  costPerUnit: 480 },
    'Tikka Masala':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1.5, minStock: 0.5, maxStock: 4,  costPerUnit: 460 },
    'Chaat Masala':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 380 },
    'Frankie Masala':                { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 400 },
    'Peri Peri Seasoning':           { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.5, maxStock: 4,  costPerUnit: 420 },
    'Black Pepper (Ground)':         { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1.5, minStock: 0.5, maxStock: 4,  costPerUnit: 680 },
    'White Pepper Powder':           { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.8, minStock: 0.3, maxStock: 3,  costPerUnit: 720 },
    'Cumin Seeds (Jeera)':           { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 6,  costPerUnit: 320 },
    'Coriander Seeds':               { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 6,  costPerUnit: 220 },
    'Carom Seeds (Ajwain)':          { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.5, minStock: 0.2, maxStock: 2,  costPerUnit: 380 },
    'Mustard Seeds':                 { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 120 },
    'Fennel Seeds':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 280 },
    'Cardamom (Green)':              { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.3, minStock: 0.1, maxStock: 1,  costPerUnit: 1800 },
    'Cloves':                        { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.3, minStock: 0.1, maxStock: 1,  costPerUnit: 1200 },
    'Bay Leaves':                    { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.5, minStock: 0.2, maxStock: 2,  costPerUnit: 280 },
    'Saffron (Kesar)':               { category: 'Spices & Seasonings', unit: 'g',  currentStock: 100, minStock: 20,  maxStock: 300,costPerUnit: 45 },
    'Italian Herbs Mix':             { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 720 },
    'Oregano':                       { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 380 },
    'Chilli Flakes':                 { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.8, minStock: 0.3, maxStock: 3,  costPerUnit: 300 },
    'Curry Leaves':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 60 },
    'Curry Powder':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 1,   minStock: 0.3, maxStock: 3,  costPerUnit: 380 },
    'Kasuri Methi':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.5, minStock: 0.2, maxStock: 2,  costPerUnit: 480 },
    'Green Chilli':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 1,   maxStock: 5,  costPerUnit: 100 },
    'Yeast (Active Dry)':            { category: 'Spices & Seasonings', unit: 'kg', currentStock: 0.5, minStock: 0.2, maxStock: 2,  costPerUnit: 320 },
    'Cornflour':                     { category: 'Spices & Seasonings', unit: 'kg', currentStock: 3,   minStock: 1,   maxStock: 8,  costPerUnit: 80 },
    'Mango Pickle':                  { category: 'Spices & Seasonings', unit: 'kg', currentStock: 2,   minStock: 0.5, maxStock: 5,  costPerUnit: 220 },

    // ── Oils & Sauces ──────────────────────────────────────────────────
    'Refined Sunflower Oil':         { category: 'Oils & Sauces', unit: 'L',  currentStock: 25, minStock: 8, maxStock: 60, costPerUnit: 150 },
    'Olive Oil (Extra Virgin)':      { category: 'Oils & Sauces', unit: 'L',  currentStock: 4,  minStock: 1, maxStock: 10, costPerUnit: 750 },
    'Mustard Oil':                   { category: 'Oils & Sauces', unit: 'L',  currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 200 },
    'Sesame Oil':                    { category: 'Oils & Sauces', unit: 'L',  currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 460 },
    'Soy Sauce':                     { category: 'Oils & Sauces', unit: 'L',  currentStock: 5,  minStock: 1, maxStock: 12, costPerUnit: 180 },
    'Vinegar':                       { category: 'Oils & Sauces', unit: 'L',  currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 80 },
    'Schezwan Sauce':                { category: 'Oils & Sauces', unit: 'kg', currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 260 },
    'Pizza Sauce':                   { category: 'Oils & Sauces', unit: 'kg', currentStock: 5,  minStock: 1, maxStock: 12, costPerUnit: 200 },
    'Makhani Sauce':                 { category: 'Oils & Sauces', unit: 'kg', currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 280 },
    'Pasta White Sauce':             { category: 'Oils & Sauces', unit: 'kg', currentStock: 4,  minStock: 1, maxStock: 10, costPerUnit: 240 },
    'Pesto Sauce':                   { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 380 },
    'BBQ Sauce':                     { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 280 },
    'Peri Peri Sauce':               { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 320 },
    'Red Chilli Sauce':              { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 180 },
    'Sweet Chilli Sauce':            { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 200 },
    'Tomato Ketchup':                { category: 'Oils & Sauces', unit: 'kg', currentStock: 5,  minStock: 2, maxStock: 12, costPerUnit: 120 },
    'Mayonnaise':                    { category: 'Oils & Sauces', unit: 'kg', currentStock: 4,  minStock: 1, maxStock: 10, costPerUnit: 210 },
    'Chipotle Mayo':                 { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 240 },
    'Mint Mayo':                     { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 220 },
    'Mint Chutney':                  { category: 'Oils & Sauces', unit: 'kg', currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 180 },
    'Green Chutney':                 { category: 'Oils & Sauces', unit: 'kg', currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 160 },
    'Honey':                         { category: 'Oils & Sauces', unit: 'kg', currentStock: 4,  minStock: 1, maxStock: 10, costPerUnit: 380 },
    'Tahini':                        { category: 'Oils & Sauces', unit: 'kg', currentStock: 1,  minStock: 0.3,maxStock: 3, costPerUnit: 480 },
    'Hummus':                        { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 280 },
    'Salsa':                         { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 220 },
    'Chocolate Syrup':               { category: 'Oils & Sauces', unit: 'kg', currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 320 },
    'Cocoa Powder':                  { category: 'Oils & Sauces', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5, costPerUnit: 520 },
    'Vanilla Essence':               { category: 'Oils & Sauces', unit: 'L',  currentStock: 1,  minStock: 0.3,maxStock: 3, costPerUnit: 980 },
    'Rose Water':                    { category: 'Oils & Sauces', unit: 'L',  currentStock: 1,  minStock: 0.3,maxStock: 3, costPerUnit: 220 },
    'Sugar Syrup':                   { category: 'Oils & Sauces', unit: 'L',  currentStock: 3,  minStock: 1, maxStock: 8,  costPerUnit: 100 },
    'Caesar Dressing':               { category: 'Oils & Sauces', unit: 'kg', currentStock: 1,  minStock: 0.3,maxStock: 3, costPerUnit: 320 },
    'Lemon-Tahini Dressing':         { category: 'Oils & Sauces', unit: 'kg', currentStock: 1,  minStock: 0.3,maxStock: 3, costPerUnit: 360 },

    // ── Fruits & Vegetables ────────────────────────────────────────────
    'Onions':                        { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 30, minStock: 12, maxStock: 60, costPerUnit: 35 },
    'Fried Onions (Birista)':        { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,  costPerUnit: 280 },
    'Tomatoes':                      { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 20, minStock: 8,  maxStock: 50, costPerUnit: 40 },
    'Potatoes':                      { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 30, minStock: 10, maxStock: 70, costPerUnit: 30 },
    'Sweet Potato':                  { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10, costPerUnit: 60 },
    'Capsicum (Mixed)':              { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 6,  minStock: 2,  maxStock: 15, costPerUnit: 80 },
    'Mushrooms (Button)':            { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10, costPerUnit: 180 },
    'Carrots':                       { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5,  minStock: 2,  maxStock: 12, costPerUnit: 45 },
    'Cabbage':                       { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10, costPerUnit: 30 },
    'Broccoli':                      { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10, costPerUnit: 220 },
    'Beans (Green)':                 { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10, costPerUnit: 70 },
    'Spinach (Palak)':               { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10, costPerUnit: 50 },
    'Spring Onion':                  { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5,  costPerUnit: 120 },
    'Cucumber':                      { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5,  minStock: 1,  maxStock: 12, costPerUnit: 40 },
    'Lettuce':                       { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,  costPerUnit: 90 },
    'Romaine Lettuce':               { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5,  costPerUnit: 140 },
    'Black Olives':                  { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 1,  minStock: 0.3,maxStock: 3,  costPerUnit: 480 },
    'Jalapeño':                      { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 1,  minStock: 0.3,maxStock: 3,  costPerUnit: 280 },
    'Eggplant (Brinjal)':            { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,  costPerUnit: 50 },
    'Lemons':                        { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5,  minStock: 2,  maxStock: 12, costPerUnit: 60 },
    'Coriander (Fresh)':             { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,  costPerUnit: 50 },
    'Mint Leaves':                   { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5,  costPerUnit: 60 },
    'Basil (Fresh)':                 { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 1,  minStock: 0.3,maxStock: 3,  costPerUnit: 280 },
    'Ginger-Garlic Paste':           { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4,  minStock: 1,  maxStock: 10, costPerUnit: 140 },
    'Garlic (Whole)':                { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3,  minStock: 1,  maxStock: 8,  costPerUnit: 220 },
    'Ginger (Fresh)':                { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 2,  minStock: 0.5,maxStock: 5,  costPerUnit: 120 },

    // ── Fruits ─────────────────────────────────────────────────────────
    'Mixed Fruits (Seasonal)':       { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 6, minStock: 2, maxStock: 15, costPerUnit: 120 },
    'Apple':                         { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5, minStock: 2, maxStock: 12, costPerUnit: 120 },
    'Banana':                        { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 6, minStock: 2, maxStock: 15, costPerUnit: 50 },
    'Pomegranate':                   { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 180 },
    'Grapes':                        { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 100 },
    'Orange':                        { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 6, minStock: 2, maxStock: 15, costPerUnit: 80 },
    'Mosambi (Sweet Lime)':          { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 5, minStock: 2, maxStock: 12, costPerUnit: 70 },
    'Pineapple':                     { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 4, minStock: 1, maxStock: 10, costPerUnit: 90 },
    'Watermelon':                    { category: 'Fruits & Vegetables', unit: 'kg', currentStock: 8, minStock: 3, maxStock: 20, costPerUnit: 30 },

    // ── Pulps & Dry Fruits ─────────────────────────────────────────────
    'Mango Pulp':                    { category: 'Raw Ingredients', unit: 'kg', currentStock: 5, minStock: 1, maxStock: 12, costPerUnit: 220 },
    'Strawberry Pulp':               { category: 'Raw Ingredients', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 280 },
    'Cashew (Whole)':                { category: 'Raw Ingredients', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 980 },
    'Almonds':                       { category: 'Raw Ingredients', unit: 'kg', currentStock: 2, minStock: 0.5,maxStock: 5, costPerUnit: 880 },
    'Walnuts':                       { category: 'Raw Ingredients', unit: 'kg', currentStock: 1, minStock: 0.3,maxStock: 3, costPerUnit: 1200 },
    'Pistachio':                     { category: 'Raw Ingredients', unit: 'kg', currentStock: 1, minStock: 0.3,maxStock: 3, costPerUnit: 1800 },
    'Pine Nuts':                     { category: 'Raw Ingredients', unit: 'kg', currentStock: 0.5,minStock: 0.2,maxStock: 2,costPerUnit: 2400 },
    'Dry Fruits Mix':                { category: 'Raw Ingredients', unit: 'kg', currentStock: 2, minStock: 0.5,maxStock: 5, costPerUnit: 1100 },
    'Praline (Butterscotch Crunch)': { category: 'Raw Ingredients', unit: 'kg', currentStock: 1, minStock: 0.3,maxStock: 3, costPerUnit: 480 },
    'Dark Chocolate':                { category: 'Raw Ingredients', unit: 'kg', currentStock: 2, minStock: 0.5,maxStock: 5, costPerUnit: 680 },

    // ── Beverages — raw materials for fresh-made drinks ────────────────
    'Coffee Beans (Arabica)':        { category: 'Beverages', unit: 'kg', currentStock: 4, minStock: 1, maxStock: 10, costPerUnit: 850 },
    'Tea Leaves (Assam Premium)':    { category: 'Beverages', unit: 'kg', currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 420 },
    'Green Tea Leaves':              { category: 'Beverages', unit: 'kg', currentStock: 1, minStock: 0.3,maxStock: 3, costPerUnit: 680 },
    'Lemon Iced Tea Concentrate':    { category: 'Beverages', unit: 'L',  currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 220 },
    'Soda Water':                    { category: 'Beverages', unit: 'L',  currentStock: 8, minStock: 2, maxStock: 20, costPerUnit: 30 },
    'Mineral Water (1L)':            { category: 'Beverages', unit: 'bottle', currentStock: 60, minStock: 24, maxStock: 150, costPerUnit: 15 },
    'Oreo Biscuits':                 { category: 'Beverages', unit: 'pack', currentStock: 8, minStock: 3, maxStock: 20,  costPerUnit: 80 },

    // ── Beverages — packaged for direct sale (MRP items) ───────────────
    'Coca-Cola 600ml (Stock)':       { category: 'Beverages', unit: 'bottle', currentStock: 60, minStock: 20, maxStock: 150, costPerUnit: 30 },
    'Pepsi 600ml (Stock)':           { category: 'Beverages', unit: 'bottle', currentStock: 48, minStock: 18, maxStock: 120, costPerUnit: 30 },
    'Sprite 600ml (Stock)':          { category: 'Beverages', unit: 'bottle', currentStock: 48, minStock: 18, maxStock: 120, costPerUnit: 30 },
    'Thumbs Up 600ml (Stock)':       { category: 'Beverages', unit: 'bottle', currentStock: 48, minStock: 18, maxStock: 120, costPerUnit: 30 },
    'Red Bull 250ml (Stock)':        { category: 'Beverages', unit: 'can',    currentStock: 24, minStock: 8,  maxStock: 60,  costPerUnit: 105 },
    'Bisleri 1L (Stock)':            { category: 'Beverages', unit: 'bottle', currentStock: 60, minStock: 20, maxStock: 150, costPerUnit: 13 },
    'Bisleri 500ml (Stock)':         { category: 'Beverages', unit: 'bottle', currentStock: 60, minStock: 20, maxStock: 150, costPerUnit: 7 },
    'Aquafina 1L (Stock)':           { category: 'Beverages', unit: 'bottle', currentStock: 36, minStock: 12, maxStock: 90,  costPerUnit: 14 },
    'Kinley 1L (Stock)':             { category: 'Beverages', unit: 'bottle', currentStock: 36, minStock: 12, maxStock: 90,  costPerUnit: 14 },
    'Himalayan Natural 1L (Stock)':  { category: 'Beverages', unit: 'bottle', currentStock: 24, minStock: 8,  maxStock: 60,  costPerUnit: 35 },

    // ── Bakery Items ───────────────────────────────────────────────────
    'Burger Buns':                   { category: 'Bakery Items', unit: 'pcs',  currentStock: 80, minStock: 25, maxStock: 200, costPerUnit: 12 },
    'Brioche Bun':                   { category: 'Bakery Items', unit: 'pcs',  currentStock: 40, minStock: 15, maxStock: 100, costPerUnit: 18 },
    'Sesame Bun':                    { category: 'Bakery Items', unit: 'pcs',  currentStock: 40, minStock: 15, maxStock: 100, costPerUnit: 15 },
    'Sandwich Bread (White)':        { category: 'Bakery Items', unit: 'pack', currentStock: 12, minStock: 4,  maxStock: 30,  costPerUnit: 45 },
    'Multigrain Bread':              { category: 'Bakery Items', unit: 'pack', currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 60 },
    'Tortilla Wraps':                { category: 'Bakery Items', unit: 'pack', currentStock: 10, minStock: 3,  maxStock: 25,  costPerUnit: 110 },
    'Pita Bread':                    { category: 'Bakery Items', unit: 'pcs',  currentStock: 30, minStock: 10, maxStock: 80,  costPerUnit: 18 },
    'Pasta (Penne)':                 { category: 'Bakery Items', unit: 'kg',   currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 180 },
    'Pasta (Fettuccine)':            { category: 'Bakery Items', unit: 'kg',   currentStock: 5,  minStock: 1,  maxStock: 12,  costPerUnit: 200 },
    'Pasta (Fusilli)':               { category: 'Bakery Items', unit: 'kg',   currentStock: 5,  minStock: 1,  maxStock: 12,  costPerUnit: 180 },
    'Pasta (Macaroni)':              { category: 'Bakery Items', unit: 'kg',   currentStock: 5,  minStock: 1,  maxStock: 12,  costPerUnit: 170 },
    'Hakka Noodles (Dry)':           { category: 'Bakery Items', unit: 'kg',   currentStock: 8,  minStock: 2,  maxStock: 20,  costPerUnit: 140 },
    'Brownie (Pre-baked)':           { category: 'Bakery Items', unit: 'pcs',  currentStock: 30, minStock: 10, maxStock: 80,  costPerUnit: 40 },
    'Brownie Mix':                   { category: 'Bakery Items', unit: 'kg',   currentStock: 4,  minStock: 1,  maxStock: 10,  costPerUnit: 380 },
    'Croutons':                      { category: 'Bakery Items', unit: 'kg',   currentStock: 2,  minStock: 0.5,maxStock: 5,   costPerUnit: 280 },
    'Gulab Jamun (Pre-made)':        { category: 'Bakery Items', unit: 'pcs',  currentStock: 60, minStock: 20, maxStock: 150, costPerUnit: 12 },
    'Mysore Pak (Sweet)':            { category: 'Bakery Items', unit: 'pcs',  currentStock: 30, minStock: 10, maxStock: 80,  costPerUnit: 15 },
    'Papad':                         { category: 'Bakery Items', unit: 'pcs',  currentStock: 100,minStock: 30, maxStock: 250, costPerUnit: 4 },

    // ── Frozen Goods ───────────────────────────────────────────────────
    'Frozen French Fries':           { category: 'Frozen Goods', unit: 'kg',  currentStock: 12, minStock: 4,  maxStock: 30,  costPerUnit: 140 },
    'Frozen Peas':                   { category: 'Frozen Goods', unit: 'kg',  currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 110 },
    'Frozen Sweet Corn':             { category: 'Frozen Goods', unit: 'kg',  currentStock: 5,  minStock: 1,  maxStock: 12,  costPerUnit: 130 },
    'Aloo Tikki Patty (Frozen)':     { category: 'Frozen Goods', unit: 'pcs', currentStock: 60, minStock: 20, maxStock: 150, costPerUnit: 14 },
    'Veg Patty (Frozen)':            { category: 'Frozen Goods', unit: 'pcs', currentStock: 60, minStock: 20, maxStock: 150, costPerUnit: 18 },
    'Crispy Veg Patty (Frozen)':     { category: 'Frozen Goods', unit: 'pcs', currentStock: 50, minStock: 15, maxStock: 120, costPerUnit: 22 },
    'Falafel (Frozen)':              { category: 'Frozen Goods', unit: 'pcs', currentStock: 50, minStock: 15, maxStock: 120, costPerUnit: 16 },
    'Chicken Patty (Frozen)':        { category: 'Frozen Goods', unit: 'pcs', currentStock: 50, minStock: 15, maxStock: 120, costPerUnit: 35 },
    'Crispy Chicken Patty (Frozen)': { category: 'Frozen Goods', unit: 'pcs', currentStock: 50, minStock: 15, maxStock: 120, costPerUnit: 42 },
    'Spring Roll Sheets':            { category: 'Frozen Goods', unit: 'pack',currentStock: 6,  minStock: 2,  maxStock: 15,  costPerUnit: 160 },

    // ── Packaging ──────────────────────────────────────────────────────
    'Takeaway Boxes (Large)':        { category: 'Packaging', unit: 'pack', currentStock: 20, minStock: 6, maxStock: 60, costPerUnit: 180 },
    'Takeaway Boxes (Small)':        { category: 'Packaging', unit: 'pack', currentStock: 25, minStock: 8, maxStock: 60, costPerUnit: 120 },
    'Paper Napkins':                 { category: 'Packaging', unit: 'pack', currentStock: 30, minStock: 10,maxStock: 80, costPerUnit: 65 },
    'Disposable Cups (250ml)':      { category: 'Packaging', unit: 'pack', currentStock: 15, minStock: 5, maxStock: 40, costPerUnit: 90 },
    'Disposable Cups (350ml)':      { category: 'Packaging', unit: 'pack', currentStock: 12, minStock: 4, maxStock: 30, costPerUnit: 110 },
    'Aluminium Foil Roll':           { category: 'Packaging', unit: 'pcs',  currentStock: 8,  minStock: 3, maxStock: 20, costPerUnit: 250 },
    'Plastic Spoons (Pack)':         { category: 'Packaging', unit: 'pack', currentStock: 10, minStock: 4, maxStock: 30, costPerUnit: 80 },
    'Pizza Box (12")':               { category: 'Packaging', unit: 'pack', currentStock: 8,  minStock: 3, maxStock: 20, costPerUnit: 250 },
    'Burger Wrap':                   { category: 'Packaging', unit: 'pack', currentStock: 8,  minStock: 3, maxStock: 20, costPerUnit: 120 },
    'Butter Paper':                  { category: 'Packaging', unit: 'pack', currentStock: 6,  minStock: 2, maxStock: 15, costPerUnit: 80 },

    // ── Cleaning Supplies ──────────────────────────────────────────────
    'Dish Wash Liquid':              { category: 'Cleaning Supplies', unit: 'L',    currentStock: 8, minStock: 3, maxStock: 20, costPerUnit: 145 },
    'Floor Cleaner (Pine)':          { category: 'Cleaning Supplies', unit: 'L',    currentStock: 6, minStock: 2, maxStock: 15, costPerUnit: 110 },
    'Hand Sanitizer':                { category: 'Cleaning Supplies', unit: 'L',    currentStock: 5, minStock: 2, maxStock: 12, costPerUnit: 220 },
    'Hand Wash':                     { category: 'Cleaning Supplies', unit: 'L',    currentStock: 4, minStock: 1, maxStock: 10, costPerUnit: 180 },
    'Disinfectant Spray':            { category: 'Cleaning Supplies', unit: 'L',    currentStock: 3, minStock: 1, maxStock: 8,  costPerUnit: 200 },
    'Cleaning Cloth (Pack)':         { category: 'Cleaning Supplies', unit: 'pack', currentStock: 4, minStock: 1, maxStock: 10, costPerUnit: 150 },

    // ── Kitchen Equipment ──────────────────────────────────────────────
    'LPG Gas Cylinder (Commercial)': { category: 'Kitchen Equipment', unit: 'pcs', currentStock: 4, minStock: 1, maxStock: 8,  costPerUnit: 1800 },
    'Kitchen Towel Roll':            { category: 'Kitchen Equipment', unit: 'pcs', currentStock: 12,minStock: 4, maxStock: 30, costPerUnit: 85 },
    'Cling Film Roll':               { category: 'Kitchen Equipment', unit: 'pcs', currentStock: 6, minStock: 2, maxStock: 15, costPerUnit: 180 },
};

// ─────────────────────────────────────────────────────────────────────────────
// RECIPES — keyed by EXACT MenuItem.name from seedFullMenu.js and
// seedNonVegMenu.js. Quantities are per single serving (recipe yield = 1).
// Every ingredient name MUST exist in INVENTORY above.
// ─────────────────────────────────────────────────────────────────────────────
const g = (name, quantity, unit) => ({ name, quantity, unit });

const RECIPES = {
    // ═══════════════════════ VEGETARIAN MENU ═══════════════════════════

    // ── Starters (veg) ─────────────────────────────────────────────────
    'Paneer Tikka': [
        g('Paneer', 200, 'g'), g('Hung Yogurt', 50, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Onions', 30, 'g'),
        g('Tandoori Masala', 5, 'g'), g('Ginger-Garlic Paste', 8, 'g'),
        g('Lemons', 10, 'g'), g('Mustard Oil', 10, 'mL'),
        g('Mint Chutney', 30, 'g'),
    ],
    'Hara Bhara Kebab': [
        g('Spinach (Palak)', 80, 'g'), g('Frozen Peas', 60, 'g'),
        g('Potatoes', 60, 'g'), g('Coriander (Fresh)', 5, 'g'),
        g('Cumin Seeds (Jeera)', 2, 'g'), g('Green Chilli', 3, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'), g('Mint Chutney', 20, 'g'),
    ],
    'Veg Manchurian Dry': [
        g('Cabbage', 80, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Cornflour', 30, 'g'),
        g('All-Purpose Flour (Maida)', 30, 'g'), g('Soy Sauce', 20, 'mL'),
        g('Garlic (Whole)', 5, 'g'), g('Spring Onion', 10, 'g'),
        g('Refined Sunflower Oil', 50, 'mL'),
    ],
    'Crispy Corn': [
        g('Frozen Sweet Corn', 150, 'g'), g('Cornflour', 30, 'g'),
        g('Curry Leaves', 2, 'g'), g('Green Chilli', 3, 'g'),
        g('Lemons', 10, 'g'), g('Black Pepper (Ground)', 1, 'g'),
        g('Refined Sunflower Oil', 50, 'mL'),
    ],
    'Chilli Paneer': [
        g('Paneer', 180, 'g'), g('Capsicum (Mixed)', 40, 'g'),
        g('Onions', 30, 'g'), g('Soy Sauce', 20, 'mL'),
        g('Green Chilli', 3, 'g'), g('Garlic (Whole)', 5, 'g'),
        g('Spring Onion', 10, 'g'), g('Cornflour', 20, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],

    // ── Soups ──────────────────────────────────────────────────────────
    'Veg Manchow Soup': [
        g('Carrots', 30, 'g'), g('Cabbage', 30, 'g'),
        g('Capsicum (Mixed)', 20, 'g'), g('Soy Sauce', 15, 'mL'),
        g('Garlic (Whole)', 3, 'g'), g('Cornflour', 10, 'g'),
        g('Hakka Noodles (Dry)', 10, 'g'), g('White Pepper Powder', 1, 'g'),
    ],
    'Hot & Sour Soup': [
        g('Cabbage', 30, 'g'), g('Carrots', 30, 'g'),
        g('Mushrooms (Button)', 20, 'g'), g('Vinegar', 10, 'mL'),
        g('Soy Sauce', 15, 'mL'), g('White Pepper Powder', 1, 'g'),
        g('Cornflour', 10, 'g'),
    ],
    'Sweet Corn Soup': [
        g('Frozen Sweet Corn', 80, 'g'), g('Carrots', 20, 'g'),
        g('Cornflour', 10, 'g'), g('White Pepper Powder', 1, 'g'),
        g('Salt (Iodised)', 1, 'g'),
    ],
    'Tomato Shorba': [
        g('Tomatoes', 200, 'g'), g('Cumin Seeds (Jeera)', 2, 'g'),
        g('Fresh Cream', 20, 'mL'), g('Black Pepper (Ground)', 1, 'g'),
        g('Coriander (Fresh)', 3, 'g'), g('Ghee', 10, 'g'),
    ],
    'Cream of Mushroom': [
        g('Mushrooms (Button)', 100, 'g'), g('Butter (Unsalted)', 15, 'g'),
        g('Fresh Cream', 30, 'mL'), g('Onions', 20, 'g'),
        g('Garlic (Whole)', 3, 'g'), g('Black Pepper (Ground)', 1, 'g'),
    ],

    // ── South Indian ───────────────────────────────────────────────────
    'Masala Dosa': [
        g('Idli Rice', 60, 'g'), g('Black Lentils (Urad Dal)', 20, 'g'),
        g('Potatoes', 100, 'g'), g('Onions', 30, 'g'),
        g('Mustard Seeds', 2, 'g'), g('Curry Leaves', 1, 'g'),
        g('Turmeric Powder', 1, 'g'), g('Refined Sunflower Oil', 20, 'mL'),
        g('Sambar (Ready)', 100, 'mL'), g('Coconut Chutney', 30, 'g'),
    ],
    'Plain Dosa': [
        g('Idli Rice', 60, 'g'), g('Black Lentils (Urad Dal)', 20, 'g'),
        g('Salt (Iodised)', 1, 'g'), g('Refined Sunflower Oil', 15, 'mL'),
        g('Sambar (Ready)', 80, 'mL'), g('Coconut Chutney', 25, 'g'),
    ],
    'Idli Sambar (3 pc)': [
        g('Idli Rice', 80, 'g'), g('Black Lentils (Urad Dal)', 25, 'g'),
        g('Sambar (Ready)', 150, 'mL'), g('Coconut Chutney', 40, 'g'),
    ],
    'Medu Vada (2 pc)': [
        g('Black Lentils (Urad Dal)', 80, 'g'), g('Curry Leaves', 1, 'g'),
        g('Black Pepper (Ground)', 1, 'g'), g('Ginger (Fresh)', 5, 'g'),
        g('Refined Sunflower Oil', 50, 'mL'), g('Sambar (Ready)', 100, 'mL'),
    ],
    'Onion Uttapam': [
        g('Idli Rice', 60, 'g'), g('Black Lentils (Urad Dal)', 20, 'g'),
        g('Onions', 50, 'g'), g('Tomatoes', 30, 'g'),
        g('Coriander (Fresh)', 3, 'g'), g('Green Chilli', 2, 'g'),
        g('Refined Sunflower Oil', 20, 'mL'),
    ],

    // ── North Indian (veg) ─────────────────────────────────────────────
    'Paneer Butter Masala': [
        g('Paneer', 180, 'g'), g('Tomatoes', 80, 'g'),
        g('Cashew (Whole)', 20, 'g'), g('Fresh Cream', 30, 'mL'),
        g('Butter (Unsalted)', 20, 'g'), g('Kasuri Methi', 1, 'g'),
        g('Garam Masala', 4, 'g'), g('Ginger-Garlic Paste', 8, 'g'),
    ],
    'Dal Makhani': [
        g('Black Whole Urad Dal', 80, 'g'), g('Rajma (Kidney Beans)', 20, 'g'),
        g('Fresh Cream', 30, 'mL'), g('Butter (Unsalted)', 20, 'g'),
        g('Tomatoes', 50, 'g'), g('Ginger-Garlic Paste', 8, 'g'),
        g('Garam Masala', 3, 'g'),
    ],
    'Shahi Paneer': [
        g('Paneer', 180, 'g'), g('Cashew (Whole)', 25, 'g'),
        g('Fresh Cream', 50, 'mL'), g('Saffron (Kesar)', 0.2, 'g'),
        g('Onions', 40, 'g'), g('Cardamom (Green)', 0.5, 'g'),
        g('Ghee', 15, 'g'),
    ],
    'Kadhai Paneer': [
        g('Paneer', 180, 'g'), g('Capsicum (Mixed)', 50, 'g'),
        g('Onions', 40, 'g'), g('Tomatoes', 40, 'g'),
        g('Coriander Seeds', 3, 'g'), g('Red Chilli Powder', 3, 'g'),
        g('Garam Masala', 3, 'g'), g('Refined Sunflower Oil', 20, 'mL'),
    ],
    'Dal Tadka': [
        g('Yellow Lentils (Toor Dal)', 100, 'g'), g('Cumin Seeds (Jeera)', 3, 'g'),
        g('Garlic (Whole)', 5, 'g'), g('Ghee', 15, 'g'),
        g('Red Chilli Powder', 2, 'g'), g('Coriander (Fresh)', 5, 'g'),
        g('Turmeric Powder', 2, 'g'),
    ],

    // ── Breads ─────────────────────────────────────────────────────────
    'Tandoori Roti': [
        g('Whole Wheat Flour (Atta)', 80, 'g'), g('Salt (Iodised)', 1, 'g'),
    ],
    'Butter Naan': [
        g('All-Purpose Flour (Maida)', 100, 'g'), g('Yogurt (Curd)', 15, 'g'),
        g('Butter (Unsalted)', 15, 'g'), g('Yeast (Active Dry)', 0.5, 'g'),
        g('Salt (Iodised)', 1, 'g'),
    ],
    'Garlic Naan': [
        g('All-Purpose Flour (Maida)', 100, 'g'), g('Garlic (Whole)', 5, 'g'),
        g('Coriander (Fresh)', 3, 'g'), g('Butter (Unsalted)', 15, 'g'),
        g('Yogurt (Curd)', 15, 'g'),
    ],
    'Lachha Paratha': [
        g('Whole Wheat Flour (Atta)', 100, 'g'), g('Ghee', 20, 'g'),
        g('Salt (Iodised)', 1, 'g'), g('Carom Seeds (Ajwain)', 1, 'g'),
    ],
    'Stuffed Kulcha': [
        g('All-Purpose Flour (Maida)', 100, 'g'), g('Potatoes', 80, 'g'),
        g('Coriander (Fresh)', 3, 'g'), g('Onions', 30, 'g'),
        g('Cumin Seeds (Jeera)', 1, 'g'), g('Ginger (Fresh)', 5, 'g'),
    ],

    // ── Rice & Biryani (veg) ───────────────────────────────────────────
    'Veg Biryani': [
        g('Basmati Rice', 200, 'g'), g('Carrots', 30, 'g'),
        g('Frozen Peas', 30, 'g'), g('Capsicum (Mixed)', 30, 'g'),
        g('Saffron (Kesar)', 0.2, 'g'), g('Garam Masala', 5, 'g'),
        g('Mint Leaves', 5, 'g'), g('Fried Onions (Birista)', 20, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Hyderabadi Veg Biryani': [
        g('Basmati Rice', 200, 'g'), g('Mint Leaves', 8, 'g'),
        g('Fried Onions (Birista)', 30, 'g'), g('Yogurt (Curd)', 30, 'g'),
        g('Saffron (Kesar)', 0.3, 'g'), g('Garam Masala', 5, 'g'),
        g('Carrots', 30, 'g'), g('Frozen Peas', 30, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Jeera Rice': [
        g('Basmati Rice', 180, 'g'), g('Cumin Seeds (Jeera)', 4, 'g'),
        g('Ghee', 15, 'g'), g('Bay Leaves', 0.5, 'g'),
    ],
    'Veg Pulao': [
        g('Basmati Rice', 180, 'g'), g('Carrots', 30, 'g'),
        g('Frozen Peas', 30, 'g'), g('Garam Masala', 4, 'g'),
        g('Cashew (Whole)', 10, 'g'), g('Ghee', 15, 'g'),
    ],
    'Curd Rice': [
        g('Basmati Rice', 150, 'g'), g('Yogurt (Curd)', 100, 'g'),
        g('Curry Leaves', 1, 'g'), g('Mustard Seeds', 1, 'g'),
        g('Pomegranate', 20, 'g'),
    ],

    // ── Chinese (veg) ──────────────────────────────────────────────────
    'Schezwan Fried Rice': [
        g('Basmati Rice', 180, 'g'), g('Schezwan Sauce', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Carrots', 20, 'g'),
        g('Spring Onion', 10, 'g'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Veg Fried Rice': [
        g('Basmati Rice', 180, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Frozen Peas', 30, 'g'),
        g('Soy Sauce', 20, 'mL'), g('Spring Onion', 10, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Honey Chilli Potato': [
        g('Frozen French Fries', 150, 'g'), g('Honey', 20, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Red Chilli Sauce', 15, 'g'),
        g('Sesame Oil', 5, 'mL'), g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Veg Spring Roll (4 pc)': [
        g('Spring Roll Sheets', 1, 'pack'), g('Cabbage', 50, 'g'),
        g('Carrots', 30, 'g'), g('Sweet Chilli Sauce', 30, 'g'),
        g('Refined Sunflower Oil', 50, 'mL'),
    ],
    'Chilli Paneer Gravy': [
        g('Paneer', 180, 'g'), g('Capsicum (Mixed)', 40, 'g'),
        g('Onions', 30, 'g'), g('Soy Sauce', 25, 'mL'),
        g('Green Chilli', 3, 'g'), g('Cornflour', 25, 'g'),
        g('Refined Sunflower Oil', 30, 'mL'),
    ],

    // ── Noodles (veg) ──────────────────────────────────────────────────
    'Veg Hakka Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Cabbage', 30, 'g'),
        g('Carrots', 30, 'g'), g('Capsicum (Mixed)', 30, 'g'),
        g('Soy Sauce', 25, 'mL'), g('Spring Onion', 10, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Schezwan Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Schezwan Sauce', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Onions', 30, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Singapore Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Curry Powder', 4, 'g'),
        g('Carrots', 30, 'g'), g('Capsicum (Mixed)', 30, 'g'),
        g('Soy Sauce', 20, 'mL'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Chilli Garlic Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Garlic (Whole)', 10, 'g'),
        g('Red Chilli Powder', 3, 'g'), g('Spring Onion', 10, 'g'),
        g('Sesame Oil', 8, 'mL'), g('Refined Sunflower Oil', 20, 'mL'),
    ],
    'Pan Fried Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Soy Sauce', 25, 'mL'),
        g('Cornflour', 10, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],

    // ── Pizza (veg) ────────────────────────────────────────────────────
    'Margherita Pizza': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Pizza Sauce', 80, 'g'),
        g('Mozzarella Cheese', 100, 'g'), g('Basil (Fresh)', 2, 'g'),
        g('Olive Oil (Extra Virgin)', 5, 'mL'),
    ],
    'Farmhouse Pizza': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Pizza Sauce', 80, 'g'),
        g('Mozzarella Cheese', 100, 'g'), g('Onions', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Tomatoes', 30, 'g'),
        g('Mushrooms (Button)', 30, 'g'), g('Frozen Sweet Corn', 30, 'g'),
    ],
    'Veggie Supreme': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Pizza Sauce', 80, 'g'),
        g('Mozzarella Cheese', 100, 'g'), g('Black Olives', 15, 'g'),
        g('Jalapeño', 10, 'g'), g('Paneer', 40, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Onions', 30, 'g'),
    ],
    'Paneer Tikka Pizza': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Makhani Sauce', 80, 'g'),
        g('Paneer', 80, 'g'), g('Onions', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Mozzarella Cheese', 90, 'g'),
        g('Tikka Masala', 5, 'g'),
    ],
    'Double Cheese Margherita': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Pizza Sauce', 80, 'g'),
        g('Mozzarella Cheese', 120, 'g'), g('Cheddar Cheese', 60, 'g'),
        g('Basil (Fresh)', 2, 'g'),
    ],

    // ── Burgers (veg) ──────────────────────────────────────────────────
    'Aloo Tikki Burger': [
        g('Burger Buns', 1, 'pcs'), g('Aloo Tikki Patty (Frozen)', 1, 'pcs'),
        g('Lettuce', 15, 'g'), g('Mint Chutney', 15, 'g'),
        g('Onions', 20, 'g'),
    ],
    'Veggie Burger': [
        g('Burger Buns', 1, 'pcs'), g('Veg Patty (Frozen)', 1, 'pcs'),
        g('Tomatoes', 20, 'g'), g('Onions', 20, 'g'),
        g('Lettuce', 15, 'g'), g('Mayonnaise', 25, 'g'),
    ],
    'Cheese Burger': [
        g('Brioche Bun', 1, 'pcs'), g('Veg Patty (Frozen)', 1, 'pcs'),
        g('Cheese Slices', 1, 'pack'), g('Lettuce', 15, 'g'),
        g('Mayonnaise', 20, 'g'),
    ],
    'Paneer Burger': [
        g('Sesame Bun', 1, 'pcs'), g('Paneer', 100, 'g'),
        g('Peri Peri Seasoning', 4, 'g'), g('Lettuce', 15, 'g'),
        g('Onions', 20, 'g'), g('Mayonnaise', 25, 'g'),
    ],
    'Crispy Veg Burger': [
        g('Burger Buns', 1, 'pcs'), g('Crispy Veg Patty (Frozen)', 1, 'pcs'),
        g('Cabbage', 20, 'g'), g('Mayonnaise', 25, 'g'),
        g('Tomatoes', 15, 'g'),
    ],

    // ── Sandwiches (veg) ───────────────────────────────────────────────
    'Bombay Grilled Sandwich': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Potatoes', 60, 'g'),
        g('Onions', 25, 'g'), g('Tomatoes', 25, 'g'),
        g('Green Chutney', 15, 'g'), g('Butter (Unsalted)', 15, 'g'),
        g('Mozzarella Cheese', 25, 'g'),
    ],
    'Veg Mayo Sandwich': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Mayonnaise', 30, 'g'),
        g('Cucumber', 20, 'g'), g('Carrots', 20, 'g'),
        g('Capsicum (Mixed)', 15, 'g'),
    ],
    'Cheese Chilli Toast': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Mozzarella Cheese', 50, 'g'),
        g('Cheddar Cheese', 20, 'g'), g('Green Chilli', 3, 'g'),
        g('Coriander (Fresh)', 3, 'g'), g('Butter (Unsalted)', 15, 'g'),
    ],
    'Paneer Tikka Sandwich': [
        g('Sandwich Bread (White)', 0.3, 'pack'), g('Paneer', 80, 'g'),
        g('Tikka Masala', 4, 'g'), g('Onions', 20, 'g'),
        g('Mint Mayo', 20, 'g'),
    ],
    'Club Sandwich': [
        g('Sandwich Bread (White)', 0.4, 'pack'), g('Cheese Slices', 1, 'pack'),
        g('Tomatoes', 25, 'g'), g('Cucumber', 20, 'g'),
        g('Lettuce', 15, 'g'), g('Mayonnaise', 25, 'g'),
    ],

    // ── Wraps & Rolls (veg) ────────────────────────────────────────────
    'Paneer Kathi Roll': [
        g('Tortilla Wraps', 1, 'pack'), g('Paneer', 100, 'g'),
        g('Onions', 25, 'g'), g('Mint Mayo', 20, 'g'),
        g('Tikka Masala', 4, 'g'),
    ],
    'Veg Frankie': [
        g('Tortilla Wraps', 1, 'pack'), g('Potatoes', 100, 'g'),
        g('Onions', 25, 'g'), g('Frankie Masala', 4, 'g'),
        g('Lemons', 8, 'g'),
    ],
    'Cheese Corn Roll': [
        g('Tortilla Wraps', 1, 'pack'), g('Frozen Sweet Corn', 50, 'g'),
        g('Mozzarella Cheese', 50, 'g'), g('Mayonnaise', 20, 'g'),
        g('Black Pepper (Ground)', 1, 'g'),
    ],
    'Falafel Wrap': [
        g('Tortilla Wraps', 1, 'pack'), g('Falafel (Frozen)', 3, 'pcs'),
        g('Hummus', 30, 'g'), g('Lettuce', 20, 'g'),
        g('Onions', 15, 'g'), g('Tahini', 10, 'g'),
    ],
    'Mexican Bean Wrap': [
        g('Tortilla Wraps', 1, 'pack'), g('Rajma (Kidney Beans)', 70, 'g'),
        g('Frozen Sweet Corn', 30, 'g'), g('Cheese Slices', 1, 'pack'),
        g('Lettuce', 15, 'g'), g('Salsa', 25, 'g'),
    ],

    // ── Pasta (veg) ────────────────────────────────────────────────────
    'Penne Arrabbiata': [
        g('Pasta (Penne)', 100, 'g'), g('Pizza Sauce', 60, 'g'),
        g('Tomatoes', 40, 'g'), g('Garlic (Whole)', 5, 'g'),
        g('Chilli Flakes', 3, 'g'), g('Basil (Fresh)', 2, 'g'),
        g('Olive Oil (Extra Virgin)', 15, 'mL'),
    ],
    'Alfredo Pasta': [
        g('Pasta (Fettuccine)', 100, 'g'), g('Pasta White Sauce', 80, 'g'),
        g('Parmesan Cheese', 20, 'g'), g('Garlic (Whole)', 5, 'g'),
        g('Butter (Unsalted)', 15, 'g'), g('Black Pepper (Ground)', 1, 'g'),
    ],
    'Mac & Cheese': [
        g('Pasta (Macaroni)', 100, 'g'), g('Mozzarella Cheese', 60, 'g'),
        g('Cheddar Cheese', 30, 'g'), g('Full Cream Milk', 80, 'mL'),
        g('Butter (Unsalted)', 15, 'g'), g('All-Purpose Flour (Maida)', 10, 'g'),
    ],
    'Pesto Pasta': [
        g('Pasta (Fusilli)', 100, 'g'), g('Pesto Sauce', 50, 'g'),
        g('Basil (Fresh)', 3, 'g'), g('Pine Nuts', 8, 'g'),
        g('Parmesan Cheese', 20, 'g'), g('Olive Oil (Extra Virgin)', 10, 'mL'),
        g('Garlic (Whole)', 3, 'g'),
    ],
    'Mixed Sauce Pasta': [
        g('Pasta (Penne)', 100, 'g'), g('Pizza Sauce', 40, 'g'),
        g('Pasta White Sauce', 40, 'g'), g('Mozzarella Cheese', 30, 'g'),
        g('Italian Herbs Mix', 2, 'g'),
    ],

    // ── Salads ─────────────────────────────────────────────────────────
    'Garden Fresh Salad': [
        g('Lettuce', 50, 'g'), g('Cucumber', 50, 'g'),
        g('Tomatoes', 50, 'g'), g('Carrots', 30, 'g'),
        g('Lemons', 15, 'g'), g('Olive Oil (Extra Virgin)', 10, 'mL'),
    ],
    'Caesar Veg Salad': [
        g('Romaine Lettuce', 80, 'g'), g('Croutons', 20, 'g'),
        g('Parmesan Cheese', 20, 'g'), g('Caesar Dressing', 30, 'g'),
        g('Black Pepper (Ground)', 1, 'g'),
    ],
    'Greek Feta Salad': [
        g('Cucumber', 50, 'g'), g('Tomatoes', 50, 'g'),
        g('Black Olives', 20, 'g'), g('Feta Cheese', 50, 'g'),
        g('Olive Oil (Extra Virgin)', 15, 'mL'), g('Oregano', 1, 'g'),
    ],
    'Sprouts Salad': [
        g('Moong Sprouts', 70, 'g'), g('Chana Sprouts', 50, 'g'),
        g('Onions', 20, 'g'), g('Tomatoes', 20, 'g'),
        g('Lemons', 15, 'g'), g('Chaat Masala', 2, 'g'),
    ],
    'Fruit Salad': [
        g('Apple', 40, 'g'), g('Banana', 40, 'g'),
        g('Pomegranate', 30, 'g'), g('Grapes', 30, 'g'),
        g('Honey', 10, 'g'), g('Chaat Masala', 1, 'g'),
    ],

    // ── Healthy Food (veg) ─────────────────────────────────────────────
    'Quinoa Veggie Bowl': [
        g('Quinoa', 100, 'g'), g('Carrots', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Broccoli', 30, 'g'),
        g('Chickpeas (Kabuli Chana)', 50, 'g'),
        g('Lemon-Tahini Dressing', 20, 'g'),
    ],
    'Steamed Veggies': [
        g('Broccoli', 60, 'g'), g('Carrots', 50, 'g'),
        g('Beans (Green)', 50, 'g'), g('Frozen Sweet Corn', 30, 'g'),
        g('Olive Oil (Extra Virgin)', 8, 'mL'), g('Italian Herbs Mix', 1, 'g'),
    ],
    'Sprouted Moong': [
        g('Moong Sprouts', 130, 'g'), g('Mustard Seeds', 1, 'g'),
        g('Curry Leaves', 1, 'g'), g('Lemons', 15, 'g'),
        g('Green Chilli', 2, 'g'), g('Refined Sunflower Oil', 8, 'mL'),
    ],
    'Oatmeal Porridge': [
        g('Oats', 60, 'g'), g('Full Cream Milk', 200, 'mL'),
        g('Banana', 40, 'g'), g('Honey', 10, 'g'),
        g('Almonds', 8, 'g'),
    ],
    'Multigrain Khichdi': [
        g('Mixed Millets', 60, 'g'), g('Moong Dal (Yellow Split)', 40, 'g'),
        g('Ghee', 12, 'g'), g('Cumin Seeds (Jeera)', 2, 'g'),
        g('Ginger (Fresh)', 4, 'g'), g('Turmeric Powder', 2, 'g'),
    ],

    // ── Combos & Thali (veg) ───────────────────────────────────────────
    'Punjabi Thali': [
        g('Black Whole Urad Dal', 60, 'g'), g('Rajma (Kidney Beans)', 15, 'g'),
        g('Paneer', 80, 'g'), g('Tomatoes', 40, 'g'),
        g('Whole Wheat Flour (Atta)', 100, 'g'), g('Basmati Rice', 80, 'g'),
        g('Cumin Seeds (Jeera)', 2, 'g'), g('Cucumber', 30, 'g'),
        g('Onions', 30, 'g'), g('Papad', 1, 'pcs'),
        g('Gulab Jamun (Pre-made)', 1, 'pcs'), g('Ghee', 15, 'g'),
    ],
    'Maharashtrian Thali': [
        g('Chickpeas (Kabuli Chana)', 60, 'g'), g('Whole Wheat Flour (Atta)', 100, 'g'),
        g('Yellow Lentils (Toor Dal)', 50, 'g'), g('Basmati Rice', 80, 'g'),
        g('Cucumber', 30, 'g'), g('Carrots', 20, 'g'),
        g('Papad', 1, 'pcs'), g('Shrikhand', 60, 'g'),
        g('Ghee', 12, 'g'),
    ],
    'South Indian Thali': [
        g('Sambar (Ready)', 200, 'mL'), g('Rasam (Ready)', 150, 'mL'),
        g('Potatoes', 60, 'g'), g('Cabbage', 50, 'g'),
        g('Basmati Rice', 100, 'g'), g('Yogurt (Curd)', 50, 'g'),
        g('Papad', 1, 'pcs'), g('Mysore Pak (Sweet)', 1, 'pcs'),
    ],
    'Mini Meal': [
        g('Paneer', 60, 'g'), g('Tomatoes', 30, 'g'),
        g('Whole Wheat Flour (Atta)', 80, 'g'),
        g('Yellow Lentils (Toor Dal)', 50, 'g'), g('Basmati Rice', 100, 'g'),
        g('Mango Pickle', 10, 'g'),
    ],
    'Family Thali (4 ppl)': [
        g('Paneer', 200, 'g'), g('Black Whole Urad Dal', 100, 'g'),
        g('Tomatoes', 100, 'g'), g('Whole Wheat Flour (Atta)', 350, 'g'),
        g('Basmati Rice', 300, 'g'), g('Yellow Lentils (Toor Dal)', 80, 'g'),
        g('Cucumber', 60, 'g'), g('Papad', 4, 'pcs'),
        g('Gulab Jamun (Pre-made)', 4, 'pcs'), g('Ghee', 40, 'g'),
    ],

    // ── Desserts ───────────────────────────────────────────────────────
    'Gulab Jamun (2 pc)': [
        g('Gulab Jamun (Pre-made)', 2, 'pcs'), g('Sugar Syrup', 60, 'mL'),
        g('Cardamom (Green)', 0.2, 'g'), g('Rose Water', 2, 'mL'),
    ],
    'Rasmalai (2 pc)': [
        g('Paneer', 80, 'g'), g('Full Cream Milk', 200, 'mL'),
        g('Sugar', 30, 'g'), g('Saffron (Kesar)', 0.1, 'g'),
        g('Pistachio', 5, 'g'), g('Cardamom (Green)', 0.2, 'g'),
    ],
    'Chocolate Lava Cake': [
        g('Brownie Mix', 80, 'g'), g('Dark Chocolate', 30, 'g'),
        g('Butter (Unsalted)', 25, 'g'), g('Cocoa Powder', 10, 'g'),
        g('Sugar', 25, 'g'), g('Vanilla Ice Cream', 50, 'mL'),
    ],
    'Brownie with Ice Cream': [
        g('Brownie (Pre-baked)', 1, 'pcs'), g('Vanilla Ice Cream', 60, 'mL'),
        g('Chocolate Syrup', 20, 'g'), g('Walnuts', 8, 'g'),
    ],
    'Gajar Halwa': [
        g('Carrots', 200, 'g'), g('Full Cream Milk', 150, 'mL'),
        g('Ghee', 20, 'g'), g('Sugar', 40, 'g'),
        g('Dry Fruits Mix', 12, 'g'), g('Cardamom (Green)', 0.3, 'g'),
    ],

    // ── Ice Cream ──────────────────────────────────────────────────────
    'Vanilla Scoop': [
        g('Vanilla Ice Cream', 100, 'mL'),
    ],
    'Chocolate Scoop': [
        g('Chocolate Ice Cream', 100, 'mL'), g('Cocoa Powder', 3, 'g'),
    ],
    'Strawberry Scoop': [
        g('Strawberry Ice Cream', 100, 'mL'), g('Strawberry Pulp', 15, 'g'),
    ],
    'Butterscotch Crunch': [
        g('Butterscotch Ice Cream', 100, 'mL'),
        g('Praline (Butterscotch Crunch)', 15, 'g'), g('Cashew (Whole)', 5, 'g'),
    ],
    'Mango Delight': [
        g('Mango Ice Cream', 100, 'mL'), g('Mango Pulp', 30, 'g'),
    ],

    // ── Coffee ─────────────────────────────────────────────────────────
    'Cappuccino': [
        g('Coffee Beans (Arabica)', 10, 'g'), g('Full Cream Milk', 120, 'mL'),
        g('Sugar', 5, 'g'),
    ],
    'Cafe Latte': [
        g('Coffee Beans (Arabica)', 10, 'g'), g('Full Cream Milk', 180, 'mL'),
    ],
    'Espresso': [
        g('Coffee Beans (Arabica)', 10, 'g'),
    ],
    'Cold Coffee': [
        g('Coffee Beans (Arabica)', 12, 'g'), g('Full Cream Milk', 200, 'mL'),
        g('Sugar', 15, 'g'), g('Vanilla Ice Cream', 30, 'mL'),
        g('Chocolate Syrup', 10, 'g'),
    ],
    'Mocha': [
        g('Coffee Beans (Arabica)', 10, 'g'), g('Full Cream Milk', 150, 'mL'),
        g('Cocoa Powder', 10, 'g'), g('Dark Chocolate', 8, 'g'),
        g('Sugar', 8, 'g'),
    ],

    // ── Tea ────────────────────────────────────────────────────────────
    'Masala Chai': [
        g('Tea Leaves (Assam Premium)', 5, 'g'), g('Full Cream Milk', 100, 'mL'),
        g('Sugar', 8, 'g'), g('Ginger (Fresh)', 3, 'g'),
        g('Cardamom (Green)', 0.3, 'g'), g('Cloves', 0.2, 'g'),
    ],
    'Ginger Lemon Tea': [
        g('Tea Leaves (Assam Premium)', 4, 'g'), g('Ginger (Fresh)', 5, 'g'),
        g('Lemons', 12, 'g'), g('Honey', 8, 'g'),
    ],
    'Green Tea': [
        g('Green Tea Leaves', 3, 'g'),
    ],
    'Honey Lemon Tea': [
        g('Tea Leaves (Assam Premium)', 4, 'g'), g('Honey', 12, 'g'),
        g('Lemons', 12, 'g'), g('Ginger (Fresh)', 3, 'g'),
    ],
    'Kullad Chai': [
        g('Tea Leaves (Assam Premium)', 5, 'g'), g('Full Cream Milk', 120, 'mL'),
        g('Sugar', 10, 'g'), g('Cardamom (Green)', 0.2, 'g'),
    ],

    // ── Milkshakes ─────────────────────────────────────────────────────
    'Chocolate Milkshake': [
        g('Full Cream Milk', 200, 'mL'), g('Chocolate Syrup', 25, 'g'),
        g('Vanilla Ice Cream', 50, 'mL'), g('Whipped Cream', 20, 'mL'),
        g('Cocoa Powder', 3, 'g'),
    ],
    'Vanilla Shake': [
        g('Full Cream Milk', 200, 'mL'), g('Vanilla Ice Cream', 60, 'mL'),
        g('Sugar', 10, 'g'), g('Vanilla Essence', 1, 'mL'),
    ],
    'Oreo Shake': [
        g('Full Cream Milk', 200, 'mL'), g('Vanilla Ice Cream', 50, 'mL'),
        g('Oreo Biscuits', 0.3, 'pack'), g('Sugar', 10, 'g'),
    ],
    'Mango Shake': [
        g('Full Cream Milk', 200, 'mL'), g('Mango Pulp', 60, 'g'),
        g('Sugar', 10, 'g'),
    ],
    'Strawberry Shake': [
        g('Full Cream Milk', 200, 'mL'), g('Strawberry Pulp', 50, 'g'),
        g('Fresh Cream', 20, 'mL'), g('Vanilla Ice Cream', 30, 'mL'),
    ],

    // ── Fresh Juices ───────────────────────────────────────────────────
    'Orange Juice': [
        g('Orange', 250, 'g'),
    ],
    'Watermelon Juice': [
        g('Watermelon', 300, 'g'), g('Mint Leaves', 3, 'g'),
        g('Lemons', 8, 'g'),
    ],
    'Mosambi Juice': [
        g('Mosambi (Sweet Lime)', 250, 'g'), g('Black Salt', 1, 'g'),
    ],
    'Pineapple Juice': [
        g('Pineapple', 200, 'g'), g('Mint Leaves', 3, 'g'),
    ],
    'Mixed Fruit Juice': [
        g('Orange', 80, 'g'), g('Mosambi (Sweet Lime)', 80, 'g'),
        g('Pineapple', 60, 'g'), g('Apple', 50, 'g'),
    ],

    // ── Cold Drinks ────────────────────────────────────────────────────
    'Lemon Iced Tea': [
        g('Lemon Iced Tea Concentrate', 50, 'mL'), g('Lemons', 15, 'g'),
        g('Mint Leaves', 2, 'g'), g('Sugar', 12, 'g'),
        g('Mineral Water (1L)', 0.25, 'bottle'),
    ],
    'Fresh Lime Soda': [
        g('Lemons', 30, 'g'), g('Soda Water', 200, 'mL'),
        g('Sugar', 12, 'g'), g('Salt (Iodised)', 0.5, 'g'),
    ],
    'Virgin Mojito': [
        g('Lemons', 30, 'g'), g('Mint Leaves', 6, 'g'),
        g('Sugar', 18, 'g'), g('Soda Water', 200, 'mL'),
    ],
    'Cold Coffee with Ice Cream': [
        g('Coffee Beans (Arabica)', 12, 'g'), g('Full Cream Milk', 200, 'mL'),
        g('Vanilla Ice Cream', 60, 'mL'), g('Chocolate Syrup', 15, 'g'),
        g('Sugar', 12, 'g'),
    ],
    'Iced Lemon Tea': [
        g('Tea Leaves (Assam Premium)', 4, 'g'), g('Lemons', 15, 'g'),
        g('Sugar', 12, 'g'),
    ],

    // ── Mineral Water (packaged — 1 bottle in = 1 bottle out) ──────────
    'Bisleri 1 Litre':         [g('Bisleri 1L (Stock)', 1, 'bottle')],
    'Bisleri 500 ml':          [g('Bisleri 500ml (Stock)', 1, 'bottle')],
    'Aquafina 1 Litre':        [g('Aquafina 1L (Stock)', 1, 'bottle')],
    'Kinley 1 Litre':          [g('Kinley 1L (Stock)', 1, 'bottle')],
    'Himalayan Natural 1L':    [g('Himalayan Natural 1L (Stock)', 1, 'bottle')],

    // ── Packaged Beverages (MRP — sealed bottles passed through) ───────
    'Coca-Cola 600 ml':        [g('Coca-Cola 600ml (Stock)', 1, 'bottle')],
    'Pepsi 600 ml':            [g('Pepsi 600ml (Stock)', 1, 'bottle')],
    'Sprite 600 ml':           [g('Sprite 600ml (Stock)', 1, 'bottle')],
    'Thumbs Up 600 ml':        [g('Thumbs Up 600ml (Stock)', 1, 'bottle')],
    'Red Bull 250 ml':         [g('Red Bull 250ml (Stock)', 1, 'can')],

    // ═══════════════════════ NON-VEG MENU ══════════════════════════════

    // ── Starters (non-veg) ─────────────────────────────────────────────
    'Chicken Tikka': [
        g('Chicken (Boneless)', 200, 'g'), g('Hung Yogurt', 50, 'g'),
        g('Tandoori Masala', 6, 'g'), g('Ginger-Garlic Paste', 8, 'g'),
        g('Lemons', 10, 'g'), g('Mustard Oil', 10, 'mL'),
        g('Onions', 30, 'g'), g('Mint Chutney', 30, 'g'),
    ],
    'Chicken Lollipop': [
        g('Chicken Winglets', 250, 'g'), g('Red Chilli Sauce', 25, 'g'),
        g('Soy Sauce', 15, 'mL'), g('Garlic (Whole)', 5, 'g'),
        g('Cornflour', 30, 'g'), g('Refined Sunflower Oil', 60, 'mL'),
    ],
    'Tandoori Chicken (Half)': [
        g('Whole Chicken', 500, 'g'), g('Hung Yogurt', 80, 'g'),
        g('Tandoori Masala', 10, 'g'), g('Kashmiri Chilli Powder', 5, 'g'),
        g('Lemons', 15, 'g'), g('Ginger-Garlic Paste', 10, 'g'),
        g('Mustard Oil', 15, 'mL'),
    ],
    'Chicken 65': [
        g('Chicken (Boneless)', 200, 'g'), g('Curry Leaves', 2, 'g'),
        g('Green Chilli', 4, 'g'), g('Yogurt (Curd)', 30, 'g'),
        g('Red Chilli Powder', 4, 'g'), g('Cornflour', 25, 'g'),
        g('Refined Sunflower Oil', 60, 'mL'),
    ],
    'Fish Tikka': [
        g('Basa Fish (Boneless)', 200, 'g'), g('Hung Yogurt', 50, 'g'),
        g('Carom Seeds (Ajwain)', 1, 'g'), g('Ginger-Garlic Paste', 8, 'g'),
        g('Lemons', 12, 'g'), g('Tandoori Masala', 5, 'g'),
        g('Mustard Oil', 10, 'mL'),
    ],

    // ── North Indian (non-veg) ─────────────────────────────────────────
    'Butter Chicken': [
        g('Chicken (Boneless)', 200, 'g'), g('Tomatoes', 80, 'g'),
        g('Cashew (Whole)', 20, 'g'), g('Butter (Unsalted)', 25, 'g'),
        g('Fresh Cream', 30, 'mL'), g('Kasuri Methi', 1, 'g'),
        g('Garam Masala', 5, 'g'), g('Ginger-Garlic Paste', 8, 'g'),
    ],
    'Chicken Curry': [
        g('Chicken (with Bone)', 220, 'g'), g('Onions', 60, 'g'),
        g('Tomatoes', 60, 'g'), g('Garam Masala', 4, 'g'),
        g('Coriander (Fresh)', 5, 'g'), g('Ginger-Garlic Paste', 10, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Mutton Rogan Josh': [
        g('Mutton', 250, 'g'), g('Yogurt (Curd)', 50, 'g'),
        g('Kashmiri Chilli Powder', 5, 'g'), g('Fennel Seeds', 3, 'g'),
        g('Cardamom (Green)', 0.5, 'g'), g('Onions', 60, 'g'),
        g('Ghee', 20, 'g'),
    ],
    'Egg Curry': [
        g('Eggs (Farm Fresh)', 0.166, 'dozen'), g('Onions', 50, 'g'),
        g('Tomatoes', 50, 'g'), g('Garam Masala', 4, 'g'),
        g('Coriander (Fresh)', 5, 'g'), g('Ginger-Garlic Paste', 8, 'g'),
        g('Refined Sunflower Oil', 20, 'mL'),
    ],
    'Fish Curry': [
        g('Basa Fish (Boneless)', 200, 'g'), g('Coconut (Grated)', 40, 'g'),
        g('Tamarind Pulp', 15, 'g'), g('Curry Leaves', 2, 'g'),
        g('Mustard Seeds', 2, 'g'), g('Onions', 40, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],

    // ── Rice & Biryani (non-veg) ───────────────────────────────────────
    'Chicken Biryani': [
        g('Basmati Rice', 200, 'g'), g('Chicken (with Bone)', 180, 'g'),
        g('Saffron (Kesar)', 0.3, 'g'), g('Fried Onions (Birista)', 30, 'g'),
        g('Mint Leaves', 6, 'g'), g('Garam Masala', 5, 'g'),
        g('Yogurt (Curd)', 30, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Hyderabadi Chicken Biryani': [
        g('Basmati Rice', 200, 'g'), g('Chicken (with Bone)', 200, 'g'),
        g('Mint Leaves', 8, 'g'), g('Fried Onions (Birista)', 35, 'g'),
        g('Yogurt (Curd)', 40, 'g'), g('Garam Masala', 6, 'g'),
        g('Saffron (Kesar)', 0.3, 'g'), g('Ghee', 20, 'g'),
    ],
    'Mutton Biryani': [
        g('Basmati Rice', 200, 'g'), g('Mutton', 200, 'g'),
        g('Saffron (Kesar)', 0.4, 'g'), g('Fried Onions (Birista)', 40, 'g'),
        g('Mint Leaves', 8, 'g'), g('Garam Masala', 6, 'g'),
        g('Yogurt (Curd)', 40, 'g'), g('Ghee', 20, 'g'),
    ],
    'Egg Biryani': [
        g('Basmati Rice', 200, 'g'), g('Eggs (Farm Fresh)', 0.166, 'dozen'),
        g('Saffron (Kesar)', 0.2, 'g'), g('Fried Onions (Birista)', 25, 'g'),
        g('Mint Leaves', 5, 'g'), g('Garam Masala', 5, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Chicken Fried Rice': [
        g('Basmati Rice', 180, 'g'), g('Chicken (Boneless)', 80, 'g'),
        g('Spring Onion', 10, 'g'), g('Soy Sauce', 20, 'mL'),
        g('Eggs (Farm Fresh)', 0.083, 'dozen'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],

    // ── Chinese (non-veg) ──────────────────────────────────────────────
    'Chilli Chicken': [
        g('Chicken (Boneless)', 200, 'g'), g('Capsicum (Mixed)', 40, 'g'),
        g('Onions', 30, 'g'), g('Soy Sauce', 25, 'mL'),
        g('Green Chilli', 4, 'g'), g('Garlic (Whole)', 5, 'g'),
        g('Cornflour', 25, 'g'), g('Refined Sunflower Oil', 30, 'mL'),
    ],
    'Chicken Manchurian': [
        g('Chicken Mince', 180, 'g'), g('Soy Sauce', 25, 'mL'),
        g('Garlic (Whole)', 6, 'g'), g('Spring Onion', 12, 'g'),
        g('Cornflour', 30, 'g'), g('Onions', 30, 'g'),
        g('Refined Sunflower Oil', 50, 'mL'),
    ],
    'Dragon Chicken': [
        g('Chicken (Boneless)', 200, 'g'), g('Red Chilli Sauce', 25, 'g'),
        g('Garlic (Whole)', 6, 'g'), g('Honey', 15, 'g'),
        g('Cashew (Whole)', 12, 'g'), g('Cornflour', 25, 'g'),
        g('Refined Sunflower Oil', 40, 'mL'),
    ],

    // ── Noodles (non-veg) ──────────────────────────────────────────────
    'Chicken Hakka Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Chicken (Boneless)', 80, 'g'),
        g('Cabbage', 30, 'g'), g('Carrots', 30, 'g'),
        g('Soy Sauce', 25, 'mL'), g('Spring Onion', 10, 'g'),
        g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Chicken Schezwan Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Chicken (Boneless)', 80, 'g'),
        g('Schezwan Sauce', 30, 'g'), g('Capsicum (Mixed)', 30, 'g'),
        g('Onions', 30, 'g'), g('Refined Sunflower Oil', 25, 'mL'),
    ],
    'Chicken Singapore Noodles': [
        g('Hakka Noodles (Dry)', 120, 'g'), g('Chicken (Boneless)', 80, 'g'),
        g('Eggs (Farm Fresh)', 0.083, 'dozen'), g('Curry Powder', 4, 'g'),
        g('Carrots', 25, 'g'), g('Capsicum (Mixed)', 25, 'g'),
        g('Soy Sauce', 20, 'mL'),
    ],

    // ── Pizza (non-veg) ────────────────────────────────────────────────
    'Chicken BBQ Pizza': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Chicken (Boneless)', 90, 'g'),
        g('BBQ Sauce', 50, 'g'), g('Onions', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Mozzarella Cheese', 100, 'g'),
    ],
    'Chicken Tikka Pizza': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Chicken (Boneless)', 90, 'g'),
        g('Makhani Sauce', 80, 'g'), g('Onions', 30, 'g'),
        g('Capsicum (Mixed)', 30, 'g'), g('Mozzarella Cheese', 100, 'g'),
        g('Tikka Masala', 5, 'g'),
    ],
    'Peri Peri Chicken Pizza': [
        g('Pizza Dough Base (10")', 1, 'pcs'), g('Chicken (Boneless)', 90, 'g'),
        g('Peri Peri Sauce', 40, 'g'), g('Peri Peri Seasoning', 4, 'g'),
        g('Capsicum (Mixed)', 40, 'g'), g('Jalapeño', 12, 'g'),
        g('Mozzarella Cheese', 80, 'g'), g('Cheddar Cheese', 30, 'g'),
    ],

    // ── Burgers (non-veg) ──────────────────────────────────────────────
    'Chicken Burger': [
        g('Brioche Bun', 1, 'pcs'), g('Chicken Patty (Frozen)', 1, 'pcs'),
        g('Lettuce', 15, 'g'), g('Onions', 20, 'g'),
        g('Mayonnaise', 25, 'g'),
    ],
    'Crispy Chicken Burger': [
        g('Burger Buns', 1, 'pcs'), g('Crispy Chicken Patty (Frozen)', 1, 'pcs'),
        g('Cabbage', 20, 'g'), g('Chipotle Mayo', 25, 'g'),
        g('Tomatoes', 15, 'g'),
    ],
    'Peri Peri Chicken Burger': [
        g('Sesame Bun', 1, 'pcs'), g('Chicken Patty (Frozen)', 1, 'pcs'),
        g('Peri Peri Seasoning', 5, 'g'), g('Lettuce', 15, 'g'),
        g('Onions', 20, 'g'), g('Mayonnaise', 25, 'g'),
    ],

    // ── Sandwiches (non-veg) ───────────────────────────────────────────
    'Chicken Club Sandwich': [
        g('Sandwich Bread (White)', 0.4, 'pack'), g('Chicken (Boneless)', 100, 'g'),
        g('Cheese Slices', 1, 'pack'), g('Tomatoes', 25, 'g'),
        g('Lettuce', 15, 'g'), g('Mayonnaise', 25, 'g'),
    ],
    'Egg Sandwich': [
        g('Sandwich Bread (White)', 0.25, 'pack'), g('Eggs (Farm Fresh)', 0.166, 'dozen'),
        g('Mayonnaise', 20, 'g'), g('Black Pepper (Ground)', 1, 'g'),
        g('Butter (Unsalted)', 12, 'g'),
    ],
    'Chicken Tikka Sandwich': [
        g('Sandwich Bread (White)', 0.3, 'pack'), g('Chicken (Boneless)', 90, 'g'),
        g('Tikka Masala', 4, 'g'), g('Onions', 20, 'g'),
        g('Mint Mayo', 20, 'g'), g('Cheese Slices', 1, 'pack'),
    ],

    // ── Wraps & Rolls (non-veg) ────────────────────────────────────────
    'Chicken Tikka Wrap': [
        g('Tortilla Wraps', 1, 'pack'), g('Chicken (Boneless)', 100, 'g'),
        g('Tikka Masala', 4, 'g'), g('Onions', 25, 'g'),
        g('Lettuce', 15, 'g'), g('Mint Mayo', 20, 'g'),
    ],
    'Chicken Kathi Roll': [
        g('Tortilla Wraps', 1, 'pack'), g('Chicken (Boneless)', 90, 'g'),
        g('Eggs (Farm Fresh)', 0.083, 'dozen'), g('Onions', 25, 'g'),
        g('Mint Chutney', 15, 'g'), g('Lemons', 8, 'g'),
    ],
    'Egg Roll': [
        g('Tortilla Wraps', 1, 'pack'), g('Eggs (Farm Fresh)', 0.166, 'dozen'),
        g('Onions', 25, 'g'), g('Green Chilli', 2, 'g'),
        g('Chaat Masala', 2, 'g'),
    ],

    // ── Pasta (non-veg) ────────────────────────────────────────────────
    'Chicken Alfredo Pasta': [
        g('Pasta (Fettuccine)', 100, 'g'), g('Chicken (Boneless)', 80, 'g'),
        g('Pasta White Sauce', 80, 'g'), g('Parmesan Cheese', 20, 'g'),
        g('Garlic (Whole)', 5, 'g'), g('Butter (Unsalted)', 15, 'g'),
    ],
    'Peri Peri Chicken Pasta': [
        g('Pasta (Penne)', 100, 'g'), g('Chicken (Boneless)', 80, 'g'),
        g('Peri Peri Sauce', 40, 'g'), g('Capsicum (Mixed)', 30, 'g'),
        g('Fresh Cream', 20, 'mL'), g('Olive Oil (Extra Virgin)', 10, 'mL'),
    ],

    // ── Healthy Food (non-veg) ─────────────────────────────────────────
    'Grilled Chicken Bowl': [
        g('Chicken Breast', 150, 'g'), g('Broccoli', 60, 'g'),
        g('Sweet Potato', 80, 'g'), g('Quinoa', 80, 'g'),
        g('Lemons', 15, 'g'), g('Black Pepper (Ground)', 2, 'g'),
        g('Olive Oil (Extra Virgin)', 8, 'mL'),
    ],
    'Egg White Omelette': [
        g('Egg Whites (Liquid)', 100, 'mL'), g('Spinach (Palak)', 30, 'g'),
        g('Mushrooms (Button)', 30, 'g'), g('Onions', 15, 'g'),
        g('Black Pepper (Ground)', 1, 'g'), g('Olive Oil (Extra Virgin)', 5, 'mL'),
    ],

    // ── Combos & Thali (non-veg) ───────────────────────────────────────
    'Chicken Thali': [
        g('Chicken (with Bone)', 180, 'g'), g('Tomatoes', 50, 'g'),
        g('Yellow Lentils (Toor Dal)', 60, 'g'),
        g('Whole Wheat Flour (Atta)', 100, 'g'), g('Basmati Rice', 100, 'g'),
        g('Cucumber', 30, 'g'), g('Onions', 25, 'g'),
        g('Papad', 1, 'pcs'), g('Gulab Jamun (Pre-made)', 1, 'pcs'),
        g('Butter (Unsalted)', 15, 'g'),
    ],
    'Mutton Thali': [
        g('Mutton', 200, 'g'), g('Yellow Lentils (Toor Dal)', 60, 'g'),
        g('Whole Wheat Flour (Atta)', 100, 'g'), g('Basmati Rice', 100, 'g'),
        g('Cucumber', 30, 'g'), g('Papad', 1, 'pcs'),
        g('Mysore Pak (Sweet)', 1, 'pcs'), g('Ghee', 18, 'g'),
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY FALLBACKS — only used for menu items that don't have an
// exact RECIPES entry. Keys are Category.name as created by
// seedFullCategories.js. Every fallback references items already in
// INVENTORY, so missing-blueprint items still get stock tracking.
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_FALLBACKS = {
    'Starters':           RECIPES['Crispy Corn'],
    'Soups':              RECIPES['Tomato Shorba'],
    'South Indian':       RECIPES['Masala Dosa'],
    'North Indian':       RECIPES['Paneer Butter Masala'],
    'Breads':             RECIPES['Butter Naan'],
    'Rice & Biryani':     RECIPES['Veg Biryani'],
    'Chinese':            RECIPES['Veg Fried Rice'],
    'Noodles':            RECIPES['Veg Hakka Noodles'],
    'Pizza':              RECIPES['Margherita Pizza'],
    'Burgers':            RECIPES['Veggie Burger'],
    'Sandwiches':         RECIPES['Bombay Grilled Sandwich'],
    'Wraps & Rolls':      RECIPES['Paneer Kathi Roll'],
    'Pasta':              RECIPES['Alfredo Pasta'],
    'Salads':             RECIPES['Garden Fresh Salad'],
    'Healthy Food':       RECIPES['Quinoa Veggie Bowl'],
    'Combos & Thali':     RECIPES['Mini Meal'],
    'Desserts':           RECIPES['Brownie with Ice Cream'],
    'Ice Cream':          RECIPES['Vanilla Scoop'],
    'Coffee':             RECIPES['Cappuccino'],
    'Tea':                RECIPES['Masala Chai'],
    'Milkshakes':         RECIPES['Vanilla Shake'],
    'Fresh Juices':       RECIPES['Orange Juice'],
    'Cold Drinks':        RECIPES['Fresh Lime Soda'],
    'Mineral Water':      RECIPES['Bisleri 1 Litre'],
    'Packaged Beverages': RECIPES['Coca-Cola 600 ml'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
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

// Fresh INV-XXX itemId factory that won't collide with the existing
// globally-unique series. Scans once on startup, increments locally.
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Inventory: ensure every catalog row exists for the tenant.
// Returns Map<lowercase-name, inventoryDoc> for the recipe phase.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureInventory(tenant, nextItemId) {
    const existing = await Inventory.find({ restaurant: tenant._id }).lean();
    const byName = new Map(existing.map(i => [i.name.toLowerCase(), i]));

    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const [name, blueprint] of Object.entries(INVENTORY)) {
        if (byName.has(name.toLowerCase())) {
            skipped += 1;
            continue;
        }
        try {
            const doc = await Inventory.create({
                restaurant: tenant._id,
                itemId: nextItemId(),
                name,
                ...blueprint,
                adjustmentHistory: blueprint.currentStock > 0 ? [{
                    type: 'restock',
                    quantity: blueprint.currentStock,
                    previousStock: 0,
                    newStock: blueprint.currentStock,
                    reason: 'Initial stock — seedFullInventoryAndRecipes',
                    date: new Date(),
                }] : [],
                lastRestocked: blueprint.currentStock > 0 ? new Date() : undefined,
            });
            byName.set(name.toLowerCase(), doc.toObject());
            created += 1;
        } catch (err) {
            failed.push({ name, error: err.message });
        }
    }

    return { byName, created, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Recipes: upsert one per menu item.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureRecipes(tenant, invByName) {
    const menuItems = await MenuItem.find({ restaurant: tenant._id })
        .populate('category', 'name')
        .lean();

    const stats = {
        total: menuItems.length,
        upserted: 0,
        usedExact: 0,
        usedFallback: 0,
        skippedNoBlueprint: 0,
        ingredientsMissing: 0,
        unmatched: [],
    };

    if (menuItems.length === 0) {
        return stats;
    }

    for (const mi of menuItems) {
        const categoryName = mi.category?.name || '';

        let blueprint = RECIPES[mi.name];
        let usedFallback = false;

        if (!blueprint) {
            blueprint = CATEGORY_FALLBACKS[categoryName];
            if (blueprint) usedFallback = true;
        }

        if (!blueprint) {
            stats.skippedNoBlueprint += 1;
            stats.unmatched.push(`${mi.name} (${categoryName || 'no category'})`);
            continue;
        }

        const recipeIngredients = [];
        for (const b of blueprint) {
            const inv = invByName.get(b.name.toLowerCase());
            if (!inv) {
                stats.ingredientsMissing += 1;
                continue;
            }
            recipeIngredients.push({
                inventoryItem: inv._id,
                quantity: b.quantity,
                unit: b.unit,
            });
        }

        if (recipeIngredients.length === 0) {
            stats.skippedNoBlueprint += 1;
            stats.unmatched.push(`${mi.name} — every ingredient missing from INVENTORY`);
            continue;
        }

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
                        ? `Auto-seeded from category fallback (${categoryName}). Edit from Inventory → Recipes for accuracy.`
                        : 'Auto-seeded from seedFullInventoryAndRecipes RECIPES blueprint.',
                },
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );

        stats.upserted += 1;
        if (usedFallback) stats.usedFallback += 1;
        else stats.usedExact += 1;
    }

    return stats;
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

    // ── Phase 1: Inventory ─────────────────────────────────────────────
    console.log(`\n⏳ Phase 1 / 2 — ensuring ${Object.keys(INVENTORY).length} inventory items...`);
    const nextItemId = await makeItemIdFactory();
    const invResult = await ensureInventory(tenant, nextItemId);
    console.log(`   ✔ Created:  ${invResult.created}`);
    console.log(`   ✔ Existing: ${invResult.skipped}`);
    if (invResult.failed.length) {
        console.log(`   ⚠ Failed:   ${invResult.failed.length}`);
        for (const f of invResult.failed) {
            console.log(`     - ${f.name}: ${f.error}`);
        }
    }

    // Sanity-check: every RECIPES ingredient must exist in INVENTORY catalog.
    const referencedNames = new Set();
    for (const recipe of Object.values(RECIPES)) {
        for (const line of recipe) referencedNames.add(line.name);
    }
    const orphanRefs = [...referencedNames].filter(n => !INVENTORY[n]);
    if (orphanRefs.length) {
        console.log(`\n⚠ ${orphanRefs.length} ingredient(s) referenced by RECIPES but NOT in INVENTORY catalog:`);
        for (const n of orphanRefs) console.log(`   - ${n}`);
        console.log('   These recipes will skip those ingredients. Fix the catalog and re-run.');
    }

    // ── Phase 2: Recipes ───────────────────────────────────────────────
    console.log(`\n⏳ Phase 2 / 2 — wiring recipes for menu items...`);
    const recResult = await ensureRecipes(tenant, invResult.byName);
    console.log(`   ✔ Menu items found:    ${recResult.total}`);
    console.log(`   ✔ Recipes upserted:    ${recResult.upserted}`);
    console.log(`     ↳ exact blueprint:   ${recResult.usedExact}`);
    console.log(`     ↳ category fallback: ${recResult.usedFallback}`);
    if (recResult.skippedNoBlueprint) {
        console.log(`   ⚠ Skipped (no blueprint or category match): ${recResult.skippedNoBlueprint}`);
        for (const u of recResult.unmatched) console.log(`     - ${u}`);
    }
    if (recResult.ingredientsMissing) {
        console.log(`   ⚠ Ingredient links missing: ${recResult.ingredientsMissing}`);
    }

    // ── Summary ────────────────────────────────────────────────────────
    const totalInv = await Inventory.countDocuments({ restaurant: tenant._id });
    const totalRec = await Recipe.countDocuments({ restaurant: tenant._id });
    const totalMenu = await MenuItem.countDocuments({ restaurant: tenant._id });

    console.log('\n📊 Final state for tenant:');
    console.log(`   Inventory items: ${totalInv}`);
    console.log(`   Menu items:      ${totalMenu}`);
    console.log(`   Recipes wired:   ${totalRec}`);
    console.log(`   Coverage:        ${totalMenu > 0 ? Math.round((totalRec / totalMenu) * 100) : 0}%`);
    console.log('\nDone.');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullInventoryAndRecipes failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
