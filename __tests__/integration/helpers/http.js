/**
 * Small request helpers over supertest, bound to a running test app.
 *
 *   const api = makeApi(baseUrl);
 *   await api.as(tenant.users.admin).get('/orders/live');
 *   await api.guest(tenant, scanToken).post('/orders').send(body);
 */
const request = require('supertest');

const V1 = '/api/v1';

function makeApi(baseUrl) {
    const agent = request(baseUrl);

    // Wrap a supertest method so every call gets the given headers.
    const withHeaders = (headers) => {
        const call = (method) => (path) => {
            let r = agent[method](`${V1}${path}`);
            for (const [k, v] of Object.entries(headers)) if (v) r = r.set(k, v);
            return r;
        };
        return {
            get: call('get'), post: call('post'), put: call('put'),
            patch: call('patch'), delete: call('delete'),
        };
    };

    return {
        raw: agent,
        /** No auth, no tenant. */
        anon: () => withHeaders({}),
        /** Authenticated user; pass a tenant to also send X-Restaurant-Slug (customers). */
        as: (user, tenant) => withHeaders({
            Authorization: `Bearer ${user.token || user}`,
            'X-Restaurant-Slug': tenant?.slug,
        }),
        /** Guest (no login) on a tenant, optionally holding a table scan token. */
        guest: (tenant, scanToken) => withHeaders({
            'X-Restaurant-Slug': tenant.slug,
            'X-Scan-Token': scanToken,
        }),
        /** Customer who also holds a table scan token. */
        customerAtTable: (user, tenant, scanToken) => withHeaders({
            Authorization: `Bearer ${user.token || user}`,
            'X-Restaurant-Slug': tenant.slug,
            'X-Scan-Token': scanToken,
        }),
    };
}

/** GET /tables/scan/:qrToken — returns { res, scanToken, sessionId }. */
async function scanTable(api, table, headers = {}) {
    let r = api.raw.get(`${V1}/tables/scan/${table.qrToken}`);
    for (const [k, v] of Object.entries(headers)) if (v) r = r.set(k, v);
    const res = await r;
    return { res, scanToken: res.body?.scanToken, sessionId: res.body?.scanSessionId };
}

/** Let post-response work (setImmediate notification tasks) drain. */
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { makeApi, scanTable, settle, V1 };
