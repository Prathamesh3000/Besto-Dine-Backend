/**
 * Turns raw reader output into review-table rows.
 *
 * A row is a PROPOSAL. Anything doubtful is flagged `needsCheck` so the owner
 * looks at it first; a price we could not read is left null, never guessed.
 */
'use strict';

const MAX_ROWS = 400;
const MAX_PRICE = 100000;
const NON_VEG = /\b(chicken|mutton|lamb|fish|prawn|shrimp|crab|egg|keema|beef|pork|bacon|ham|salmon|tuna|seafood|kebab|tikka|biryani gosht|gosht|murgh|anda)\b/i;
const GENERIC_CATEGORY = 'Menu';

const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(Number(n)) ? Number(n) : 0.5));
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const keyOf = (name, category) => `${text(category, 80).toLowerCase()}::${text(name, 120).toLowerCase()}`;

function cleanPrice(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_PRICE) return null;
    return Math.round(n * 100) / 100;
}

function cleanBox(b) {
    if (!b || typeof b !== 'object') return null;
    const x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.02 || y + h > 1.02) return null;
    return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

/**
 * @param {Array<object>} rawItems  reader output
 * @param {Array<{ index:number, level:string }>} pages  per-page quality (index 1-based)
 */
function buildDraft(rawItems, pages = []) {
    const levelByPage = new Map(pages.map((p) => [p.index, p.level]));
    const byKey = new Map();

    for (const raw of Array.isArray(rawItems) ? rawItems : []) {
        const name = text(raw?.name, 120);
        if (!name) continue;
        const issues = Array.isArray(raw.issues) ? raw.issues.map((s) => text(s, 80)).filter(Boolean).slice(0, 4) : [];
        let category = text(raw.category, 80);
        if (!category) { category = GENERIC_CATEGORY; issues.push('No section heading found'); }

        const sizes = (Array.isArray(raw.sizes) ? raw.sizes : [])
            .map((s) => ({ name: text(s?.name, 40), price: cleanPrice(s?.price) }))
            .filter((s) => s.name && s.price !== null)
            .slice(0, 8);

        let basePrice = cleanPrice(raw.price);
        if (raw.price !== null && raw.price !== undefined && raw.price !== '' && basePrice === null) issues.push('Price looked wrong and was cleared');
        if (basePrice === null && sizes.length) basePrice = Math.min(...sizes.map((s) => s.price));
        if (basePrice === null) issues.push('Price missing');

        let vegType = raw.veg_type === 'non-veg' ? 'non-veg' : raw.veg_type === 'veg' ? 'veg' : null;
        let confidence = clamp01(raw.certainty);
        if (!vegType) {
            vegType = NON_VEG.test(name) ? 'non-veg' : 'veg';
            issues.push('Veg / non-veg was guessed from the name');
            confidence = Math.max(0, confidence - 0.1);
        }

        const page = Number.isInteger(raw.page) && raw.page > 0 ? raw.page : 1;
        const level = levelByPage.get(page);
        if (level === 'blurry') confidence = Math.max(0, confidence - 0.15);
        else if (level === 'soft') confidence = Math.max(0, confidence - 0.05);
        if (basePrice === null) confidence = Math.min(confidence, 0.4);

        const row = {
            name,
            category,
            description: text(raw.description, 300),
            basePrice,
            priceText: text(raw.price_text, 40),
            vegType,
            sizes,
            page,
            box: cleanBox(raw.box),
            confidence: Math.round(confidence * 100) / 100,
            issues: [...new Set(issues)],
        };
        row.needsCheck = row.confidence < 0.7 || basePrice === null || row.issues.length > 0;

        // Same dish seen twice (overlapping photos): keep the more confident read.
        const k = keyOf(name, category);
        const prev = byKey.get(k);
        if (!prev || row.confidence > prev.confidence) byKey.set(k, row);
    }

    return [...byKey.values()].slice(0, MAX_ROWS).map((r, i) => ({ id: `r${i + 1}`, ...r }));
}

/**
 * Merge a second reading of the hard pages into the first. When both passes
 * agree the row gains confidence; when the price differs the row is flagged
 * and keeps the lower-risk answer (no price).
 */
function mergePasses(first, second) {
    const secondByKey = new Map();
    for (const it of second || []) secondByKey.set(keyOf(it?.name, it?.category), it);
    const merged = (first || []).map((it) => {
        const other = secondByKey.get(keyOf(it?.name, it?.category));
        if (!other) return it;
        secondByKey.delete(keyOf(it?.name, it?.category));
        const a = cleanPrice(it.price);
        const b = cleanPrice(other.price);
        if (a !== null && b !== null && a !== b) {
            return { ...it, price: null, certainty: Math.min(clamp01(it.certainty), 0.35), issues: [...(it.issues || []), `Price read as ${a} and as ${b}`] };
        }
        return { ...it, certainty: Math.min(1, clamp01(it.certainty) + 0.05) };
    });
    // Items only the second pass found are kept, but flagged.
    for (const it of secondByKey.values()) {
        merged.push({ ...it, certainty: Math.min(clamp01(it.certainty), 0.6), issues: [...(it.issues || []), 'Found on second reading only'] });
    }
    return merged;
}

module.exports = { buildDraft, mergePasses, MAX_ROWS };
