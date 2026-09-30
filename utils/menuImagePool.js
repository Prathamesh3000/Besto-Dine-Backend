// Shared curated menu/combo image data + scorer.
//
// Single source of truth for "what photo should a dish show". Both the
// manual Seed/applyMenuImages.js refresh and the scheduled
// menuItemImageHealer.js import from here, so the curated pool and the
// exact-name maps only ever live in one place.
//
// Adding a new dish image:
//   - Best accuracy: drop an entry in NAME_MAP / COMBO_NAME_MAP (keyed
//     by lowercased, whitespace-collapsed name).
//   - Otherwise append to IMAGE_POOL with a few lowercase keyword tags;
//     the scorer tokenises the item name + category and counts overlaps.
//   DO NOT remove old pool entries — legacy items still score against them.

// Curated, verified-working Unsplash food photos. Keyword overlap drives
// selection when no exact NAME_MAP entry exists.
const IMAGE_POOL = [
    // ── Indian mains / gravies ──────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['paneer', 'butter', 'masala', 'curry', 'gravy', 'tikka'] },
    { url: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38', tags: ['dal', 'tadka', 'lentil', 'makhani', 'yellow', 'fry'] },
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['kadhai', 'paneer', 'kadai'] },
    { url: 'https://images.unsplash.com/photo-1574894709920-11b28e7367e3', tags: ['mushroom', 'masala', 'gravy', 'veg'] },
    { url: 'https://images.unsplash.com/photo-1567337710282-00832b415979', tags: ['aloo', 'gobi', 'potato', 'cauliflower', 'sabzi', 'sabji'] },
    { url: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d', tags: ['chana', 'chole', 'chickpea', 'kabuli', 'masala'] },
    { url: 'https://images.unsplash.com/photo-1626777553635-3d8b06bd56ca', tags: ['rajma', 'kidney', 'beans', 'chawal'] },
    { url: 'https://images.unsplash.com/photo-1574484284002-952d92456975', tags: ['kolhapuri', 'mixed', 'veg', 'vegetable', 'curry'] },
    { url: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0', tags: ['pav', 'bhaji', 'misal', 'mumbai', 'street'] },
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['vada', 'pav', 'mumbai', 'fritter'] },
    { url: 'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8', tags: ['bhurji', 'scramble', 'egg', 'paneer'] },
    { url: 'https://images.unsplash.com/photo-1626500155318-d36a1c2da0d4', tags: ['shahi', 'paneer', 'cream', 'gravy', 'rich'] },

    // ── Non-veg mains ───────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47', tags: ['butter', 'chicken', 'makhani', 'gravy', 'curry'] },
    { url: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398', tags: ['chicken', 'curry', 'home', 'style'] },
    { url: 'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8', tags: ['egg', 'curry', 'masala', 'gravy'] },
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['peri', 'peri', 'grilled', 'chicken'] },

    // ── Tandoor / starters ──────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['tikka', 'kebab', 'kabab', 'tandoor', 'tandoori', 'skewer', 'grilled'] },
    { url: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d', tags: ['tandoori', 'chicken', 'leg', 'half', 'full'] },
    { url: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46', tags: ['paneer', 'tikka', 'starter', 'grill'] },
    { url: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0', tags: ['chicken', '65', 'fried', 'spicy', 'starter'] },
    { url: 'https://images.unsplash.com/photo-1604908554049-2f6b7ce5e4d2', tags: ['chicken', 'lollipop', 'wing'] },
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['fish', 'tikka', 'marinade'] },
    { url: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828', tags: ['hara', 'bhara', 'kebab', 'spinach'] },
    { url: 'https://images.unsplash.com/photo-1559847844-1c2d8bd9b8f0', tags: ['fish', 'fingers', 'fried', 'crumb'] },
    { url: 'https://images.unsplash.com/photo-1633237308525-cd587cf71926', tags: ['65', 'fried', 'crispy'] },
    { url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', tags: ['cheese', 'garlic', 'bread', 'toast'] },
    { url: 'https://images.unsplash.com/photo-1571091718767-18b5b1457add', tags: ['fries', 'french', 'fried', 'potato', 'chips'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['honey', 'chilli', 'potato', 'tossed'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['crispy', 'corn', 'sweet'] },
    { url: 'https://images.unsplash.com/photo-1606490194859-07c18c9f0968', tags: ['onion', 'rings', 'fried'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['veg', 'cutlet', 'patty'] },
    { url: 'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a', tags: ['aloo', 'tikki', 'patty', 'potato'] },
    { url: 'https://images.unsplash.com/photo-1565299507177-b0ac66763828', tags: ['samosa', 'pakoda', 'pakora', 'fritter'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['spring', 'rolls', 'crispy'] },
    { url: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46', tags: ['manchurian', 'dry'] },
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['chopsuey', 'american'] },

    // ── Chaat ───────────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['sev', 'puri', 'chaat', 'mumbai'] },
    { url: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46', tags: ['dahi', 'puri', 'chaat', 'yogurt'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['pani', 'puri', 'gol', 'gappa'] },

    // ── South Indian ────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1668236543090-82eba5ee5976', tags: ['dosa', 'plain', 'crepe', 'south'] },
    { url: 'https://images.unsplash.com/photo-1610192244261-3f33de3f55e4', tags: ['masala', 'dosa', 'crepe', 'south'] },
    { url: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc', tags: ['idli', 'sambar', 'steamed', 'south', 'rice'] },
    { url: 'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a', tags: ['upma', 'semolina', 'breakfast'] },
    { url: 'https://images.unsplash.com/photo-1610192244261-3f33de3f55e4', tags: ['uttapam', 'south', 'pancake'] },
    { url: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84', tags: ['vada', 'medu', 'south'] },

    // ── Biryani / Rice ──────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7', tags: ['biryani', 'chicken', 'rice', 'dum'] },
    { url: 'https://images.unsplash.com/photo-1633237308525-cd587cf71926', tags: ['biryani', 'mutton', 'lamb', 'rice'] },
    { url: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0', tags: ['biryani', 'veg', 'paneer', 'rice'] },
    { url: 'https://images.unsplash.com/photo-1596797038530-2c107229654b', tags: ['fried', 'rice', 'schezwan'] },
    { url: 'https://images.unsplash.com/photo-1626500155318-d36a1c2da0d4', tags: ['jeera', 'rice', 'cumin', 'pulao'] },
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['pulao', 'pilaf', 'rice'] },
    { url: 'https://images.unsplash.com/photo-1574894709920-11b28e7367e3', tags: ['chawal', 'rajma'] },

    // ── Breads ──────────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['naan', 'butter', 'plain', 'cheese', 'garlic'] },
    { url: 'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a', tags: ['roti', 'tandoori', 'chapati'] },
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['paratha', 'aloo', 'methi', 'stuffed'] },
    { url: 'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a', tags: ['roomali', 'roti', 'thin'] },
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['kulcha', 'amritsari'] },
    { url: 'https://images.unsplash.com/photo-1601050690597-df0568f70950', tags: ['puri', 'bhaji', 'fried', 'bread'] },

    // ── Desserts ────────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187', tags: ['gulab', 'jamun', 'sweet'] },
    { url: 'https://images.unsplash.com/photo-1567337710282-00832b415979', tags: ['rasgulla', 'bengali', 'sweet'] },
    { url: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187', tags: ['rasmalai', 'milk', 'sweet'] },
    { url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c', tags: ['brownie', 'chocolate', 'cake', 'fudge'] },
    { url: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002', tags: ['ice', 'cream', 'kulfi', 'frozen'] },
    { url: 'https://images.unsplash.com/photo-1551024506-0bccd828d307', tags: ['mousse', 'pudding', 'dessert'] },
    { url: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187', tags: ['kheer', 'phirni', 'milk', 'rice'] },

    // ── Burgers / sandwiches / wraps ────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1551782450-a2132b4ba21d', tags: ['burger', 'patty', 'bun', 'cheese'] },
    { url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', tags: ['sandwich', 'grilled', 'cheese', 'bread', 'bombay', 'club'] },
    { url: 'https://images.unsplash.com/photo-1576091160550-2173dba999ef', tags: ['shawarma', 'wrap', 'roll'] },
    { url: 'https://images.unsplash.com/photo-1593504049359-74330189a345', tags: ['kathi', 'roll', 'wrap'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['caesar', 'wrap', 'tortilla'] },

    // ── Pizza ───────────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', tags: ['pizza', 'margherita', 'cheese', 'italian', 'pepperoni'] },
    { url: 'https://images.unsplash.com/photo-1604068549290-dea0e4a305ca', tags: ['pizza', 'paneer', 'farmhouse', 'veggie'] },

    // ── Pasta ───────────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['pasta', 'alfredo', 'white', 'creamy'] },
    { url: 'https://images.unsplash.com/photo-1473093226795-af9932fe5856', tags: ['pasta', 'arrabbiata', 'spaghetti', 'red', 'tomato'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['pasta', 'aglio', 'olio', 'olive'] },

    // ── Chinese ─────────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1626804475297-41608ea09aeb', tags: ['noodles', 'hakka', 'chowmein', 'schezwan'] },
    { url: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b', tags: ['manchurian', 'gobi', 'chicken'] },
    { url: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0', tags: ['schezwan', 'chicken', 'rice', 'spicy'] },

    // ── Soups ───────────────────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['tomato', 'soup', 'cream'] },
    { url: 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83', tags: ['mushroom', 'soup', 'cream'] },
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['manchow', 'sweet', 'corn', 'soup', 'spicy'] },
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['chicken', 'soup', 'clear', 'broth'] },
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['veg', 'soup', 'mixed', 'clear'] },

    // ── Healthy bowls / salad ───────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d', tags: ['caesar', 'salad', 'bowl', 'healthy', 'lettuce'] },
    { url: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061', tags: ['greek', 'mediterranean', 'salad', 'bowl'] },
    { url: 'https://images.unsplash.com/photo-1551248429-40975aa4de74', tags: ['power', 'protein', 'bowl', 'quinoa'] },

    // ── Beverages — coffee / tea ────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1534778101976-62847782c213', tags: ['coffee', 'espresso', 'black', 'americano'] },
    { url: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d', tags: ['cappuccino', 'latte', 'foam'] },
    { url: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c', tags: ['cold', 'coffee', 'iced', 'frappe'] },
    { url: 'https://images.unsplash.com/photo-1571934811356-5cc061b6821f', tags: ['masala', 'chai', 'tea', 'cutting'] },
    { url: 'https://images.unsplash.com/photo-1597481499750-3e6b22637e12', tags: ['green', 'tea', 'matcha'] },
    { url: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc', tags: ['black', 'tea', 'lemon'] },
    { url: 'https://images.unsplash.com/photo-1497935586351-b67a49e012bf', tags: ['hot', 'chocolate'] },
    { url: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c', tags: ['iced', 'tea', 'lemon'] },

    // ── Beverages — shakes / juices / mocktails ─────────────────────
    { url: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699', tags: ['mango', 'shake', 'milkshake'] },
    { url: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699', tags: ['banana', 'shake'] },
    { url: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699', tags: ['strawberry', 'shake'] },
    { url: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699', tags: ['chocolate', 'shake', 'milkshake'] },
    { url: 'https://images.unsplash.com/photo-1542444459-db63c7e3f43e', tags: ['lassi', 'sweet', 'plain', 'yogurt'] },
    { url: 'https://images.unsplash.com/photo-1542444459-db63c7e3f43e', tags: ['mango', 'lassi'] },
    { url: 'https://images.unsplash.com/photo-1542444459-db63c7e3f43e', tags: ['pudina', 'mint', 'lassi'] },
    { url: 'https://images.unsplash.com/photo-1437418747212-8d9709afab22', tags: ['lemon', 'soda', 'lime', 'fresh'] },
    { url: 'https://images.unsplash.com/photo-1437418747212-8d9709afab22', tags: ['mocktail', 'cooler', 'mojito'] },
    { url: 'https://images.unsplash.com/photo-1437418747212-8d9709afab22', tags: ['orange', 'pineapple', 'juice'] },
    { url: 'https://images.unsplash.com/photo-1437418747212-8d9709afab22', tags: ['water', 'mineral', 'bottle'] },
    { url: 'https://images.unsplash.com/photo-1437418747212-8d9709afab22', tags: ['coke', 'cola', 'pepsi', 'sprite', 'fanta', 'thums'] },
    { url: 'https://images.unsplash.com/photo-1497534446932-c925b458314e', tags: ['nimbu', 'pani', 'shikanji'] },

    // ── Eggs / breakfast specials ───────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1525351484163-7529414344d8', tags: ['egg', 'omelette', 'bhurji', 'breakfast'] },

    // ── Combos (catch-alls) ─────────────────────────────────────────
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['thali', 'combo', 'platter', 'family', 'feast'] },
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['veg', 'thali', 'mini', 'special'] },
    { url: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7', tags: ['biryani', 'combo'] },
    { url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', tags: ['pizza', 'combo', 'drink'] },
    { url: 'https://images.unsplash.com/photo-1551782450-a2132b4ba21d', tags: ['burger', 'meal', 'combo', 'kids', 'kiosk'] },
    { url: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086', tags: ['kathi', 'wrap', 'combo'] },
    { url: 'https://images.unsplash.com/photo-1547592180-85f173990554', tags: ['soup', 'sandwich', 'combo'] },
    { url: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d', tags: ['healthy', 'bowl', 'combo'] },
    { url: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641', tags: ['brunch', 'weekend'] },
];

// Generic fallback for items whose name + category produce no keyword overlap.
const DEFAULT_IMAGE = IMAGE_POOL[0].url;

// Exact-name override map — keyword scoring can't tell "Paneer Tikka"
// from "Paneer 65". Keys are LOWERCASED, whitespace-collapsed names.
const NAME_MAP = {
    // ── Beverages ────────────────────────────────────────────────────
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

    // ── Breads ────────────────────────────────────────────────────────
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

    // ── Burgers ───────────────────────────────────────────────────────
    'cheese burger':          'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800',
    'chicken burger':         'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=800',
    'veg burger':             'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'vegetable burger':       'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'paneer burger':          'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'french fries':           'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=800',

    // ── Pizza ─────────────────────────────────────────────────────────
    'margherita pizza':       'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'classic margherita pizza':'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'cheese pizza':           'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'double cheese pizza':    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'farmhouse pizza':        'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',
    'spicy paneer pizza':     'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=800',
    'bbq chicken pizza':      'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=800',
    'veggie supreme pizza':   'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',

    // ── Pasta ─────────────────────────────────────────────────────────
    'pasta alfredo':          'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',
    'pasta arrabbiata':       'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800',
    'penne arrabbiata':       'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800',
    'pasta aglio e olio':     'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=800',
    'spaghetti aglio olio':   'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=800',
    'chicken alfredo pasta':  'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',
    'veg pasta in white sauce':'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',

    // ── Chinese / Indo-Chinese ───────────────────────────────────────
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

    // ── Starters ──────────────────────────────────────────────────────
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

    // ── Chaat ─────────────────────────────────────────────────────────
    'sev puri':               'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'dahi puri':              'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'pav bhaji':              'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'misal pav':              'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'vada pav':               'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',

    // ── South Indian ──────────────────────────────────────────────────
    'dosa (plain)':           'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'masala dosa':            'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'rava dosa':              'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'idli (plain)':           'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',
    'idli sambar':            'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',
    'medu vada':              'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',
    'uttapam':                'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'upma':                   'https://images.unsplash.com/photo-1626776876729-bab4369a5a5a?w=800',

    // ── Main Course (Indian) ──────────────────────────────────────────
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

    // ── Rice / Biryani ────────────────────────────────────────────────
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

    // ── Sandwiches / Wraps ────────────────────────────────────────────
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

    // ── Soups ─────────────────────────────────────────────────────────
    'tomato soup':            'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'tomato shorba':          'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'sweet corn soup':        'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'cream of mushroom soup': 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=800',
    'chicken soup':           'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'veg manchow soup':       'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'mixed veg soup':         'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',

    // ── Healthy Bowls / Salads ────────────────────────────────────────
    'caesar salad':           'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=800',
    'veg salad':              'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800',
    'buddha bowl':            'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800',
    'quinoa bowl':            'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800',
    'acai berry bowl':        'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800',

    // ── Desserts ──────────────────────────────────────────────────────
    'gulab jamun':            'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'rasgulla':               'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'rasmalai':               'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'gajar halwa':            'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'moong dal halwa':        'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'kulfi falooda':          'https://images.unsplash.com/photo-1601303437019-7c89ffe04ed5?w=800',
    'chocolate brownie':      'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=800',
    'cheesecake':             'https://images.unsplash.com/photo-1567171466295-4afa63d45416?w=800',
    'tiramisu':               'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=800',
};

// Combo exact-name overrides — keyword scoring collapses every combo to
// the same "platter" fallback otherwise. Keys lowercased + space-collapsed.
const COMBO_NAME_MAP = {
    // ── Thalis / Family Feasts ────────────────────────────────────────
    'veg thali mini':             'https://images.unsplash.com/photo-1625938144755-652e08e359b7?w=800',
    'veg thali special':          'https://images.unsplash.com/photo-1625938144755-652e08e359b7?w=800',
    'non-veg thali':              'https://images.unsplash.com/photo-1567337710282-00832b415979?w=800',
    'family veg feast':           'https://images.unsplash.com/photo-1625938144755-652e08e359b7?w=800',
    'family non-veg feast':       'https://images.unsplash.com/photo-1567337710282-00832b415979?w=800',
    'party combo for 4':          'https://images.unsplash.com/photo-1567337710282-00832b415979?w=800',
    'paneer lovers combo':        'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800',
    'chicken lover feast':        'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',

    // ── Biryani Combos ────────────────────────────────────────────────
    'chicken biryani combo':      'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'mutton biryani combo':       'https://images.unsplash.com/photo-1633237308525-cd587cf71926?w=800',
    'veg biryani combo':          'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',

    // ── Sunday Specials ──────────────────────────────────────────────
    'sunday special veg':         'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800',
    'sunday special non-veg':     'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?w=800',

    // ── Pizza Combos ──────────────────────────────────────────────────
    'pizza & drink combo':        'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'margherita lovers combo':    'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800',
    'kids veg combo':             'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800',

    // ── Burger Combos ─────────────────────────────────────────────────
    'burger meal veg':            'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'burger meal non-veg':        'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800',
    'kiosk quick bite veg':       'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=800',
    'kiosk quick bite non-veg':   'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800',
    'kids non-veg combo':         'https://images.unsplash.com/photo-1604908554049-2f6b7ce5e4d2?w=800',

    // ── Indo-Chinese ──────────────────────────────────────────────────
    'indo-chinese combo veg':     'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',
    'indo-chinese combo non-veg': 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=800',

    // ── Pasta ─────────────────────────────────────────────────────────
    'pasta combo':                'https://images.unsplash.com/photo-1645112411341-6c4fd023714a?w=800',

    // ── South Indian ──────────────────────────────────────────────────
    'south indian combo':         'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800',
    'breakfast bonanza veg':      'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800',

    // ── Breakfast / Brunch ────────────────────────────────────────────
    'continental breakfast combo':'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'egg breakfast combo':        'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'weekend brunch veg':         'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',
    'weekend brunch non-veg':     'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800',

    // ── Street Food / Chaat ───────────────────────────────────────────
    'mumbai street combo':        'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',
    'chaat combo':                'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800',

    // ── Wraps ─────────────────────────────────────────────────────────
    'veg wrap & drink':           'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',
    'chicken wrap & drink':       'https://images.unsplash.com/photo-1530469912745-a215c6b256ea?w=800',

    // ── Healthy Bowls / Soup-Salad ───────────────────────────────────
    'healthy bowl combo':         'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=800',
    'healthy power bowl':         'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=800',
    'soup & sandwich combo':      'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',
    'soup & salad light combo':   'https://images.unsplash.com/photo-1547592180-85f173990554?w=800',

    // ── Beverage / Snack Combos ──────────────────────────────────────
    'coffee & brownie combo':     'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=800',
    'tea time combo':             'https://images.unsplash.com/photo-1571934811356-5cc061b6821f?w=800',
};

// Normalise a name for map lookup: lowercase, collapse whitespace.
function normaliseNameKey(name) {
    return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Tokenise a string into lowercase word tokens.
function tokensOf(str) {
    if (!str || typeof str !== 'string') return [];
    return str.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

// Score every pool entry against an item's tokens, returning pool entries
// sorted best-first. Name matches weigh far more than category matches.
function scorePool(item) {
    const nameTokens = new Set(tokensOf(item.name));
    const categoryTokens = new Set([
        ...tokensOf(item?.category?.name),
        ...tokensOf(item.vegType),
    ]);
    return IMAGE_POOL
        .map((entry) => {
            let score = 0;
            for (const t of entry.tags) {
                if (nameTokens.has(t)) score += 10;
                else if (categoryTokens.has(t)) score += 1;
            }
            return { url: entry.url, score };
        })
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score);
}

// Single best image for a menu item (exact-name map first, then keyword
// scoring, then the generic default). Backward-compatible with the
// original applyMenuImages.pickImage().
function pickImage(item) {
    const key = normaliseNameKey(item.name);
    if (NAME_MAP[key]) return NAME_MAP[key];
    const scored = scorePool(item);
    return scored.length ? scored[0].url : DEFAULT_IMAGE;
}

// Ordered list of candidate URLs for a menu item, best-first, ending with
// the default. The healer HEAD-verifies each in turn and writes the first
// that's alive — so a dead exact-name match degrades gracefully to the
// next-best keyword candidate instead of writing a broken URL.
function pickImageCandidates(item) {
    const key = normaliseNameKey(item.name);
    const out = [];
    if (NAME_MAP[key]) out.push(NAME_MAP[key]);
    for (const { url } of scorePool(item)) if (!out.includes(url)) out.push(url);
    if (!out.includes(DEFAULT_IMAGE)) out.push(DEFAULT_IMAGE);
    return out;
}

// Ordered candidate URLs for a combo. Exact combo-name map first, then a
// synthetic-item keyword pass (combos have no populated category, so we
// seed common combo vocabulary), then the default.
function pickComboCandidates(combo) {
    const key = normaliseNameKey(combo.name);
    const out = [];
    if (COMBO_NAME_MAP[key]) out.push(COMBO_NAME_MAP[key]);
    const synthetic = { name: combo.name, category: { name: 'combo platter meal feast' }, vegType: combo.vegType };
    for (const { url } of scorePool(synthetic)) if (!out.includes(url)) out.push(url);
    if (!out.includes(DEFAULT_IMAGE)) out.push(DEFAULT_IMAGE);
    return out;
}

module.exports = {
    IMAGE_POOL,
    NAME_MAP,
    COMBO_NAME_MAP,
    DEFAULT_IMAGE,
    normaliseNameKey,
    tokensOf,
    pickImage,
    pickImageCandidates,
    pickComboCandidates,
};
