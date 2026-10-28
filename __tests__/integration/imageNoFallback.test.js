/**
 * No stock images (2026-10-28): a menu item, combo or category the admin
 * never gave a photo stays WITHOUT one. The CSV importer no longer picks a
 * pool Unsplash photo, the scheduled healers never fill one in (they only
 * clear the legacy placeholder / dead URLs), and a new category defaults
 * to an empty image instead of '/uploads/Thumbnil.png'.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const MenuItem = require(path.join(BACKEND, 'models/menuItem'));
const Combo = require(path.join(BACKEND, 'models/combo'));
const Category = require(path.join(BACKEND, 'models/category'));
const Hall = require(path.join(BACKEND, 'models/hall'));
const { runMenuItemImageHeal } = require(path.join(BACKEND, 'utils/menuItemImageHealer'));
const { runCategoryImageHeal } = require(path.join(BACKEND, 'utils/categoryImageHealer'));

const ctx = useIntegrationApp();
let A;
beforeAll(async () => { A = await seedTenant({ label: 'noimg-a' }); });

const admin = () => ctx.api.as(A.users.admin, A);
const importCsv = (csv) => admin().post('/menu/import').attach('file', Buffer.from(csv, 'utf8'), { filename: 'm.csv', contentType: 'text/csv' });
const PLACEHOLDER = '/uploads/Thumbnil.png';

describe('CSV import', () => {
    test('a row without an image is saved with images: [] (no stock photo)', async () => {
        const res = await importCsv('name,description,category,baseprice\nBlank Tikka,Tikka,Starters,200\n');
        expect(res.status).toBe(200);
        const item = await MenuItem.findOne({ restaurant: A.restaurant._id, name: 'Blank Tikka' }).lean();
        expect(item).toBeTruthy();
        expect(item.images).toEqual([]);
    });

    test('a known-dead placeholder host is dropped, a real URL is kept', async () => {
        const csv = 'name,description,category,baseprice,images\n'
            + 'Dead Pic,x,Starters,100,https://source.unsplash.com/random/400x300\n'
            + 'Real Pic,x,Starters,100,/uploads/real-pic.jpg\n';
        const res = await importCsv(csv);
        expect(res.status).toBe(200);
        const dead = await MenuItem.findOne({ restaurant: A.restaurant._id, name: 'Dead Pic' }).lean();
        const real = await MenuItem.findOne({ restaurant: A.restaurant._id, name: 'Real Pic' }).lean();
        expect(dead.images).toEqual([]);
        expect(real.images).toEqual(['/uploads/real-pic.jpg']);
    });
});

describe('category default', () => {
    test('a new category has an empty image, not the placeholder', async () => {
        const cat = await Category.create({ name: 'No Pic Cat', restaurant: A.restaurant._id });
        expect(cat.image).toBe('');
    });
});

describe('scheduled healers never fill an image in', () => {
    test('menu items + combos: empty stays empty, placeholder is cleared, uploads untouched', async () => {
        const r = A.restaurant._id;
        const cat = await Category.create({ name: 'Heal Cat', restaurant: r });
        const base = { restaurant: r, category: cat._id, description: 'x', basePrice: 10, finalPrice: 10 };
        const empty = await MenuItem.create({ ...base, name: 'Heal Empty', images: [] });
        const ph = await MenuItem.create({ ...base, name: 'Heal Placeholder', images: [PLACEHOLDER] });
        const up = await MenuItem.create({ ...base, name: 'Heal Upload', images: ['/uploads/mine.jpg'] });
        // bypass validation: only the image field matters here
        const comboIns = await Combo.collection.insertOne({ name: 'Heal Combo', restaurant: r, images: [PLACEHOLDER] });

        await runMenuItemImageHeal();

        expect((await MenuItem.findById(empty._id).lean()).images).toEqual([]);
        expect((await MenuItem.findById(ph._id).lean()).images).toEqual([]);
        expect((await MenuItem.findById(up._id).lean()).images).toEqual(['/uploads/mine.jpg']);
        expect((await Combo.collection.findOne({ _id: comboIns.insertedId })).images).toEqual([]);
        // nothing anywhere got a stock Unsplash photo
        const unsplash = await MenuItem.countDocuments({ restaurant: r, 'images.0': /unsplash/ });
        expect(unsplash).toBe(0);
    });

    test('categories: empty stays empty, placeholder is cleared, uploads untouched', async () => {
        const r = A.restaurant._id;
        const empty = await Category.create({ name: 'Cat Empty', restaurant: r, image: '' });
        const ph = await Category.create({ name: 'Cat Placeholder', restaurant: r, image: PLACEHOLDER });
        const up = await Category.create({ name: 'Cat Upload', restaurant: r, image: '/uploads/cat.jpg' });

        await runCategoryImageHeal();

        expect((await Category.findById(empty._id).lean()).image).toBe('');
        expect((await Category.findById(ph._id).lean()).image).toBe('');
        expect((await Category.findById(up._id).lean()).image).toBe('/uploads/cat.jpg');
        expect(await Category.countDocuments({ restaurant: r, image: /unsplash/ })).toBe(0);
    });
});

describe('hall list', () => {
    test('a hall without images is returned with image: "" and images: [] (no stock photo)', async () => {
        // bypass validation: only the images field matters here
        const ins = await Hall.collection.insertOne({
            name: 'Blank Hall', type: 'Banquet Hall', maxCapacity: 50, basePrice: 1000,
            restaurant: A.restaurant._id, branch: null, images: [], isActive: true,
        });
        const res = await ctx.api.guest(A).get('/halls');
        expect(res.status).toBe(200);
        const hall = res.body.halls.find((h) => String(h._id) === String(ins.insertedId));
        expect(hall).toBeTruthy();
        expect(hall.images).toEqual([]);
        expect(hall.image).toBe('');
        expect(res.body.halls.some((h) => /unsplash/.test(h.image || ''))).toBe(false);
    });
});
