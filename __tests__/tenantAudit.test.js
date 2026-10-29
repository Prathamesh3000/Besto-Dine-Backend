/**
 * Tenant audit log (plan task 2.1): service never throws, redaction + size
 * cap, hook adapters, API visibility rules, filters and CSV.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreate = jest.fn();
const mockFind = jest.fn();
const mockCount = jest.fn();
jest.mock('../models/tenantAudit', () => ({
    ACTIONS: ['order.cancel', 'order.void', 'order.discount', 'order.refund', 'bill.edit', 'bill.finalize', 'staff.create', 'staff.permission_change', 'staff.role_change', 'settings.change', 'menu.price_change', 'other'],
    create: (...a) => mockCreate(...a),
    find: (...a) => mockFind(...a),
    countDocuments: (...a) => mockCount(...a),
}));

const { recordTenantAudit, prepareSnapshot, MAX_BYTES } = require('../services/tenantAuditService');
const hooks = require('../services/tenantAuditHooks');
const ctrl = require('../controllers/auditController');

const oid = (n) => String(n).padStart(24, '0');
const req = (over = {}) => ({
    user: { _id: oid(1), name: 'Asha', role: 'admin' },
    restaurant: { _id: oid(9) },
    branch: { _id: oid(5) },
    ip: '1.2.3.4',
    query: {},
    ...over,
});
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => { jest.clearAllMocks(); mockCreate.mockImplementation(async (d) => d); });

describe('recordTenantAudit', () => {
    test('writes actor, tenant, branch, ip and action', async () => {
        const doc = await recordTenantAudit(req(), { action: 'order.cancel', entityType: 'order', entityId: 'ORD1', summary: 's' });
        expect(doc.restaurant).toBe(oid(9));
        expect(doc.branch).toBe(oid(5));
        expect(doc.actor).toEqual({ id: oid(1), name: 'Asha', role: 'admin' });
        expect(doc.action).toBe('order.cancel');
        expect(doc.ip).toBe('1.2.3.4');
    });

    test('unknown action falls back to other', async () => {
        const doc = await recordTenantAudit(req(), { action: 'nope' });
        expect(doc.action).toBe('other');
    });

    test('never throws when the DB write fails', async () => {
        mockCreate.mockRejectedValue(new Error('db down'));
        await expect(recordTenantAudit(req(), { action: 'other' })).resolves.toBeNull();
    });

    test('never throws on garbage input or a throwing create', async () => {
        mockCreate.mockImplementation(() => { throw new Error('sync boom'); });
        await expect(recordTenantAudit(null, null)).resolves.toBeNull();
        await expect(recordTenantAudit(undefined, { action: 'other' })).resolves.toBeNull();
        await expect(recordTenantAudit(req(), { action: 'other' })).resolves.toBeNull();
    });

    test('without awaiting, a failure never becomes an unhandled rejection', async () => {
        mockCreate.mockRejectedValue(new Error('db down'));
        const p = recordTenantAudit(req(), { action: 'other' });
        expect(typeof p.then).toBe('function');
        await flush();
    });

    test('skips (no write) when there is no tenant', async () => {
        const r = await recordTenantAudit({ user: { _id: oid(1) } }, { action: 'other' });
        expect(r).toBeNull();
        expect(mockCreate).not.toHaveBeenCalled();
    });
});

describe('snapshots', () => {
    test('redacts secret and PII-ish keys, keeps ordinary ones', () => {
        const out = prepareSnapshot({ password: 'x', apiKey: 'k', email: 'a@b.c', phone: '99', tokenNumber: 7, company: 'Acme', nested: { secret: 's', price: 10 } });
        expect(out.password).toBe('[REDACTED]');
        expect(out.apiKey).toBe('[REDACTED]');
        expect(out.email).toBe('[REDACTED]');
        expect(out.phone).toBe('[REDACTED]');
        expect(out.tokenNumber).toBe(7);
        expect(out.company).toBe('Acme');
        expect(out.nested).toEqual({ secret: '[REDACTED]', price: 10 });
    });

    test('caps oversized snapshots at ~8KB', () => {
        const big = { items: Array.from({ length: 50 }, (_, i) => ({ n: 'x'.repeat(400) + i })) };
        const out = prepareSnapshot(big);
        expect(out._truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(MAX_BYTES);
    });

    test('handles circular structures', () => {
        const a = { n: 1 }; a.self = a;
        expect(() => prepareSnapshot(a)).not.toThrow();
    });
});

describe('hook adapters', () => {
    test('cancel of an unpaid order records order.cancel; paid records order.void', async () => {
        hooks.auditOrderUpdate(req(), { status: 'new', paymentStatus: 'Pending' }, { orderId: 'O1', status: 'cancelled' });
        hooks.auditOrderUpdate(req(), { status: 'new', paymentStatus: 'Paid' }, { orderId: 'O2', status: 'cancelled' });
        await flush();
        expect(mockCreate.mock.calls.map((c) => c[0].action)).toEqual(['order.cancel', 'order.void']);
    });

    test('discount change recorded only when it changes', async () => {
        hooks.auditOrderUpdate(req(), { status: 'new', manualDiscount: 10 }, { orderId: 'O1', status: 'new', manualDiscount: 10 });
        hooks.auditOrderUpdate(req(), { status: 'new', manualDiscount: 10 }, { orderId: 'O1', status: 'new', manualDiscount: 25 });
        await flush();
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockCreate.mock.calls[0][0].action).toBe('order.discount');
        expect(mockCreate.mock.calls[0][0].after).toEqual({ manualDiscount: 25 });
    });

    test('adapters swallow bad input', () => {
        expect(() => hooks.auditOrderUpdate(null, null, null)).not.toThrow();
        expect(() => hooks.auditStaff(null, 'create', null, null)).not.toThrow();
        expect(() => hooks.auditSettingsChange(null, null, null)).not.toThrow();
        expect(() => hooks.auditMenuPrice(null, null, null)).not.toThrow();
    });

    test('staff role + permission changes are separate rows', async () => {
        hooks.auditStaff(req(), 'update',
            { _id: oid(3), name: 'B', role: 'waiter', permissions: { refund: false } },
            { _id: oid(3), name: 'B', role: 'captain', permissions: { refund: true } });
        await flush();
        expect(mockCreate.mock.calls.map((c) => c[0].action).sort()).toEqual(['staff.permission_change', 'staff.role_change']);
    });

    test('settings change records changed keys only and hides secrets', async () => {
        hooks.auditSettingsChange(req(), { taxRate: 5, same: 1, upiId: 'a@upi' }, { taxRate: 8, same: 1, upiId: 'b@upi' }, 'taxes');
        await flush();
        const d = mockCreate.mock.calls[0][0];
        expect(d.action).toBe('settings.change');
        expect(Object.keys(d.after).sort()).toEqual(['taxRate', 'upiId']);
        expect(d.after.upiId).toBe('[REDACTED]');
        expect(d.after.taxRate).toBe(8);
    });

    test('menu price change only when price fields differ', async () => {
        hooks.auditMenuPrice(req(), { _id: oid(4), name: 'Tea', basePrice: 10 }, { _id: oid(4), name: 'Tea2', basePrice: 10 });
        hooks.auditMenuPrice(req(), { _id: oid(4), name: 'Tea', basePrice: 10 }, { _id: oid(4), name: 'Tea', basePrice: 12 });
        await flush();
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockCreate.mock.calls[0][0].action).toBe('menu.price_change');
    });
});

describe('API visibility + filters', () => {
    const chain = (rows) => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }), limit: () => ({ lean: async () => rows }) }) });
    const res = () => { const r = { headers: {} }; r.json = jest.fn(() => r); r.status = jest.fn(() => r); r.setHeader = (k, v) => { r.headers[k] = v; }; r.send = jest.fn(() => r); return r; };

    test('other roles are refused (403)', () => {
        for (const role of ['waiter', 'chef', 'captain', 'customer', 'superadmin']) {
            expect(() => ctrl.buildFilter(req({ user: { _id: oid(2), role } }))).toThrow(expect.objectContaining({ status: 403 }));
        }
    });

    test('admin sees all and may filter by actor', () => {
        const f = ctrl.buildFilter(req({ query: { actorId: oid(7) } }));
        expect(String(f['actor.id'])).toBe(oid(7));
        expect(String(f.restaurant)).toBe(oid(9));
        expect(ctrl.buildFilter(req())['actor.id']).toBeUndefined();
    });

    test('manager is pinned to own actions even when asking for another actor', () => {
        const f = ctrl.buildFilter(req({ user: { _id: oid(2), role: 'manager' }, query: { actorId: oid(7) } }));
        expect(String(f['actor.id'])).toBe(oid(2));
    });

    test('filters: action, entity, date range, validation', () => {
        const f = ctrl.buildFilter(req({ query: { action: 'order.refund', entityType: 'order', entityId: 'O1', from: '2026-01-01', to: '2026-01-31' } }));
        expect(f.action).toBe('order.refund');
        expect(f.entityType).toBe('order');
        expect(f.entityId).toBe('O1');
        expect(f.createdAt.$gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(f.createdAt.$lte.toISOString()).toBe('2026-01-31T23:59:59.999Z');
        expect(() => ctrl.buildFilter(req({ query: { action: 'bogus' } }))).toThrow(expect.objectContaining({ status: 400 }));
        expect(() => ctrl.buildFilter(req({ query: { from: 'junk' } }))).toThrow(expect.objectContaining({ status: 400 }));
        expect(() => ctrl.buildFilter(req({ query: { actorId: 'x' } }))).toThrow(expect.objectContaining({ status: 400 }));
    });

    test('listAudit paginates and returns totals', async () => {
        mockFind.mockReturnValue(chain([{ action: 'other' }]));
        mockCount.mockResolvedValue(51);
        const r = res();
        await ctrl.listAudit(req({ query: { limit: '25', page: '2' } }), r, jest.fn());
        const body = r.json.mock.calls[0][0];
        expect(body).toMatchObject({ success: true, page: 2, limit: 25, total: 51, pages: 3 });
    });

    test('listAudit answers 403 for a waiter', async () => {
        const r = res();
        await ctrl.listAudit(req({ user: { _id: oid(2), role: 'waiter' } }), r, jest.fn());
        expect(r.status).toHaveBeenCalledWith(403);
    });
});

describe('CSV', () => {
    test('quotes, escapes and neutralises formula injection', () => {
        expect(ctrl.csvCell('a"b')).toBe('"a""b"');
        expect(ctrl.csvCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');
        expect(ctrl.csvCell(null)).toBe('""');
    });

    test('toCsv has a header and one line per row', () => {
        const csv = ctrl.toCsv([{ createdAt: new Date('2026-01-01T00:00:00Z'), action: 'order.cancel', actor: { id: oid(1), name: 'A, B', role: 'admin' }, entityType: 'order', entityId: 'O1', summary: 'x', before: { a: 1 }, after: null, ip: '1.1.1.1' }]);
        const lines = csv.trim().split('\r\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('createdAt,action,actorName');
        expect(lines[1]).toContain('"2026-01-01T00:00:00.000Z"');
        expect(lines[1]).toContain('"A, B"');
        expect(lines[1]).toContain('"{""a"":1}"');
    });
});
