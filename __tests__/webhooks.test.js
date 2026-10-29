/**
 * Webhooks: signing + verification, SSRF guard (private IPs, DNS rebinding
 * style answers, redirects, oversize responses), retry/backoff, auto-disable,
 * emitWebhookEvent safety. No network, no database.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { EventEmitter } = require('events');
const WebhookEndpoint = require('../models/webhookEndpoint');
const WebhookDelivery = require('../models/webhookDelivery');
const Restaurant = require('../models/restaurant');
const { sign, verify } = require('../utils/webhookSigner');
const { safePost, validateWebhookUrl } = require('../utils/safeHttpPost');
const svc = require('../utils/webhookService');

describe('signing', () => {
    test('header format t=<unix>,v1=<hex hmac-sha256(secret, t.body)>', () => {
        const { header, timestamp, v1 } = sign('whsec_x', '{"a":1}', 1700000000);
        expect(header).toBe(`t=1700000000,v1=${v1}`);
        expect(timestamp).toBe(1700000000);
        expect(v1).toMatch(/^[0-9a-f]{64}$/);
        const expected = require('crypto').createHmac('sha256', 'whsec_x').update('1700000000.{"a":1}').digest('hex');
        expect(v1).toBe(expected);
    });

    test('verify: good signature passes; tampered body / wrong secret / bad header fail', () => {
        const now = 1700000100;
        const { header } = sign('s3cret', 'BODY', 1700000000);
        expect(verify('s3cret', 'BODY', header, { now })).toBe(true);
        expect(verify('s3cret', 'BODY!', header, { now })).toBe(false);
        expect(verify('other', 'BODY', header, { now })).toBe(false);
        expect(verify('s3cret', 'BODY', 'garbage', { now })).toBe(false);
        expect(verify('s3cret', 'BODY', undefined, { now })).toBe(false);
        expect(verify('s3cret', 'BODY', `t=1700000000,v1=${'0'.repeat(64)}`, { now })).toBe(false);
    });

    test('verify: stale timestamps are rejected (replay protection), tolerance can be widened', () => {
        const { header } = sign('s3cret', 'BODY', 1700000000);
        expect(verify('s3cret', 'BODY', header, { now: 1700000000 + 301 })).toBe(false);
        expect(verify('s3cret', 'BODY', header, { now: 1700000000 + 301, toleranceSec: 600 })).toBe(true);
    });
});

describe('validateWebhookUrl', () => {
    test.each([
        ['http://example.com/hook', /https/],
        ['ftp://example.com', /https/],
        ['https://user:pw@example.com/', /Credentials/],
        ['https://example.com:8080/', /ports/],
        ['https://localhost/hook', /not allowed/],
        ['https://foo.localhost/hook', /not allowed/],
        ['https://printer.local/hook', /not allowed/],
        ['https://127.0.0.1/hook', /not allowed/],
        ['https://10.0.0.5/hook', /not allowed/],
        ['https://192.168.1.10/hook', /not allowed/],
        ['https://169.254.169.254/latest/meta-data', /not allowed/],
        ['https://[::1]/hook', /not allowed/],
        ['https://[fd00:ec2::254]/hook', /not allowed/],
        ['https://[::ffff:10.0.0.1]/hook', /not allowed/],
        ['not a url', /Invalid/],
    ])('rejects %s', (url, msg) => {
        const r = validateWebhookUrl(url);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(msg);
    });

    test('accepts a normal public https URL (also :8443)', () => {
        expect(validateWebhookUrl('https://hooks.example.com/bestodine').ok).toBe(true);
        expect(validateWebhookUrl('https://hooks.example.com:8443/x').ok).toBe(true);
    });
});

// A fake https.request that records the options and replies as scripted.
function fakeRequest(reply) {
    const calls = [];
    const request = (opts, onResponse) => {
        calls.push(opts);
        const req = new EventEmitter();
        req.written = '';
        req.write = (b) => { req.written += b; };
        req.destroy = (err) => { req.emit('error', err || new Error('destroyed')); };
        req.end = () => {
            setImmediate(() => {
                if (reply.error) return req.emit('error', new Error(reply.error));
                if (reply.hang) return undefined;
                const res = new EventEmitter();
                res.statusCode = reply.status;
                res.destroy = () => {};
                onResponse(res);
                (reply.chunks || []).forEach((c) => res.emit('data', Buffer.from(c)));
                return res.emit('end');
            });
        };
        calls.last = req;
        return req;
    };
    return { request, calls };
}
const lookupTo = (...addrs) => jest.fn(async () => addrs.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })));

describe('safePost (SSRF guard)', () => {
    const body = '{"x":1}';

    test('delivers to a public address, pins the socket to the validated IP and sends the headers', async () => {
        const { request, calls } = fakeRequest({ status: 200 });
        const r = await safePost('https://hooks.example.com/in', { body, headers: { 'X-Test': '1' } }, { lookup: lookupTo('93.184.216.34'), request });
        expect(r).toEqual({ ok: true, status: 200 });
        expect(calls[0].method).toBe('POST');
        expect(calls[0].hostname).toBe('hooks.example.com');
        expect(calls[0].headers['X-Test']).toBe('1');
        expect(calls.last.written).toBe(body);
        const pinned = await new Promise((res) => calls[0].lookup('hooks.example.com', {}, (e, a) => res(a)));
        expect(pinned).toBe('93.184.216.34');
    });

    test.each([
        '127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.9', '169.254.169.254', '100.64.0.1',
        '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:192.168.1.1',
    ])('blocks a hostname that resolves to %s', async (ip) => {
        const { request, calls } = fakeRequest({ status: 200 });
        const r = await safePost('https://evil.example.com/', { body }, { lookup: lookupTo(ip), request });
        expect(r.ok).toBe(false);
        expect(r.blocked).toBe(true);
        expect(calls).toHaveLength(0);
    });

    test('blocks when ANY resolved address is private (mixed answer)', async () => {
        const { request, calls } = fakeRequest({ status: 200 });
        const r = await safePost('https://evil.example.com/', { body }, { lookup: lookupTo('93.184.216.34', '10.0.0.1'), request });
        expect(r.blocked).toBe(true);
        expect(calls).toHaveLength(0);
    });

    test('literal private IPs and http:// never reach DNS or the network', async () => {
        const { request, calls } = fakeRequest({ status: 200 });
        const lookup = lookupTo('93.184.216.34');
        for (const u of ['https://127.0.0.1/', 'https://169.254.169.254/', 'http://hooks.example.com/']) {
            const r = await safePost(u, { body }, { lookup, request });
            expect(r.ok).toBe(false);
            expect(r.blocked).toBe(true);
        }
        expect(lookup).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
    });

    test('redirects are not followed and count as failure', async () => {
        const { request, calls } = fakeRequest({ status: 302 });
        const r = await safePost('https://hooks.example.com/in', { body }, { lookup: lookupTo('93.184.216.34'), request });
        expect(r.ok).toBe(false);
        expect(r.status).toBe(302);
        expect(r.error).toMatch(/Redirects/);
        expect(calls).toHaveLength(1);
    });

    test('non-2xx is a failure with the status; network error is reported, never thrown', async () => {
        let f = fakeRequest({ status: 500 });
        let r = await safePost('https://hooks.example.com/in', { body }, { lookup: lookupTo('93.184.216.34'), request: f.request });
        expect(r).toMatchObject({ ok: false, status: 500 });
        f = fakeRequest({ error: 'ECONNRESET' });
        r = await safePost('https://hooks.example.com/in', { body }, { lookup: lookupTo('93.184.216.34'), request: f.request });
        expect(r).toMatchObject({ ok: false, status: null, error: 'ECONNRESET' });
    });

    test('oversized responses are cut off', async () => {
        const f = fakeRequest({ status: 200, chunks: ['x'.repeat(40), 'x'.repeat(40)] });
        const r = await safePost('https://hooks.example.com/in', { body, maxBytes: 50 }, { lookup: lookupTo('93.184.216.34'), request: f.request });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/too large/);
    });

    test('DNS failure is a plain failure (not blocked)', async () => {
        const lookup = jest.fn(async () => { throw new Error('ENOTFOUND'); });
        const r = await safePost('https://nope.example.com/', { body }, { lookup, request: fakeRequest({ status: 200 }).request });
        expect(r.ok).toBe(false);
        expect(r.blocked).toBe(false);
        expect(r.error).toMatch(/DNS/);
    });
});

describe('retry / backoff', () => {
    test('six attempts total, exponentially growing waits, then none', () => {
        expect(svc.MAX_ATTEMPTS).toBe(6);
        const waits = [1, 2, 3, 4, 5].map(svc.backoffAfter);
        expect(waits).toEqual([60000, 300000, 1800000, 7200000, 21600000]);
        for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThan(waits[i - 1]);
        expect(svc.backoffAfter(6)).toBeNull();
        expect(svc.backoffAfter(7)).toBeNull();
    });
});

describe('attemptDelivery', () => {
    const RID = '64b000000000000000000001';
    const mkDelivery = (over = {}) => ({ _id: 'd1', restaurant: RID, endpoint: 'e1', type: 'order.paid', payload: { id: 'evt_1', type: 'order.paid', data: { id: 'ORD-1' } }, attempts: 0, ...over });
    const mkEndpoint = (over = {}) => ({ _id: 'e1', restaurant: RID, url: 'https://hooks.example.com/in', secret: 'whsec_test', active: true, consecutiveFailures: 0, ...over });
    const deps = (reply) => ({ lookup: lookupTo('93.184.216.34'), ...(() => { const f = fakeRequest(reply); deps.calls = f.calls; deps.f = f; return { request: f.request }; })() });

    beforeEach(() => {
        jest.spyOn(WebhookDelivery, 'updateOne').mockResolvedValue({});
        jest.spyOn(WebhookEndpoint, 'updateOne').mockResolvedValue({});
        jest.spyOn(WebhookEndpoint, 'findOneAndUpdate').mockImplementation(async () => ({ _id: 'e1', restaurant: RID, active: true, consecutiveFailures: 1 }));
    });
    afterEach(() => { jest.restoreAllMocks(); delete process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES; });

    test('success: signed request with event/delivery headers, status success, counter reset', async () => {
        const d = mkDelivery(); const ep = mkEndpoint({ consecutiveFailures: 3 });
        const r = await svc.attemptDelivery(d, ep, { deps: deps({ status: 204 }) });
        expect(r.ok).toBe(true);
        const sent = deps.calls[0];
        expect(sent.headers['X-BestoDine-Event']).toBe('order.paid');
        expect(sent.headers['X-BestoDine-Delivery']).toBe('d1');
        expect(verify('whsec_test', deps.f.calls.last.written, sent.headers['X-BestoDine-Signature'])).toBe(true);
        expect(d).toMatchObject({ status: 'success', attempts: 1, responseCode: 204 });
        expect(WebhookDelivery.updateOne).toHaveBeenCalledWith({ _id: 'd1', restaurant: RID }, { $set: expect.objectContaining({ status: 'success' }) });
        expect(WebhookEndpoint.updateOne).toHaveBeenCalledWith({ _id: 'e1', restaurant: RID }, { $set: { consecutiveFailures: 0 } });
    });

    test('failure: stays pending with a backoff time, increments consecutiveFailures', async () => {
        const d = mkDelivery({ attempts: 1 });
        const before = Date.now();
        const r = await svc.attemptDelivery(d, mkEndpoint(), { deps: deps({ status: 500 }) });
        expect(r.ok).toBe(false);
        expect(d.status).toBe('pending');
        expect(d.attempts).toBe(2);
        expect(d.responseCode).toBe(500);
        expect(d.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 300000);
        expect(WebhookEndpoint.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'e1', restaurant: RID }, { $inc: { consecutiveFailures: 1 } }, expect.any(Object));
    });

    test('final attempt failing marks the delivery failed (no nextAttemptAt)', async () => {
        const d = mkDelivery({ attempts: 5 });
        await svc.attemptDelivery(d, mkEndpoint(), { deps: deps({ status: 500 }) });
        expect(d.status).toBe('failed');
        expect(d.nextAttemptAt).toBeUndefined();
    });

    test('SSRF-blocked target is a failure like any other (and is never sent)', async () => {
        const d = mkDelivery();
        const r = await svc.attemptDelivery(d, mkEndpoint({ url: 'https://169.254.169.254/x' }), { deps: deps({ status: 200 }) });
        expect(r.ok).toBe(false);
        expect(deps.calls).toHaveLength(0);
        expect(d.status).toBe('pending');
    });

    test('auto-disable at the consecutive-failure threshold', async () => {
        process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '3';
        WebhookEndpoint.findOneAndUpdate.mockImplementation(async () => ({ _id: 'e1', restaurant: RID, active: true, consecutiveFailures: 3 }));
        await svc.attemptDelivery(mkDelivery(), mkEndpoint(), { deps: deps({ status: 500 }) });
        expect(WebhookEndpoint.updateOne).toHaveBeenCalledWith(
            { _id: 'e1', restaurant: RID, active: true },
            { $set: expect.objectContaining({ active: false, disabledAt: expect.any(Date), disabledReason: expect.stringMatching(/consecutive/) }) },
        );
    });

    test('below the threshold nothing is disabled', async () => {
        process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '3';
        WebhookEndpoint.findOneAndUpdate.mockImplementation(async () => ({ _id: 'e1', restaurant: RID, active: true, consecutiveFailures: 2 }));
        await svc.attemptDelivery(mkDelivery(), mkEndpoint(), { deps: deps({ status: 500 }) });
        expect(WebhookEndpoint.updateOne).not.toHaveBeenCalled();
    });

    test('test sends (countFailure:false, retry:false) neither count nor retry', async () => {
        const d = mkDelivery();
        await svc.attemptDelivery(d, mkEndpoint(), { countFailure: false, retry: false, deps: deps({ status: 500 }) });
        expect(d.status).toBe('failed');
        expect(WebhookEndpoint.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a disabled endpoint is not contacted and the delivery is failed, not retried', async () => {
        const d = mkDelivery();
        await svc.attemptDelivery(d, mkEndpoint({ active: false }), { deps: deps({ status: 200 }) });
        expect(deps.calls).toHaveLength(0);
        expect(d.status).toBe('failed');
    });
});

describe('processDueDeliveries (retry job)', () => {
    const RID = '64b000000000000000000001';
    afterEach(() => jest.restoreAllMocks());

    test('claims each due row atomically, skips ones another instance claimed, attempts the rest', async () => {
        const rows = [{ _id: 'a', restaurant: RID }, { _id: 'b', restaurant: RID }];
        jest.spyOn(WebhookDelivery, 'find').mockReturnValue({ setOptions: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }) });
        const claim = jest.spyOn(WebhookDelivery, 'findOneAndUpdate')
            .mockImplementationOnce(async () => null)
            .mockImplementationOnce(async () => ({ _id: 'b', restaurant: RID, endpoint: 'e1', type: 't', payload: { id: 'evt' }, attempts: 1 }));
        jest.spyOn(WebhookEndpoint, 'findOne').mockReturnValue({ select: async () => ({ _id: 'e1', restaurant: RID, url: 'https://hooks.example.com/in', secret: 's', active: true }) });
        jest.spyOn(WebhookDelivery, 'updateOne').mockResolvedValue({});
        jest.spyOn(WebhookEndpoint, 'updateOne').mockResolvedValue({});
        const f = fakeRequest({ status: 200 });
        const n = await svc.processDueDeliveries({ deps: { lookup: lookupTo('93.184.216.34'), request: f.request } });
        expect(n).toBe(1);
        expect(claim.mock.calls[0][0]).toMatchObject({ _id: 'a', restaurant: RID, status: 'pending' });
        expect(f.calls).toHaveLength(1);
    });
});

describe('emitWebhookEvent', () => {
    afterEach(() => jest.restoreAllMocks());

    test('never throws, even with bad input', () => {
        expect(() => svc.emitWebhookEvent(null, 'order.paid', {})).not.toThrow();
        expect(() => svc.emitWebhookEvent('x', undefined, {})).not.toThrow();
    });

    test('is non-blocking: returns before any DB work and swallows DB errors', async () => {
        const find = jest.spyOn(WebhookEndpoint, 'find').mockImplementation(() => { throw new Error('db down'); });
        expect(svc.emitWebhookEvent('64b000000000000000000001', 'order.paid', { id: 1 })).toBeUndefined();
        expect(find).not.toHaveBeenCalled();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(find).toHaveBeenCalled();
    });

    test('tenant without the publicApi feature gets no deliveries', async () => {
        jest.spyOn(WebhookEndpoint, 'find').mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'e1', secret: 's', url: 'https://x.example.com' }] }) });
        jest.spyOn(Restaurant, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ subscription: { features: { publicApi: false } } }) }) });
        const create = jest.spyOn(WebhookDelivery, 'create').mockResolvedValue({});
        svc.emitWebhookEvent('64b000000000000000000001', 'order.paid', {});
        await new Promise((r) => setTimeout(r, 20));
        expect(create).not.toHaveBeenCalled();
    });

    test('subscribed endpoint on an entitled tenant: one delivery row with the event envelope and a sent attempt', async () => {
        const RID = '64b000000000000000000001';
        const find = jest.spyOn(WebhookEndpoint, 'find').mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'e1', restaurant: RID, secret: 's', url: 'https://127.0.0.1/blocked', active: true }] }) });
        jest.spyOn(Restaurant, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ subscription: { features: { publicApi: true } } }) }) });
        const create = jest.spyOn(WebhookDelivery, 'create').mockImplementation(async (d) => ({ ...d, _id: 'd1' }));
        jest.spyOn(WebhookDelivery, 'updateOne').mockResolvedValue({});
        jest.spyOn(WebhookEndpoint, 'findOneAndUpdate').mockResolvedValue({ active: true, consecutiveFailures: 1 });
        svc.emitWebhookEvent(RID, 'order.paid', { id: 'ORD-9' });
        await new Promise((r) => setTimeout(r, 30));
        expect(find).toHaveBeenCalledWith({ restaurant: RID, active: true, events: 'order.paid' });
        expect(create).toHaveBeenCalledTimes(1);
        const row = create.mock.calls[0][0];
        expect(row).toMatchObject({ restaurant: RID, endpoint: 'e1', type: 'order.paid', status: 'pending' });
        expect(row.payload).toMatchObject({ type: 'order.paid', data: { id: 'ORD-9' } });
        expect(row.payload.id).toBe(row.eventId);
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });
});

describe('models', () => {
    test('delivery rows expire after 30 days; secret is never selected by default; events enum', () => {
        const ttl = WebhookDelivery.schema.indexes().find(([k]) => k.createdAt === 1 && Object.keys(k).length === 1);
        expect(ttl[1].expireAfterSeconds).toBe(30 * 24 * 60 * 60);
        expect(WebhookEndpoint.schema.path('secret').options.select).toBe(false);
        expect(WebhookEndpoint.EVENTS).toEqual(['order.created', 'order.paid', 'order.cancelled', 'refund.created', 'booking.created', 'stock.low']);
        expect(WebhookDelivery.schema.path('status').enumValues).toEqual(['pending', 'success', 'failed']);
    });
});
