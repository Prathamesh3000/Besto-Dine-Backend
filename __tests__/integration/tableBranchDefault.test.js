/**
 * A table created / imported / edited without a branch lands in the
 * tenant's Main branch, so it shows in the admin Tables view (which
 * filters strictly by the selected branch). Before this, such tables
 * were stored with branch:null and were invisible there.
 */
const path = require('path');
const { useIntegrationApp } = require('./helpers/harness');
const { seedTenant } = require('./helpers/seed');

const BACKEND = path.join(__dirname, '..', '..');
const Table = require(path.join(BACKEND, 'models/table'));
const Branch = require(path.join(BACKEND, 'models/branch'));

const ctx = useIntegrationApp();
let A;

beforeAll(async () => {
    A = await seedTenant({ label: 'tbd' });
});

const admin = () => ctx.api.as(A.users.admin);

test('create without a branch → Main branch, visible in the strict branch view', async () => {
    const res = await admin().post('/tables').send({ name: 'No Branch 1', capacity: 4, area: String(A.area._id) });
    expect(res.status).toBe(201);
    const saved = await Table.findOne({ restaurant: A.restaurant._id, name: 'No Branch 1' }).lean();
    expect(String(saved.branch)).toBe(String(A.branch._id));

    const list = await admin().get(`/tables?branch=${A.branch._id}`);
    expect(list.status).toBe(200);
    const names = (list.body.tables || list.body.data || []).map((t) => t.name);
    expect(names).toContain('No Branch 1');
});

test('empty-string branch on create and on edit also resolves to Main', async () => {
    const res = await admin().post('/tables').send({ name: 'No Branch 2', capacity: 2, area: String(A.area._id), branch: '' });
    expect(res.status).toBe(201);
    const t = await Table.findOne({ restaurant: A.restaurant._id, name: 'No Branch 2' }).lean();
    expect(String(t.branch)).toBe(String(A.branch._id));

    const upd = await admin().put(`/tables/${t._id}`).send({ branch: '' });
    expect(upd.status).toBe(200);
    expect(String((await Table.findById(t._id).lean()).branch)).toBe(String(A.branch._id));
});

test('an explicit other branch is still honoured', async () => {
    const second = await Branch.create({ restaurant: A.restaurant._id, name: 'Kothrud', slug: 'kothrud', isActive: true });
    const res = await admin().post('/tables').send({ name: 'K1', capacity: 4, area: String(A.area._id), branch: String(second._id) });
    expect(res.status).toBe(201);
    expect(String((await Table.findOne({ restaurant: A.restaurant._id, name: 'K1' }).lean()).branch)).toBe(String(second._id));
});
