/**
 * Shared shape helpers for Settings.landingPage (the public
 * /<restaurantSlug> page). Pure — no DB, no req.
 *
 * Used by settingsController (PATCH /settings/landingPage + GET overlay)
 * and publicController (GET /public/restaurants/:slug/landing) so the
 * admin form and the public page always see the same defaults, even for
 * Settings docs saved before the section existed (lean reads don't apply
 * schema defaults).
 */

const LANDING_SECTION_KEYS = ['featured', 'about', 'hours', 'location', 'branches', 'gallery'];
const LANDING_SOCIAL_KEYS = ['instagram', 'facebook', 'website', 'whatsapp', 'googleMapsUrl'];
const MAX_COVER_IMAGES = 6;
const MAX_FEATURED_ITEMS = 8;

function landingPageDefaults() {
    return {
        enabled: true,
        tagline: '',
        about: '',
        coverImages: [],
        social: Object.fromEntries(LANDING_SOCIAL_KEYS.map((k) => [k, ''])),
        featuredItems: [],
        sections: Object.fromEntries(LANDING_SECTION_KEYS.map((k) => [k, true])),
        accentColor: '',
    };
}

/** Fill any missing landingPage keys with the defaults (plain object in/out). */
function normalizeLandingPage(raw) {
    const d = landingPageDefaults();
    const lp = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: typeof lp.enabled === 'boolean' ? lp.enabled : d.enabled,
        tagline: typeof lp.tagline === 'string' ? lp.tagline : d.tagline,
        about: typeof lp.about === 'string' ? lp.about : d.about,
        coverImages: Array.isArray(lp.coverImages)
            ? lp.coverImages.filter((u) => typeof u === 'string' && u).slice(0, MAX_COVER_IMAGES)
            : d.coverImages,
        social: Object.fromEntries(LANDING_SOCIAL_KEYS.map((k) => [
            k, typeof lp.social?.[k] === 'string' ? lp.social[k] : d.social[k],
        ])),
        featuredItems: Array.isArray(lp.featuredItems)
            ? lp.featuredItems.filter(Boolean).map((id) => String(id)).slice(0, MAX_FEATURED_ITEMS)
            : d.featuredItems,
        sections: Object.fromEntries(LANDING_SECTION_KEYS.map((k) => [
            k, typeof lp.sections?.[k] === 'boolean' ? lp.sections[k] : d.sections[k],
        ])),
        accentColor: typeof lp.accentColor === 'string' ? lp.accentColor : d.accentColor,
    };
}

module.exports = {
    LANDING_SECTION_KEYS,
    LANDING_SOCIAL_KEYS,
    MAX_COVER_IMAGES,
    MAX_FEATURED_ITEMS,
    landingPageDefaults,
    normalizeLandingPage,
};
