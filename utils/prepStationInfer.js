/**
 * Heuristic prep-station inference.
 *
 * Centralises the name/category rules so the same logic runs in two
 * places:
 *   1. Order create — fallback when a MenuItem has prepStation unset
 *      or stuck at the schema default 'kitchen' but its name clearly
 *      indicates a ready-to-serve item (water, Red Bull, Coke, etc.).
 *      Without this fallback, every pre-migration item routes to the
 *      chef KDS until an admin manually edits each menu item.
 *   2. Backfill script (`migrations/backfillPrepStation.js`) — bulk upgrade
 *      existing rows.
 *
 * The function returns one of: 'kitchen' | 'bar' | 'counter'.
 */

// Items whose NAME contains one of these patterns are ready-to-serve.
// Match is regex case-insensitive on the trimmed name.
//
// We include both generic tokens (water, bottle, canned) AND specific
// brand names because most cafes name menu items by brand ("Kinley 1
// Litre", "Aquafina 1 Litre") rather than the generic category — the
// regex `/\bwater\b/` would never match "Bisleri 500 ml". Brands are
// the strongest signal for "this is sealed packaging, no prep needed".
const COUNTER_NAME_PATTERNS = [
    // Generic
    /\bwater\b/i, /mineral\s*water/i, /drinking\s*water/i,
    /\bbottle\b/i, /\bbottled\b/i,
    /\bcanned\b/i, /soda\s*can/i, /\bcan\b\s*\d/i,        // "Coke can 330" etc.
    /\bpackaged\b/i, /pre[-\s]*pack/i, /\bsealed\b/i,
    /soft\s*drink/i, /\bsoda\b/i,

    // Bottled water brands (Indian + global)
    /bisleri/i, /aquafina/i, /kinley/i, /himalayan/i,
    /baill?ey/i, /vedica/i, /aqua\s*pura/i, /aqua\s*fina/i,
    /tata\s*copper/i, /tata\s*gluco/i, /tata\s*water/i,
    // "Qua" water brand — whole word only (not Quattro / Squash / Aquarius).
    /catch\s*water/i, /\bqua\b/i, /oxyrich/i, /rail\s*neer/i,

    // Carbonated soft drinks (sealed bottles/cans)
    /\bcoke\b/i, /coca[-\s]*cola/i, /diet\s*coke/i,
    /\bpepsi\b/i, /\bsprite\b/i, /\bfanta\b/i,
    /thums?\s*up/i, /mountain\s*dew/i, /7\s*up/i, /seven\s*up/i,
    /limca/i, /maaza/i, /mirinda/i, /appy\s*fizz/i, /frooti/i,
    // "Slice" mango drink — whole word, and not a food slice ("Pizza
    // Slice", "Slice of Cake").
    /(?<!\b(?:pizza|cake|bread|cheese|pie|apple|lemon|lime|orange|watermelon|melon|pineapple)\s+)\bslice\b(?!\s+of\b)/i,

    // Energy drinks
    /red\s*bull/i, /monster\s+energy/i, /\bsting\b/i, /energy\s*drink/i,
];

// Beverage station — drinks that need preparation but go through a
// dedicated bar/coffee setup, not the food kitchen. 'bar' currently
// shares the chef workflow on the dashboard side, but tagging now
// keeps the future migration to a separate bar dashboard a no-op.
const BAR_NAME_PATTERNS = [
    /coffee/i, /cappuccino/i, /\blatte\b/i, /espresso/i, /mocha/i, /americano/i, /macchiato/i,
    /\btea\b/i, /\bchai\b/i,
    /shake/i, /smoothie/i, /milkshake/i,
    /mojito/i, /lime\s*soda/i, /iced\s*tea/i, /lemonade/i,
    /\bjuice\b/i, /mocktail/i, /\blassi\b/i,
];

const CATEGORY_RULES = [
    { match: /ice\s*cream/i,    station: 'counter' },
    { match: /packaged/i,       station: 'counter' },
    { match: /bottled/i,        station: 'counter' },
    { match: /coffee/i,         station: 'bar' },
    { match: /^\s*tea\s*$/i,    station: 'bar' },
    { match: /milkshake/i,      station: 'bar' },
    { match: /smoothie/i,       station: 'bar' },
    { match: /cold\s*drink/i,   station: 'bar' },
    { match: /beverage/i,       station: 'bar' },
    { match: /mocktail/i,       station: 'bar' },
    { match: /juice/i,          station: 'bar' },
];

function inferPrepStation({ name, categoryName }) {
    const safeName = String(name || '');

    for (const p of COUNTER_NAME_PATTERNS) if (p.test(safeName)) return 'counter';
    for (const p of BAR_NAME_PATTERNS)     if (p.test(safeName)) return 'bar';

    const cat = String(categoryName || '');
    for (const rule of CATEGORY_RULES)     if (rule.match.test(cat)) return rule.station;

    return 'kitchen';
}

/**
 * Resolve the authoritative prep station for a single order line item.
 * Priority:
 *   1. Admin-set non-default station on the MenuItem (bar/counter)
 *   2. Heuristic inference from name + category
 *   3. Falls back to 'kitchen' (chef workflow)
 *
 * Why "non-default" matters: Mongoose populates the schema default
 * 'kitchen' on every menu item when first read after the field was
 * added, which makes "admin explicitly chose kitchen" indistinguishable
 * from "field has never been touched". Treating the default as a
 * sentinel for "not configured" lets the heuristic upgrade obviously-
 * counter items (water, Red Bull) without a manual menu edit.
 */
function resolveOrderItemStation({ menuItem, fallbackName, fallbackCategory }) {
    const station = menuItem?.prepStation;
    if (station && station !== 'kitchen') return station;

    const inferred = inferPrepStation({
        name: menuItem?.name || fallbackName,
        categoryName: menuItem?.category?.name || fallbackCategory,
    });
    return inferred;
}

module.exports = {
    inferPrepStation,
    resolveOrderItemStation,
};
