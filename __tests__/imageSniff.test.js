/**
 * Upload hardening (plan 3A.3): magic-byte sniffer + the content check that
 * runs after multer. Real sharp, real (tiny) file headers — no mocks, no DB.
 */
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { sniffImage, checkDeclared } = require('../utils/imageSniff');
const upload = require('../middlewares/uploadMiddleware');

const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const HDR = {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]),
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0])]),
    webp: Buffer.concat([Buffer.from('RIFF'), le32(20), Buffer.from('WEBPVP8 ')]),
    bmp: Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), le32(40), Buffer.alloc(8)]),
    tiff: Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]),
    ico: Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]),
    heic: Buffer.concat([le32(24), Buffer.from('ftypheic'), Buffer.alloc(8)]),
    avif: Buffer.concat([le32(24), Buffer.from('ftypavif'), Buffer.alloc(8)]),
    svg: Buffer.from('<?xml version="1.0"?>\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg"/>'),
};

describe('sniffImage', () => {
    test.each(Object.keys(HDR))('recognises %s', (type) => {
        expect(sniffImage(HDR[type])).toBe(type);
    });

    test.each([
        ['empty', Buffer.alloc(0)],
        ['too short', Buffer.from([0xff, 0xd8])],
        ['html', Buffer.from('<html><script>alert(1)</script></html>')],
        ['svg-looking html', Buffer.from('<div><svg></svg></div>')],
        ['zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
        ['pdf', Buffer.from('%PDF-1.7\n')],
        ['exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
        ['php', Buffer.from('<?php system($_GET[0]); ?>')],
        ['RIFF but not WEBP (wav)', Buffer.concat([Buffer.from('RIFF'), le32(4), Buffer.from('WAVE')])],
        ['ftyp with unknown brand (mp4)', Buffer.concat([le32(24), Buffer.from('ftypisom'), Buffer.alloc(8)])],
        ['BM with bad DIB size', Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), le32(7), Buffer.alloc(8)])],
        ['a string', 'not a buffer'],
    ])('rejects %s', (_l, buf) => {
        expect(sniffImage(buf)).toBeNull();
    });

    test('binary data that starts like an svg but has NUL bytes is not svg', () => {
        expect(sniffImage(Buffer.concat([Buffer.from('<svg'), Buffer.alloc(4)]))).toBeNull();
    });
});

describe('checkDeclared', () => {
    test('matching extension + mime passes', () => {
        expect(checkDeclared({ originalname: 'a.jpg', mimetype: 'image/jpeg' }, HDR.jpeg)).toEqual({ ok: true, type: 'jpeg' });
        expect(checkDeclared({ originalname: 'a.PNG', mimetype: 'image/png' }, HDR.png).ok).toBe(true);
        expect(checkDeclared({ originalname: 'a.heic', mimetype: 'application/octet-stream' }, HDR.heic).ok).toBe(true);
        expect(checkDeclared({ originalname: 'a.heif', mimetype: '' }, HDR.avif).ok).toBe(true);
    });
    test('extension / mime that disagree with the bytes fail', () => {
        expect(checkDeclared({ originalname: 'a.png', mimetype: 'image/png' }, HDR.jpeg).ok).toBe(false);
        expect(checkDeclared({ originalname: 'a.jpg', mimetype: 'image/png' }, HDR.jpeg).ok).toBe(false); // mime says png
        expect(checkDeclared({ originalname: 'a.svg', mimetype: 'image/svg+xml' }, HDR.png).ok).toBe(false);
        expect(checkDeclared({ originalname: 'a.png', mimetype: 'image/png' }, Buffer.from('<html>')).ok).toBe(false);
    });
    test('unknown / generic mime falls back to the extension only', () => {
        expect(checkDeclared({ originalname: 'a.webp', mimetype: 'application/octet-stream' }, HDR.webp).ok).toBe(true);
        expect(checkDeclared({ originalname: 'a.webp', mimetype: 'image/x-weird' }, HDR.webp).ok).toBe(true);
    });
});

describe('uploadMiddleware content check (real sharp)', () => {
    const app = express();
    app.post('/up', upload.single('image'), (req, res) => res.json({ ok: true, size: req.file ? req.file.size : 0 }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ ok: false, message: err.message }));
    const send = (filename, contentType, buf) => request(app).post('/up').attach('image', buf, { filename, contentType });

    let realPng; let realJpeg; let realWebp; let realGif;
    beforeAll(async () => {
        const base = sharp({ create: { width: 8, height: 8, channels: 3, background: '#dd3333' } });
        realPng = await base.clone().png().toBuffer();
        realJpeg = await base.clone().jpeg().toBuffer();
        realWebp = await base.clone().webp().toBuffer();
        realGif = await base.clone().gif().toBuffer();
    });

    test('valid PNG / JPEG / WebP / GIF / SVG pass', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
        const cases = [
            ['a.png', 'image/png', realPng], ['a.jpg', 'image/jpeg', realJpeg],
            ['a.webp', 'image/webp', realWebp], ['a.gif', 'image/gif', realGif],
            ['a.svg', 'image/svg+xml', svg],
        ];
        for (const [n, m, b] of cases) {
            const res = await send(n, m, b);
            expect({ n, status: res.status }).toEqual({ n, status: 200 });
        }
    });

    test('HEIC / BMP / ICO pass on signature alone (sharp cannot decode them; Cloudinary does)', async () => {
        expect((await send('a.heic', 'image/heic', HDR.heic)).status).toBe(200);
        expect((await send('a.bmp', 'image/bmp', HDR.bmp)).status).toBe(200);
        expect((await send('a.ico', 'image/x-icon', HDR.ico)).status).toBe(200);
    });

    test('valid header but corrupt body is rejected (sharp cannot decode)', async () => {
        const res = await send('a.png', 'image/png', realPng.subarray(0, 40));
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/could not be read/);
        const junkJpeg = Buffer.concat([HDR.jpeg, Buffer.from('this is not jpeg data at all')]);
        expect((await send('a.jpg', 'image/jpeg', junkJpeg)).status).toBe(400);
    });

    test('spoofed content is rejected with 400', async () => {
        expect((await send('a.png', 'image/png', Buffer.from('<html><script>1</script></html>'))).status).toBe(400);
        expect((await send('a.jpg', 'image/jpeg', realPng)).status).toBe(400);   // png bytes, .jpg name
        expect((await send('a.svg', 'image/svg+xml', realPng)).status).toBe(400);
    });

    test('a request with no file passes straight through the content check', async () => {
        const res = await request(app).post('/up').field('x', '1');
        expect(res.status).toBe(200);
        expect(res.body.size).toBe(0);
    });
});
