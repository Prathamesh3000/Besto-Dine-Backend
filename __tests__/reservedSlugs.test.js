/**
 * Unit tests for utils/reservedSlugs — restaurant slugs that would
 * collide with a top-level frontend route at /<restaurantSlug>.
 */
const fs = require('fs');
const path = require('path');
const {
    RESERVED_SLUGS,
    isReservedSlug,
    checkExplicitRestaurantSlug,
} = require('../utils/reservedSlugs');

describe('isReservedSlug', () => {
    test.each([
        'admin', 'superadmin', 'staff-login', 'login', 'register-restaurant', 'waiter',
        'chef', 'kiosk', 'r', 'scan', 'customer', 'bill-preview', 'api', 'blog',
        'favicon.ico', 'robots.txt', 'sitemap.xml', '404', 'null', 'undefined',
    ])('%s is reserved', (slug) => {
        expect(isReservedSlug(slug)).toBe(true);
    });

    test('case and surrounding whitespace are ignored', () => {
        expect(isReservedSlug('ADMIN')).toBe(true);
        expect(isReservedSlug('  Login ')).toBe(true);
    });

    test.each(['hotel-tip-top', 'admin-1', 'my-admin', 'kiosk-cafe', 'rr', 'main'])(
        '%s is not reserved', (slug) => {
            expect(isReservedSlug(slug)).toBe(false);
        },
    );

    test('empty / nullish input is not reserved', () => {
        expect(isReservedSlug('')).toBe(false);
        expect(isReservedSlug(null)).toBe(false);
        expect(isReservedSlug(undefined)).toBe(false);
    });

    test('RESERVED_SLUGS is a lowercase Set', () => {
        expect(RESERVED_SLUGS).toBeInstanceOf(Set);
        for (const s of RESERVED_SLUGS) expect(s).toBe(s.toLowerCase());
    });

    test('covers every top-level route segment in Frontend/src/App.jsx', () => {
        const appJsx = path.join(__dirname, '..', '..', 'Frontend', 'src', 'App.jsx');
        if (!fs.existsSync(appJsx)) return; // backend-only checkout
        const src = fs.readFileSync(appJsx, 'utf8');
        const segments = new Set();
        for (const m of src.matchAll(/path=["'{`]+\/([^"'`}/]*)/g)) {
            const seg = m[1].trim();
            if (seg && !seg.startsWith(':') && seg !== '*') segments.add(seg.toLowerCase());
        }
        expect(segments.size).toBeGreaterThan(5);
        const missing = [...segments].filter((s) => !RESERVED_SLUGS.has(s));
        expect(missing).toEqual([]);
    });
});

describe('checkExplicitRestaurantSlug', () => {
    test('valid slug passes (normalised to lowercase)', () => {
        expect(checkExplicitRestaurantSlug('Hotel-Tip-Top')).toEqual({ slug: 'hotel-tip-top' });
    });

    test('reserved slug → SLUG_RESERVED', () => {
        const r = checkExplicitRestaurantSlug('admin');
        expect(r.error).toMatchObject({ status: 400, code: 'SLUG_RESERVED' });
    });

    test.each(['a', 'has space', 'bad--dash', '-lead', 'x'.repeat(61), 'emoji🙂'])(
        '%s → INVALID_SLUG', (slug) => {
            expect(checkExplicitRestaurantSlug(slug).error).toMatchObject({ status: 400, code: 'INVALID_SLUG' });
        },
    );

    test('non-string → INVALID_SLUG', () => {
        expect(checkExplicitRestaurantSlug(42).error.code).toBe('INVALID_SLUG');
        expect(checkExplicitRestaurantSlug({ $ne: 1 }).error.code).toBe('INVALID_SLUG');
    });
});
