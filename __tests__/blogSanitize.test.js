/**
 * Blog content safety + blog controller contract (checklist 10.7):
 *
 *   utils/sanitizeBlogContent.js  XSS payloads (script, on* handlers,
 *                                 javascript:/vbscript:/data: URLs, svg,
 *                                 style expressions, iframes, nested-tag
 *                                 reassembly) are stripped; markdown and
 *                                 allowed formatting are kept verbatim;
 *                                 code spans / fences are left untouched
 *   controllers/blogController.js content sanitised on create + update,
 *                                 slug generation + uniqueness, public read
 *                                 only returns published posts and never
 *                                 internal fields, rebuild trigger rules
 *
 * Role gating (superadmin read / full-superadmin write) is pinned over HTTP
 * in __tests__/integration/roleMatrix.test.js (SA_ANY / SA_FULL rows).
 *
 * sanitize-html → htmlparser2 is ESM-only and Jest's CJS runtime cannot
 * require it under the unit config, so the mock below hands back the REAL
 * library loaded through Node's native require (Node ≥ 20.19 supports
 * require(esm); process.getBuiltinModule bypasses Jest's module shim).
 * The sanitizer itself still runs through Jest (coverage).
 */
jest.mock('sanitize-html', () => process.getBuiltinModule('module')
    .createRequire(require('path').join(process.cwd(), 'package.json'))('sanitize-html'));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// ── BlogPost: tiny in-memory model ──────────────────────────────────
const mockPosts = [];
let mockSeq = 0;
const mockOid = () => `b${String(++mockSeq).padStart(23, '0')}`;

function mockMatches(doc, filter = {}) {
    return Object.entries(filter).every(([k, v]) => {
        if (k === '$or') return v.some((f) => mockMatches(doc, f));
        if (v && typeof v === 'object' && '$ne' in v) return String(doc[k]) !== String(v.$ne);
        if (v instanceof RegExp) return v.test(doc[k]);
        return String(doc[k]) === String(v);
    });
}

function mockQuery(result) {
    const q = {
        select: () => q, sort: () => q, skip: () => q, limit: () => q,
        lean: () => Promise.resolve(result()),
        then: (res, rej) => Promise.resolve(result()).then(res, rej),
    };
    return q;
}

function mockDoc(data) {
    const doc = { ...data };
    Object.defineProperty(doc, 'save', {
        enumerable: false,
        value: jest.fn(async () => {
            if (doc.status === 'published' && !doc.publishedAt) doc.publishedAt = new Date();
            const i = mockPosts.findIndex((p) => p._id === doc._id);
            mockPosts[i] = { ...doc };
            return doc;
        }),
    });
    Object.defineProperty(doc, 'deleteOne', {
        enumerable: false,
        value: jest.fn(async () => { mockPosts.splice(mockPosts.findIndex((p) => p._id === doc._id), 1); }),
    });
    return doc;
}

jest.mock('../models/blogPost', () => ({
    findOne: jest.fn((filter) => mockQuery(() => {
        const hit = mockPosts.find((p) => mockMatches(p, filter));
        return hit ? { ...hit } : null;
    })),
    find: jest.fn((filter) => mockQuery(() => mockPosts.filter((p) => mockMatches(p, filter)).map((p) => ({ ...p })))),
    findById: jest.fn((id) => {
        const hit = mockPosts.find((p) => p._id === String(id));
        const value = hit ? mockDoc(hit) : null;
        const q = mockQuery(() => (hit ? { ...hit } : null));
        q.then = (res, rej) => Promise.resolve(value).then(res, rej);
        return q;
    }),
    countDocuments: jest.fn(async (filter) => mockPosts.filter((p) => mockMatches(p, filter)).length),
    create: jest.fn(async (data) => {
        if (mockPosts.some((p) => p.slug === data.slug)) {
            throw Object.assign(new Error('E11000 duplicate key slug'), { code: 11000 });
        }
        const doc = {
            _id: mockOid(), tags: [], coverUrl: '', keyword: '', readingTime: 1,
            publishedAt: data.status === 'published' ? new Date() : null,
            createdAt: new Date(), updatedAt: new Date(), ...data,
        };
        mockPosts.push(doc);
        return { ...doc };
    }),
}));

const mockRecordAudit = jest.fn(async () => {});
jest.mock('../utils/audit', () => ({ recordAudit: (...a) => mockRecordAudit(...a) }));
const mockRebuild = jest.fn();
jest.mock('../utils/deployHook', () => ({ triggerMarketingRebuild: (...a) => mockRebuild(...a) }));
const mockCompress = jest.fn();
jest.mock('../utils/cloudinaryUploader', () => ({ compressAndUpload: (...a) => mockCompress(...a) }));

const { sanitizeBlogContent } = require('../utils/sanitizeBlogContent');
const blog = require('../controllers/blogController');
const BlogPost = require('../models/blogPost');

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    return res;
}
const SA = { _id: 'sa000000000000000000000a', role: 'superadmin', superadminLevel: 'full' };
const call = async (fn, { body = {}, params = {}, query = {} } = {}) => {
    const res = mockRes();
    await fn({ body, params, query, user: SA }, res);
    return res;
};
const validPost = (o = {}) => ({ title: 'Hello World', description: 'Meta', content: 'Body text', ...o });

beforeEach(() => {
    mockPosts.length = 0;
    mockRecordAudit.mockClear();
    mockRebuild.mockClear();
    mockCompress.mockReset();
});

// ═══════════════════════ sanitizer ═══════════════════════════════════

describe('sanitizeBlogContent — dangerous markup is removed', () => {
    test.each([
        ['script tag', '<script>alert(1)</script>Hello', 'Hello'],
        ['img onerror', '<img src=x onerror=alert(1)>', '<img src="x" />'],
        ['a href javascript:', '<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
        ['mixed-case scheme', '<a href="JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
        ['leading spaces in href', '<a href="  javascript:alert(1)">x</a>', '<a>x</a>'],
        ['literal tab inside scheme', '<a href="java\tscript:alert(1)">x</a>', '<a>x</a>'],
        ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>', '<a>x</a>'],
        ['svg onload', '<svg onload=alert(1)><circle/></svg>', ''],
        ['style url(javascript:)', '<div style="background:url(javascript:alert(1))">x</div>', '<div>x</div>'],
        ['style expression()', '<p style="width:expression(alert(1))">x</p>', '<p>x</p>'],
        ['img data: URI', '<img src="data:image/svg+xml;base64,PHN2Zz4=">', '<img />'],
        ['iframe', '<iframe src="https://evil.test"></iframe>after', 'after'],
        ['object/embed', '<object data=x></object><embed src=x>', ''],
        ['form action', '<form action="javascript:alert(1)"><input></form>', ''],
        ['base / meta refresh', '<base href="javascript:/"><meta http-equiv="refresh" content="0;url=javascript:alert(1)">', ''],
        ['<style> block', '<style>body{}</style>keep', 'keep'],
        ['textarea smuggling', '<textarea><script>alert(1)</script></textarea>', ''],
        ['details ontoggle', '<details open ontoggle=alert(1)><summary>s</summary>d</details>', '<details><summary>s</summary>d</details>'],
        ['MathML xlink:href', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', 'x'],
        ['noscript mXSS', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', '<p></p>'],
        ['onclick on allowed tag', '<a href="https://x.test" onclick="x()">ok</a>', '<a href="https://x.test">ok</a>'],
    ])('%s', (_l, input, expected) => {
        expect(sanitizeBlogContent(input)).toBe(expected);
    });

    test('nested-tag reassembly cannot produce a live <script>', () => {
        const out = sanitizeBlogContent('<scr<script>ipt>alert(1)</script>');
        expect(out).not.toMatch(/<script/i);
    });

    test.each([
        ['inline link', '[click](javascript:alert(1))', '[click](#alert(1))'],
        ['inline link, leading space', '[click]( javascript:alert(1))', '[click]( #alert(1))'],
        ['angle-bracket target', '[click](<javascript:alert(1)>)', '[click](#alert(1)>)'],
        ['image data: URI', '![img](data:text/html;base64,xx)', '![img](#text/html;base64,xx)'],
        ['upper-case scheme with title', '[c](JAVASCRIPT:alert(1) "t")', '[c](#alert(1) "t")'],
        ['reference definition', '[ref]: javascript:alert(1)', '[ref]: #'],
        ['reference definition in <>', '[x]: <javascript:alert(1)>', '[x]: #'],
        ['data:text/html with inline script', '[x](data:text/html,<script>alert(1)</script>)', '[x](#text/html,)'],
    ])('markdown %s is neutralised', (_l, input, expected) => {
        expect(sanitizeBlogContent(input)).toBe(expected);
    });

    test('a code span inside an attribute is restored ESCAPED (cannot break out of the attribute)', () => {
        const out = sanitizeBlogContent('<a title="`<img src=x onerror=alert(1)>`">t</a>');
        expect(out).toBe('<a title="`&lt;img src=x onerror=alert(1)&gt;`">t</a>');
    });

    // Regression (fixed 2026-10): transformTags decodes entities + strips control chars before the scheme check (dropUnsafeUrlAttrs).
    test.each([
        ['decimal entity', '<a href="&#106;avascript:alert(1)">x</a>'],
        ['hex tab entity', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
        ['named-colon entity', '<a href="javascript&colon;alert(1)">x</a>'],
    ])('entity-encoded javascript: href (%s) must not survive', (_l, input) => {
        const out = sanitizeBlogContent(input);
        // What a browser would see after entity decoding:
        const decoded = out
            .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/&#(\d+);?/g, (_m, d) => String.fromCharCode(Number(d)))
            .replace(/&colon;/gi, ':')
            .replace(/[\t\n\r]/g, '');
        expect(decoded).not.toMatch(/href="\s*javascript:/i);
    });
});

describe('sanitizeBlogContent — legitimate content is preserved', () => {
    test('markdown (headings, emphasis, blockquote, comparisons, ampersands) is untouched', () => {
        const md = '# Title\n\n**bold** _em_ <strong>x</strong> <em>y</em>\n\n> quote\n\na < b > c && d';
        expect(sanitizeBlogContent(md)).toBe(md);
    });

    test('allowed attributes are kept on allowed tags', () => {
        const html = '<a href="https://x.test" target="_blank" rel="noopener" title="t">ok</a>';
        expect(sanitizeBlogContent(html)).toBe(html);
        expect(sanitizeBlogContent('<img src="x" alt="a" title="t" width="1" height="2" loading="lazy" class="c" id="i">'))
            .toBe('<img src="x" alt="a" title="t" width="1" height="2" loading="lazy" class="c" id="i" />');
    });

    test.each([
        ['mailto', '<a href="mailto:hi@x.test">m</a>'],
        ['tel', '<a href="tel:+911234">t</a>'],
        ['protocol-relative', '<a href="//cdn.x.test/a">p</a>'],
        ['relative', '<a href="/blog/other">r</a>'],
        ['anchor', '<a href="#top">a</a>'],
    ])('%s links survive', (_l, html) => {
        expect(sanitizeBlogContent(html)).toBe(html);
    });

    test('tables / lists / code / kbd / details survive', () => {
        const html = '<table><thead><tr><th colspan="2" align="left">h</th></tr></thead><tbody><tr><td rowspan="1">d</td></tr></tbody></table><ol start="3"><li>x</li></ol><pre><code>c</code></pre><kbd>K</kbd>';
        expect(sanitizeBlogContent(html)).toBe(html);
    });

    test('fenced code and inline code are left byte-for-byte (rendered as text by markdown)', () => {
        const fence = '```html\n<script>alert(1)</script>\n<img onerror=x>\n```';
        expect(sanitizeBlogContent(fence)).toBe(fence);
        expect(sanitizeBlogContent('`<script>alert(1)</script>`')).toBe('`<script>alert(1)</script>`');
        expect(sanitizeBlogContent('~~~\n<b onclick=1>\n~~~')).toBe('~~~\n<b onclick=1>\n~~~');
    });

    test('code spans around a dangerous tag do not shield it', () => {
        expect(sanitizeBlogContent('`a` <img src=x onerror=1> `b`')).toBe('`a` <img src="x" /> `b`');
    });

    test('entities the author wrote stay entities', () => {
        expect(sanitizeBlogContent('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        // Only &lt; / &gt; are held back; an authored &amp; comes out as a bare &
        // (renders identically in markdown).
        expect(sanitizeBlogContent('Fish &amp; Chips')).toBe('Fish & Chips');
    });

    test.each([
        [null, null],
        [undefined, undefined],
        [123, '123'],
        ['', ''],
    ])('%p → %p', (input, expected) => {
        expect(sanitizeBlogContent(input)).toBe(expected);
    });

    test('idempotent: sanitising twice equals sanitising once', () => {
        const inputs = ['<a href="https://x.test">x</a> a < b', '**x** <img src=x onerror=1>', '[c](javascript:1)'];
        for (const i of inputs) {
            const once = sanitizeBlogContent(i);
            expect(sanitizeBlogContent(once)).toBe(once);
        }
    });

    test('placeholder tokens typed by the author are not mistaken for stash slots', () => {
        const text = 'BDSAN0000000000000000X0X literal';
        expect(sanitizeBlogContent(text)).toBe(text);
    });
});

// ═══════════════════════ controller ══════════════════════════════════

describe('createBlogPost', () => {
    test('stores SANITISED content and returns the admin payload', async () => {
        const res = await call(blog.createBlogPost, { body: validPost({ content: 'Hi <script>alert(1)</script><img src=x onerror=alert(1)>' }) });
        expect(res.statusCode).toBe(201);
        expect(mockPosts[0].content).toBe('Hi <img src="x" />');
        expect(res.body.data).toEqual(expect.objectContaining({ title: 'Hello World', slug: 'hello-world', status: 'draft', author: 'Team BestoDine' }));
        expect(mockRecordAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'blog.create' }));
        expect(mockRebuild).not.toHaveBeenCalled();
    });

    test('content that sanitises to nothing → 400 Content is required', async () => {
        const res = await call(blog.createBlogPost, { body: validPost({ content: '<script>x</script><iframe></iframe>' }) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Content is required');
        expect(mockPosts).toHaveLength(0);
    });

    test.each([
        ['title', { title: '  ' }, 'Title is required'],
        ['description', { description: '' }, 'Meta description is required'],
        ['content', { content: undefined }, 'Content is required'],
    ])('missing %s → 400', async (_l, patch, msg) => {
        const res = await call(blog.createBlogPost, { body: validPost(patch) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe(msg);
    });

    test('status other than "published" is coerced to draft; published triggers a rebuild', async () => {
        await call(blog.createBlogPost, { body: validPost({ status: 'live' }) });
        expect(mockPosts[0].status).toBe('draft');
        await call(blog.createBlogPost, { body: validPost({ title: 'P', status: 'published' }) });
        expect(mockPosts[1].status).toBe('published');
        expect(mockRebuild).toHaveBeenCalledWith('blog.create.published');
    });

    test('createdBy is the caller; tags normalised (string or array, max 8)', async () => {
        await call(blog.createBlogPost, { body: validPost({ tags: ' a, b ,,c ' }) });
        expect(mockPosts[0].tags).toEqual(['a', 'b', 'c']);
        expect(mockPosts[0].createdBy).toBe(SA._id);
        await call(blog.createBlogPost, { body: validPost({ title: 'T2', tags: Array.from({ length: 12 }, (_, i) => `t${i}`) }) });
        expect(mockPosts[1].tags).toHaveLength(8);
        await call(blog.createBlogPost, { body: validPost({ title: 'T3', tags: { $gt: '' } }) });
        expect(mockPosts[2].tags).toEqual([]);
    });

    test('DB failure → 500 generic message', async () => {
        BlogPost.create.mockRejectedValueOnce(new Error('boom'));
        const res = await call(blog.createBlogPost, { body: validPost() });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ success: false, message: 'Failed to create blog post' });
    });
});

describe('slugs', () => {
    test.each([
        ['Hello, World!', 'hello-world'],
        ['  Spaces   and --- dashes  ', 'spaces-and-dashes'],
        ['Café Déjà Vu', 'caf-dj-vu'],
    ])('title %p → slug %p', async (title, slug) => {
        await call(blog.createBlogPost, { body: validPost({ title }) });
        expect(mockPosts[0].slug).toBe(slug);
    });

    test('a valid explicit slug is used as-is; an invalid one is slugified', async () => {
        await call(blog.createBlogPost, { body: validPost({ slug: 'my-post' }) });
        await call(blog.createBlogPost, { body: validPost({ slug: 'My Other Post!' }) });
        expect(mockPosts.map((p) => p.slug)).toEqual(['my-post', 'my-other-post']);
    });

    test('duplicate titles get -2, -3 suffixes', async () => {
        for (let i = 0; i < 3; i++) await call(blog.createBlogPost, { body: validPost() });
        expect(mockPosts.map((p) => p.slug)).toEqual(['hello-world', 'hello-world-2', 'hello-world-3']);
    });

    test('a title with no latin characters falls back to "post"', async () => {
        await call(blog.createBlogPost, { body: validPost({ title: 'नमस्ते दुनिया' }) });
        expect(mockPosts[0].slug).toBe('post');
    });

    // Regression (fixed 2026-10): uniqueSlug builds suffixed candidates from the 'post' fallback base.
    test('second non-latin title gets a well-formed slug (post-2), not "-2"', async () => {
        await call(blog.createBlogPost, { body: validPost({ title: 'नमस्ते' }) });
        await call(blog.createBlogPost, { body: validPost({ title: 'दुनिया' }) });
        expect(mockPosts[1].slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(mockPosts[1].slug).toBe('post-2');
    });

    test('update keeps its own slug (excludeId) and dedupes against others', async () => {
        await call(blog.createBlogPost, { body: validPost({ title: 'A' }) });
        await call(blog.createBlogPost, { body: validPost({ title: 'B' }) });
        const [a, b] = mockPosts;
        await call(blog.updateBlogPost, { params: { id: a._id }, body: { slug: 'a' } });
        expect(mockPosts.find((p) => p._id === a._id).slug).toBe('a');
        await call(blog.updateBlogPost, { params: { id: b._id }, body: { slug: 'a' } });
        expect(mockPosts.find((p) => p._id === b._id).slug).toBe('a-2');
    });

    test('concurrent creates of the same title race the check-then-insert: loser gets 500 (unique index)', async () => {
        // Characterisation: uniqueSlug is not atomic. The unique index on
        // slug prevents duplicates, but the second request fails instead of
        // retrying with -2.
        const [r1, r2] = await Promise.all([
            call(blog.createBlogPost, { body: validPost() }),
            call(blog.createBlogPost, { body: validPost() }),
        ]);
        expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 500]);
        expect(mockPosts).toHaveLength(1);
    });
});

describe('updateBlogPost', () => {
    async function seed(o = {}) {
        await call(blog.createBlogPost, { body: validPost(o) });
        return mockPosts[mockPosts.length - 1];
    }

    test('content is re-sanitised on update and the audit records only the length change', async () => {
        const p = await seed();
        const res = await call(blog.updateBlogPost, { params: { id: p._id }, body: { content: 'New <img src=x onerror=alert(1)> <a href="javascript:1">l</a>' } });
        expect(res.statusCode).toBe(200);
        expect(mockPosts[0].content).toBe('New <img src="x" /> <a>l</a>');
        const audit = mockRecordAudit.mock.calls.at(-1)[1];
        expect(audit.action).toBe('blog.update');
        expect(audit.details.changes.content).toEqual({ from: '9 chars', to: `${mockPosts[0].content.length} chars` });
    });

    test('unknown id → 404', async () => {
        const res = await call(blog.updateBlogPost, { params: { id: 'b'.repeat(24) }, body: { title: 'x' } });
        expect(res.statusCode).toBe(404);
    });

    test('empty title → 400; invalid status ignored', async () => {
        const p = await seed();
        expect((await call(blog.updateBlogPost, { params: { id: p._id }, body: { title: '  ' } })).statusCode).toBe(400);
        await call(blog.updateBlogPost, { params: { id: p._id }, body: { status: 'archived' } });
        expect(mockPosts[0].status).toBe('draft');
    });

    test('no-op save is audited as "Saved with no field changes"', async () => {
        const p = await seed();
        await call(blog.updateBlogPost, { params: { id: p._id }, body: { title: 'Hello World' } });
        expect(mockRecordAudit.mock.calls.at(-1)[1].details).toEqual(expect.objectContaining({ changedFields: [], note: 'Saved with no field changes' }));
    });

    test('rebuild fires when the post is or WAS published (unpublish), not for draft edits', async () => {
        const p = await seed();
        await call(blog.updateBlogPost, { params: { id: p._id }, body: { description: 'd2' } });
        expect(mockRebuild).not.toHaveBeenCalled();
        await call(blog.updateBlogPost, { params: { id: p._id }, body: { status: 'published' } });
        expect(mockRebuild).toHaveBeenCalledTimes(1);
        expect(mockPosts[0].publishedAt).toBeInstanceOf(Date);
        await call(blog.updateBlogPost, { params: { id: p._id }, body: { status: 'draft' } });
        expect(mockRebuild).toHaveBeenCalledTimes(2);
    });

    test('long field values are truncated in the audit preview', async () => {
        const p = await seed();
        await call(blog.updateBlogPost, { params: { id: p._id }, body: { description: 'x'.repeat(300) } });
        expect(mockRecordAudit.mock.calls.at(-1)[1].details.changes.description.to).toHaveLength(118);
    });

    // Regression (fixed 2026-10): validatePostBody rejects non-string text fields with 400.
    // (Previously pinned as "current behaviour": a generic 500 from title.trim().)
    test('non-string title / description → 400 (type validation on PATCH)', async () => {
        const p = await seed();
        expect((await call(blog.updateBlogPost, { params: { id: p._id }, body: { title: 42 } })).statusCode).toBe(400);
        expect((await call(blog.updateBlogPost, { params: { id: p._id }, body: { description: ['x'] } })).statusCode).toBe(400);
    });

    test('title / description / author are NOT sanitised (stored verbatim)', async () => {
        // Characterisation (risk): only `content` goes through the sanitizer.
        // The marketing site must escape these when rendering.
        const p = await seed();
        await call(blog.updateBlogPost, {
            params: { id: p._id },
            body: { title: '<img src=x onerror=alert(1)>', author: '<script>1</script>', coverUrl: 'https://cdn.test/c.png' },
        });
        expect(mockPosts[0]).toEqual(expect.objectContaining({
            title: '<img src=x onerror=alert(1)>', author: '<script>1</script>', coverUrl: 'https://cdn.test/c.png',
        }));
    });

    // Regression (fixed 2026-10): coverUrl with a non-http(s) scheme (incl. entity-encoded) is refused with 400.
    // (Previously pinned as "current behaviour": javascript: cover URLs were stored verbatim.)
    test.each(['javascript:alert(1)', '&#106;avascript:alert(1)', 'data:text/html,<b>x</b>'])('coverUrl %p → 400, not stored', async (coverUrl) => {
        const p = await seed();
        const before = mockPosts[0].coverUrl;
        const res = await call(blog.updateBlogPost, { params: { id: p._id }, body: { coverUrl } });
        expect(res.statusCode).toBe(400);
        expect(mockPosts[0].coverUrl).toBe(before);
    });
});

describe('public read', () => {
    async function seedMixed() {
        await call(blog.createBlogPost, { body: validPost({ title: 'Draft one' }) });
        await call(blog.createBlogPost, { body: validPost({ title: 'Live one', status: 'published', keyword: 'secret-kw' }) });
    }

    test('list returns only published posts, public shape only, cacheable', async () => {
        await seedMixed();
        const res = await call(blog.listPublicBlogPosts);
        expect(res.statusCode).toBe(200);
        expect(BlogPost.find).toHaveBeenLastCalledWith({ status: 'published' });
        expect(res.body.data).toHaveLength(1);
        expect(Object.keys(res.body.data[0]).sort()).toEqual(
            ['author', 'content', 'cover', 'date', 'description', 'readingTime', 'slug', 'tags', 'title', 'updated'],
        );
        expect(JSON.stringify(res.body)).not.toMatch(/secret-kw|createdBy|"status"|_id/);
        expect(res.headers['Cache-Control']).toBe('public, max-age=300');
    });

    test('a draft is a 404 by slug; a published post is served', async () => {
        await seedMixed();
        expect((await call(blog.getPublicBlogPost, { params: { slug: 'draft-one' } })).statusCode).toBe(404);
        const live = await call(blog.getPublicBlogPost, { params: { slug: 'live-one' } });
        expect(live.statusCode).toBe(200);
        expect(live.body.data.title).toBe('Live one');
        expect(live.body.data.keyword).toBeUndefined();
    });

    test('slug lookup is a plain equality filter (no operator injection via params)', async () => {
        await seedMixed();
        await call(blog.getPublicBlogPost, { params: { slug: 'live-one' } });
        expect(BlogPost.findOne).toHaveBeenLastCalledWith({ slug: 'live-one', status: 'published' });
    });

    test('DB errors → 500 generic', async () => {
        BlogPost.find.mockImplementationOnce(() => { throw new Error('x'); });
        expect((await call(blog.listPublicBlogPosts)).statusCode).toBe(500);
        BlogPost.findOne.mockImplementationOnce(() => { throw new Error('x'); });
        expect((await call(blog.getPublicBlogPost, { params: { slug: 's' } })).statusCode).toBe(500);
    });
});

describe('admin list / get / delete / cover', () => {
    test('list: status filter, regex-escaped search, pagination clamps', async () => {
        await call(blog.createBlogPost, { body: validPost({ title: 'a.b post' }) });
        await call(blog.createBlogPost, { body: validPost({ title: 'axb post', status: 'published' }) });
        const res = await call(blog.listBlogPosts, { query: { q: 'a.b', page: '-5', limit: '1000' } });
        expect(res.body.data.map((p) => p.title)).toEqual(['a.b post']);
        expect(res.body.pagination).toEqual(expect.objectContaining({ page: 1, limit: 100 }));
        expect(res.body.summary).toEqual({ total: 2, published: 1, draft: 1 });
        const drafts = await call(blog.listBlogPosts, { query: { status: 'draft' } });
        expect(drafts.body.data).toHaveLength(1);
    });

    test('get: 404 / 200', async () => {
        await call(blog.createBlogPost, { body: validPost() });
        expect((await call(blog.getBlogPost, { params: { id: 'nope' } })).statusCode).toBe(404);
        expect((await call(blog.getBlogPost, { params: { id: mockPosts[0]._id } })).body.data.slug).toBe('hello-world');
    });

    test('delete: removes, audits, rebuilds only if it was published', async () => {
        await call(blog.createBlogPost, { body: validPost({ status: 'published' }) });
        mockRebuild.mockClear();
        const res = await call(blog.deleteBlogPost, { params: { id: mockPosts[0]._id } });
        expect(res.statusCode).toBe(200);
        expect(mockPosts).toHaveLength(0);
        expect(mockRebuild).toHaveBeenCalledWith('blog.delete');
        expect((await call(blog.deleteBlogPost, { params: { id: 'gone' } })).statusCode).toBe(404);
    });

    test.each([
        ['listBlogPosts', 'countDocuments', {}],
        ['getBlogPost', 'findById', { params: { id: 'x' } }],
        ['updateBlogPost', 'findById', { params: { id: 'x' } }],
        ['deleteBlogPost', 'findById', { params: { id: 'x' } }],
    ])('%s: DB error → 500 generic message', async (fn, method, req) => {
        BlogPost[method].mockImplementationOnce(() => { throw new Error('db down'); });
        const res = await call(blog[fn], req);
        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
        expect(JSON.stringify(res.body)).not.toContain('db down');
    });

    test('update: keyword / coverUrl / author / tags are trimmed and audited', async () => {
        await call(blog.createBlogPost, { body: validPost() });
        await call(blog.updateBlogPost, {
            params: { id: mockPosts[0]._id },
            body: { keyword: ' kw ', coverUrl: ' https://c.test/x.jpg ', author: '   ', tags: ['x'] },
        });
        expect(mockPosts[0]).toEqual(expect.objectContaining({ keyword: 'kw', coverUrl: 'https://c.test/x.jpg', author: 'Team BestoDine', tags: ['x'] }));
        expect(mockRecordAudit.mock.calls.at(-1)[1].details.changedFields.sort()).toEqual(['coverUrl', 'keyword', 'tags']);
    });

    test('cover upload: requires a file, uses the blog folder, surfaces errors', async () => {
        expect((await call(blog.uploadBlogCover)).statusCode).toBe(400);
        mockCompress.mockResolvedValueOnce({ secure_url: 'https://res.cloudinary.test/c.jpg' });
        const res = mockRes();
        await blog.uploadBlogCover({ file: { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'c.png' } }, res);
        expect(res.body).toEqual(expect.objectContaining({ success: true, url: 'https://res.cloudinary.test/c.jpg' }));
        expect(mockCompress).toHaveBeenCalledWith(expect.objectContaining({ folder: 'bestodine/blog', maxWidth: 1280 }));
        mockCompress.mockRejectedValueOnce(new Error('cloud down'));
        const err = mockRes();
        await blog.uploadBlogCover({ file: { buffer: Buffer.from('x') } }, err);
        expect(err.statusCode).toBe(500);
    });
});
