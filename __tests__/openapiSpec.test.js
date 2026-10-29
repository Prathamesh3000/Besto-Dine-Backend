/**
 * OpenAPI documents: the public spec must match routes/serializers, and the
 * internal generator must produce a sane, unique-operationId document.
 * Pure file reads: no database, no server.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const publicSpec = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'openapi', 'public-v1.json'), 'utf8'));

function serializerFields() {
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'publicApiSerializers.js'), 'utf8');
    const out = {};
    for (const fn of ['serializeOrder', 'serializeMenuItem', 'serializeInventoryItem', 'serializeBooking']) {
        const start = src.indexOf(`function ${fn}(`);
        const ret = src.indexOf('return {', start);
        const end = src.indexOf('\n    };', ret);
        const body = src.slice(ret, end);
        // top-level keys are indented exactly 8 spaces
        out[fn] = [...body.matchAll(/^ {8}([a-z_]+):/gm)].map((m) => m[1]);
    }
    return out;
}

describe('public OpenAPI spec', () => {
    it('is OpenAPI 3.1 with the required top-level keys', () => {
        expect(publicSpec.openapi).toMatch(/^3\.1\./);
        expect(publicSpec.info.title).toBeTruthy();
        expect(publicSpec.info.version).toBeTruthy();
        expect(publicSpec.paths).toBeTruthy();
        expect(publicSpec.webhooks).toBeTruthy();
        expect(publicSpec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
        expect(publicSpec.components.securitySchemes.apiKeyHeader.name).toBe('X-API-Key');
    });

    it('documents every path in publicApiRoute.js', () => {
        const route = fs.readFileSync(path.join(ROOT, 'routes', 'publicApiRoute.js'), 'utf8');
        const routePaths = [...route.matchAll(/router\.get\('([^']+)'/g)].map((m) => m[1]);
        expect(routePaths.length).toBeGreaterThanOrEqual(6);
        for (const p of routePaths) {
            const oa = p.replace(/:(\w+)/g, '{$1}');
            expect(publicSpec.paths[oa] && publicSpec.paths[oa].get).toBeTruthy();
        }
    });

    it('declares the scope of each endpoint', () => {
        const route = fs.readFileSync(path.join(ROOT, 'routes', 'publicApiRoute.js'), 'utf8');
        for (const m of route.matchAll(/router\.get\('([^']+)', apiKeyAuth\('([^']+)'\)/g)) {
            const oa = m[1].replace(/:(\w+)/g, '{$1}');
            expect(publicSpec.paths[oa].get['x-required-scope']).toBe(m[2]);
        }
    });

    it('schema properties equal the serializer allow-lists exactly', () => {
        const fields = serializerFields();
        const map = {
            serializeOrder: 'Order', serializeMenuItem: 'MenuItem',
            serializeInventoryItem: 'InventoryItem', serializeBooking: 'Booking',
        };
        for (const [fn, schema] of Object.entries(map)) {
            expect(fields[fn].length).toBeGreaterThan(5);
            expect(Object.keys(publicSpec.components.schemas[schema].properties).sort()).toEqual([...fields[fn]].sort());
        }
    });

    it('documents the webhook events and signature header', () => {
        const events = ['order.created', 'order.paid', 'order.cancelled', 'refund.created', 'booking.created', 'stock.low', 'webhook.test'];
        expect(Object.keys(publicSpec.webhooks).sort()).toEqual([...events].sort());
        const params = publicSpec.webhooks['order.paid'].post.parameters.map((p) => p.name);
        expect(params).toEqual(expect.arrayContaining(['X-BestoDine-Signature', 'X-BestoDine-Event', 'X-BestoDine-Delivery']));
    });

    it('has no dangling $ref', () => {
        const text = JSON.stringify(publicSpec);
        for (const m of text.matchAll(/"\$ref":"#\/components\/(\w+)\/([^"]+)"/g)) {
            expect(publicSpec.components[m[1]][m[2]]).toBeTruthy();
        }
    });
});

describe('internal OpenAPI generator', () => {
    const { buildSpec } = require('../scripts/generate-openapi');
    const { spec, stats } = buildSpec();

    const ops = Object.entries(spec.paths).flatMap(([p, item]) => Object.entries(item).map(([method, op]) => ({ p, method, op })));

    it('finds a plausible number of endpoints', () => {
        expect(spec.openapi).toMatch(/^3\.1\./);
        expect(ops.length).toBeGreaterThan(300);
        expect(stats.skipped).toEqual([]);
    });

    it('has no duplicate operationIds', () => {
        const ids = ops.map((o) => o.op.operationId);
        expect(ids.every(Boolean)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('captures auth middleware and request bodies', () => {
        const create = spec.paths['/api/v1/categories'].post;
        expect(create['x-auth']).toEqual(expect.arrayContaining(['protect', 'adminOnly']));
        expect(create['x-permissions']).toContain('editMenu');
        expect(create.requestBody.content['application/json'].schema.properties).toHaveProperty('name');
        expect(spec.paths['/api/v1/developer/api-keys'].get['x-feature-gates']).toContain('publicApi');
    });

    it('the committed internal.json has unique operationIds too', () => {
        const file = path.join(ROOT, 'docs', 'openapi', 'internal.json');
        if (!fs.existsSync(file)) return;
        const committed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const ids = Object.values(committed.paths).flatMap((i) => Object.values(i)).map((o) => o.operationId);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
