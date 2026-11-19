/** scripts/repair-cross-tenant-refs.js against the in-memory DB only. */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Table = require(path.join(BACKEND, 'models/table'));
const { repairCrossTenantRefs } = require(path.join(BACKEND, 'scripts/repair-cross-tenant-refs'));

useIntegrationApp();
let A; let B; let rawId;
beforeAll(async () => {
    A = await seedTenant({ label: 'rep-a' });
    B = await seedTenant({ label: 'rep-b' });
    const r = await Table.collection.insertOne({
        restaurant: A.restaurant._id, branch: A.branch._id, area: B.area._id, name: 'REPAIR-RAW', capacity: 2,
        qrToken: 'tb-repairraw1', isDeleted: false, status: 'free', createdAt: new Date(), updatedAt: new Date(),
    });
    rawId = r.insertedId;
});

test('dry run reports the cross-tenant ref and writes nothing; --apply nulls it; second run is clean', async () => {
    const dry = await repairCrossTenantRefs({ apply: false, models: ['Table'] });
    expect(dry.details.some((d) => d._id === String(rawId) && d.path === 'area')).toBe(true);
    expect(String((await Table.collection.findOne({ _id: rawId })).area)).toBe(String(B.area._id));

    const done = await repairCrossTenantRefs({ apply: true, models: ['Table'] });
    expect(done.fixed).toBeGreaterThan(0);
    expect((await Table.collection.findOne({ _id: rawId })).area).toBeNull();
    // own-tenant refs untouched
    expect(String((await Table.collection.findOne({ _id: A.tables.main._id })).area)).toBe(String(A.area._id));

    const again = await repairCrossTenantRefs({ apply: true, models: ['Table'] });
    expect(again.found).toBe(0);
});
