/**
 * Per-file harness: boots the app + DB in beforeAll and tears both down
 * in afterAll.
 *
 *   const ctx = useIntegrationApp();
 *   test('...', async () => { await ctx.api.anon().get('/public/...'); });
 */
const { createTestApp } = require('./createTestApp');
const db = require('./db');
const { makeApi, settle } = require('./http');
const rzp = require('./razorpayMock');

function useIntegrationApp() {
    const ctx = {};

    beforeAll(async () => {
        const started = await createTestApp();
        Object.assign(ctx, started);
        await db.connect();
        await db.initModels();
        ctx.api = makeApi(started.baseUrl);
    });

    beforeEach(() => {
        rzp.reset();
    });

    afterAll(async () => {
        await settle(300);                // let post-response tasks finish
        if (ctx.close) await ctx.close();
        await db.disconnect();
    });

    return ctx;
}

module.exports = { useIntegrationApp };
