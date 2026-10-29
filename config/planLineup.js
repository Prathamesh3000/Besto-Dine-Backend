/**
 * The public plan line-up: Silver / Gold / Premium (+ Enterprise).
 *
 * Single source of truth for which modules each plan unlocks — read by
 * Seed/seedSuperAdmin.js (fresh installs) and
 * migrations/applyPlanLineup2026.js (existing databases). Mirrors the
 * feature table in PRICING_PACKAGING.md §4.
 *
 *   Silver  — runs the outlet (billing, QR, KDS, waiter app, tips, inventory)
 *   Gold    — brings customers back (loyalty, coupons, CRM, campaigns,
 *             reservations, staff performance)
 *   Premium — high-ticket revenue + integrations (banquet halls, kiosk,
 *             e-invoice, webhooks, own branding)
 *
 * Hall bookings, kiosk and e-invoice can also be sold to Silver / Gold
 * tenants as paid add-ons (utils/featureAccess ADDON_CATALOG).
 *
 * Prices are the per-month list prices (INR, before GST). Per-outlet
 * billing and annual prices from the pricing proposal are not modelled
 * yet, so maxBranches keeps the previous 1 / 3 / 10 outlet ladder.
 */

// Every boolean module, off. Each plan below switches on what it sells.
const ALL_OFF = {
    dineIn: false, takeaway: false, kitchenDisplay: false, waiterDashboard: false,
    advanceBookingTable: false, advanceBookingHall: false,
    walletLoyalty: false, couponPromotions: false, campaigns: false,
    inventory: false, crm: false, tipManagement: false,
    multiBranch: false, staffPerformance: false, paymentGateway: false,
    dataExport: false, accountingExport: false, aggregatorOrders: false,
    eInvoice: false, webhooks: false, whiteLabelBranding: false, kiosk: false,
    incentives: false,   // add-on only (utils/featureAccess ADDON_CATALOG)
    publicApi: false,    // API keys + public API + webhooks: Gold and above, or add-on
};

const SILVER_FEATURES = {
    ...ALL_OFF,
    dineIn: true, takeaway: true, paymentGateway: true,
    kitchenDisplay: true, waiterDashboard: true,
    tipManagement: true, inventory: true,
    aggregatorOrders: true, accountingExport: true, dataExport: true,
    multiBranch: true,
    revenueAnalytics: 'basic',
};

const GOLD_FEATURES = {
    ...SILVER_FEATURES,
    walletLoyalty: true, couponPromotions: true, crm: true, campaigns: true,
    advanceBookingTable: true, staffPerformance: true,
    publicApi: true,
    revenueAnalytics: 'standard',
};

const PREMIUM_FEATURES = {
    ...GOLD_FEATURES,
    advanceBookingHall: true, kiosk: true, eInvoice: true,
    webhooks: true, whiteLabelBranding: true,
    revenueAnalytics: 'advanced',
};

// Fair-use caps — never advertised, just there to stop abuse.
const FAIR_USE = { maxStaff: 500, maxMenuItems: 5000, maxTables: 500 };

const LINEUP = [
    {
        name: 'Silver',
        slug: 'silver',
        description: 'For cafes, QSRs and single-outlet starters — billing, QR ordering, kitchen display, tips and inventory.',
        price: 699,
        billingCycle: 'monthly',
        trialDays: 14,
        sortOrder: 1,
        isPublic: true,
        highlight: false,
        limits: { maxBranches: 1, ...FAIR_USE, apiRateLimit: 100, auditRetentionDays: 180 },
        features: SILVER_FEATURES,
    },
    {
        name: 'Gold',
        slug: 'gold',
        description: 'For dine-in restaurants and small chains — everything in Silver plus loyalty, coupons, CRM, campaigns and reservations.',
        price: 1799,
        billingCycle: 'monthly',
        trialDays: 14,
        sortOrder: 2,
        isPublic: true,
        highlight: true,
        limits: { maxBranches: 3, ...FAIR_USE, apiRateLimit: 300, auditRetentionDays: 365 },
        features: GOLD_FEATURES,
    },
    {
        name: 'Premium',
        slug: 'premium',
        description: 'For busy restaurants, banquets and chains — everything in Gold plus hall bookings, kiosk, e-invoicing and integrations.',
        price: 2999,
        billingCycle: 'monthly',
        trialDays: 14,
        sortOrder: 3,
        isPublic: true,
        highlight: false,
        limits: { maxBranches: 10, ...FAIR_USE, apiRateLimit: 1000, auditRetentionDays: 0 },
        features: PREMIUM_FEATURES,
    },
    {
        name: 'Enterprise',
        slug: 'enterprise',
        description: 'Custom contracts for 20+ outlets. Dedicated account manager and SLA.',
        price: 0,                    // priced individually
        billingCycle: 'monthly',
        trialDays: 0,
        sortOrder: 4,
        isPublic: true,
        highlight: false,
        limits: { maxBranches: 100000, maxStaff: 100000, maxMenuItems: 100000, maxTables: 100000, apiRateLimit: 5000, auditRetentionDays: 0 },
        features: { ...PREMIUM_FEATURES },
    },
];

// Plans from the previous line-up. They stay active (tenants on them keep
// working) but are hidden from the catalog. The old `premium` slug is
// renamed so the new Premium can take it.
const LEGACY_PLANS = [
    { slug: 'basic',    newSlug: 'basic',          newName: 'Basic (legacy)' },
    { slug: 'standard', newSlug: 'standard',       newName: 'Standard (legacy)' },
    { slug: 'premium',  newSlug: 'premium-legacy', newName: 'Premium (legacy)' },
];

module.exports = { LINEUP, LEGACY_PLANS, ALL_OFF, SILVER_FEATURES, GOLD_FEATURES, PREMIUM_FEATURES };
