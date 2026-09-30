/**
 * seedFullEventTypes.js
 *
 * Seeds the 14 most-common event types an Indian cafe / restaurant /
 * banquet hall handles, each with:
 *   - unique emoji icon (rendered directly by the Bookings → Event Types
 *     card; falls back to <img> if a URL is uploaded later)
 *   - unique hex color for the card's left accent stripe
 *   - sensible guest range, description, services and tags so the
 *     details panel is meaningful out of the box
 *
 * Idempotent — matches existing rows by (restaurant, title) and skips
 * anything already present, so re-running after the admin has tweaked
 * an event type from the UI never overwrites their changes.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedFullEventTypes.js
 *   TENANT_SLUG=<slug> node Seed/seedFullEventTypes.js
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Restaurant = require('../models/restaurant');
const EventType = require('../models/eventType');

// ─────────────────────────────────────────────────────────────────────────────
// 14 most-common event types, ordered by typical frequency in an Indian
// cafe / restaurant. icon = emoji (renders directly), color = hex used
// as the card's left-accent stripe, iconColor = matching tint kept for
// future text-based icon swaps.
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_TYPES = [
    {
        title: 'Birthday Party',
        icon: '🎂',
        color: '#A855F7',
        iconColor: '#A855F7',
        description: 'Celebrate birthdays with cake, decoration and a warm gathering.',
        guests: '10-200',
        services: ['Cake cutting', 'Decoration', 'Music', 'Photography'],
        tags: ['Birthday', 'Celebration', 'Family'],
    },
    {
        title: 'Anniversary',
        icon: '💍',
        color: '#E11D48',
        iconColor: '#E11D48',
        description: 'A special evening to celebrate years of togetherness.',
        guests: '2-100',
        services: ['Romantic decoration', 'Couple cake', 'Live music', 'Special menu'],
        tags: ['Anniversary', 'Couple', 'Romantic'],
    },
    {
        title: 'Wedding Reception',
        icon: '👰',
        color: '#EC4899',
        iconColor: '#EC4899',
        description: 'Grand reception space for the bride and groom and their guests.',
        guests: '100-500',
        services: ['Stage decoration', 'Floral arrangement', 'Buffet', 'DJ', 'Photography'],
        tags: ['Wedding', 'Reception', 'Banquet'],
    },
    {
        title: 'Engagement',
        icon: '💑',
        color: '#F472B6',
        iconColor: '#F472B6',
        description: 'Ring ceremony with close family and friends.',
        guests: '30-200',
        services: ['Ring stand', 'Decoration', 'Photography', 'Catering'],
        tags: ['Engagement', 'Pre-wedding', 'Family'],
    },
    {
        title: 'Pre-Wedding (Mehendi / Sangeet / Haldi)',
        icon: '💐',
        color: '#FACC15',
        iconColor: '#FACC15',
        description: 'Vibrant pre-wedding rituals — mehendi, haldi, sangeet — with traditional decor.',
        guests: '40-250',
        services: ['Theme decoration', 'Mehendi artist', 'DJ / dhol', 'Snacks counter'],
        tags: ['Mehendi', 'Sangeet', 'Haldi', 'Pre-wedding'],
    },
    {
        title: 'Baby Shower',
        icon: '🤰',
        color: '#38BDF8',
        iconColor: '#38BDF8',
        description: 'Celebrate the mother-to-be with games, gifts and a soft pastel setup.',
        guests: '15-80',
        services: ['Pastel decoration', 'Games', 'Gift table', 'Photography'],
        tags: ['Baby Shower', 'Godh Bharai', 'Family'],
    },
    {
        title: 'Naming Ceremony',
        icon: '👶',
        color: '#22D3EE',
        iconColor: '#22D3EE',
        description: 'Naamkaran / cradle ceremony with rituals and a small lunch.',
        guests: '20-100',
        services: ['Cradle decoration', 'Pandit booking', 'Catering', 'Photography'],
        tags: ['Naamkaran', 'Naming', 'Family'],
    },
    {
        title: 'Corporate Meeting',
        icon: '💼',
        color: '#475569',
        iconColor: '#475569',
        description: 'Private meeting space for client meets, board reviews and team off-sites.',
        guests: '5-50',
        services: ['Projector', 'Wi-Fi', 'Tea / coffee', 'Working lunch', 'Stationery'],
        tags: ['Corporate', 'Business', 'Meeting'],
    },
    {
        title: 'Conference / Seminar',
        icon: '🎤',
        color: '#2563EB',
        iconColor: '#2563EB',
        description: 'Auditorium-style setup with stage, mic and AV for talks and seminars.',
        guests: '50-300',
        services: ['Stage + podium', 'Sound system', 'AV setup', 'Bulk catering'],
        tags: ['Conference', 'Seminar', 'Corporate'],
    },
    {
        title: 'Team Party / Office Get-together',
        icon: '🎉',
        color: '#FB923C',
        iconColor: '#FB923C',
        description: 'Annual day, year-end party or quarterly bash for the office team.',
        guests: '20-150',
        services: ['DJ', 'Open bar', 'Buffet', 'Games', 'Awards stage'],
        tags: ['Team Party', 'Corporate', 'Annual Day'],
    },
    {
        title: 'Reunion',
        icon: '🤝',
        color: '#F59E0B',
        iconColor: '#F59E0B',
        description: 'School / college / family reunion with nostalgia, music and food.',
        guests: '20-200',
        services: ['Buffet', 'Music', 'Photography', 'Memory wall'],
        tags: ['Reunion', 'Friends', 'Family'],
    },
    {
        title: 'Kitty Party',
        icon: '👯',
        color: '#D946EF',
        iconColor: '#D946EF',
        description: 'Ladies-only get-together with games, gossip and high tea.',
        guests: '8-40',
        services: ['Theme decor', 'High tea', 'Games', 'Music'],
        tags: ['Kitty Party', 'Ladies', 'Casual'],
    },
    {
        title: 'Festive Celebration',
        icon: '🪔',
        color: '#DC2626',
        iconColor: '#DC2626',
        description: 'Diwali, Holi, New Year, Christmas, Eid — themed festive party space.',
        guests: '20-300',
        services: ['Festive decor', 'Themed menu', 'DJ', 'Photo booth'],
        tags: ['Festival', 'Diwali', 'New Year', 'Christmas'],
    },
    {
        title: 'Other / Custom Event',
        icon: '✨',
        color: '#6B7280',
        iconColor: '#6B7280',
        description: 'Any other private gathering — proposal, farewell, retirement, custom theme.',
        guests: '2-500',
        services: ['Custom decor', 'Custom menu', 'Photography'],
        tags: ['Custom', 'Other'],
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

async function ensureEventTypes(tenant) {
    let created = 0;
    let skipped = 0;
    const failed = [];

    for (const et of EVENT_TYPES) {
        const existing = await EventType.findOne({
            restaurant: tenant._id,
            title: et.title,
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        try {
            await EventType.create({
                ...et,
                restaurant: tenant._id,
                isActive: true,
            });
            created += 1;
            console.log(`  + ${et.icon}  ${et.title}`);
        } catch (err) {
            failed.push({ title: et.title, error: err.message });
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

    console.log(`\n⏳ Ensuring ${EVENT_TYPES.length} event types...`);
    const result = await ensureEventTypes(tenant);
    console.log('');
    console.log(`   ✔ Created:  ${result.created}`);
    console.log(`   ✔ Existing: ${result.skipped}`);
    if (result.failed.length) {
        console.log(`   ⚠ Failed:   ${result.failed.length}`);
        for (const f of result.failed) console.log(`     - ${f.title}: ${f.error}`);
    }

    const total = await EventType.countDocuments({ restaurant: tenant._id });
    console.log(`\n📊 Total event types for tenant: ${total}`);

    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('❌ seedFullEventTypes failed:', err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
