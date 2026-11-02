/**
 * listMenuForBranch.js — READ-ONLY. Lists the menu items one branch owns,
 * with their category and status, to compare against the admin menu list.
 *
 *   node Seed/listMenuForBranch.js <restaurant-slug> <branch-id>
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Category = require('../models/category');
const MenuItem = require('../models/menuItem');

(async () => {
    const [slug, branchId] = process.argv.slice(2);
    if (!slug || !branchId) {
        console.error('Usage: node Seed/listMenuForBranch.js <restaurant-slug> <branch-id>');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000, family: 4, autoIndex: false });
    const restaurant = await Restaurant.findOne({ slug }).lean();
    if (!restaurant) throw new Error(`No restaurant "${slug}"`);
    const bid = new mongoose.Types.ObjectId(branchId);
    const items = await MenuItem.find({
        restaurant: restaurant._id,
        $or: [{ branch: bid }, { 'branchPrices.branch': bid }],
    }).lean();
    const cats = new Map((await Category.find({ restaurant: restaurant._id }).lean()).map((c) => [String(c._id), c]));
    console.log(`Database: ${mongoose.connection.name}  Tenant: ${restaurant.name}  Items counted for branch: ${items.length}\n`);
    console.table(items.map((i) => {
        const c = cats.get(String(i.category));
        return {
            name: i.name,
            status: i.status,
            inStock: i.inStock,
            ownBranch: i.branch ? (String(i.branch) === branchId ? 'this' : 'other') : 'none',
            viaPrices: (i.branchPrices || []).some((p) => String(p.branch) === branchId),
            category: c ? c.name : '(missing)',
            catStatus: c ? c.status : '-',
            created: i.createdAt && i.createdAt.toISOString().slice(0, 10),
        };
    }));
    await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
