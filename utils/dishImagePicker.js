/**
 * dishImagePicker — pick a working Unsplash food photo for a given
 * menu item / combo name.
 *
 * Why this exists:
 *   The CSV master templates point at `source.unsplash.com/featured/?<query>`
 *   which Unsplash retired in mid-2024 — every URL now redirects to the
 *   same generic placeholder photo, so a fresh tenant who bulk-imports
 *   the master menu sees the same "grilled chicken burger" stock photo
 *   on every dish. That looks broken.
 *
 * What this does:
 *   - NAME_MAP: hand-curated `lowercase name → direct images.unsplash.com URL`
 *     mapping for ~190 common cafe / restaurant / hotel dishes. These
 *     URLs are direct CDN paths to specific verified-working photos,
 *     NOT the deprecated source.unsplash.com search endpoint.
 *   - IMAGE_POOL: ~110 keyword-tagged fallback URLs used when a name
 *     isn't in NAME_MAP. The scorer tokenises the item name + its
 *     category and picks the pool entry with the highest tag overlap.
 *   - pickDishImage(name, category) → url string (always returns a
 *     usable URL; falls back to DEFAULT_IMAGE if everything misses).
 *
 * Used by:
 *   - Backend/controllers/menuController.js  (importMenuItemsCsv)
 *   - Backend/controllers/comboController.js (importCombosCsv)
 *   - Backend/Seed/applyMenuImages.js        (one-shot DB migration)
 *
 * Keeping NAME_MAP up-to-date: when you add a new dish, drop a line in
 * NAME_MAP keyed by lowercased name. If you skip it, the keyword
 * scorer still picks the best generic photo — no crash, no missing
 * thumbnail.
 */
'use strict';

// ── Curated keyword-tagged fallback pool ────────────────────────────
// Each entry: { url, tags }. Scoring is overlap of item-name tokens
// (weight 10) plus category tokens (weight 1). Tied scores → first
// match wins, so keep the more-specific entries near the top.
const IMAGE_POOL = [
    // ── Indian mains / gravies ──
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['paneer', 'butter', 'masala', 'curry', 'gravy'] },
    { url: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38', tags: ['dal', 'tadka', 'lentil', 'makhani', 'yellow'] },
    { url: 'https://images.unsplash.com/photo-1574894709920-11b28e7367e3', tags: ['mushroom', 'masala', 'gravy', 'veg'] },
    { url: 'https://images.unsplash.com/photo-1567337710282-00832b415979', tags: ['aloo', 'gobi', 'potato', 'cauliflower', 'sabzi'] },
    { url: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d', tags: ['chana', 'chole', 'chickpea', 'kabuli'] },
    { url: 'https://images.unsplash.com/photo-1626777553635-3d8b06bd56ca', tags: ['rajma', 'kidney', 'beans'] },
    { url: 'https://images.unsplash.com/photo-1574484284002-952d92456975', tags: ['kolhapuri', 'mixed', 'curry'] },
    { url: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0', tags: ['pav', 'bhaji', 'misal', 'mumbai', 'street'] },
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['vada', 'pav'] },
    { url: 'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8', tags: ['bhurji', 'scramble', 'egg', 'paneer'] },
    { url: 'https://images.unsplash.com/photo-1626500155318-d36a1c2da0d4', tags: ['shahi', 'cream', 'rich'] },
    // ── Non-veg mains ──
    { url: 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47', tags: ['butter', 'chicken', 'makhani'] },
    { url: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398', tags: ['chicken', 'curry', 'home', 'style'] },
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['peri', 'grilled', 'chicken'] },
    // ── Tandoor / starters ──
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['tikka', 'kebab', 'kabab', 'tandoor', 'tandoori', 'skewer', 'grilled'] },
    { url: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d', tags: ['tandoori', 'chicken', 'leg'] },
    { url: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46', tags: ['paneer', 'tikka', 'starter'] },
    { url: 'https://images.unsplash.com/photo-1633237308525-cd587cf71926', tags: ['65', 'fried', 'crispy'] },
    { url: 'https://images.unsplash.com/photo-1604908554049-2f6b7ce5e4d2', tags: ['lollipop', 'wing'] },
    { url: 'https://images.unsplash.com/photo-1559847844-1c2d8bd9b8f0', tags: ['fish', 'fingers', 'crumb'] },
    { url: 'https://images.unsplash.com/photo-1571091718767-18b5b1457add', tags: ['fries', 'french', 'chips'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['honey', 'chilli', 'tossed'] },
    { url: 'https://images.unsplash.com/photo-1606490194859-07c18c9f0968', tags: ['onion', 'rings', 'fried'] },
    { url: 'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a', tags: ['tikki', 'patty'] },
    { url: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828', tags: ['samosa', 'pakoda', 'pakora', 'fritter'] },
    { url: 'https://images.unsplash.com/photo-1606852956048-fa11d61a85a8', tags: ['spring', 'rolls', 'crispy'] },
    { url: 'https://images.unsplash.com/photo-1573821663912-6df460f9c684', tags: ['garlic', 'bread', 'toast'] },
    // ── Chaat ──
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['sev', 'puri', 'chaat', 'mumbai'] },
    { url: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46', tags: ['dahi', 'puri', 'yogurt'] },
    // ── South Indian ──
    { url: 'https://images.unsplash.com/photo-1668236543090-82eba5ee5976', tags: ['dosa', 'plain', 'crepe', 'south'] },
    { url: 'https://images.unsplash.com/photo-1610192244261-3f33de3f55e4', tags: ['masala', 'dosa'] },
    { url: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc', tags: ['idli', 'sambar', 'steamed'] },
    { url: 'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a', tags: ['upma', 'semolina'] },
    { url: 'https://images.unsplash.com/photo-1610192244261-3f33de3f55e4', tags: ['uttapam', 'pancake'] },
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['medu', 'vada'] },
    // ── Biryani / Rice ──
    { url: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7', tags: ['biryani', 'chicken', 'rice', 'dum'] },
    { url: 'https://images.unsplash.com/photo-1633237308525-cd587cf71926', tags: ['biryani', 'mutton', 'lamb'] },
    { url: 'https://images.unsplash.com/photo-1596797038530-2c107229654b', tags: ['fried', 'rice', 'schezwan'] },
    { url: 'https://images.unsplash.com/photo-1626500155318-d36a1c2da0d4', tags: ['jeera', 'cumin', 'pulao'] },
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['pulao', 'pilaf'] },
    // ── Breads ──
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['naan', 'butter', 'plain'] },
    { url: 'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a', tags: ['roti', 'tandoori', 'chapati', 'roomali'] },
    { url: 'https://images.unsplash.com/photo-1605195340785-b9e8e85e6ada', tags: ['paratha', 'aloo', 'methi', 'lachha'] },
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['kulcha', 'stuffed'] },
    // ── Desserts ──
    { url: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187', tags: ['gulab', 'jamun', 'rasmalai'] },
    { url: 'https://images.unsplash.com/photo-1567337710282-00832b415979', tags: ['rasgulla', 'bengali'] },
    { url: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c', tags: ['brownie', 'chocolate', 'cake', 'fudge'] },
    { url: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002', tags: ['ice', 'cream', 'kulfi', 'frozen'] },
    { url: 'https://images.unsplash.com/photo-1567171466295-4afa63d45416', tags: ['cheesecake'] },
    { url: 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9', tags: ['tiramisu'] },
    { url: 'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5', tags: ['halwa', 'gajar', 'moong'] },
    // ── Burgers / Sandwiches / Wraps ──
    { url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', tags: ['burger', 'patty', 'bun', 'cheese'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['chicken', 'burger'] },
    { url: 'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9', tags: ['veg', 'burger'] },
    { url: 'https://images.unsplash.com/photo-1528736235302-52922df5c122', tags: ['sandwich', 'grilled', 'bombay', 'club'] },
    { url: 'https://images.unsplash.com/photo-1530469912745-a215c6b256ea', tags: ['shawarma', 'wrap', 'roll', 'kathi'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['caesar', 'wrap'] },
    // ── Pizza ──
    { url: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002', tags: ['margherita', 'pizza'] },
    { url: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38', tags: ['cheese', 'pizza'] },
    { url: 'https://images.unsplash.com/photo-1628840042765-356cda07504e', tags: ['bbq', 'chicken', 'pizza'] },
    { url: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f', tags: ['paneer', 'pizza', 'farmhouse', 'veggie', 'supreme'] },
    // ── Pasta ──
    { url: 'https://images.unsplash.com/photo-1645112411341-6c4fd023714a', tags: ['pasta', 'alfredo', 'white', 'creamy'] },
    { url: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8', tags: ['pasta', 'arrabbiata', 'penne', 'spaghetti', 'red'] },
    { url: 'https://images.unsplash.com/photo-1551183053-bf91a1d81141', tags: ['aglio', 'olio', 'olive'] },
    // ── Chinese ──
    { url: 'https://images.unsplash.com/photo-1585032226651-759b368d7246', tags: ['noodles', 'hakka', 'chowmein', 'schezwan'] },
    { url: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46', tags: ['manchurian', 'gobi'] },
    { url: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46', tags: ['chilli', 'chicken'] },
    { url: 'https://images.unsplash.com/photo-1585032226651-759b368d7246', tags: ['chopsuey', 'american'] },
    // ── Soups ──
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['tomato', 'soup', 'shorba'] },
    { url: 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83', tags: ['mushroom', 'soup', 'cream'] },
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['manchow', 'corn', 'soup'] },
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['chicken', 'soup', 'broth'] },
    // ── Healthy bowls / salad ──
    { url: 'https://images.unsplash.com/photo-1551248429-40975aa4de74', tags: ['caesar', 'salad', 'lettuce'] },
    { url: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd', tags: ['salad', 'veg', 'bowl'] },
    { url: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061', tags: ['buddha', 'quinoa', 'acai', 'berry'] },
    // ── Beverages ──
    { url: 'https://images.unsplash.com/photo-1494314671902-399b18174975', tags: ['black', 'coffee', 'americano', 'espresso'] },
    { url: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d', tags: ['cappuccino', 'latte', 'foam'] },
    { url: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735', tags: ['cold', 'coffee', 'iced', 'frappe'] },
    { url: 'https://images.unsplash.com/photo-1497636577773-f1231844b336', tags: ['filter', 'coffee'] },
    { url: 'https://images.unsplash.com/photo-1571934811356-5cc061b6821f', tags: ['masala', 'chai', 'tea', 'cutting'] },
    { url: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3', tags: ['green', 'tea'] },
    { url: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc', tags: ['black', 'tea', 'lemon'] },
    { url: 'https://images.unsplash.com/photo-1542990253-0d0f5be5f0ed', tags: ['hot', 'chocolate'] },
    { url: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc', tags: ['iced', 'tea', 'lemon'] },
    { url: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699', tags: ['shake', 'milkshake', 'banana', 'chocolate', 'strawberry'] },
    { url: 'https://images.unsplash.com/photo-1605713185862-08f8b35cd141', tags: ['mango', 'shake', 'smoothie'] },
    { url: 'https://images.unsplash.com/photo-1626202378-1ddfe9f78c5d', tags: ['lassi', 'plain', 'sweet', 'salted'] },
    { url: 'https://images.unsplash.com/photo-1571805341302-f857581a1517', tags: ['mango', 'lassi'] },
    { url: 'https://images.unsplash.com/photo-1564631027894-5bdb17613451', tags: ['lime', 'soda', 'fresh'] },
    { url: 'https://images.unsplash.com/photo-1551538827-9c037cb4f32a', tags: ['mojito', 'mocktail', 'lagoon', 'pina', 'colada'] },
    { url: 'https://images.unsplash.com/photo-1547514701-42782101795e', tags: ['watermelon', 'juice'] },
    // ── Eggs ──
    { url: 'https://images.unsplash.com/photo-1525351484163-7529414344d8', tags: ['egg', 'omelette', 'breakfast'] },
    // ── Combos (catch-alls) ──
    { url: 'https://images.unsplash.com/photo-1625938144755-652e08e359b7', tags: ['thali', 'platter', 'feast', 'family'] },
    { url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', tags: ['pizza', 'combo'] },
    { url: 'https://images.unsplash.com/photo-1551782450-a2132b4ba21d', tags: ['burger', 'combo', 'meal', 'kids', 'kiosk'] },
];

const DEFAULT_IMAGE = IMAGE_POOL[0].url;

// ── Hand-curated exact-name overrides ──────────────────────────────
// Wins over keyword scoring whenever the dish name matches exactly.
// Keys are lowercased + space-collapsed.
const NAME_MAP = {
    // Beverages
    'masala chai':            'https://images.unsplash.com/photo-1571934811356-5cc061b6821f?w=800',
    'black coffee':           'https://images.unsplash.com/photo-1494314671902-399b18174975?w=800',
    'black tea':              'https://images.unsplash.com/photo-1597481499750-3e6b22637e12?w=800',
    'green tea':              'https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800',
    'filter coffee':          'https://images.unsplash.com/photo-1497636577773-f1231844b336?w=800',
    'espresso':               'https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?w=800',
    'cappuccino':             'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=800',
    'cold coffee':            'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=800',
    'hot chocolate':          'https://images.unsplash.com/photo-1542990253-0d0f5be5f0ed?w=800',
    'lemon iced tea':         'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=800',
    'fresh lime soda':        'https://images.unsplash.com/photo-1564631027894-5bdb17613451?w=800',
    'plain lassi':            'https://images.unsplash.com/photo-1626202378-1ddfe9f78c5d?w=800',
    'sweet lassi':            'https://images.unsplash.com/photo-1626202378-1ddfe9f78c5d?w=800',
    'salted lassi':           'https://images.unsplash.com/photo-1626202378-1ddfe9f78c5d?w=800',
    'mango lassi':            'https://images.unsplash.com/photo-1571805341302-f857581a1517?w=800',
    'pudina lassi':           'https://images.unsplash.com/photo-1626202378-1ddfe9f78c5d?w=800',
    'banana shake':           'https://images.unsplash.com/photo-1623065422902-30a2d299bbe4?w=800',
    'mango shake':            'https://images.unsplash.com/photo-1605713185862-08f8b35cd141?w=800',
    'chocolate milkshake':    'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=800',
    'strawberry shake':       'https://images.unsplash.com/photo-1553787499-6f9133860278?w=800',
    'mango smoothie':         'https://images.unsplash.com/photo-1505252585461-04db1eb84625?w=800',
    'watermelon juice':       'https://images.unsplash.com/photo-1547514701-42782101795e?w=800',
    'virgin mojito':          'https://images.unsplash.com/photo-1551538827-9c037cb4f32a?w=800',
    'cold drink mocktail':    'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=800',
    'blue lagoon mocktail':   'https://images.unsplash.com/photo-1551538827-9c037cb4f32a?w=800',
    'pina colada mocktail':   'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=800',
    // Breads
    'butter naan':            'https://images.unsplash.com/photo-1626078577006-78f12ce9f3e6?w=800',
    'plain naan':             'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800',
    'naan':                   'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800',
    'cheese naan':            'https://images.unsplash.com/photo-1626078577006-78f12ce9f3e6?w=800',
    'garlic naan':            'https://images.unsplash.com/photo-1626078577006-78f12ce9f3e6?w=800',
    'butter roti':            'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a?w=800',
    'tandoori roti':          'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a?w=800',
    'roomali roti':           'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a?w=800',
    'aloo paratha':           'https://images.unsplash.com/photo-1605195340785-b9e8e85e6ada?w=800',
    'methi paratha':          'https://images.unsplash.com/photo-1605195340785-b9e8e85e6ada?w=800',
    'lachha paratha':         'https://images.unsplash.com/photo-1605195340785-b9e8e85e6ada?w=800',
    'stuffed kulcha':         'https://images.unsplash.com/photo-1626078577006-78f12ce9f3e6?w=800',
    // Burgers + sides
    'cheese burger':          'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800',
    'chicken burger':         'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=800',
    'veg burger':             'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'vegetable burger':       'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'paneer burger':          'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'french fries':           'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=800',
    // Pizza
    'margherita pizza':       'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'classic margherita pizza':'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'cheese pizza':           'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'double cheese pizza':    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'farmhouse pizza':        'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'spicy paneer pizza':     'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=800',
    'bbq chicken pizza':      'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=800',
    'veggie supreme pizza':   'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    // Pasta
    'pasta alfredo':          'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',
    'pasta arrabbiata':       'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800',
    'penne arrabbiata':       'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800',
    'pasta aglio e olio':     'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=800',
    'spaghetti aglio olio':   'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=800',
    'chicken alfredo pasta':  'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',
    'veg pasta in white sauce':'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',
    // Chinese / Indo-Chinese
    'hakka noodles':          'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'veg hakka noodles':      'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'chicken hakka noodles':  'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'schezwan noodles':       'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'chicken manchurian':     'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'veg manchurian dry':     'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'chilli chicken':         'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'schezwan chicken':       'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'american chopsuey':      'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'spring rolls':           'https://images.unsplash.com/photo-1606852956048-fa11d61a85a8?w=800',
    'veg spring rolls':       'https://images.unsplash.com/photo-1606852956048-fa11d61a85a8?w=800',
    'honey chilli potato':    'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=800',
    'veg fried rice':         'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=800',
    'egg fried rice':         'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=800',
    'schezwan fried rice':    'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=800',
    'chicken schezwan rice':  'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=800',
    'veg schezwan rice':      'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=800',
    // Starters
    'paneer tikka':           'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'chicken tikka':          'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'fish tikka':             'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'tandoori mushroom':      'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'tandoori chicken (half)':'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',
    'tandoori chicken (full)':'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',
    'chicken 65':             'https://images.unsplash.com/photo-1633237308525-cd587cf71926?w=800',
    'paneer 65':              'https://images.unsplash.com/photo-1633237308525-cd587cf71926?w=800',
    'chicken lollipop':       'https://images.unsplash.com/photo-1604908554049-2f6b7ce5e4d2?w=800',
    'galouti kebab':          'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'hara bhara kebab':       'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?w=800',
    'aloo tikki':             'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a?w=800',
    'fish fingers':           'https://images.unsplash.com/photo-1559847844-1c2d8bd9b8f0?w=800',
    'cheese garlic bread':    'https://images.unsplash.com/photo-1573821663912-6df460f9c684?w=800',
    'garlic bread':           'https://images.unsplash.com/photo-1573821663912-6df460f9c684?w=800',
    'crispy corn':            'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=800',
    'corn cheese balls':      'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=800',
    'onion rings':            'https://images.unsplash.com/photo-1639024471283-03518883512d?w=800',
    'veg cutlet':             'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a?w=800',
    // Chaat
    'sev puri':               'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'dahi puri':              'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'pav bhaji':              'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',
    'misal pav':              'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',
    'vada pav':               'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    // South Indian
    'dosa (plain)':           'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'masala dosa':            'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'rava dosa':              'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'idli (plain)':           'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',
    'idli sambar':            'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',
    'medu vada':              'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',
    'uttapam':                'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'upma':                   'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a?w=800',
    // Main course
    'butter chicken':         'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800',
    'chicken curry':          'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800',
    'mutton rogan josh':      'https://images.unsplash.com/photo-1604908554049-2f6b7ce5e4d2?w=800',
    'paneer butter masala':   'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800',
    'kadhai paneer':          'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'palak paneer':           'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?w=800',
    'paneer bhurji':          'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?w=800',
    'mushroom masala':        'https://images.unsplash.com/photo-1574894709920-11b28e7367e3?w=800',
    'dal makhani':            'https://images.unsplash.com/photo-1626777553635-3d8b06bd56ca?w=800',
    'yellow dal tadka':       'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'chana masala':           'https://images.unsplash.com/photo-1626777553635-3d8b06bd56ca?w=800',
    'chole bhature':          'https://images.unsplash.com/photo-1626777553635-3d8b06bd56ca?w=800',
    'aloo gobi':              'https://images.unsplash.com/photo-1567337710282-00832b415979?w=800',
    'baingan bharta':         'https://images.unsplash.com/photo-1626777553635-3d8b06bd56ca?w=800',
    'veg kolhapuri':          'https://images.unsplash.com/photo-1574484284002-952d92456975?w=800',
    'egg bhurji':             'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'egg curry':              'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800',
    'peri peri chicken':      'https://images.unsplash.com/photo-1604908554049-2f6b7ce5e4d2?w=800',
    'puri bhaji':             'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800',
    // Rice / Biryani
    'chicken biryani':        'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'mutton biryani':         'https://images.unsplash.com/photo-1633237308525-cd587cf71926?w=800',
    'hyderabadi mutton biryani':'https://images.unsplash.com/photo-1633237308525-cd587cf71926?w=800',
    'paneer biryani':         'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'veg biryani':            'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'veg pulao':              'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800',
    'jeera rice':             'https://images.unsplash.com/photo-1626500155318-d36a1c2da0d4?w=800',
    'lemon rice':             'https://images.unsplash.com/photo-1626500155318-d36a1c2da0d4?w=800',
    'curd rice':              'https://images.unsplash.com/photo-1626500155318-d36a1c2da0d4?w=800',
    'rajma chawal':           'https://images.unsplash.com/photo-1626777553635-3d8b06bd56ca?w=800',
    // Sandwiches / Wraps
    'veg sandwich':           'https://images.unsplash.com/photo-1528736235302-52922df5c122?w=800',
    'vegetable sandwich':     'https://images.unsplash.com/photo-1528736235302-52922df5c122?w=800',
    'veg cheese sandwich':    'https://images.unsplash.com/photo-1528736235302-52922df5c122?w=800',
    'chicken sandwich':       'https://images.unsplash.com/photo-1559054663-e8d23213f55c?w=800',
    'chicken tikka sandwich': 'https://images.unsplash.com/photo-1559054663-e8d23213f55c?w=800',
    'bombay sandwich':        'https://images.unsplash.com/photo-1528736235302-52922df5c122?w=800',
    'bombay grilled sandwich':'https://images.unsplash.com/photo-1528736235302-52922df5c122?w=800',
    'chicken shawarma':       'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'chicken caesar wrap':    'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'chicken frankie':        'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'paneer wrap':            'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'paneer kathi roll':      'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'veg kathi roll':         'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    // Soups
    'tomato soup':            'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'tomato shorba':          'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'sweet corn soup':        'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'cream of mushroom soup': 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=800',
    'chicken soup':           'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'veg manchow soup':       'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'mixed veg soup':         'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    // Healthy bowls
    'caesar salad':           'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=800',
    'veg salad':              'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800',
    'buddha bowl':            'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800',
    'quinoa bowl':            'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800',
    'acai berry bowl':        'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800',
    // Desserts
    'gulab jamun':            'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'rasgulla':               'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'rasmalai':               'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'gajar halwa':            'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'moong dal halwa':        'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'kulfi falooda':          'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'chocolate brownie':      'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=800',
    'cheesecake':             'https://images.unsplash.com/photo-1567171466295-4afa63d45416?w=800',
    'tiramisu':               'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=800',
    // Combos
    'veg thali mini':             'https://images.unsplash.com/photo-1625938144755-652e08e359b7?w=800',
    'veg thali special':          'https://images.unsplash.com/photo-1625938144755-652e08e359b7?w=800',
    'non-veg thali':              'https://images.unsplash.com/photo-1567337710282-00832b415979?w=800',
    'family veg feast':           'https://images.unsplash.com/photo-1625938144755-652e08e359b7?w=800',
    'family non-veg feast':       'https://images.unsplash.com/photo-1567337710282-00832b415979?w=800',
    'party combo for 4':          'https://images.unsplash.com/photo-1567337710282-00832b415979?w=800',
    'paneer lovers combo':        'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'chicken lover feast':        'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',
    'chicken biryani combo':      'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'mutton biryani combo':       'https://images.unsplash.com/photo-1633237308525-cd587cf71926?w=800',
    'veg biryani combo':          'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'pizza & drink combo':        'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'margherita lovers combo':    'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'burger meal veg':            'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'burger meal non-veg':        'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800',
    'kiosk quick bite veg':       'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'kiosk quick bite non-veg':   'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800',
    'indo-chinese combo veg':     'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'indo-chinese combo non-veg': 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'pasta combo':                'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',
    'south indian combo':         'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'mumbai street combo':        'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'chaat combo':                'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'veg wrap & drink':           'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'chicken wrap & drink':       'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'healthy bowl combo':         'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=800',
    'healthy power bowl':         'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=800',
    'soup & sandwich combo':      'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'soup & salad light combo':   'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'coffee & brownie combo':     'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=800',
    'tea time combo':             'https://images.unsplash.com/photo-1571934811356-5cc061b6821f?w=800',
    'continental breakfast combo':'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'egg breakfast combo':        'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'weekend brunch veg':         'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'weekend brunch non-veg':     'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'breakfast bonanza veg':      'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',
    'sunday special veg':         'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'sunday special non-veg':     'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',
    'kids veg combo':             'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'kids non-veg combo':         'https://images.unsplash.com/photo-1604908554049-2f6b7ce5e4d2?w=800',
};

function normaliseKey(name) {
    return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function tokensOf(str) {
    if (!str || typeof str !== 'string') return [];
    return str
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter(Boolean);
}

/**
 * Pick a working food photo for the given dish name.
 *
 * @param {string} name           dish / combo name (e.g. "Chicken 65")
 * @param {string} [categoryName] optional category (e.g. "Starters") used as a
 *                                weak tie-breaker by the keyword scorer
 * @returns {string}              an https URL to a working Unsplash photo
 */
function pickDishImage(name, categoryName) {
    const key = normaliseKey(name);
    if (NAME_MAP[key]) return NAME_MAP[key];

    const nameTokens = new Set(tokensOf(name));
    const catTokens = new Set(tokensOf(categoryName));

    let best = null;
    let bestScore = 0;
    for (const entry of IMAGE_POOL) {
        let score = 0;
        for (const t of entry.tags) {
            if (nameTokens.has(t))     score += 10;
            else if (catTokens.has(t)) score += 1;
        }
        if (score > bestScore) {
            best = entry;
            bestScore = score;
        }
    }
    return best ? best.url : DEFAULT_IMAGE;
}

// Patterns we treat as "no real photo" — used by callers that want to
// decide whether to overwrite an existing image or leave it alone.
const DEAD_IMAGE_PATTERNS = [
    /^https?:\/\/images\.unsplash\.com\/photo-(1567620905732-2d1ec7bb7445|1484723088339-323833995221)/i,
    /^https?:\/\/(?:[a-z0-9-]+\.)?picsum\.photos\//i,
    /^https?:\/\/source\.unsplash\.com\//i,
];

function isDeadImage(url) {
    if (!url || typeof url !== 'string') return true;
    return DEAD_IMAGE_PATTERNS.some(re => re.test(url));
}

module.exports = {
    pickDishImage,
    isDeadImage,
    DEAD_IMAGE_PATTERNS,
    DEFAULT_IMAGE,
};
