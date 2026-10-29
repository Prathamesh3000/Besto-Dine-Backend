/**
 * Unit tests for small shared utils (checklist 10.14):
 *   - utils/prepStationInfer   — name/category → kitchen | bar | counter
 *   - utils/idGenerator        — human-readable id format + uniqueness
 *   - utils/menuAvailability   — day / time windows, overnight windows
 *   - utils/audit              — secret redaction, never throws
 *   - utils/alerts             — cooldown via audit log, never throws,
 *                                HTML escaping of tenant-controlled names
 *   - utils/email              — provider selection + SMTP fallback
 *   - utils/emailTemplates     — HTML escaping of user-supplied names
 *   - utils/imageLiveness      — SSRF guard, status classification
 *
 * No DB and no network: models, nodemailer and fetch are mocked.
 */
const mockAuditCreate = jest.fn();
const mockAuditFindOne = jest.fn();
const mockUserFind = jest.fn();
const mockOrderAggregate = jest.fn();
const mockRestaurantFind = jest.fn();
const mockSendMail = jest.fn();

jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// uuid@13 is ESM-only and the unit Jest runtime cannot require it.
jest.mock('uuid', () => ({ v4: () => require('crypto').randomUUID() }));
jest.mock('../models/auditLog', () => ({
    create: (...a) => mockAuditCreate(...a),
    findOne: (...a) => mockAuditFindOne(...a),
}));
jest.mock('../models/user', () => ({ find: (...a) => mockUserFind(...a) }));
jest.mock('../models/order', () => ({ aggregate: (...a) => mockOrderAggregate(...a) }));
jest.mock('../models/restaurant', () => ({ find: (...a) => mockRestaurantFind(...a) }));
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: (...a) => mockSendMail(...a) }) }));

const { inferPrepStation, resolveOrderItemStation } = require('../utils/prepStationInfer');
const idGen = require('../utils/idGenerator');
const {
    buildAvailabilityFilter, currentDayShort, currentTimeHHMM, isStaffCaller,
} = require('../utils/menuAvailability');
const { recordAudit } = require('../utils/audit');
const templates = require('../utils/emailTemplates');
const { isSafeImageUrl, isPrivateAddress, urlStatus, resetLivenessCache } = require('../utils/imageLiveness');

/** Chainable `.select().lean()` stub resolving to `value`. */
const chain = (value) => ({ select: () => ({ lean: () => Promise.resolve(value) }), lean: () => Promise.resolve(value) });

const ENV_KEYS = ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SENDGRID_API_KEY',
    'RESEND_API_KEY', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'EMAIL_FROM', 'SUPERADMIN_ALERT_EMAILS', 'FRONTEND_URL'];
const savedEnv = {};
beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    jest.clearAllMocks();
});

// ─── prepStationInfer ───────────────────────────────────────────────
describe('prepStationInfer.inferPrepStation', () => {
    test.each([
        ['Bisleri 500 ml', '', 'counter'],
        ['Mineral Water', '', 'counter'],
        ['Coke can 330', '', 'counter'],
        ['Red Bull', '', 'counter'],
        ['Thums Up', '', 'counter'],
        ['Cold Coffee', '', 'bar'],
        ['Masala Chai', '', 'bar'],
        ['Mango Lassi', '', 'bar'],
        ['Paneer Tikka', 'Starters', 'kitchen'],
        ['Vanilla Scoop', 'Ice Cream', 'counter'],
        ['House Special', 'Beverages', 'bar'],
        ['', '', 'kitchen'],
        [null, undefined, 'kitchen'],
    ])('%p (category %p) → %s', (name, categoryName, expected) => {
        expect(inferPrepStation({ name, categoryName })).toBe(expected);
    });

    // Regression (fixed 2026-10): COUNTER_NAME_PATTERNS anchor "Qua" and "Slice" as whole words (and not "Pizza Slice").
    test.each([
        'Quattro Formaggi Pizza',
        'Aquarius Mocktail',
        'Butternut Squash Soup',
        'Pepperoni Pizza Slice',
    ])('%p must not be inferred as a counter (ready-to-serve) item', (name) => {
        expect(inferPrepStation({ name, categoryName: 'Mains' })).not.toBe('counter');
    });
});

describe('prepStationInfer.resolveOrderItemStation', () => {
    test.each([
        [{ prepStation: 'bar', name: 'Water' }, 'bar'],
        [{ prepStation: 'counter', name: 'Paneer Tikka' }, 'counter'],
        [{ prepStation: 'kitchen', name: 'Paneer Tikka', category: { name: 'Mains' } }, 'kitchen'],
        [{ prepStation: 'kitchen', name: 'Bisleri' }, 'counter'],
    ])('menuItem %p → %s', (menuItem, expected) => {
        expect(resolveOrderItemStation({ menuItem })).toBe(expected);
    });

    test('falls back to the order line name / category when the menu item is gone', () => {
        expect(resolveOrderItemStation({ menuItem: null, fallbackName: 'Iced Tea' })).toBe('bar');
        expect(resolveOrderItemStation({ menuItem: undefined, fallbackName: 'Dal', fallbackCategory: 'Packaged Foods' }))
            .toBe('counter');
    });

    test('an admin-chosen "kitchen" station is not overridden by a misfiring heuristic', () => {
        // Regression (fixed 2026-10): the anchored patterns no longer misfire, so 'kitchen' stands (the schema default 'kitchen' is still treated as "unset" for obvious sealed items — see Bisleri above).
        expect(resolveOrderItemStation({
            menuItem: { prepStation: 'kitchen', name: 'Quattro Formaggi Pizza', category: { name: 'Pizza' } },
        })).toBe('kitchen');
    });
});

// ─── idGenerator ────────────────────────────────────────────────────
describe('idGenerator', () => {
    test.each([
        ['orderId', 'ORD'], ['takeawayOrderId', 'ORT'], ['kioskOrderId', 'KSK'],
        ['tableBookingId', 'BKT'], ['hallBookingId', 'BKH'], ['transactionId', 'TXN'],
    ])('%s → %s-YYMMDD-XXXXXX', (fn, prefix) => {
        const id = idGen[fn]();
        expect(id).toMatch(new RegExp(`^${prefix}-\\d{6}-[0-9A-F]{6}$`));
        // Date part is in the restaurant zone (default Asia/Kolkata), not server-local.
        expect(id.split('-')[1]).toBe(idGen.getDatePart('Asia/Kolkata'));
    });

    test('generate() with a custom prefix', () => {
        expect(idGen.generate('RFD')).toMatch(/^RFD-\d{6}-[0-9A-F]{6}$/);
    });

    // Risk pin (deterministic): the random part is only 6 hex chars, i.e.
    // 16^6 ≈ 16.7M suffixes per prefix per day, shared across ALL tenants
    // (Order.orderId is globally unique) and the create path (now) retries a fresh suffix
    // on an orderId E11000. Birthday bound: ~50% chance of at least one
    // collision at ~4,800 orders/day platform-wide. A sampled uniqueness
    // check would be flaky (~11% for 2,000 ids), so the suffix space and the
    // resulting collision probability are asserted instead.
    test('the random suffix space is 16^6 per prefix per day (collision risk documented)', () => {
        const suffix = idGen.orderId().split('-')[2];
        expect(suffix).toMatch(/^[0-9A-F]{6}$/);

        const space = 16 ** 6;
        const pCollision = (n) => 1 - Math.exp(-(n * (n - 1)) / (2 * space));
        expect(pCollision(4800)).toBeGreaterThan(0.49);
        expect(pCollision(4800)).toBeLessThan(0.51);
    });
});

// ─── menuAvailability ───────────────────────────────────────────────
describe('menuAvailability', () => {
    // Local-time constructor: the util reads the server clock in local time.
    const local = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);

    test('currentDayShort / currentTimeHHMM read local time, zero padded', () => {
        const fri = local(2026, 10, 2, 7, 5); // 2 Oct 2026 is a Friday
        expect(currentDayShort(fri)).toBe('Fri');
        expect(currentTimeHHMM(fri)).toBe('07:05');
    });

    test.each([
        [{ user: { role: 'admin' } }, true],
        [{ user: { role: 'chef' } }, true],
        [{ user: { role: 'superadmin' } }, true],
        [{ user: { role: 'customer' } }, false],
        [{}, false],
        [undefined, false],
    ])('isStaffCaller(%p) → %p', (req, expected) => {
        expect(isStaffCaller(req)).toBe(expected);
    });

    // Tiny evaluator for the generated filter, so the window semantics
    // can be checked without Mongo.
    const evalExpr = (doc, e) => {
        if (typeof e === 'string' && e.startsWith('$')) return doc[e.slice(1)];
        if (e === null || typeof e !== 'object' || Array.isArray(e)) return e;
        const [op] = Object.keys(e);
        const a = e[op];
        switch (op) {
            case '$or': return a.some((x) => evalExpr(doc, x));
            case '$and': return a.every((x) => evalExpr(doc, x));
            case '$ifNull': { const v = evalExpr(doc, a[0]); return v == null ? a[1] : v; }
            case '$in': return a[1].includes(evalExpr(doc, a[0]));
            case '$lte': return evalExpr(doc, a[0]) <= evalExpr(doc, a[1]);
            case '$gte': return evalExpr(doc, a[0]) >= evalExpr(doc, a[1]);
            case '$gt': return evalExpr(doc, a[0]) > evalExpr(doc, a[1]);
            case '$eq': return evalExpr(doc, a[0]) === evalExpr(doc, a[1]);
            case '$cond': return evalExpr(doc, a[0]) ? evalExpr(doc, a[1]) : evalExpr(doc, a[2]);
            case '$strLenCP': return [...evalExpr(doc, a)].length;
            case '$concat': { const parts = a.map((x) => evalExpr(doc, x)); return parts.some((p) => p == null) ? null : parts.join(''); }
            default: throw new Error(`op ${op}`);
        }
    };
    const matches = (doc, now) => {
        const [dayGate, timeGate] = buildAvailabilityFilter(now).$and;
        const dayOk = dayGate.$or.some((c) => {
            if (c.availableDays.$exists === false) return doc.availableDays === undefined;
            if (c.availableDays.$size === 0) return Array.isArray(doc.availableDays) && doc.availableDays.length === 0;
            return (doc.availableDays || []).includes(c.availableDays);
        });
        return dayOk && evalExpr(doc, timeGate.$expr);
    };

    const FRI_0900 = local(2026, 10, 2, 9, 0);
    const FRI_1130 = local(2026, 10, 2, 11, 30);
    const FRI_2300 = local(2026, 10, 2, 23, 0);
    const SAT_0130 = local(2026, 10, 3, 1, 30);
    const SAT_0300 = local(2026, 10, 3, 3, 0);

    test.each([
        ['no restriction at all', {}, FRI_0900, true],
        ['empty days + blank times', { availableDays: [], startTime: '', endTime: '' }, SAT_0300, true],
        ['today listed', { availableDays: ['Fri'] }, FRI_0900, true],
        ['today not listed', { availableDays: ['Mon', 'Tue'] }, FRI_0900, false],
        ['inside 07:00–11:00', { startTime: '07:00', endTime: '11:00' }, FRI_0900, true],
        ['after 07:00–11:00', { startTime: '07:00', endTime: '11:00' }, FRI_1130, false],
        ['window boundary is inclusive (end)', { startTime: '07:00', endTime: '09:00' }, FRI_0900, true],
        ['only start set → no time gate', { startTime: '07:00', endTime: '' }, FRI_2300, true],
        ['overnight 22:00–02:00 at 23:00', { startTime: '22:00', endTime: '02:00' }, FRI_2300, true],
        ['overnight 22:00–02:00 at 01:30', { startTime: '22:00', endTime: '02:00' }, SAT_0130, true],
        ['overnight 22:00–02:00 at 03:00', { startTime: '22:00', endTime: '02:00' }, SAT_0300, false],
        ['Mon–Fri breakfast on Saturday', { availableDays: ['Mon', 'Fri'], startTime: '07:00', endTime: '11:00' }, local(2026, 10, 3, 9, 0), false],
    ])('%s', (_label, doc, now, expected) => {
        expect(matches(doc, now)).toBe(expected);
    });

    // Regression (fixed 2026-10): buildAvailabilityFilter zero-pads legacy "H:MM" bounds in the $expr (evaluator extended with $cond/$eq/$strLenCP/$concat).
    test.each([
        ['08:00 (before opening)', FRI_0900.getTime() - 3600000, false],
        ['12:00 (lunch)', local(2026, 10, 2, 12, 0).getTime(), true],
    ])('a "9:00"–"17:00" window at %s', (_l, ts, expected) => {
        expect(matches({ startTime: '9:00', endTime: '17:00' }, new Date(ts))).toBe(expected);
    });

    test('day gate uses the calendar day, so a Friday-only overnight window closes at midnight', () => {
        // Documented behaviour (not asserted as a bug): the late-night
        // tail of a Fri 22:00–02:00 window falls on Saturday and is hidden.
        expect(matches({ availableDays: ['Fri'], startTime: '22:00', endTime: '02:00' }, SAT_0130)).toBe(false);
    });
});

// ─── audit ──────────────────────────────────────────────────────────
describe('audit.recordAudit', () => {
    const req = { user: { _id: 'u1', email: 'sa@x.test', role: 'superadmin', superadminLevel: 'owner' }, ip: '1.2.3.4', headers: { 'user-agent': 'jest' } };

    test('redacts secret keys at any depth, case-insensitively', async () => {
        mockAuditCreate.mockResolvedValue({ _id: 'a1' });
        await recordAudit(req, {
            action: 'restaurant.create',
            details: { Password: 'p', nested: { apiKey: 'k', JWT: 'j', keep: 1 }, list: [{ token: 't' }], plan: 'pro' },
        });
        const doc = mockAuditCreate.mock.calls[0][0];
        expect(doc).toMatchObject({ actor: 'u1', actorEmail: 'sa@x.test', actorRole: 'superadmin', actorLevel: 'owner', ip: '1.2.3.4', userAgent: 'jest' });
        expect(doc.details).toEqual({
            Password: '[REDACTED]',
            nested: { apiKey: '[REDACTED]', JWT: '[REDACTED]', keep: 1 },
            list: [{ token: 't' }], // arrays are passed through untouched (see risks)
            plan: 'pro',
        });
    });

    test.each([
        ['no actor', { headers: {} }, { action: 'x' }],
        ['no action', req, { action: '' }],
    ])('%s → returns null without writing', async (_l, r, opts) => {
        expect(await recordAudit(r, opts)).toBeNull();
        expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    test('a failing write never throws', async () => {
        mockAuditCreate.mockRejectedValue(new Error('db down'));
        await expect(recordAudit(req, { action: 'x' })).resolves.toBeNull();
    });
});

// ─── alerts ─────────────────────────────────────────────────────────
describe('alerts', () => {
    let alerts;
    let mockSendEmail;
    let mockReadyState;
    beforeEach(() => {
        mockReadyState = 0;
        jest.isolateModules(() => {
            mockSendEmail = jest.fn().mockResolvedValue({ sent: true });
            jest.doMock('../utils/email', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));
            jest.doMock('mongoose', () => ({ connection: { get readyState() { return mockReadyState; } } }));
            alerts = require('../utils/alerts');
        });
    });
    afterEach(() => { jest.dontMock('../utils/email'); jest.dontMock('mongoose'); });

    const tenant = (extra = {}) => ({
        _id: 'r1', name: 'Cafe One', slug: 'cafe-one', contactEmail: 'o@c.test', status: 'active',
        subscription: { planName: 'Pro' }, ...extra,
    });

    test('recipients: env list wins, deduped + lowercased; else every superadmin', async () => {
        process.env.SUPERADMIN_ALERT_EMAILS = ' A@x.test, a@x.test ,b@x.test,, ';
        expect(await alerts.resolveRecipients()).toEqual(['a@x.test', 'b@x.test']);
        delete process.env.SUPERADMIN_ALERT_EMAILS;
        mockUserFind.mockReturnValue(chain([{ email: 'S1@x.test' }, { email: '' }, { email: 's1@x.test' }]));
        expect(await alerts.resolveRecipients()).toEqual(['s1@x.test']);
    });

    test('sends once, writes the audit record first, then honours the cooldown', async () => {
        process.env.SUPERADMIN_ALERT_EMAILS = 'ops@x.test';
        process.env.FRONTEND_URL = 'https://app.test/';
        mockAuditFindOne.mockReturnValueOnce(chain(null));
        mockAuditCreate.mockResolvedValue({});
        expect(await alerts.notifyTenantHalted(tenant())).toBe(true);
        expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
            action: alerts.ALERT.HALTED, targetId: 'r1', actorRole: 'system',
            details: expect.objectContaining({ recipients: ['ops@x.test'], reason: 'subscription.halted', plan: 'Pro' }),
        }));
        const mail = mockSendEmail.mock.calls[0][0];
        expect(mail.to).toBe('ops@x.test');
        expect(mail.html).toContain('href="https://app.test/superadmin/restaurants/r1"');
        expect(mail.text).not.toMatch(/<[^>]+>/);

        // Cooldown query looks for the same action + tenant within 7 days.
        mockAuditFindOne.mockReturnValueOnce(chain({ _id: 'prev' }));
        expect(await alerts.notifyTenantHalted(tenant())).toBe(false);
        const q = mockAuditFindOne.mock.calls[1][0];
        expect(q.action).toBe(alerts.ALERT.HALTED);
        const ageMs = Date.now() - q.createdAt.$gte.getTime();
        expect(Math.round(ageMs / 86400000)).toBe(7);
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['no recipients', () => { mockUserFind.mockReturnValue(chain([])); }],
        ['audit lookup throws', () => { mockAuditFindOne.mockImplementation(() => { throw new Error('boom'); }); }],
    ])('never throws: %s → false', async (_l, arrange) => {
        delete process.env.SUPERADMIN_ALERT_EMAILS;
        mockAuditFindOne.mockReturnValue(chain(null));
        arrange();
        await expect(alerts.notifyTenantCancelled(tenant())).resolves.toBe(false);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test('a failing email send is swallowed per-recipient', async () => {
        process.env.SUPERADMIN_ALERT_EMAILS = 'a@x.test,b@x.test';
        mockAuditFindOne.mockReturnValue(chain(null));
        mockAuditCreate.mockResolvedValue({});
        mockSendEmail.mockRejectedValueOnce(new Error('smtp down')).mockResolvedValueOnce({ sent: true });
        await expect(alerts.notifyTenantDormant(tenant())).resolves.toBe(true);
        expect(mockSendEmail).toHaveBeenCalledTimes(2);
    });

    test('checkDormantTenants alerts only tenants without recent orders', async () => {
        mockReadyState = 1;
        {
            process.env.SUPERADMIN_ALERT_EMAILS = 'ops@x.test';
            mockOrderAggregate.mockResolvedValue([{ _id: { toString: () => 'busy' }, count: 4 }]);
            mockRestaurantFind.mockReturnValue(chain([tenant({ _id: 'busy' }), tenant({ _id: 'idle', name: 'Idle' })]));
            mockAuditFindOne.mockReturnValue(chain(null));
            mockAuditCreate.mockResolvedValue({});
            expect(await alerts.checkDormantTenants()).toEqual({ scanned: 2, dormant: 1, alerted: 1, skipped: false });
            expect(mockAuditCreate.mock.calls[0][0].targetId).toBe('idle');
        }
    });

    test('checkDormantTenants skips when Mongo is not connected', async () => {
        expect(await alerts.checkDormantTenants()).toMatchObject({ skipped: true, scanned: 0 });
        expect(mockOrderAggregate).not.toHaveBeenCalled();
    });

    // Regression (fixed 2026-10): alerts.js escapes tenant name / slug / email / plan / status in the alert HTML (subjects stay plain text).
    test('tenant name is HTML-escaped in Super Admin alert emails', async () => {
        process.env.SUPERADMIN_ALERT_EMAILS = 'ops@x.test';
        mockAuditFindOne.mockReturnValue(chain(null));
        mockAuditCreate.mockResolvedValue({});
        const evil = '<a href="https://evil.test/login">Click to restore billing</a>';
        await alerts.notifyTenantHalted(tenant({ name: evil }));
        const { html } = mockSendEmail.mock.calls[0][0];
        expect(html).not.toContain('<a href="https://evil.test/login">');
        expect(html).toContain('&lt;a href=');
    });
});

// ─── email ──────────────────────────────────────────────────────────
describe('email.sendEmail provider selection', () => {
    let email;
    let fetchSpy;
    beforeEach(() => {
        for (const k of ENV_KEYS) delete process.env[k];
        jest.isolateModules(() => { email = require('../utils/email'); });
        fetchSpy = jest.spyOn(global, 'fetch');
    });
    afterEach(() => fetchSpy.mockRestore());

    const msg = { to: 'x@y.test', subject: 'Hi', html: '<p>Hello</p>', text: 'Hello' };
    const okRes = { ok: true, status: 202, text: async () => '' };
    const badRes = { ok: false, status: 403, text: async () => 'forbidden' };

    test('missing fields → not sent, no network', async () => {
        expect(await email.sendEmail({ to: 'x@y.test', subject: 'Hi' })).toEqual(
            { sent: false, provider: 'none', dev: false, error: 'missing required fields' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('no provider and no SMTP → dev mode (logged, not sent)', async () => {
        expect(await email.sendEmail(msg)).toEqual({ sent: false, provider: 'none', dev: true });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('SMTP creds alone select SMTP', async () => {
        Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p' });
        mockSendMail.mockResolvedValue({});
        expect(await email.sendEmail(msg)).toEqual({ sent: true, provider: 'smtp', dev: false });
        expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'x@y.test', from: 'u' }));
    });

    test.each([
        ['sendgrid', { SENDGRID_API_KEY: 'sg' }, 'https://api.sendgrid.com/v3/mail/send', 'Bearer sg'],
        ['resend', { RESEND_API_KEY: 're' }, 'https://api.resend.com/emails', 'Bearer re'],
        ['mailgun', { MAILGUN_API_KEY: 'mg', MAILGUN_DOMAIN: 'mg.test' }, 'https://api.mailgun.net/v3/mg.test/messages',
            `Basic ${Buffer.from('api:mg').toString('base64')}`],
    ])('%s → POSTs to its API with the right auth', async (provider, env, url, auth) => {
        Object.assign(process.env, { EMAIL_PROVIDER: provider.toUpperCase(), ...env });
        fetchSpy.mockResolvedValue(okRes);
        expect(await email.sendEmail(msg)).toEqual({ sent: true, provider, dev: false });
        expect(fetchSpy.mock.calls[0][0]).toBe(url);
        expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe(auth);
    });

    test('sendgrid parses "Name <addr>" from EMAIL_FROM and base64s attachments', async () => {
        Object.assign(process.env, { EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'sg', EMAIL_FROM: 'Besto <no-reply@b.test>' });
        fetchSpy.mockResolvedValue(okRes);
        await email.sendEmail({ ...msg, attachments: [{ filename: 'a.txt', content: 'hi' }] });
        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.from).toEqual({ email: 'no-reply@b.test', name: 'Besto' });
        expect(body.attachments[0]).toEqual({ content: 'aGk=', filename: 'a.txt', type: 'application/octet-stream', disposition: 'attachment' });
    });

    test('API provider failure falls back to SMTP when configured', async () => {
        Object.assign(process.env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' });
        fetchSpy.mockResolvedValue(badRes);
        mockSendMail.mockResolvedValue({});
        expect(await email.sendEmail(msg)).toEqual({ sent: true, provider: 'smtp', dev: false, fallbackFrom: 'resend' });
    });

    test.each([
        ['provider rejects, no SMTP', { EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'sg' }, badRes, 'SendGrid 403: forbidden'],
        ['missing API key', { EMAIL_PROVIDER: 'mailgun' }, okRes, 'MAILGUN_API_KEY and MAILGUN_DOMAIN must be set'],
        ['unknown provider', { EMAIL_PROVIDER: 'pigeon' }, okRes, 'Unknown EMAIL_PROVIDER: pigeon'],
    ])('%s → never throws, reports the error', async (_l, env, res, error) => {
        Object.assign(process.env, env);
        fetchSpy.mockResolvedValue(res);
        await expect(email.sendEmail(msg)).resolves.toMatchObject({ sent: false, error });
    });

    test('isSmtpConfigured needs host + user + pass', () => {
        process.env.SMTP_HOST = 'h';
        process.env.SMTP_USER = 'u';
        expect(email.isSmtpConfigured()).toBe(false);
        process.env.SMTP_PASS = 'p';
        expect(email.isSmtpConfigured()).toBe(true);
    });
});

// ─── emailTemplates ─────────────────────────────────────────────────
describe('emailTemplates escape user-supplied values', () => {
    const XSS = '<img src=x onerror=alert(1)>"\'&';
    const ESC = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';

    test.each([
        ['restaurantWelcome', { restaurantName: XSS, ownerName: XSS, email: XSS, tempPassword: XSS, planName: XSS, trialDays: 14 }],
        ['restaurantSelfSignupWelcome', { restaurantName: XSS, ownerName: XSS, email: XSS, planName: XSS, slug: 'cafe' }],
        ['signupApplicationReceived', { restaurantName: XSS, ownerName: XSS, email: XSS, slug: 'cafe' }],
        ['signupAdminAlert', { restaurantName: XSS, ownerName: XSS, email: XSS, phone: XSS, city: XSS, planName: XSS, slug: 'cafe', source: XSS }],
        ['signupRejected', { restaurantName: XSS, ownerName: XSS, reason: XSS }],
        ['restaurantSuspended', { restaurantName: XSS, ownerName: XSS, reason: XSS }],
        ['restaurantReactivated', { restaurantName: XSS, ownerName: XSS, reason: XSS }],
        ['customerPasswordReset', { customerName: XSS, restaurantName: XSS, resetUrl: 'https://app.test/r?t=1' }],
    ])('%s: no raw markup from user input in the HTML body', (name, props) => {
        const fn = templates[name];
        expect(typeof fn).toBe('function');
        const { html, text, subject } = fn(props);
        expect(html).not.toContain('<img src=x');
        expect(html).toContain(ESC);
        expect(typeof text).toBe('string');
        expect(typeof subject).toBe('string');
    });

    // Regression (fixed 2026-10): emailTemplates build subjects from the raw name and escape them only inside <title>.
    test.each([
        ['restaurantWelcome', { restaurantName: "Tom & Jerry's" }],
        ['restaurantSuspended', { restaurantName: "Tom & Jerry's" }],
        ['customerPasswordReset', { restaurantName: "Tom & Jerry's", resetUrl: 'https://app.test/r' }],
    ])('%s subject is plain text, not HTML-entity encoded', (name, props) => {
        expect(templates[name](props).subject).toContain("Tom & Jerry's");
    });

    test('suspension reason keeps line breaks as <br> after escaping', () => {
        const { html } = templates.restaurantSuspended({ restaurantName: 'A', ownerName: 'B', reason: 'line1\n<b>line2</b>' });
        expect(html).toContain('line1<br>&lt;b&gt;line2&lt;/b&gt;');
    });

    test('welcome email carries the trial line only when trialDays is set', () => {
        expect(templates.restaurantWelcome({ restaurantName: 'A', trialDays: 7 }).html).toContain('7-day free trial');
        expect(templates.restaurantWelcome({ restaurantName: 'A' }).html).not.toContain('free trial');
    });
});

// ─── imageLiveness ──────────────────────────────────────────────────
describe('imageLiveness SSRF guard', () => {
    test.each([
        ['127.0.0.1', true], ['10.1.2.3', true], ['169.254.169.254', true], ['192.168.0.10', true],
        ['100.64.0.1', true], ['::1', true], ['fe80::1', true], ['::ffff:10.0.0.1', true],
        ['::ffff:a00:1', true], // hex IPv4-mapped form of 10.0.0.1
        ['not-an-ip', true],
        ['8.8.8.8', false], ['2606:4700:4700::1111', false],
    ])('isPrivateAddress(%p) → %p', (ip, expected) => {
        expect(isPrivateAddress(ip)).toBe(expected);
    });

    test.each([
        'http://images.unsplash.com/a.jpg',          // not https
        'https://user:pw@images.unsplash.com/a.jpg', // credentials
        'https://evil.test/a.jpg',                   // host not allowlisted
        'https://169.254.169.254/latest/meta-data',  // metadata IP, not allowlisted
        'javascript:alert(1)',
        'not a url',
    ])('isSafeImageUrl rejects %p', async (url) => {
        expect(await isSafeImageUrl(url)).toBe(false);
    });

    test('urlStatus never fetches an unsafe URL and reports unknown', async () => {
        const fetchSpy = jest.spyOn(global, 'fetch');
        try {
            resetLivenessCache();
            expect(await urlStatus('https://evil.test/a.jpg')).toBe('unknown');
            expect(await urlStatus('')).toBe('unknown');
            expect(await urlStatus(null)).toBe('unknown');
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
