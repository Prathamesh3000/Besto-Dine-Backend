// Category image auto-heal.
//
// Problem: category hero images are external Unsplash URLs. Unsplash
// periodically reaps photos, so a URL that worked at seed time later
// 404s and the customer menu falls back to the grey placeholder
// (/uploads/Thumbnil.png). The older applyMenuImages.js only catches a
// HARDCODED list of known-dead URLs (DEAD_IMAGE_PATTERNS) — a *newly*
// dead photo id is invisible to it until a human adds the id to the
// list. That's not automatic.
//
// This module does a LIVE HTTP HEAD check on every category image, so
// ANY dead URL (present or future) is detected without anyone
// enumerating ids. Dead/empty/placeholder images are re-pointed to an
// accurate, name-matched replacement — and the replacement is itself
// HEAD-verified before we write it, so we never swap one dead URL for
// another.
//
// Safety rules that keep this from ever clobbering good data:
//   - Only a DEFINITIVE dead signal (HTTP 404 / 410) triggers a heal.
//     A timeout, network blip, or 5xx is treated as "unknown" and left
//     untouched — a flaky scan must never overwrite a working image.
//   - Admin-uploaded local images (/uploads/… that aren't the default
//     placeholder) are assumed alive and never touched.
//   - URL liveness is cached per run, so we hit each distinct URL once.
//
// Wired into server.js as a setInterval scheduler (same shape as
// menuAutoRestoreScheduler). Disable on multi-instance setups via
// CATEGORY_IMAGE_HEAL_DISABLED=true and poke runCategoryImageHeal()
// from an external cron instead. Interval via CATEGORY_IMAGE_HEAL_HOURS
// (default 24h).

const Category = require('../models/category');
const logger = require('./logger');
const { urlStatus, resetLivenessCache } = require('./imageLiveness');

const DEFAULT_IMAGE = '/uploads/Thumbnil.png';

// Verified-working Unsplash hero per standard category name. Keys are
// lowercased + whitespace-collapsed. These are the *replacement source*
// when a category's current image dies — but each is HEAD-verified at
// heal time before being written, so a future death here self-corrects
// on the next scan (falls through to the keyword pool / placeholder).
const CATEGORY_IMAGE_MAP = {
    'beverages':           'https://images.unsplash.com/photo-1551024709-8f23befc6f87',
    'healthy bowls':       'https://images.unsplash.com/photo-1512621776951-a57141f2eefd',
    'healthy food':        'https://images.unsplash.com/photo-1490645935967-10de6ba17061',
    'main course':         'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
    'rice and biryani':    'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8',
    'rice & biryani':      'https://images.unsplash.com/photo-1633945274405-b6c8069047b0',
    'starters':            'https://images.unsplash.com/photo-1600891964599-f61ba0e24092',
    'north indian':        'https://images.unsplash.com/photo-1601050690597-df0568f70950',
    'south indian':        'https://images.unsplash.com/photo-1668236543090-82eba5ee5976',
    'soups':               'https://images.unsplash.com/photo-1547592180-85f173990554',
    'breads':              'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38',
    'chinese':             'https://images.unsplash.com/photo-1585032226651-759b368d7246',
    'noodles':             'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841',
    'pizza':               'https://images.unsplash.com/photo-1513104890138-7c749659a591',
    'burgers':             'https://images.unsplash.com/photo-1550547660-d9450f859349',
    'sandwiches':          'https://images.unsplash.com/photo-1553909489-cd47e0907980',
    'wraps & rolls':       'https://images.unsplash.com/photo-1606755962773-d324e0a13086',
    'pasta':               'https://images.unsplash.com/photo-1525755662778-989d0524087e',
    'salads':              'https://images.unsplash.com/photo-1546793665-c74683f339c1',
    'combos & thali':      'https://images.unsplash.com/photo-1585937421612-70a008356fbe',
    'desserts':            'https://images.unsplash.com/photo-1551024601-bec78aea704b',
    'ice cream':           'https://images.unsplash.com/photo-1563805042-7684c019e1cb',
    'cakes':               'https://images.unsplash.com/photo-1578985545062-69928b1d9587',
    'coffee':              'https://images.unsplash.com/photo-1509042239860-f550ce710b93',
    'tea':                 'https://images.unsplash.com/photo-1576092768241-dec231879fc3',
    'milkshakes':          'https://images.unsplash.com/photo-1577805947697-89e18249d767',
    'fresh juices':        'https://images.unsplash.com/photo-1600271886742-f049cd451bba',
    'cold drinks':         'https://images.unsplash.com/photo-1554866585-cd94860890b7',
    'mineral water':       'https://images.unsplash.com/photo-1564419320461-6870880221ad',
    'packaged beverages':  'https://images.unsplash.com/photo-1622483767028-3f66f32aef97',
};

// Keyword-scored pool for non-standard category names not in the map
// above. Each entry's tags are matched against the category-name tokens;
// highest overlap wins. Keep entries verified-working.
const KEYWORD_POOL = [
    { url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c', tags: ['main', 'course', 'meal', 'gravy', 'curry', 'thali'] },
    { url: 'https://images.unsplash.com/photo-1600891964599-f61ba0e24092', tags: ['starter', 'snack', 'appetizer', 'tandoor', 'kebab', 'tikka'] },
    { url: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8', tags: ['rice', 'biryani', 'pulao', 'fried'] },
    { url: 'https://images.unsplash.com/photo-1585032226651-759b368d7246', tags: ['chinese', 'noodles', 'hakka', 'manchurian', 'schezwan'] },
    { url: 'https://images.unsplash.com/photo-1513104890138-7c749659a591', tags: ['pizza', 'italian'] },
    { url: 'https://images.unsplash.com/photo-1550547660-d9450f859349', tags: ['burger', 'sandwich', 'wrap', 'roll', 'fast'] },
    { url: 'https://images.unsplash.com/photo-1551024601-bec78aea704b', tags: ['dessert', 'sweet', 'cake', 'pastry', 'ice', 'cream'] },
    { url: 'https://images.unsplash.com/photo-1551024709-8f23befc6f87', tags: ['beverage', 'drink', 'juice', 'shake', 'coffee', 'tea', 'cold', 'water'] },
    { url: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061', tags: ['healthy', 'salad', 'bowl', 'diet', 'vegan'] },
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['soup', 'shorba', 'broth'] },
];

function normaliseName(name) {
    return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function tokensOf(str) {
    return String(str || '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

// Pick the most accurate replacement URL for a category by name. Exact
// name map first (most accurate), then keyword scoring, then null (caller
// falls back to the placeholder). Does NOT verify liveness — the caller
// HEAD-checks the candidate before writing.
function pickReplacement(name) {
    const key = normaliseName(name);
    if (CATEGORY_IMAGE_MAP[key]) return [CATEGORY_IMAGE_MAP[key]];

    const nameTokens = new Set(tokensOf(name));
    const scored = KEYWORD_POOL
        .map((e) => ({ url: e.url, score: e.tags.reduce((s, t) => s + (nameTokens.has(t) ? 1 : 0), 0) }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((e) => e.url);
    return scored; // may be [] — caller handles
}

// Liveness check ('alive' | 'dead' | 'unknown') is shared with the
// menu-item healer — see utils/imageLiveness.js.

// Decide whether a category needs healing based on its current image.
// Returns true only when we're confident the current image won't render.
async function needsHeal(image) {
    const img = (image || '').trim();
    if (!img) return true;                       // empty
    if (img === DEFAULT_IMAGE) return true;      // bare placeholder
    if (img.startsWith('/uploads/')) return false; // admin-uploaded local asset — assume alive
    if (/^https?:\/\//i.test(img)) {
        return (await urlStatus(img)) === 'dead'; // only definitive 404/410
    }
    return false; // unrecognised shape — leave it
}

// Resolve the best WORKING replacement URL for a category, verifying
// each candidate is alive before returning it. Falls back to the
// placeholder so the field stays consistent if nothing verifies.
async function resolveWorkingImage(name) {
    for (const candidate of pickReplacement(name)) {
        if ((await urlStatus(candidate)) === 'alive') return candidate;
    }
    return DEFAULT_IMAGE;
}

/**
 * Scan every category (all tenants) and heal dead / empty / placeholder
 * images. Idempotent and safe to run repeatedly.
 *
 * @param {{ dry?: boolean }} opts
 * @returns {Promise<{ scanned:number, healed:number, skipped:number }>}
 */
async function runCategoryImageHeal({ dry = false } = {}) {
    resetLivenessCache();
    const cats = await Category.find({}).select('name image restaurant').lean();
    let healed = 0, skipped = 0;

    for (const cat of cats) {
        if (!(await needsHeal(cat.image))) { skipped++; continue; }

        const newImage = await resolveWorkingImage(cat.name);
        if (newImage === (cat.image || '').trim()) { skipped++; continue; } // nothing better found

        if (!dry) {
            await Category.updateOne({ _id: cat._id }, { $set: { image: newImage } });
        }
        healed++;
        logger.info(`category image heal: "${cat.name}" ${cat.image || '(empty)'} → ${newImage}`);
    }

    if (healed > 0 || dry) {
        logger.info(`category image heal: scanned ${cats.length}, healed ${healed}, skipped ${skipped}${dry ? ' (dry run)' : ''}`);
    }
    return { scanned: cats.length, healed, skipped };
}

const INTERVAL_HOURS = Number(process.env.CATEGORY_IMAGE_HEAL_HOURS) || 24;
const DELAY_MS = 45 * 1000; // first run ~45s after boot (let DB warm up)
let _timer = null;

function startScheduledCategoryImageHeal() {
    if (_timer) return;
    if (process.env.CATEGORY_IMAGE_HEAL_DISABLED === 'true') {
        logger.info('category image heal disabled via CATEGORY_IMAGE_HEAL_DISABLED');
        return;
    }
    const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
    // #35 — cluster-locked; scheduler logs errors.
    _timer = require('./scheduler').scheduleJob('category-image-heal', intervalMs, () => runCategoryImageHeal(), { initialDelayMs: DELAY_MS });
    logger.debug(`scheduled category image heal every ${INTERVAL_HOURS}h (first run in ${DELAY_MS / 1000}s)`);
}

module.exports = {
    runCategoryImageHeal,
    startScheduledCategoryImageHeal,
    // exported for tests / manual use
    urlStatus,
    pickReplacement,
};
