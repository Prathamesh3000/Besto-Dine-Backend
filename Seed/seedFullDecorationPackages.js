/**
 * seedFullDecorationPackages.js
 *
 * Seeds 10 most-common decoration packages an Indian banquet / event
 * venue offers, covering every typical event bucket:
 *   - Birthday (boy / girl / cartoon)
 *   - Wedding floral mandap
 *   - Engagement cocktail
 *   - Anniversary romantic
 *   - Mehendi / sangeet pre-wedding
 *   - Baby shower
 *   - Corporate backdrop
 *   - Festive Diwali / new year
 *
 * Each package is fully populated — pricing, theme colours, suitable
 * spaces, items / quantities, materials, addons, restrictions, vendor
 * details and a public Unsplash hero image — so the card and detail
 * panel are meaningful out of the box.
 *
 * Idempotent — matches by (restaurant, name) and skips anything
 * already present, so re-running after admin tweaks never overwrites.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullDecorationPackages.js
 *   TENANT_SLUG=<slug> node Seed/seedFullDecorationPackages.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const DecorationPackage = require('../models/decorationPackage');

const VENDOR = {
    vendorName: 'Hotel Tip Top — In-house Decor Team',
    vendorEmail: 'decor@hoteltiptop.in',
    vendorPhone: '+91 9876543210',
    vendorRating: 4.7,
};

// Helper — wraps {name, quantity, unit} so the categories[].items
// sub-document literal stays compact at call sites.
const it = (name, quantity, unit) => ({ name, quantity, unit });

// ─────────────────────────────────────────────────────────────────────────────
// 10 most-common decoration packages
// ─────────────────────────────────────────────────────────────────────────────
const PACKAGES = [
    {
        name: 'Birthday Theme — Pastel Boy',
        category: 'Birthday',
        description: 'Pastel-blue balloon arch, foil number balloons, tassel garlands and a backdrop wall — perfect for boys aged 1 to 12.',
        themeStyle: 'Pastel Balloon Arch',
        primaryColor: '#7DD3FC',
        secondaryColor: '#FFFFFF',
        accentColor: '#1E3A8A',
        suitableFor: { Indoor: true, Hall: true, Restaurant: true },
        minArea: 100,
        maxArea: 600,
        ceilingHeight: 10,
        searchTags: ['Birthday', 'Boy', 'Pastel', 'Balloon Arch'],
        isFeatured: true,
        isPopular: true,
        tag: 'Popular',
        tagColor: 'bg-blue-100 text-blue-700',
        teamSize: '3 - 4 Team',
        categories: [
            {
                name: 'Balloons',
                items: [
                    it('Pastel Blue Latex Balloons', 100, 'pcs'),
                    it('White Latex Balloons', 60, 'pcs'),
                    it('Foil Number Balloon (age)', 1, 'pcs'),
                    it('Confetti Balloons', 20, 'pcs'),
                ],
            },
            {
                name: 'Backdrop',
                items: [
                    it('Pastel Backdrop Cloth (8x6 ft)', 1, 'pcs'),
                    it('Tassel Garland (silver / blue)', 4, 'pcs'),
                    it('Happy Birthday Banner', 1, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Latex', 'Foil', 'Cloth Backdrop', 'Paper Tassels'],
        setupTime: '2 hours',
        advanceBookingDays: 2,
        technicalSupport: false,
        onSiteSupervision: true,
        numberOfCaretakers: 2,
        basePrice: 4999,
        setupCharges: 500,
        dismantlingCharges: 300,
        transportCharges: 500,
        isCustomizable: true,
        allowCustomization: true,
        bestFor: ['Birthday Party', 'Naming Ceremony'],
        notRecommendedFor: ['Wedding Reception'],
        simultaneousBookings: 3,
        clientNotes: 'Number balloon (age) is included — please share the age at booking confirmation.',
        addons: [
            {
                name: 'Helium Tank Refill',
                description: 'Extra helium for floating foil balloons — enough for 30 balloons',
                basePrice: 1500,
                count: '1 tank',
                deliverables: ['Tank', 'Nozzle', 'Disposable inflator'],
            },
            {
                name: 'Custom Name Banner',
                description: 'Personalised "Happy Birthday <Name>" cloth banner',
                basePrice: 600,
                count: '1 banner',
                deliverables: ['Cloth banner (4x2 ft)', 'Hooks'],
            },
            {
                name: 'Photo Booth Props',
                description: 'Pack of 12 themed photo-booth props (hats, glasses, cutout speech bubbles)',
                basePrice: 800,
                count: '1 pack',
                deliverables: ['12 props', 'Carry stand'],
            },
        ],
        restrictions: {
            indoorOnly: true,
            notSuitableForKids: false,
        },
        images: [
            'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Birthday Theme — Pastel Girl',
        category: 'Birthday',
        description: 'Pastel-pink balloon arch, rose-gold confetti balloons, fairy lights and a backdrop wall — perfect for girls aged 1 to 12.',
        themeStyle: 'Pastel Balloon Arch',
        primaryColor: '#F9A8D4',
        secondaryColor: '#FFFFFF',
        accentColor: '#BE185D',
        suitableFor: { Indoor: true, Hall: true, Restaurant: true },
        minArea: 100,
        maxArea: 600,
        ceilingHeight: 10,
        searchTags: ['Birthday', 'Girl', 'Pastel', 'Pink', 'Balloon Arch'],
        isFeatured: true,
        isPopular: true,
        tag: 'Popular',
        tagColor: 'bg-pink-100 text-pink-700',
        teamSize: '3 - 4 Team',
        categories: [
            {
                name: 'Balloons',
                items: [
                    it('Pastel Pink Latex Balloons', 100, 'pcs'),
                    it('White Latex Balloons', 60, 'pcs'),
                    it('Foil Number Balloon (age)', 1, 'pcs'),
                    it('Rose Gold Confetti Balloons', 20, 'pcs'),
                ],
            },
            {
                name: 'Lighting',
                items: [
                    it('Fairy Lights (Warm White)', 4, 'strings'),
                ],
            },
            {
                name: 'Backdrop',
                items: [
                    it('Pastel Pink Backdrop Cloth (8x6 ft)', 1, 'pcs'),
                    it('Tassel Garland (rose gold / pink)', 4, 'pcs'),
                    it('Happy Birthday Banner', 1, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Latex', 'Foil', 'Cloth Backdrop', 'Fairy Lights'],
        setupTime: '2 hours',
        advanceBookingDays: 2,
        technicalSupport: false,
        onSiteSupervision: true,
        numberOfCaretakers: 2,
        basePrice: 4999,
        setupCharges: 500,
        dismantlingCharges: 300,
        transportCharges: 500,
        isCustomizable: true,
        allowCustomization: true,
        bestFor: ['Birthday Party', 'Baby Shower', 'Naming Ceremony'],
        notRecommendedFor: ['Wedding Reception'],
        simultaneousBookings: 3,
        clientNotes: 'Number balloon (age) is included — please share the age at booking confirmation.',
        addons: [
            {
                name: 'Helium Tank Refill',
                description: 'Extra helium for floating foil balloons — enough for 30 balloons',
                basePrice: 1500,
                count: '1 tank',
                deliverables: ['Tank', 'Nozzle', 'Disposable inflator'],
            },
            {
                name: 'Custom Name Banner',
                description: 'Personalised "Happy Birthday <Name>" cloth banner',
                basePrice: 600,
                count: '1 banner',
                deliverables: ['Cloth banner (4x2 ft)', 'Hooks'],
            },
            {
                name: 'Tiara + Sash Set',
                description: 'Birthday-girl tiara and "Birthday Princess" sash',
                basePrice: 500,
                count: '1 set',
                deliverables: ['Tiara', 'Sash'],
            },
        ],
        restrictions: {
            indoorOnly: true,
        },
        images: [
            'https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Cartoon Birthday Theme',
        category: 'Birthday',
        description: 'Theme-character balloon decor (Mickey, Frozen, Spiderman, Doraemon — choose at booking) with cutouts, foil curtains and a photo wall.',
        themeStyle: 'Cartoon Theme',
        primaryColor: '#FB7185',
        secondaryColor: '#FACC15',
        accentColor: '#1F2937',
        suitableFor: { Indoor: true, Hall: true, Restaurant: true },
        minArea: 100,
        maxArea: 500,
        ceilingHeight: 10,
        searchTags: ['Birthday', 'Cartoon', 'Kids', 'Theme'],
        isFeatured: false,
        isPopular: true,
        tag: 'Kids Special',
        tagColor: 'bg-yellow-100 text-yellow-700',
        teamSize: '3 - 4 Team',
        categories: [
            {
                name: 'Theme Cutouts',
                items: [
                    it('Character Standee Cutout', 2, 'pcs'),
                    it('Themed Backdrop Banner', 1, 'pcs'),
                    it('Theme Character Foil Balloons', 6, 'pcs'),
                ],
            },
            {
                name: 'Balloons',
                items: [
                    it('Themed Coloured Latex', 120, 'pcs'),
                    it('Foil Curtain (gold / silver)', 2, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Latex', 'Foil', 'Theme Banners', 'Cardboard Cutouts'],
        setupTime: '2.5 hours',
        advanceBookingDays: 3,
        technicalSupport: false,
        onSiteSupervision: true,
        numberOfCaretakers: 2,
        basePrice: 6499,
        setupCharges: 600,
        dismantlingCharges: 400,
        transportCharges: 500,
        isCustomizable: true,
        allowCustomization: true,
        bestFor: ['Birthday Party', 'Kids Party'],
        notRecommendedFor: ['Wedding Reception', 'Corporate Meeting'],
        simultaneousBookings: 2,
        clientNotes: 'Please confirm the cartoon theme at least 3 days in advance for proper sourcing.',
        addons: [
            {
                name: 'Themed Birthday Cake (1 kg)',
                description: 'Designer cake matching the chosen cartoon theme',
                basePrice: 1800,
                count: '1 kg',
                deliverables: ['1 kg cake', 'Knife', 'Candles'],
            },
            {
                name: 'Return Gift Hampers',
                description: 'Themed return-gift hampers for kids (15 pieces)',
                basePrice: 2250,
                count: '15 hampers',
                deliverables: ['Themed bag', 'Stationery', 'Small toy', 'Chocolates'],
            },
            {
                name: 'Magic Show / Cartoon Mascot',
                description: 'Live magic show or costumed mascot performer (45 min slot)',
                basePrice: 3500,
                hasFullEventPrice: true,
                fullEventPrice: 5500,
                count: '1 performer',
                deliverables: ['Performer', 'Costume', 'Music + props'],
            },
        ],
        restrictions: {
            indoorOnly: true,
            notSuitableForKids: false,
        },
        images: [
            'https://images.unsplash.com/photo-1607478900766-efe13248b125?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Wedding Floral Mandap',
        category: 'Wedding',
        description: 'Premium 4-pillar floral mandap with marigold + rose drapes, fairy-light canopy, jaimala stand and a 12-ft floral backdrop.',
        themeStyle: 'Traditional Floral Mandap',
        primaryColor: '#F59E0B',
        secondaryColor: '#DC2626',
        accentColor: '#FFFFFF',
        suitableFor: { Indoor: true, Outdoor: true, Hall: true, Banquet: true, Garden: true },
        minArea: 800,
        maxArea: 4000,
        ceilingHeight: 14,
        searchTags: ['Wedding', 'Mandap', 'Floral', 'Marigold'],
        isFeatured: true,
        isPopular: true,
        tag: 'Premium',
        tagColor: 'bg-amber-100 text-amber-700',
        teamSize: '8 - 10 Team',
        categories: [
            {
                name: 'Mandap Structure',
                items: [
                    it('4-Pillar Mandap Frame', 1, 'set'),
                    it('Marigold Drape Garlands', 20, 'pcs'),
                    it('Rose Petal Curtain', 8, 'pcs'),
                ],
            },
            {
                name: 'Stage Setup',
                items: [
                    it('Fresh Flower Backdrop (12x8 ft)', 1, 'pcs'),
                    it('Jaimala Stand (silver)', 2, 'pcs'),
                    it('Bride / Groom Throne Chairs', 2, 'pcs'),
                ],
            },
            {
                name: 'Lighting',
                items: [
                    it('Fairy Light Canopy', 8, 'strings'),
                    it('Up-lighting Spotlights', 6, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Fresh Flowers', 'Drape Cloth', 'Wooden Mandap Frame', 'Fairy Lights'],
        setupTime: '6 hours',
        advanceBookingDays: 7,
        waterRequired: true,
        technicalSupport: true,
        onSiteSupervision: true,
        numberOfCaretakers: 4,
        basePrice: 49999,
        setupCharges: 5000,
        dismantlingCharges: 3000,
        transportCharges: 2500,
        isCustomizable: true,
        allowCustomization: true,
        additionalChargesPercent: 15,
        addons: [
            {
                name: 'Floral Aisle Walkway',
                description: '20-ft floral aisle leading to the mandap',
                basePrice: 8000,
                count: '1 walkway',
                deliverables: ['Fresh petals', 'Carpet runner', 'Side floral pots'],
            },
            {
                name: 'Drone Photography Setup',
                description: 'Drone landing pad + safe overhead clearance check',
                basePrice: 3000,
                count: '1 setup',
                deliverables: ['Pad', 'Safety briefing'],
            },
            {
                name: 'Live Sehra / Pheras Music',
                description: 'Live shehnai + tabla artists for the pheras (1.5 hour slot)',
                basePrice: 8000,
                count: '2 artists',
                deliverables: ['Shehnai player', 'Tabla player', 'Sound coordination'],
            },
        ],
        restrictions: {
            specialPermission: true,
            weatherDependent: true,
        },
        bestFor: ['Wedding Reception', 'Engagement', 'Pre-Wedding (Mehendi / Sangeet / Haldi)'],
        notRecommendedFor: ['Birthday Party', 'Corporate Meeting'],
        simultaneousBookings: 1,
        clientNotes: 'Fresh flower SKUs subject to seasonal availability. Final quote confirmed 24 hours before the event.',
        images: [
            'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80',
            'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Engagement Ring Setup',
        category: 'Wedding',
        description: 'Romantic ring-ceremony stage with rose petal pathway, ring-stand pedestal, soft drapes and warm candle lighting.',
        themeStyle: 'Romantic Stage',
        primaryColor: '#E11D48',
        secondaryColor: '#FCE7F3',
        accentColor: '#F59E0B',
        suitableFor: { Indoor: true, Hall: true, Banquet: true, Restaurant: true },
        minArea: 300,
        maxArea: 1500,
        ceilingHeight: 12,
        searchTags: ['Engagement', 'Ring Ceremony', 'Romantic'],
        isFeatured: false,
        isPopular: true,
        tag: 'Premium',
        tagColor: 'bg-rose-100 text-rose-700',
        teamSize: '4 - 5 Team',
        categories: [
            {
                name: 'Stage',
                items: [
                    it('Stage Backdrop (10x7 ft)', 1, 'pcs'),
                    it('Ring Stand Pedestal', 1, 'pcs'),
                    it('Couple Sofa', 1, 'pcs'),
                ],
            },
            {
                name: 'Florals',
                items: [
                    it('Rose Petal Path (10 ft)', 1, 'pcs'),
                    it('Floral Drapes', 6, 'pcs'),
                    it('Centrepiece Floral Pots', 4, 'pcs'),
                ],
            },
            {
                name: 'Lighting',
                items: [
                    it('Pillar Candles (LED)', 20, 'pcs'),
                    it('Warm Spotlights', 4, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Fresh Roses', 'LED Candles', 'Drape Cloth'],
        setupTime: '3 hours',
        advanceBookingDays: 4,
        onSiteSupervision: true,
        numberOfCaretakers: 2,
        basePrice: 14999,
        setupCharges: 1500,
        dismantlingCharges: 800,
        transportCharges: 800,
        isCustomizable: true,
        allowCustomization: true,
        bestFor: ['Engagement', 'Anniversary', 'Proposal'],
        notRecommendedFor: ['Birthday Party'],
        simultaneousBookings: 2,
        addons: [
            {
                name: 'Customised Ring Box',
                description: 'Velvet ring box with engraved couple initials',
                basePrice: 1200,
                count: '1 box',
                deliverables: ['Velvet ring box', 'Engraving (initials)'],
            },
            {
                name: 'Live Saxophone (1 hour)',
                description: 'Solo saxophonist for ring exchange + cocktail hour',
                basePrice: 5500,
                count: '1 artist',
                deliverables: ['Saxophonist', 'Wireless mic'],
            },
            {
                name: 'Photographer (Engagement Hour)',
                description: 'Dedicated photographer for the ring ceremony hour',
                basePrice: 3500,
                hasFullEventPrice: true,
                fullEventPrice: 8500,
                count: '1 photographer',
                deliverables: ['Edited photos (50+)', 'Soft-copy delivery in 7 days'],
            },
        ],
        restrictions: {
            indoorOnly: true,
        },
        images: [
            'https://images.unsplash.com/photo-1469371670807-013ccf25f16a?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Anniversary Romantic Setup',
        category: 'Anniversary',
        description: 'Intimate candle-lit table setup for anniversary dinners — petal heart, balloon bouquet, custom name banner and warm fairy lights.',
        themeStyle: 'Candle-lit Romantic',
        primaryColor: '#DC2626',
        secondaryColor: '#FCD34D',
        accentColor: '#FFFFFF',
        suitableFor: { Indoor: true, Restaurant: true, Terrace: true },
        minArea: 80,
        maxArea: 400,
        ceilingHeight: 10,
        searchTags: ['Anniversary', 'Couple', 'Romantic Dinner'],
        isFeatured: false,
        isPopular: true,
        tag: 'Couples',
        tagColor: 'bg-red-100 text-red-700',
        teamSize: '2 - 3 Team',
        categories: [
            {
                name: 'Tabletop',
                items: [
                    it('Rose Petal Heart on Table', 1, 'set'),
                    it('LED Pillar Candles', 6, 'pcs'),
                    it('Custom Couple-name Banner', 1, 'pcs'),
                ],
            },
            {
                name: 'Surround',
                items: [
                    it('Red & White Balloon Bouquet', 1, 'set'),
                    it('Fairy Light Curtain', 2, 'strings'),
                    it('Heart-shape Foil Balloons', 4, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Fresh Petals', 'LED Candles', 'Latex + Foil Balloons'],
        setupTime: '1.5 hours',
        advanceBookingDays: 2,
        onSiteSupervision: false,
        numberOfCaretakers: 1,
        basePrice: 2999,
        setupCharges: 300,
        dismantlingCharges: 200,
        transportCharges: 300,
        isCustomizable: true,
        allowCustomization: true,
        bestFor: ['Anniversary', 'Proposal', 'Couple Date Night'],
        notRecommendedFor: ['Wedding Reception', 'Conference'],
        simultaneousBookings: 5,
        clientNotes: 'Couple-name banner is custom — please provide names at least 24 hours before the event.',
        addons: [
            {
                name: 'Anniversary Cake (500 g)',
                description: 'Custom heart-shape cake with couple initials',
                basePrice: 1100,
                count: '500 g',
                deliverables: ['Heart-shape cake', 'Knife', 'Candles'],
            },
            {
                name: 'Bouquet of Red Roses',
                description: 'Hand-tied bouquet of 24 fresh red roses',
                basePrice: 900,
                count: '24 roses',
                deliverables: ['24 roses', 'Wrap', 'Greeting card'],
            },
            {
                name: 'Surprise Reveal Setup',
                description: 'Curtain reveal + smoke effect for surprise moment',
                basePrice: 1800,
                count: '1 setup',
                deliverables: ['Curtain rig', 'Cold-spark machine', 'Coordinator'],
            },
        ],
        restrictions: {
            indoorOnly: true,
            fireHazard: true,
        },
        images: [
            'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Mehendi / Sangeet Theme',
        category: 'Wedding',
        description: 'Vibrant pre-wedding stage — mirror-work canopy, marigold drapes, dholki seating circle and Rajasthani jharokha backdrop.',
        themeStyle: 'Vibrant Indian',
        primaryColor: '#FACC15',
        secondaryColor: '#16A34A',
        accentColor: '#DC2626',
        suitableFor: { Indoor: true, Outdoor: true, Hall: true, Garden: true, Terrace: true },
        minArea: 400,
        maxArea: 2500,
        ceilingHeight: 12,
        searchTags: ['Mehendi', 'Sangeet', 'Haldi', 'Pre-wedding', 'Marigold'],
        isFeatured: true,
        isPopular: true,
        tag: 'Premium',
        tagColor: 'bg-yellow-100 text-yellow-700',
        teamSize: '6 - 8 Team',
        categories: [
            {
                name: 'Stage Backdrop',
                items: [
                    it('Rajasthani Jharokha Frame', 1, 'pcs'),
                    it('Marigold + Rose Drapes', 12, 'pcs'),
                    it('Mirror-work Canopy', 1, 'pcs'),
                ],
            },
            {
                name: 'Seating',
                items: [
                    it('Floor Cushions (jaipuri prints)', 30, 'pcs'),
                    it('Low Round Tables', 6, 'pcs'),
                ],
            },
            {
                name: 'Lighting',
                items: [
                    it('Fairy Lights (warm)', 6, 'strings'),
                    it('Diya / Tealight Setup', 40, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Marigold + Rose', 'Jaipuri Cushions', 'Mirror Work', 'Tealights'],
        setupTime: '4 hours',
        advanceBookingDays: 5,
        onSiteSupervision: true,
        numberOfCaretakers: 3,
        basePrice: 24999,
        setupCharges: 2500,
        dismantlingCharges: 1500,
        transportCharges: 1500,
        isCustomizable: true,
        allowCustomization: true,
        addons: [
            {
                name: 'Mehendi Artist (4 hours)',
                description: 'Professional mehendi artist on-site for 4 hours',
                basePrice: 4000,
                count: '1 artist',
                deliverables: ['Cone setup', 'Designs catalogue'],
            },
            {
                name: 'Live Dholki + Singer (2 hours)',
                description: 'Folk dholki player + singer for sangeet songs',
                basePrice: 6500,
                count: '2 artists',
                deliverables: ['Dholki', 'Singer', 'Mic + sound'],
            },
            {
                name: 'Bangle Stall',
                description: 'On-site lac bangle stall (bangles charged separately)',
                basePrice: 2000,
                count: '1 stall',
                deliverables: ['Stall setup', 'Bangle artisan', 'Display props'],
            },
        ],
        restrictions: {
            weatherDependent: true,
        },
        bestFor: ['Pre-Wedding (Mehendi / Sangeet / Haldi)', 'Engagement'],
        notRecommendedFor: ['Corporate Meeting', 'Conference / Seminar'],
        simultaneousBookings: 2,
        images: [
            'https://images.unsplash.com/photo-1532375810709-75b1da00537c?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Baby Shower Theme',
        category: 'Custom',
        description: 'Soft-pastel canopy, baby-foot cutouts, "Mom-to-Be" sash and ribbon banner — ideal for godh bharai and baby showers.',
        themeStyle: 'Pastel Baby Shower',
        primaryColor: '#A7F3D0',
        secondaryColor: '#FBCFE8',
        accentColor: '#FFFFFF',
        suitableFor: { Indoor: true, Hall: true, Restaurant: true },
        minArea: 150,
        maxArea: 700,
        ceilingHeight: 10,
        searchTags: ['Baby Shower', 'Godh Bharai', 'Pastel'],
        isFeatured: false,
        isPopular: true,
        tag: 'Family',
        tagColor: 'bg-emerald-100 text-emerald-700',
        teamSize: '3 - 4 Team',
        categories: [
            {
                name: 'Stage',
                items: [
                    it('Pastel Backdrop Cloth (8x6 ft)', 1, 'pcs'),
                    it('Baby Foot Cutouts', 6, 'pcs'),
                    it('Mom-to-Be Sash', 1, 'pcs'),
                ],
            },
            {
                name: 'Balloons',
                items: [
                    it('Mint + Pink Latex Balloons', 80, 'pcs'),
                    it('Stork Foil Balloon', 1, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Latex', 'Cloth', 'Foil', 'Sash Ribbon'],
        setupTime: '2 hours',
        advanceBookingDays: 2,
        onSiteSupervision: true,
        numberOfCaretakers: 2,
        basePrice: 5999,
        setupCharges: 500,
        dismantlingCharges: 300,
        transportCharges: 400,
        isCustomizable: true,
        allowCustomization: true,
        bestFor: ['Baby Shower', 'Naming Ceremony'],
        notRecommendedFor: ['Wedding Reception', 'Corporate Meeting'],
        simultaneousBookings: 3,
        addons: [
            {
                name: '"Mom-to-Be" Photo Booth',
                description: 'Pastel photo wall with props for guest photos',
                basePrice: 1800,
                count: '1 setup',
                deliverables: ['8x6 ft pastel wall', '12 props', 'Photo frame border'],
            },
            {
                name: 'Naming Rituals Setup',
                description: 'Cradle decor + name reveal banner for naming ceremony combo',
                basePrice: 2500,
                count: '1 setup',
                deliverables: ['Decorated cradle', 'Name banner', 'Ribbon reveal'],
            },
            {
                name: 'Return Gift Hampers (15)',
                description: 'Hand-packed return-gift hampers for guests',
                basePrice: 2250,
                count: '15 hampers',
                deliverables: ['Themed pouch', 'Sweets', 'Small gift'],
            },
        ],
        restrictions: {
            indoorOnly: true,
        },
        images: [
            'https://images.unsplash.com/photo-1558625050-c4ed5d92aa07?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Corporate Backdrop',
        category: 'Custom',
        description: 'Clean, professional event backdrop with company-logo print, podium drape, lectern flowers and step-and-repeat photo wall.',
        themeStyle: 'Corporate Branding',
        primaryColor: '#1E40AF',
        secondaryColor: '#FFFFFF',
        accentColor: '#0F172A',
        suitableFor: { Indoor: true, Hall: true, Banquet: true },
        minArea: 200,
        maxArea: 1500,
        ceilingHeight: 11,
        searchTags: ['Corporate', 'Branding', 'Conference', 'Backdrop'],
        isFeatured: false,
        isPopular: true,
        tag: 'Business',
        tagColor: 'bg-slate-100 text-slate-700',
        teamSize: '2 - 3 Team',
        categories: [
            {
                name: 'Stage',
                items: [
                    it('Logo-Print Backdrop (10x8 ft)', 1, 'pcs'),
                    it('Lectern / Podium', 1, 'pcs'),
                    it('Lectern Floral Arrangement', 1, 'pcs'),
                ],
            },
            {
                name: 'Photo Area',
                items: [
                    it('Step-and-Repeat Wall (8x8 ft)', 1, 'pcs'),
                    it('Red Carpet Runner (10 ft)', 1, 'pcs'),
                ],
            },
        ],
        materialsUsed: ['Vinyl Print', 'Carpet', 'Floral Arrangement'],
        setupTime: '2 hours',
        advanceBookingDays: 3,
        technicalSupport: true,
        onSiteSupervision: true,
        numberOfCaretakers: 2,
        basePrice: 8999,
        setupCharges: 800,
        dismantlingCharges: 500,
        transportCharges: 700,
        isCustomizable: true,
        allowCustomization: true,
        clientNotes: 'Logo print artwork (high-res, AI / PDF / PNG) must be shared 48 hours in advance.',
        bestFor: ['Corporate Meeting', 'Conference / Seminar', 'Product Launch', 'Team Party / Office Get-together'],
        notRecommendedFor: ['Birthday Party', 'Wedding Reception'],
        simultaneousBookings: 3,
        addons: [
            {
                name: 'Welcome Branded Standees (4 ft)',
                description: 'Pull-up roller standees with company branding at entry',
                basePrice: 2200,
                count: '2 standees',
                deliverables: ['2 roller standees', 'Bag', 'Print artwork'],
            },
            {
                name: 'Branded Lanyards & Name Tags',
                description: 'Conference-ready lanyards and printed name tags',
                basePrice: 1500,
                count: '50 pieces',
                deliverables: ['50 lanyards', '50 printed name tags'],
            },
            {
                name: 'AV / Tech Operator (Half Day)',
                description: 'On-site sound + projector technician',
                basePrice: 2500,
                hasFullEventPrice: true,
                fullEventPrice: 4500,
                count: '1 operator',
                deliverables: ['Sound check', 'Slide advancer', 'Mic management'],
            },
        ],
        restrictions: {
            indoorOnly: true,
            specialPermission: false,
        },
        images: [
            'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },

    {
        name: 'Festive Diwali Decor',
        category: 'Custom',
        description: 'Diwali / new-year venue makeover — diya / tealight pathway, marigold torans, rangoli at entrance and warm lantern overhead.',
        themeStyle: 'Festive Indian',
        primaryColor: '#DC2626',
        secondaryColor: '#FACC15',
        accentColor: '#1F2937',
        suitableFor: { Indoor: true, Outdoor: true, Hall: true, Banquet: true, Restaurant: true, Terrace: true },
        minArea: 200,
        maxArea: 2000,
        ceilingHeight: 12,
        searchTags: ['Diwali', 'Festive', 'New Year', 'Christmas', 'Eid'],
        isFeatured: true,
        isPopular: true,
        tag: 'Seasonal',
        tagColor: 'bg-orange-100 text-orange-700',
        teamSize: '4 - 5 Team',
        categories: [
            {
                name: 'Entry',
                items: [
                    it('Marigold Toran (door)', 2, 'pcs'),
                    it('Rangoli (chalk + petals)', 1, 'set'),
                    it('Welcome Diya Lineup', 12, 'pcs'),
                ],
            },
            {
                name: 'Hall',
                items: [
                    it('Diya / Tealight Setup', 100, 'pcs'),
                    it('Hanging Paper Lanterns', 12, 'pcs'),
                    it('Fairy Light Curtains', 6, 'strings'),
                ],
            },
        ],
        materialsUsed: ['Diyas', 'Marigold', 'Rangoli Powder', 'Paper Lanterns'],
        setupTime: '3 hours',
        advanceBookingDays: 3,
        onSiteSupervision: true,
        numberOfCaretakers: 2,
        basePrice: 9999,
        setupCharges: 1000,
        dismantlingCharges: 600,
        transportCharges: 800,
        isCustomizable: true,
        allowCustomization: true,
        seasonalAvailability: { spring: false, summer: false, fall: true, winter: true },
        restrictions: {
            fireHazard: true,
            specialPermission: true,
            weatherDependent: true,
        },
        clientNotes: 'LED diyas are used by default. Real diyas only on request and with venue fire-safety clearance.',
        bestFor: ['Festive Celebration', 'Religious Function', 'Corporate Annual Day'],
        notRecommendedFor: ['Conference / Seminar'],
        simultaneousBookings: 2,
        addons: [
            {
                name: 'Live Rangoli Artist',
                description: 'On-site rangoli artist for entry-area live rangoli (1.5 hr slot)',
                basePrice: 2500,
                count: '1 artist',
                deliverables: ['Rangoli artist', 'Coloured powders', 'Stencils'],
            },
            {
                name: 'Sky Lanterns (Eco-friendly)',
                description: 'Pack of 25 biodegradable sky lanterns (subject to local rules)',
                basePrice: 3500,
                count: '25 lanterns',
                deliverables: ['25 lanterns', 'Lighter', 'Safety briefing'],
            },
            {
                name: 'Mithai Box Hampers (10)',
                description: 'Assorted Indian sweets in branded gift boxes',
                basePrice: 4000,
                count: '10 boxes',
                deliverables: ['10 mithai boxes (250 g each)', 'Branded sleeve'],
            },
        ],
        images: [
            'https://images.unsplash.com/photo-1605197381122-2dba9c1b1cf1?auto=format&fit=crop&w=1200&q=80',
        ],
        ...VENDOR,
    },
];

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

async function ensureDecorationPackages(tenant) {
    let created = 0;
    let updated = 0;
    let untouched = 0;
    const failed = [];

    for (const p of PACKAGES) {
        const existing = await DecorationPackage.findOne({
            restaurant: tenant._id,
            name: p.name,
        });
        if (existing) {
            // Backfill addons + restrictions on existing rows so a re-run
            // adds these two fields without overwriting any other admin
            // tweaks (description, pricing, images, vendor, etc.).
            //
            // Replace strategy: only when the seed declares MORE entries
            // than what's currently on the row. That way:
            //   - empty / partial rows get filled to match the seed
            //   - rows where the admin manually added MORE entries than
            //     the seed (a curated row) are left untouched
            const seedAddons = Array.isArray(p.addons) ? p.addons : [];
            const existingAddons = Array.isArray(existing.addons) ? existing.addons : [];
            const seedRestrFlags = Object.values(p.restrictions || {}).filter(v => v === true).length;
            const existingRestrObj = existing.restrictions
                ? (existing.restrictions.toObject ? existing.restrictions.toObject() : existing.restrictions)
                : {};
            const existingRestrFlags = Object.values(existingRestrObj).filter(v => v === true).length;

            const patch = {};
            if (seedAddons.length > existingAddons.length) patch.addons = seedAddons;
            if (seedRestrFlags > existingRestrFlags && p.restrictions) patch.restrictions = p.restrictions;
            if (Object.keys(patch).length > 0) {
                try {
                    await DecorationPackage.updateOne({ _id: existing._id }, { $set: patch });
                    updated += 1;
                    const fields = Object.keys(patch).join(' + ');
                    console.log(`  ↻ [${p.category.padEnd(11)}] ${p.name}  → backfilled ${fields}`);
                } catch (err) {
                    failed.push({ name: p.name, error: err.message });
                }
            } else {
                untouched += 1;
            }
            continue;
        }
        try {
            await DecorationPackage.create({
                ...p,
                restaurant: tenant._id,
                isActive: true,
            });
            created += 1;
            console.log(`  + [${p.category.padEnd(11)}] ${p.name}  ₹${p.basePrice.toLocaleString('en-IN')}`);
        } catch (err) {
            failed.push({ name: p.name, error: err.message });
        }
    }
    return { created, updated, untouched, failed };
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

    console.log(`\n⏳ Ensuring ${PACKAGES.length} decoration packages...`);
    const result = await ensureDecorationPackages(tenant);
    console.log('');
    console.log(`   ✔ Created:                ${result.created}`);
    console.log(`   ↻ Backfilled (existing):  ${result.updated}`);
    console.log(`   ✔ Untouched (already OK): ${result.untouched}`);
    if (result.failed.length) {
        console.log(`   ⚠ Failed:   ${result.failed.length}`);
        for (const f of result.failed) console.log(`     - ${f.name}: ${f.error}`);
    }

    const total = await DecorationPackage.countDocuments({ restaurant: tenant._id });
    console.log(`\n📊 Total decoration packages for tenant: ${total}`);

    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullDecorationPackages failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
