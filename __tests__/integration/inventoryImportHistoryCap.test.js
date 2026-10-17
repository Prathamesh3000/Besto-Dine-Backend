/**
 * Inventory CSV import — adjustmentHistory cap.
 *
 * Every atomic writer of Inventory.adjustmentHistory uses
 * `$push … $slice: -200`; the CSV import mutated the array in memory and
 * saved it, with no cap, so an item re-imported on every stock count grew
 * its history without limit (DATABASE_SCALING_PLAN.md A2-now #4). The
 * import now trims to the newest 200 like the others.
 *
 * Endpoint: POST /inventory/import (multipart `file`), routes/inventoryRoute.js.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Inventory = require(path.join(BACKEND, 'models/inventory'));

const ctx = useIntegrationApp();
let A;

beforeAll(async () => {
    A = await seedTenant({ label: 'inv-hist' });
});

const admin = () => ctx.api.as(A.users.admin, A);

const HEADER = 'name,category,unit,minStock,costPerUnit,currentStock';
const csv = (name, currentStock) => Buffer.from(`${HEADER}\n${name},Raw Ingredients,kg,1,10,${currentStock}\n`, 'utf8');

function historyRow(i) {
    return {
        type: 'restock',
        quantity: 1,
        previousStock: i,
        newStock: i + 1,
        reason: `seed ${i}`,
        adjustedBy: A.users.admin._id,
        date: new Date(Date.now() - (1000 - i) * 60000),
    };
}

async function seedItem(name, historyLength) {
    return Inventory.create({
        restaurant: A.restaurant._id,
        branch: null,
        itemId: `INV-HIST-${name}`,
        name,
        category: 'Raw Ingredients',
        unit: 'kg',
        currentStock: 5,
        minStock: 1,
        costPerUnit: 10,
        adjustmentHistory: Array.from({ length: historyLength }, (_, i) => historyRow(i)),
    });
}

function upload(buffer) {
    return admin().post('/inventory/import').attach('file', buffer, { filename: 'stock.csv', contentType: 'text/csv' });
}

test('an item already holding 200 history rows keeps exactly 200 after a CSV stock update, newest last', async () => {
    const item = await seedItem('Basmati Rice', 200);
    expect(item.adjustmentHistory).toHaveLength(200);

    const res = await upload(csv('Basmati Rice', 7));
    expect([200, 201]).toContain(res.status);
    expect(res.body.success).toBe(true);
    expect(res.body.errors || []).toEqual([]);
    expect(Number(res.body.updated)).toBe(1);

    const after = await Inventory.findById(item._id).lean();
    expect(after.currentStock).toBe(7);
    expect(after.adjustmentHistory).toHaveLength(200);
    const last = after.adjustmentHistory[after.adjustmentHistory.length - 1];
    expect(last).toMatchObject({ type: 'restock', quantity: 2, previousStock: 5, newStock: 7, reason: 'CSV import' });
    // The oldest seed row (seed 0) was dropped; seed 1 is now first.
    expect(after.adjustmentHistory[0].reason).toBe('seed 1');
});

test('an item well under the cap just gains one row (no trimming below 200)', async () => {
    const item = await seedItem('Toor Dal', 50);
    const res = await upload(csv('Toor Dal', 4));
    expect(res.body.success).toBe(true);
    const after = await Inventory.findById(item._id).lean();
    expect(after.adjustmentHistory).toHaveLength(51);
    expect(after.adjustmentHistory[0].reason).toBe('seed 0');
    expect(after.adjustmentHistory[50]).toMatchObject({ type: 'correction', quantity: 1, reason: 'CSV import' });
});

test('a CSV row with unchanged stock adds no history row', async () => {
    const item = await seedItem('Sugar', 3);
    const res = await upload(csv('Sugar', 5));
    expect(res.body.success).toBe(true);
    const after = await Inventory.findById(item._id).lean();
    expect(after.adjustmentHistory).toHaveLength(3);
});

// No afterAll cleanup: useIntegrationApp() drops the per-file database
// itself, and its own afterAll closes the connection before ours would run.
