/**
 * Restaurant URL slug helpers for hotel self-signup
 * (POST /public/register-restaurant) and the live availability check
 * (GET /public/slug-availability).
 *
 * Pure helpers — DB lookups are passed in as `findTaken(slugs) → Set`
 * so the suggestion logic is unit-testable without Mongo.
 */
'use strict';

const crypto = require('crypto');
const { isReservedSlug, RESTAURANT_SLUG_REGEX } = require('./reservedSlugs');

const SLUG_MIN = 2;
const SLUG_MAX = 60;
// Generated slugs are capped at 55 so a "-xxxx" collision suffix still
// fits the 2-60 range the tenant resolver accepts.
const GENERATED_MAX = 55;

function slugify(input = '') {
    return String(input)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/** The slug signup would derive from a restaurant name (before collision handling). */
function slugFromName(name) {
    return slugify(name).slice(0, GENERATED_MAX).replace(/-+$/, '');
}

/**
 * Why `slug` can't be used, ignoring uniqueness:
 *   null | 'too_short' | 'invalid' | 'reserved'
 */
function slugIssue(slug) {
    if (typeof slug !== 'string' || !slug) return 'invalid';
    if (slug.length < SLUG_MIN) return 'too_short';
    if (slug.length > SLUG_MAX || !RESTAURANT_SLUG_REGEX.test(slug)) return 'invalid';
    if (isReservedSlug(slug)) return 'reserved';
    return null;
}

/** Ordered, de-duplicated, well-formed alternative slugs for `base`. */
function suggestionCandidates(base, { city } = {}) {
    const b = slugify(base).slice(0, 48).replace(/-+$/, '');
    if (!b) return [];
    const c = slugify(city || '').slice(0, 20).replace(/-+$/, '');
    const raw = [
        c && !b.endsWith(`-${c}`) ? `${b}-${c}` : '',
        `${b}-restaurant`,
        `${b}-hotel`,
        `the-${b}`,
        `${b}-2`,
        `${b}-3`,
        `${b}-kitchen`,
        `${b}-online`,
        `${b}-4`,
        `${b}-5`,
    ];
    const out = [];
    for (const s of raw) {
        if (s && !out.includes(s) && s !== b && slugIssue(s) === null) out.push(s);
    }
    return out;
}

/**
 * Up to `limit` available alternatives for `base`.
 * `findTaken(slugs[]) → Promise<Set<string>>` reports which already exist.
 * Falls back to random suffixes if every deterministic candidate is taken.
 */
async function suggestSlugs(base, findTaken, { city, limit = 3 } = {}) {
    let candidates = suggestionCandidates(base, { city });
    const b = slugify(base).slice(0, 48).replace(/-+$/, '');
    if (b) {
        for (let i = 0; i < 3; i += 1) candidates.push(`${b}-${crypto.randomBytes(2).toString('hex')}`);
    }
    candidates = candidates.filter((s) => slugIssue(s) === null);
    if (!candidates.length) return [];
    const taken = await findTaken(candidates);
    return candidates.filter((s) => !taken.has(s)).slice(0, limit);
}

module.exports = {
    SLUG_MIN,
    SLUG_MAX,
    GENERATED_MAX,
    slugify,
    slugFromName,
    slugIssue,
    suggestionCandidates,
    suggestSlugs,
};
