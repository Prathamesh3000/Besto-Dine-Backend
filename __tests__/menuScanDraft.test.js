const { buildDraft, mergePasses } = require('../utils/menuScan/draft');

describe('menu scan draft', () => {
    test('clean row keeps price and is not flagged', () => {
        const [r] = buildDraft([{ name: 'Paneer Tikka', category: 'Starters', price: 240, veg_type: 'veg', certainty: 0.95, page: 1 }]);
        expect(r).toMatchObject({ name: 'Paneer Tikka', category: 'Starters', basePrice: 240, vegType: 'veg', needsCheck: false });
        expect(r.id).toBe('r1');
    });

    test('unreadable price stays null, is capped and flagged (never guessed)', () => {
        const [r] = buildDraft([{ name: 'Dal', category: 'Mains', price: null, veg_type: 'veg', certainty: 0.9 }]);
        expect(r.basePrice).toBeNull();
        expect(r.confidence).toBeLessThanOrEqual(0.4);
        expect(r.needsCheck).toBe(true);
        expect(r.issues).toContain('Price missing');
    });

    test('absurd or negative prices are cleared', () => {
        const rows = buildDraft([
            { name: 'A', category: 'X', price: -5, veg_type: 'veg', certainty: 0.9 },
            { name: 'B', category: 'X', price: 9999999, veg_type: 'veg', certainty: 0.9 },
        ]);
        expect(rows.map((r) => r.basePrice)).toEqual([null, null]);
    });

    test('unknown veg type is inferred from the name and flagged', () => {
        const rows = buildDraft([
            { name: 'Chicken 65', category: 'Starters', price: 200, veg_type: 'unknown', certainty: 0.9 },
            { name: 'Gobi Manchurian', category: 'Starters', price: 150, veg_type: 'unknown', certainty: 0.9 },
        ]);
        expect(rows[0].vegType).toBe('non-veg');
        expect(rows[1].vegType).toBe('veg');
        expect(rows.every((r) => r.needsCheck)).toBe(true);
    });

    test('sizes fill the base price with the lowest size', () => {
        const [r] = buildDraft([{ name: 'Biryani', category: 'Rice', price: null, veg_type: 'non-veg', certainty: 0.9, sizes: [{ name: 'Full', price: 320 }, { name: 'Half', price: 180 }] }]);
        expect(r.basePrice).toBe(180);
        expect(r.sizes).toHaveLength(2);
    });

    test('blurry page lowers confidence', () => {
        const base = { name: 'Naan', category: 'Breads', price: 40, veg_type: 'veg', certainty: 0.9, page: 2 };
        const [clear] = buildDraft([base], [{ index: 2, level: 'good' }]);
        const [blur] = buildDraft([base], [{ index: 2, level: 'blurry' }]);
        expect(blur.confidence).toBeLessThan(clear.confidence);
    });

    test('duplicates keep the more confident read; empty names dropped; boxes validated', () => {
        const rows = buildDraft([
            { name: 'Lassi', category: 'Drinks', price: 60, veg_type: 'veg', certainty: 0.5 },
            { name: ' lassi ', category: 'drinks', price: 60, veg_type: 'veg', certainty: 0.9, box: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 } },
            { name: '', category: 'Drinks', price: 10, certainty: 1 },
            { name: 'Tea', category: 'Drinks', price: 20, veg_type: 'veg', certainty: 0.9, box: { x: 2, y: 0, w: 1, h: 1 } },
        ]);
        expect(rows.map((r) => r.name)).toEqual(['lassi', 'Tea']);
        expect(rows[0].box).not.toBeNull();
        expect(rows[1].box).toBeNull();
    });

    test('missing category falls back and is flagged', () => {
        const [r] = buildDraft([{ name: 'Soup', price: 90, veg_type: 'veg', certainty: 0.9 }]);
        expect(r.category).toBe('Menu');
        expect(r.needsCheck).toBe(true);
    });

    test('second pass: agreeing prices add confidence, disagreeing prices cleared and flagged', () => {
        const first = [
            { name: 'Naan', category: 'Breads', price: 40, certainty: 0.7 },
            { name: 'Roti', category: 'Breads', price: 20, certainty: 0.7 },
        ];
        const second = [
            { name: 'Naan', category: 'Breads', price: 40, certainty: 0.7 },
            { name: 'Roti', category: 'Breads', price: 30, certainty: 0.7 },
            { name: 'Paratha', category: 'Breads', price: 50, certainty: 0.9 },
        ];
        const merged = mergePasses(first, second);
        expect(merged.find((i) => i.name === 'Naan').certainty).toBeGreaterThan(0.7);
        const roti = merged.find((i) => i.name === 'Roti');
        expect(roti.price).toBeNull();
        expect(roti.issues.join(' ')).toMatch(/20.*30/);
        expect(merged.find((i) => i.name === 'Paratha').certainty).toBeLessThanOrEqual(0.6);
    });
});
