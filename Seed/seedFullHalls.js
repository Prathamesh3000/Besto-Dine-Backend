/**
 * seedFullHalls.js
 *
 * Seeds 6 most-common halls an Indian banquet / restaurant venue offers,
 * one per realistic use-case bucket:
 *   - Grand / Royal / Mini Banquet Hall      (Banquet Hall)
 *   - Conference Room A                       (Conference Room)
 *   - Auditorium                              (Auditorium)
 *   - Garden Lawn                             (Outdoor Space)
 *
 * Each hall ships with realistic Pune mid-range pricing, full
 * amenities map, audio/visual gear, policies, "best for" event tags,
 * status badges, contact details and a public Unsplash hero image so
 * the card and detail panel are meaningful out of the box.
 *
 * Idempotent — matches by (restaurant, name) and skips anything
 * already present, so re-running after admin tweaks never overwrites.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullHalls.js
 *   TENANT_SLUG=<slug> node Seed/seedFullHalls.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const Hall = require('../models/hall');

// Standard amenities baseline — most halls have everything except a few
// flips (Conference Room has no kitchen, Outdoor Lawn has no AC, etc.)
const allAmenities = (overrides = {}) => ({
    soundSystem: true,
    projector: true,
    wifi: true,
    ledScreen: true,
    airConditioning: true,
    elevator: true,
    powerBackup: true,
    parking: true,
    kitchen: true,
    ...overrides,
});

const DEFAULT_CONTACT = {
    name: 'Booking Manager',
    phone: '+91 9876543210',
    email: 'bookings@hoteltiptop.in',
};

// ─────────────────────────────────────────────────────────────────────────────
// 6 most-common halls
// ─────────────────────────────────────────────────────────────────────────────
const HALLS = [
    {
        name: 'Grand Banquet Hall',
        type: 'Banquet Hall',
        description: 'Our flagship banquet hall — high ceiling, crystal chandeliers and a 60-foot stage. Perfect for grand weddings and large corporate functions.',
        minCapacity: 200,
        maxCapacity: 500,
        optimalCapacity: 350,
        basePrice: 50000,
        hourlyRate: 6000,
        cleaningCharges: 3000,
        securityDeposit: 25000,
        floorLevel: 'Ground Floor',
        buildingWing: 'Main Wing',
        amenities: allAmenities(),
        features: [
            'Crystal Chandeliers',
            'Stage with Backdrop Setup',
            'Centralised AC',
            'Wedding-Ready Decor Hooks',
            'Bridal Room',
            'Green Room',
        ],
        audioVisual: [
            'Surround Sound System (Bose)',
            '3 Wireless Mics + 2 Collar Mics',
            'Full Stage Lighting',
            'LED Wall (10x6 ft)',
            'DJ Console Setup',
        ],
        policies: [
            'Booking confirmed only after 50% advance',
            'Outside catering not allowed',
            'Music allowed till 11:00 PM (police rules)',
            'No fireworks inside hall',
            'Damages charged from security deposit',
        ],
        bestFor: ['Wedding Reception', 'Engagement', 'Corporate Annual Day', 'Festive Celebration'],
        badges: ['Featured', 'AC Indoor', 'Premium'],
        contact: DEFAULT_CONTACT,
        images: [
            'https://images.unsplash.com/photo-1519225421980-715cb0215aed?auto=format&fit=crop&w=1200&q=80',
            'https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1200&q=80',
        ],
    },

    {
        name: 'Royal Banquet Hall',
        type: 'Banquet Hall',
        description: 'Mid-size premium banquet — ideal for receptions, sangeet nights and milestone birthdays of 150 to 300 guests.',
        minCapacity: 100,
        maxCapacity: 300,
        optimalCapacity: 200,
        basePrice: 30000,
        hourlyRate: 4000,
        cleaningCharges: 2000,
        securityDeposit: 15000,
        floorLevel: '1st Floor',
        buildingWing: 'Royal Wing',
        amenities: allAmenities(),
        features: [
            'Stage + Backdrop Setup',
            'AC Hall',
            'Bridal Room',
            'Buffet Setup Area',
            'Dance Floor',
        ],
        audioVisual: [
            'Sound System with Sub-woofer',
            '2 Wireless Mics + 1 Collar Mic',
            'Stage Lighting',
            'Projector + 100" Screen',
        ],
        policies: [
            'Booking confirmed only after 50% advance',
            'Outside DJ allowed with prior intimation',
            'Music allowed till 10:30 PM',
            'In-house catering preferred',
        ],
        bestFor: ['Wedding Reception', 'Engagement', 'Pre-Wedding (Mehendi / Sangeet / Haldi)', 'Birthday Party'],
        badges: ['AC Indoor', 'Popular'],
        contact: DEFAULT_CONTACT,
        images: [
            'https://images.unsplash.com/photo-1508253730651-e5ace80a7025?auto=format&fit=crop&w=1200&q=80',
        ],
    },

    {
        name: 'Mini Banquet Hall',
        type: 'Banquet Hall',
        description: 'Cosy hall for intimate gatherings — birthdays, baby showers, family pujas and small corporate parties up to 150 guests.',
        minCapacity: 30,
        maxCapacity: 150,
        optimalCapacity: 80,
        basePrice: 15000,
        hourlyRate: 2500,
        cleaningCharges: 1200,
        securityDeposit: 8000,
        floorLevel: '2nd Floor',
        buildingWing: 'East Wing',
        amenities: allAmenities({ ledScreen: false }),
        features: [
            'AC Hall',
            'Stage Backdrop',
            'Buffet Setup',
            'Photo Booth Area',
        ],
        audioVisual: [
            'Sound System',
            '2 Wireless Mics',
            'Background Lighting',
        ],
        policies: [
            '30% advance to confirm booking',
            'In-house catering only',
            'Decoration team must be approved',
            'Music till 10:00 PM',
        ],
        bestFor: ['Birthday Party', 'Baby Shower', 'Naming Ceremony', 'Kitty Party', 'Family Get-together'],
        badges: ['AC Indoor', 'Family Friendly'],
        contact: DEFAULT_CONTACT,
        images: [
            'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&w=1200&q=80',
        ],
    },

    {
        name: 'Conference Room A',
        type: 'Conference Room',
        description: 'Boardroom-style conference room with full A/V — perfect for client meets, board reviews, training sessions and small workshops.',
        minCapacity: 6,
        maxCapacity: 30,
        optimalCapacity: 20,
        basePrice: 3000,
        hourlyRate: 500,
        cleaningCharges: 300,
        securityDeposit: 2000,
        floorLevel: '1st Floor',
        buildingWing: 'Business Wing',
        amenities: allAmenities({ kitchen: false, parking: true }),
        features: [
            'U-shape Boardroom Table',
            'Whiteboard + Markers',
            'High-Speed Wi-Fi',
            'Tea / Coffee Vending Machine',
            'Stationery Kit',
        ],
        audioVisual: [
            'Smart TV (65")',
            'Conference Speakerphone',
            'HDMI / USB-C Connectors',
            'Video Conferencing Camera',
        ],
        policies: [
            'Hourly billing — minimum 2 hours',
            'Working lunch can be arranged on request',
            'Cancellation 24 hours in advance',
            'Available 8 AM to 9 PM',
        ],
        bestFor: ['Corporate Meeting', 'Training Session', 'Client Meet', 'Workshop'],
        badges: ['AC Indoor', 'Corporate'],
        contact: DEFAULT_CONTACT,
        images: [
            'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1200&q=80',
        ],
    },

    {
        name: 'Auditorium',
        type: 'Auditorium',
        description: 'Theatre-style auditorium with raked seating, stage and full A/V — designed for seminars, conferences and product launches.',
        minCapacity: 80,
        maxCapacity: 300,
        optimalCapacity: 220,
        basePrice: 25000,
        hourlyRate: 3500,
        cleaningCharges: 1500,
        securityDeposit: 12000,
        floorLevel: 'Ground Floor',
        buildingWing: 'North Wing',
        amenities: allAmenities({ kitchen: false }),
        features: [
            'Theatre-Style Raked Seating',
            'Stage with Podium',
            'Green Room',
            'Speaker Lounge',
            'Registration Desk',
        ],
        audioVisual: [
            'Professional Sound System',
            '4 Wireless Mics + 2 Lapel Mics',
            'Stage + Auditorium Lighting',
            'LED Wall (12x7 ft)',
            'Live Streaming Camera Setup',
        ],
        policies: [
            'Booking confirmed only after 50% advance',
            'Tech rehearsal slot included (1 hour)',
            'Live streaming setup chargeable extra',
            'In-house catering for tea breaks only',
        ],
        bestFor: ['Conference / Seminar', 'Product Launch', 'Corporate Annual Day', 'Award Ceremony'],
        badges: ['AC Indoor', 'Pro AV'],
        contact: DEFAULT_CONTACT,
        images: [
            'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&w=1200&q=80',
            'https://images.unsplash.com/photo-1531058020387-3be344556be6?auto=format&fit=crop&w=1200&q=80',
        ],
    },

    {
        name: 'Garden Lawn',
        type: 'Outdoor Space',
        description: 'Open-air manicured lawn with fairy-light canopy and a dance floor — perfect for sangeet nights, cocktail evenings and outdoor receptions.',
        minCapacity: 100,
        maxCapacity: 400,
        optimalCapacity: 250,
        basePrice: 35000,
        hourlyRate: 5000,
        cleaningCharges: 2500,
        securityDeposit: 18000,
        floorLevel: 'Ground Level',
        buildingWing: 'Garden Side',
        amenities: allAmenities({ airConditioning: false, elevator: false, ledScreen: false }),
        features: [
            'Manicured Lawn (8000 sq ft)',
            'Fairy-Light Canopy',
            'Outdoor Dance Floor',
            'BBQ Counter Setup',
            'Live Counters Area',
            'Open Bar Setup',
        ],
        audioVisual: [
            'Outdoor Sound System',
            '2 Wireless Mics',
            'Decorative Lighting (3 themes)',
            'DJ Setup with Sub-woofer',
        ],
        policies: [
            'Weather contingency — covered area on standby',
            'Music allowed till 10:00 PM (open-air rule)',
            'No fireworks',
            'Liquor permit handled by client',
        ],
        bestFor: ['Wedding Reception', 'Pre-Wedding (Mehendi / Sangeet / Haldi)', 'Cocktail Evening', 'Festive Celebration'],
        badges: ['Featured', 'Outdoor', 'Sangeet Special'],
        contact: DEFAULT_CONTACT,
        images: [
            'https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1200&q=80',
            'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?auto=format&fit=crop&w=1200&q=80',
        ],
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

async function ensureHalls(tenant) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const h of HALLS) {
        const existing = await Hall.findOne({
            restaurant: tenant._id,
            name: h.name,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            await Hall.create({
                ...h,
                restaurant: tenant._id,
                isActive: true,
            });
            created += 1;
            console.log(`  + [${h.type.padEnd(15)}] ${h.name}  ₹${h.basePrice.toLocaleString('en-IN')}  (${h.minCapacity}-${h.maxCapacity} ppl)`);
        } catch (err) {
            failed.push({ name: h.name, error: err.message });
        }
    }
    return { created, skipped, failed };
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

    console.log(`\n⏳ Ensuring ${HALLS.length} halls...`);
    const result = await ensureHalls(tenant);
    console.log('');
    console.log(`   ✔ Created:  ${result.created}`);
    console.log(`   ✔ Existing: ${result.skipped}`);
    if (result.failed.length) {
        console.log(`   ⚠ Failed:   ${result.failed.length}`);
        for (const f of result.failed) console.log(`     - ${f.name}: ${f.error}`);
    }

    const total = await Hall.countDocuments({ restaurant: tenant._id });
    console.log(`\n📊 Total halls for tenant: ${total}`);

    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullHalls failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
