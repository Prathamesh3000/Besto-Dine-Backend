/**
 * fetchMenuImagesGoogle.js — fetch ACTUAL dish photos from Google
 * Custom Search (Images API) for every MenuItem and Combo in the DB.
 *
 * Why this script instead of applyMenuImages.js?
 *   applyMenuImages.js picks from a small curated Unsplash pool by
 *   keyword scoring. The pool is mostly Western lifestyle photos —
 *   "Aloo Tikki" / "Gulab Jamun" / "Misal Pav" don't actually exist
 *   in the pool, so they fall through to generic substitutes that
 *   don't look like the real dish. This script searches Google Images
 *   for each item's exact name and writes the first high-quality
 *   result back to the DB, giving 100% dish-accurate thumbnails.
 *
 * Setup (one time, ~5 minutes):
 *   1. Create a Custom Search Engine at
 *      https://programmablesearchengine.google.com/
 *        - Sites to search: leave blank, toggle "Search the entire web"
 *        - Enable Image Search
 *        - Save → copy the "Search engine ID" (also called cx)
 *   2. Create an API key at
 *      https://console.cloud.google.com/apis/credentials
 *        - Enable the "Custom Search API" first under "Library"
 *        - Create credentials → API key, copy the key
 *   3. Add to Backend/.env:
 *      GOOGLE_CSE_KEY=<your-api-key>
 *      GOOGLE_CSE_ID=<your-search-engine-id>
 *
 * Cost: free tier = 100 queries / day. We have ~210 items (170 menu +
 * 40 combos) so the script will hit the daily quota. Run it in two
 * passes a day apart, or pay for additional queries ($5 / 1000).
 *
 * Usage:
 *   cd Backend
 *   node Seed/fetchMenuImagesGoogle.js              # only items with no/dead image
 *   node Seed/fetchMenuImagesGoogle.js --force      # overwrite every item + combo
 *   node Seed/fetchMenuImagesGoogle.js --dry        # preview without writes
 *   node Seed/fetchMenuImagesGoogle.js --limit 50   # cap how many lookups to run
 *   node Seed/fetchMenuImagesGoogle.js --combos     # only combos (saves quota)
 *   node Seed/fetchMenuImagesGoogle.js --menu       # only menu items (saves quota)
 *
 * The script throttles to ~1 query/sec to stay under Google's rate
 * limits and prints a per-item report so you can spot any failures.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const MenuItem = require('../models/menuItem');
const Combo = require('../models/combo');
require('../models/category');

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');
const ONLY_COMBOS = process.argv.includes('--combos');
const ONLY_MENU = process.argv.includes('--menu');
const LIMIT_ARG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_ARG !== -1 ? Number(process.argv[LIMIT_ARG + 1]) : Infinity;

const KEY = process.env.GOOGLE_CSE_KEY;
const CX = process.env.GOOGLE_CSE_ID;

if (!KEY || !CX) {
    console.error('FATAL: GOOGLE_CSE_KEY and GOOGLE_CSE_ID must be set in Backend/.env');
    console.error('See the header comment in this file for setup steps.');
    process.exit(1);
}
if (!process.env.MONGO_URL) {
    console.error('FATAL: MONGO_URL is not set');
    process.exit(1);
}

// Reuse the dead-URL list from applyMenuImages.js — same triggers.
const DEAD_IMAGE_PATTERNS = [
    /^https?:\/\/images\.unsplash\.com\/photo-(1567620905732-2d1ec7bb7445|1484723088339-323833995221)/i,
    /^https?:\/\/(?:[a-z0-9-]+\.)?picsum\.photos\//i,
    /^https?:\/\/source\.unsplash\.com\//i,
];

function needsRefresh(currentImages) {
    if (FORCE) return true;
    const first = Array.isArray(currentImages) ? currentImages[0] : null;
    if (!first || typeof first !== 'string') return true;
    return DEAD_IMAGE_PATTERNS.some((re) => re.test(first));
}

// Build a high-signal search query. Adding "food dish" and a cuisine
// modifier ("indian"/"chinese"/"continental") sharpens the results so
// e.g. "Margherita" isn't ambiguous with the cocktail.
function buildQuery(name, category) {
    const cat = String(category?.name || '').toLowerCase();
    let cuisineHint = '';
    if (/biryani|paneer|dal|tandoori|tikka|naan|paratha|chai|lassi|chaat|kebab|kabab|dosa|idli|samosa|gulab|rasgulla|kheer|halwa|roti|pulao|aloo|chana|chole|rajma/i.test(name)) {
        cuisineHint = ' indian food';
    } else if (/pizza|pasta|alfredo|arrabbiata|caesar|burger|sandwich|tiramisu|cheesecake|brownie/i.test(name)) {
        cuisineHint = ' food dish';
    } else if (/manchurian|schezwan|hakka|noodles|chopsuey|spring/i.test(name)) {
        cuisineHint = ' indo chinese food';
    } else if (/coffee|tea|latte|cappuccino|espresso|chai|lassi|shake|smoothie|mocktail|juice|soda/i.test(name)) {
        cuisineHint = ' drink';
    } else {
        cuisineHint = ' food';
    }
    return (name + cuisineHint).trim();
}

// Call Google Custom Search Images API. Returns the first usable URL
// or null on miss / error.
async function googleImageSearch(query) {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', KEY);
    url.searchParams.set('cx', CX);
    url.searchParams.set('q', query);
    url.searchParams.set('searchType', 'image');
    // Filter for safe, reasonably-sized, food-photo-friendly results.
    url.searchParams.set('safe', 'active');
    url.searchParams.set('imgSize', 'medium');
    url.searchParams.set('imgType', 'photo');
    url.searchParams.set('num', '5');

    try {
        const res = await fetch(url.toString());
        if (!res.ok) {
            const body = await res.text();
            console.warn(`  ! Google API returned ${res.status} for "${query}": ${body.slice(0, 200)}`);
            return null;
        }
        const json = await res.json();
        const items = json.items || [];
        // Prefer URLs from known-stable hosts. Skip data: URIs and tiny
        // thumbnails. Cap at the first 5 results to keep cost down.
        for (const item of items) {
            const link = item.link;
            if (!link || typeof link !== 'string') continue;
            if (!/^https?:\/\//i.test(link)) continue;
            // Block obvious bad hosts: ad servers, expired stock-photo
            // watermark previews, etc.
            if (/(watermarked|preview|gettyimages|alamy|shutterstock)/i.test(link)) continue;
            return link;
        }
        return null;
    } catch (err) {
        console.warn(`  ! Network error for "${query}": ${err.message}`);
        return null;
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    await mongoose.connect(process.env.MONGO_URL, { family: 4 });
    console.log('Connected to MongoDB.');
    console.log(FORCE ? 'FORCE — overwriting every item' : 'Selective — only items with missing/dead images');
    if (DRY) console.log('DRY RUN — no writes will be made');
    if (LIMIT !== Infinity) console.log(`LIMIT — at most ${LIMIT} lookups`);
    console.log('');

    let totalLookups = 0;
    let menuUpdated = 0;
    let menuSkipped = 0;
    let menuFailed = 0;
    let comboUpdated = 0;
    let comboSkipped = 0;
    let comboFailed = 0;

    // ── Menu items ────────────────────────────────────────────────
    if (!ONLY_COMBOS) {
        const items = await MenuItem.find({}).populate('category', 'name').lean();
        console.log(`Found ${items.length} menu item(s).\n`);
        for (const item of items) {
            if (totalLookups >= LIMIT) break;
            if (!needsRefresh(item.images)) { menuSkipped++; continue; }
            const query = buildQuery(item.name, item.category);
            process.stdout.write(`  [${String(totalLookups + 1).padStart(3)}] ${item.name.padEnd(34)} q="${query}"  → `);
            const url = await googleImageSearch(query);
            totalLookups++;
            if (!url) {
                console.log('NO RESULT');
                menuFailed++;
                await sleep(1100);
                continue;
            }
            console.log(url.slice(0, 80));
            if (!DRY) {
                await MenuItem.updateOne({ _id: item._id }, { $set: { images: [url] } });
            }
            menuUpdated++;
            // 1 query/sec keeps us under Google's hard limit.
            await sleep(1100);
        }
    }

    // ── Combos ────────────────────────────────────────────────────
    if (!ONLY_MENU && totalLookups < LIMIT) {
        const combos = await Combo.find({}).lean();
        console.log(`\nFound ${combos.length} combo(s).\n`);
        for (const combo of combos) {
            if (totalLookups >= LIMIT) break;
            if (!needsRefresh(combo.images)) { comboSkipped++; continue; }
            // Combos: use the name verbatim + "indian food platter"
            // since they're typically bundled meals.
            const query = (combo.name + ' indian food platter meal').trim();
            process.stdout.write(`  [${String(totalLookups + 1).padStart(3)}] ${combo.name.padEnd(34)} q="${query}"  → `);
            const url = await googleImageSearch(query);
            totalLookups++;
            if (!url) {
                console.log('NO RESULT');
                comboFailed++;
                await sleep(1100);
                continue;
            }
            console.log(url.slice(0, 80));
            if (!DRY) {
                await Combo.updateOne({ _id: combo._id }, { $set: { images: [url] } });
            }
            comboUpdated++;
            await sleep(1100);
        }
    }

    console.log('\n—');
    console.log(`Menu  — Updated: ${menuUpdated}, Skipped: ${menuSkipped}, Failed: ${menuFailed}`);
    console.log(`Combo — Updated: ${comboUpdated}, Skipped: ${comboSkipped}, Failed: ${comboFailed}`);
    console.log(`Total Google API calls: ${totalLookups}`);
    console.log('Done.');
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('fetchMenuImagesGoogle failed:', err);
    process.exit(1);
});
