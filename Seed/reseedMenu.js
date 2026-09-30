/**
 * reseedMenu.js — destructive reset of the menu surface for one tenant.
 *
 * Deletes every Category, MenuItem, Combo, and Order belonging to
 * `the-coffee-house`, then recreates a curated catalogue:
 *
 *   - 8 categories (Starters → Desserts) with verified Unsplash images
 *   - ~30 menu items spread across the categories, each with a
 *     hand-picked image, branchPrices for the Main branch, and
 *     sensible defaults (active 09:00–23:00 every day, ingredients
 *     listed, vegType set, isFeatured for hero items)
 *   - 5 combos that reference real menu items by id
 *
 * Tables and inventory are intentionally untouched — they're physical
 * configuration, not menu data.
 *
 * Usage:
 *     cd Backend
 *     node Seed/reseedMenu.js          # apply
 *     node Seed/reseedMenu.js --dry    # preview deletes + counts only
 *
 * NOT idempotent on the create side — every run wipes the catalogue
 * and creates fresh ObjectIds. Existing customer carts that point at
 * old item ids will be invalidated.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Restaurant = require('../models/restaurant');
const Branch     = require('../models/branch');
const Category   = require('../models/category');
const MenuItem   = require('../models/menuItem');
const Combo      = require('../models/combo');
const Order      = require('../models/order');

const TENANT_SLUG = 'the-coffee-house';
const DRY = process.argv.includes('--dry');

// ─── Curated, verified-working Unsplash food photos ─────────────────
const IMG = {
    starters: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84',
    paneerTikka: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
    chilliMushroom: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46',
    springRolls: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828',
    soup: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d',
    paneerCurry: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
    dal: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38',
    butterChicken: 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47',
    naan: 'https://images.unsplash.com/photo-1601050690597-df0568f70950',
    biryani: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7',
    samosa: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828',
    pavBhaji: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84',
    coldCoffee: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4',
    lassi: 'https://images.unsplash.com/photo-1572119865084-43c285814d63',
    masalaChai: 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9',
    limeSoda: 'https://images.unsplash.com/photo-1497034825429-c343d7c6a68f',
    gulabJamun: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187',
    rasmalai: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187',
    lavaCake: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
    kulfi: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002',
    salad: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d',
    burger: 'https://images.unsplash.com/photo-1551782450-a2132b4ba21d',
    pizza: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd',
    pasta: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086',

    catStarters: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84',
    catSoups: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d',
    catMains: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
    catBreads: 'https://images.unsplash.com/photo-1601050690597-df0568f70950',
    catRice: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7',
    catSnacks: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828',
    catBeverages: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4',
    catDesserts: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
};

// ─── Categories ─────────────────────────────────────────────────────
const CATEGORIES = [
    { name: 'Starters',       displayOrder: 1, image: IMG.catStarters },
    { name: 'Soups',          displayOrder: 2, image: IMG.catSoups },
    { name: 'Main Course',    displayOrder: 3, image: IMG.catMains },
    { name: 'Indian Breads',  displayOrder: 4, image: IMG.catBreads },
    { name: 'Rice & Biryani', displayOrder: 5, image: IMG.catRice },
    { name: 'Snacks',         displayOrder: 6, image: IMG.catSnacks },
    { name: 'Beverages',      displayOrder: 7, image: IMG.catBeverages },
    { name: 'Desserts',       displayOrder: 8, image: IMG.catDesserts },
];

// ─── Menu items (catName drives category lookup at insert time) ────
const ITEMS = [
    // Starters
    { catName: 'Starters', name: 'Hara Bhara Kabab',  desc: 'Crispy spinach and green pea patties grilled to perfection.', img: IMG.starters,        veg: 'veg',     base: 220, off: 10, time: '15 mins', unit: 'plate', ingredients: ['Spinach', 'Green peas', 'Paneer', 'Spices'], featured: true,  healthy: true },
    { catName: 'Starters', name: 'Paneer Tikka',      desc: 'Marinated paneer cubes, capsicum and onion grilled in tandoor.', img: IMG.paneerTikka, veg: 'veg',     base: 280, off: 0,  time: '18 mins', unit: 'plate', ingredients: ['Paneer', 'Bell pepper', 'Onion', 'Yogurt marinade'], featured: true,  healthy: false },
    { catName: 'Starters', name: 'Chilli Mushroom',   desc: 'Crispy mushrooms tossed in a tangy Indo-Chinese sauce.',     img: IMG.chilliMushroom, veg: 'veg',     base: 240, off: 5,  time: '14 mins', unit: 'plate', ingredients: ['Button mushroom', 'Capsicum', 'Soy sauce'], featured: false, healthy: false },
    { catName: 'Starters', name: 'Veg Spring Rolls',  desc: 'Golden-fried rolls stuffed with stir-fried vegetables.',     img: IMG.springRolls,    veg: 'veg',     base: 180, off: 0,  time: '12 mins', unit: 'plate', ingredients: ['Cabbage', 'Carrot', 'Spring onion', 'Wrapper'], featured: false, healthy: false },

    // Soups
    { catName: 'Soups', name: 'Tomato Basil Soup',  desc: 'Classic creamy tomato soup with fresh basil.',        img: IMG.soup, veg: 'veg', base: 140, off: 0, time: '8 mins',  unit: 'bowl', ingredients: ['Tomato', 'Basil', 'Cream'],            featured: false, healthy: true },
    { catName: 'Soups', name: 'Sweet Corn Soup',    desc: 'Hot and comforting soup with sweet corn kernels.',    img: IMG.soup, veg: 'veg', base: 150, off: 0, time: '8 mins',  unit: 'bowl', ingredients: ['Sweet corn', 'Vegetable stock', 'Pepper'], featured: false, healthy: true },

    // Main Course
    { catName: 'Main Course', name: 'Paneer Butter Masala', desc: 'Creamy tomato gravy with soft paneer cubes — a north-Indian classic.', img: IMG.paneerCurry,   veg: 'veg',     base: 320, off: 10, time: '20 mins', unit: 'bowl', ingredients: ['Paneer', 'Tomato', 'Cashew', 'Butter'], featured: true,  healthy: false },
    { catName: 'Main Course', name: 'Dal Tadka',            desc: 'Yellow lentils tempered with cumin, garlic and fresh coriander.',     img: IMG.dal,           veg: 'veg',     base: 180, off: 0,  time: '15 mins', unit: 'bowl', ingredients: ['Toor dal', 'Cumin', 'Garlic', 'Ghee'],   featured: false, healthy: true },
    { catName: 'Main Course', name: 'Kadhai Paneer',        desc: 'Paneer and bell peppers tossed in freshly ground kadhai masala.',     img: IMG.paneerCurry,   veg: 'veg',     base: 310, off: 5,  time: '18 mins', unit: 'bowl', ingredients: ['Paneer', 'Bell pepper', 'Kadhai masala'], featured: false, healthy: false },
    { catName: 'Main Course', name: 'Mushroom Masala',      desc: 'Earthy mushrooms simmered in a rich onion-tomato gravy.',             img: IMG.chilliMushroom, veg: 'veg',     base: 270, off: 0,  time: '17 mins', unit: 'bowl', ingredients: ['Mushroom', 'Onion', 'Tomato', 'Spices'], featured: false, healthy: false },
    { catName: 'Main Course', name: 'Butter Chicken',       desc: 'Tandoor-roasted chicken in a velvety tomato-cream sauce.',            img: IMG.butterChicken, veg: 'non-veg', base: 380, off: 8,  time: '22 mins', unit: 'bowl', ingredients: ['Chicken', 'Tomato', 'Butter', 'Cream'],  featured: true,  healthy: false },

    // Indian Breads
    { catName: 'Indian Breads', name: 'Butter Naan',     desc: 'Soft tandoori bread brushed with melted butter.',          img: IMG.naan, veg: 'veg', base: 60, off: 0, time: '6 mins', unit: 'pieces', ingredients: ['Refined flour', 'Yogurt', 'Butter'], featured: false, healthy: false },
    { catName: 'Indian Breads', name: 'Garlic Naan',     desc: 'Tandoori naan topped with garlic and coriander.',           img: IMG.naan, veg: 'veg', base: 80, off: 0, time: '7 mins', unit: 'pieces', ingredients: ['Refined flour', 'Garlic', 'Coriander'], featured: false, healthy: false },
    { catName: 'Indian Breads', name: 'Tandoori Roti',   desc: 'Whole-wheat flatbread baked fresh in the tandoor.',         img: IMG.naan, veg: 'veg', base: 35, off: 0, time: '5 mins', unit: 'pieces', ingredients: ['Whole-wheat flour'], featured: false, healthy: true },
    { catName: 'Indian Breads', name: 'Lachha Paratha',  desc: 'Layered, flaky whole-wheat paratha with a buttery finish.', img: IMG.naan, veg: 'veg', base: 70, off: 0, time: '8 mins', unit: 'pieces', ingredients: ['Whole-wheat flour', 'Ghee'], featured: false, healthy: false },

    // Rice & Biryani
    { catName: 'Rice & Biryani', name: 'Veg Biryani',    desc: 'Long-grain basmati layered with mixed vegetables and aromatic spices.', img: IMG.biryani, veg: 'veg',     base: 260, off: 12, time: '25 mins', unit: 'plate', ingredients: ['Basmati rice', 'Mixed veg', 'Whole spices'], featured: true,  healthy: false },
    { catName: 'Rice & Biryani', name: 'Chicken Biryani', desc: 'Hyderabadi-style chicken biryani with saffron and fried onion.',     img: IMG.biryani, veg: 'non-veg', base: 340, off: 10, time: '28 mins', unit: 'plate', ingredients: ['Basmati rice', 'Chicken', 'Saffron'],         featured: true,  healthy: false },
    { catName: 'Rice & Biryani', name: 'Jeera Rice',      desc: 'Fluffy basmati tempered with cumin and ghee.',                       img: IMG.biryani, veg: 'veg',     base: 160, off: 0,  time: '12 mins', unit: 'plate', ingredients: ['Basmati rice', 'Cumin', 'Ghee'],              featured: false, healthy: true },

    // Snacks
    { catName: 'Snacks', name: 'Samosa (2 pcs)', desc: 'Crispy pastry stuffed with spiced potato and peas. Served with chutney.', img: IMG.samosa,   veg: 'veg', base: 60,  off: 0,  time: '7 mins',  unit: 'pieces', ingredients: ['Potato', 'Pea', 'Pastry'],         featured: false, healthy: false },
    { catName: 'Snacks', name: 'Veg Pakoda',     desc: 'Mixed vegetable fritters in spiced gram-flour batter.',                  img: IMG.samosa,   veg: 'veg', base: 140, off: 0,  time: '10 mins', unit: 'plate',  ingredients: ['Mixed veg', 'Gram flour'],        featured: false, healthy: false },
    { catName: 'Snacks', name: 'Pav Bhaji',      desc: 'Mumbai street-style mashed-veg curry with butter-toasted pav.',          img: IMG.pavBhaji, veg: 'veg', base: 180, off: 5,  time: '15 mins', unit: 'plate',  ingredients: ['Mixed veg', 'Pav', 'Butter'],     featured: true,  healthy: false },

    // Beverages
    { catName: 'Beverages', name: 'Cold Coffee',       desc: 'Chilled espresso blended with milk and a scoop of ice cream.', img: IMG.coldCoffee,  veg: 'veg', base: 160, off: 0, time: '5 mins', unit: 'glass', ingredients: ['Coffee', 'Milk', 'Ice cream'],   featured: true,  healthy: false },
    { catName: 'Beverages', name: 'Mango Lassi',       desc: 'Thick yogurt smoothie blended with sweet mango pulp.',         img: IMG.lassi,       veg: 'veg', base: 130, off: 0, time: '4 mins', unit: 'glass', ingredients: ['Yogurt', 'Mango pulp', 'Sugar'],  featured: false, healthy: true  },
    { catName: 'Beverages', name: 'Masala Chai',       desc: 'House blend tea brewed with ginger, cardamom and milk.',       img: IMG.masalaChai,  veg: 'veg', base: 50,  off: 0, time: '5 mins', unit: 'cup',   ingredients: ['Tea', 'Ginger', 'Cardamom', 'Milk'], featured: false, healthy: true  },
    { catName: 'Beverages', name: 'Fresh Lime Soda',   desc: 'Refreshing soda with lime, mint and your choice of sweet/salt.', img: IMG.limeSoda,  veg: 'veg', base: 90,  off: 0, time: '3 mins', unit: 'glass', ingredients: ['Lime', 'Mint', 'Soda'],            featured: false, healthy: true  },

    // Desserts
    { catName: 'Desserts', name: 'Gulab Jamun (2 pcs)', desc: 'Classic milk-solid dumplings soaked in saffron-cardamom syrup.', img: IMG.gulabJamun, veg: 'veg', base: 120, off: 0,  time: '5 mins',  unit: 'pieces', ingredients: ['Khoya', 'Sugar syrup', 'Cardamom'], featured: false, healthy: false },
    { catName: 'Desserts', name: 'Rasmalai',           desc: 'Soft cottage-cheese discs in chilled, saffron-infused milk.',     img: IMG.rasmalai,   veg: 'veg', base: 150, off: 0,  time: '5 mins',  unit: 'bowl',   ingredients: ['Chenna', 'Milk', 'Saffron'],         featured: true,  healthy: false },
    { catName: 'Desserts', name: 'Chocolate Lava Cake', desc: 'Warm chocolate cake with a molten centre. Served with vanilla.', img: IMG.lavaCake,   veg: 'veg', base: 220, off: 10, time: '12 mins', unit: 'pieces', ingredients: ['Dark chocolate', 'Butter', 'Egg', 'Flour'], featured: true,  healthy: false },
    { catName: 'Desserts', name: 'Kulfi (Pista)',       desc: 'Traditional Indian frozen dessert with pistachio and cardamom.', img: IMG.kulfi,      veg: 'veg', base: 110, off: 0,  time: '3 mins',  unit: 'pieces', ingredients: ['Milk', 'Pistachio', 'Cardamom'],     featured: false, healthy: false },
];

// ─── Combos (item names map to created MenuItems) ──────────────────
const COMBOS = [
    {
        name: 'Family Pack',
        description: 'Generous spread for the whole family — paneer, dal, rice, naan and a sweet finish.',
        serveUpto: '4-6 person',
        vegType: 'veg',
        isSpecial: true,
        price: 999,
        originalPrice: 1280,
        discount: 22,
        discountType: 'Percentage',
        image: IMG.paneerCurry,
        groups: [
            { name: 'Main Course', items: ['Paneer Butter Masala', 'Dal Tadka'] },
            { name: 'Breads',      items: ['Butter Naan', 'Garlic Naan'] },
            { name: 'Rice',        items: ['Jeera Rice'] },
            { name: 'Dessert',     items: ['Gulab Jamun (2 pcs)'] },
        ],
    },
    {
        name: 'Lunch Special',
        description: 'A complete one-plate meal — biryani with cooling lassi and a sweet finish.',
        serveUpto: '1-2 person',
        vegType: 'veg',
        isSpecial: true,
        price: 449,
        originalPrice: 540,
        discount: 17,
        discountType: 'Percentage',
        image: IMG.biryani,
        groups: [
            { name: 'Main',    items: ['Veg Biryani'] },
            { name: 'Drink',   items: ['Mango Lassi'] },
            { name: 'Dessert', items: ['Gulab Jamun (2 pcs)'] },
        ],
    },
    {
        name: 'Snack Combo',
        description: 'Hot samosas with a cup of masala chai — perfect tea-time treat.',
        serveUpto: '1-2 person',
        vegType: 'veg',
        isSpecial: false,
        price: 99,
        originalPrice: 110,
        discount: 10,
        discountType: 'Percentage',
        image: IMG.samosa,
        groups: [
            { name: 'Snack', items: ['Samosa (2 pcs)'] },
            { name: 'Drink', items: ['Masala Chai'] },
        ],
    },
    {
        name: 'Sweet Treat',
        description: 'Molten lava cake with chilled cold coffee — a dessert lover\'s favourite.',
        serveUpto: '1-2 person',
        vegType: 'veg',
        isSpecial: false,
        price: 329,
        originalPrice: 380,
        discount: 13,
        discountType: 'Percentage',
        image: IMG.lavaCake,
        groups: [
            { name: 'Dessert', items: ['Chocolate Lava Cake'] },
            { name: 'Drink',   items: ['Cold Coffee'] },
        ],
    },
    {
        name: 'Tea Time Special',
        description: 'Crispy pakodas paired with our signature masala chai.',
        serveUpto: '2-3 person',
        vegType: 'veg',
        isSpecial: false,
        price: 179,
        originalPrice: 240,
        discount: 25,
        discountType: 'Percentage',
        image: IMG.samosa,
        groups: [
            { name: 'Snack', items: ['Veg Pakoda', 'Pav Bhaji'] },
            { name: 'Drink', items: ['Masala Chai'] },
        ],
    },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function main() {
    if (!process.env.MONGO_URL) {
        console.error('FATAL: MONGO_URL is not set');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL, { family: 4 });
    console.log('Connected.');

    const tenant = await Restaurant.findOne({ slug: TENANT_SLUG });
    if (!tenant) {
        console.error(`FATAL: tenant '${TENANT_SLUG}' not found`);
        process.exit(1);
    }
    const main = await Branch.findOne({ restaurant: tenant._id, slug: 'main' });
    if (!main) {
        console.error(`FATAL: Main branch for '${TENANT_SLUG}' not found`);
        process.exit(1);
    }
    console.log(`Tenant: ${tenant.name} (${tenant._id})`);
    console.log(`Main:   ${main.name} (${main._id})`);
    console.log('');

    // ── Survey current state ────────────────────────────────────────
    const before = {
        Category: await Category.countDocuments({ restaurant: tenant._id }),
        MenuItem: await MenuItem.countDocuments({ restaurant: tenant._id }),
        Combo:    await Combo.countDocuments({ restaurant: tenant._id }),
        Order:    await Order.countDocuments({ restaurant: tenant._id }),
    };
    console.log('Before:', before);

    if (DRY) {
        console.log('\nDRY RUN — would delete the above and create:');
        console.log(`  Categories: ${CATEGORIES.length}`);
        console.log(`  Menu items: ${ITEMS.length}`);
        console.log(`  Combos:     ${COMBOS.length}`);
        await mongoose.disconnect();
        return;
    }

    // ── Wipe ────────────────────────────────────────────────────────
    console.log('\nDeleting existing menu data + orders…');
    const dCat = await Category.deleteMany({ restaurant: tenant._id });
    const dMenu = await MenuItem.deleteMany({ restaurant: tenant._id });
    const dCombo = await Combo.deleteMany({ restaurant: tenant._id });
    const dOrder = await Order.deleteMany({ restaurant: tenant._id });
    console.log(`  categories: ${dCat.deletedCount}`);
    console.log(`  menu items: ${dMenu.deletedCount}`);
    console.log(`  combos:     ${dCombo.deletedCount}`);
    console.log(`  orders:     ${dOrder.deletedCount}`);

    // ── Categories ──────────────────────────────────────────────────
    console.log('\nSeeding categories…');
    const catByName = {};
    for (const c of CATEGORIES) {
        const doc = await Category.create({
            restaurant: tenant._id,
            branch: null,
            name: c.name,
            displayOrder: c.displayOrder,
            image: c.image,
            status: 'active',
        });
        catByName[c.name] = doc._id;
        console.log(`  + ${c.name}`);
    }

    // ── Menu items ──────────────────────────────────────────────────
    console.log('\nSeeding menu items…');
    const itemByName = {};
    for (const it of ITEMS) {
        const catId = catByName[it.catName];
        if (!catId) {
            console.warn(`  ! skip ${it.name} — category '${it.catName}' not seeded`);
            continue;
        }
        const doc = new MenuItem({
            restaurant: tenant._id,
            branch: null, // tenant-shared so any sub-branch added later inherits
            name: it.name,
            category: catId,
            description: it.desc,
            images: [it.img],
            cookingTime: it.time,
            serveUpto: '1 person',
            ingredients: it.ingredients,
            vegType: it.veg,
            isFeatured: !!it.featured,
            availableDays: DAYS,
            startTime: '09:00',
            endTime: '23:00',
            basePrice: it.base,
            offerPercentage: it.off || 0,
            unit: it.unit || 'plate',
            isHealthy: !!it.healthy,
            status: 'active',
            inStock: true,
            // Per-branch override for Main — seed defaults to same price
            // as base, so when sub-branches are added later they can fork.
            branchPrices: [{
                branch: main._id,
                basePrice: it.base,
                offerPercentage: it.off || 0,
            }],
        });
        await doc.save();
        itemByName[it.name] = { _id: doc._id, price: doc.finalPrice, isVeg: it.veg === 'veg' };
        console.log(`  + ${it.catName.padEnd(15)} ${it.name}`);
    }

    // ── Combos ──────────────────────────────────────────────────────
    console.log('\nSeeding combos…');
    for (const cb of COMBOS) {
        const groups = cb.groups.map(g => ({
            name: g.name,
            items: g.items.map(itemName => {
                const m = itemByName[itemName];
                if (!m) {
                    console.warn(`  ! combo '${cb.name}' references missing item '${itemName}'`);
                    return null;
                }
                return {
                    menuItemId: m._id,
                    name: itemName,
                    price: m.price,
                    isVeg: m.isVeg,
                };
            }).filter(Boolean),
        }));

        await Combo.create({
            restaurant: tenant._id,
            name: cb.name,
            description: cb.description,
            serveUpto: cb.serveUpto,
            vegType: cb.vegType,
            isSpecial: cb.isSpecial,
            images: [cb.image],
            categories: groups,
            price: cb.price,
            originalPrice: cb.originalPrice,
            discount: cb.discount,
            discountType: cb.discountType,
            unlimitedQuantity: true,
            availableDays: DAYS,
            startTime: '09:00',
            endTime: '23:00',
            status: 'active',
        });
        console.log(`  + ${cb.name.padEnd(20)} (₹${cb.price})`);
    }

    // ── Final state ─────────────────────────────────────────────────
    const after = {
        Category: await Category.countDocuments({ restaurant: tenant._id }),
        MenuItem: await MenuItem.countDocuments({ restaurant: tenant._id }),
        Combo:    await Combo.countDocuments({ restaurant: tenant._id }),
        Order:    await Order.countDocuments({ restaurant: tenant._id }),
    };
    console.log('\nAfter:', after);
    console.log('Done.');
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('reseedMenu failed:', err);
    process.exit(1);
});
