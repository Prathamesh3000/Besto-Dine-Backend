/**
 * deadImage — recognise image URLs that are known to be broken or that
 * were never a real photo (random-placeholder hosts, two retired Unsplash
 * ids). Importers drop such URLs so the row is saved BLANK; nothing is
 * ever substituted (no stock photos since 2026-10-28).
 *
 *   - isDeadImage(url)       → true for empty / non-string / matching URLs
 *   - DEAD_IMAGE_PATTERNS    → the regex list, for scripts that filter rows
 */
const DEAD_IMAGE_PATTERNS = [
    /^https?:\/\/images\.unsplash\.com\/photo-(1567620905732-2d1ec7bb7445|1484723088339-323833995221)/i,
    /^https?:\/\/(?:[a-z0-9-]+\.)?picsum\.photos\//i,
    /^https?:\/\/source\.unsplash\.com\//i,
];

function isDeadImage(url) {
    if (!url || typeof url !== 'string') return true;
    return DEAD_IMAGE_PATTERNS.some(re => re.test(url));
}

module.exports = { isDeadImage, DEAD_IMAGE_PATTERNS };
