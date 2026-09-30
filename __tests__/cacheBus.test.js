/**
 * #35 — cross-instance cache invalidation (utils/cacheBus + listCache).
 * Two "instances" are simulated by publishing through a fake transport
 * and delivering the message back as if it came from another instance.
 */
const cacheBus = require('../utils/cacheBus');
const listCache = require('../utils/listCache');

afterEach(() => cacheBus.setTransport(null));

test('publish is a no-op without a transport (single-instance mode)', () => {
    expect(cacheBus.hasTransport()).toBe(false);
    expect(cacheBus.publish('x', { a: 1 })).toBe(false);
});

test('listCache.invalidate publishes and a remote message clears the local entry', async () => {
    const sent = [];
    cacheBus.setTransport({ publish: (channel, msg) => sent.push({ channel, msg }) });

    let loads = 0;
    const cache = listCache.create({ name: 'bus-test', loader: async () => ++loads, ttlMs: 60_000 });
    const req = { restaurant: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } };

    expect(await cache.get(req)).toBe(1);
    expect(await cache.get(req)).toBe(1); // cached

    cache.invalidate(req);
    expect(sent).toEqual([{ channel: 'listCache', msg: { name: 'bus-test', key: 'aaaaaaaaaaaaaaaaaaaaaaaa:null' } }]);
    expect(await cache.get(req)).toBe(2);

    // Message from another instance → local entry dropped, reload.
    cacheBus.deliver('listCache', { name: 'bus-test', key: 'aaaaaaaaaaaaaaaaaaaaaaaa:null' });
    expect(await cache.get(req)).toBe(3);

    // Remote "clear all" (key null).
    cacheBus.deliver('listCache', { name: 'bus-test', key: null });
    expect(await cache.get(req)).toBe(4);
});

test('listCache caps TTL and entry count', async () => {
    const cache = listCache.create({ name: 'cap-test', loader: async (r) => r.restaurant._id, ttlMs: 60 * 60 * 1000, maxEntries: 2 });
    for (const id of ['a', 'b', 'c']) await cache.get({ restaurant: { _id: id } });
    expect(cache._size()).toBe(2);
    expect(listCache.MAX_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
});

test('a load that started before an invalidation is not cached', async () => {
    let release;
    let calls = 0;
    const cache = listCache.create({
        name: 'race-test',
        loader: () => { calls += 1; return calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve('fresh'); },
    });
    const req = { restaurant: { _id: 'r1' } };
    const pending = cache.get(req);
    cache.invalidate(req);
    release('stale');
    expect(await pending).toBe('stale');
    expect(await cache.get(req)).toBe('fresh');
});
