const sharp = require('sharp');
const { assess, prepare } = require('../utils/menuScan/imageQuality');

// Black text-like dashes on white paper.
async function textPage(blur = 0) {
    const w = 1400, h = 1800;
    const rects = [];
    for (let y = 60; y < h - 60; y += 36) {
        for (let x = 60; x < w - 200; x += 70) rects.push(`<rect x="${x}" y="${y}" width="${40 + ((x + y) % 25)}" height="9" fill="#111"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${rects.join('')}</svg>`;
    let img = sharp(Buffer.from(svg));
    if (blur) img = img.blur(blur);
    return img.jpeg().toBuffer();
}

describe('menu scan image quality', () => {
    test('crisp page scores good, heavily blurred page scores blurry', async () => {
        const crisp = await assess(await textPage());
        const blurry = await assess(await textPage(14));
        expect(crisp.level).toBe('good');
        expect(blurry.level).toBe('blurry');
        expect(blurry.ok).toBe(false);
        expect(blurry.warnings.join(' ')).toMatch(/blurry/i);
        expect(blurry.sharpness).toBeLessThan(crisp.sharpness);
    });

    test('tiny dark photo gets size and light warnings', async () => {
        const buf = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#101010' } }).jpeg().toBuffer();
        const q = await assess(buf);
        expect(q.warnings.join(' ')).toMatch(/small/i);
        expect(q.warnings.join(' ')).toMatch(/dark/i);
    });

    test('garbage bytes are reported unreadable, not thrown', async () => {
        const q = await assess(Buffer.from('not an image'));
        expect(q.level).toBe('unreadable');
    });

    test('prepare returns a JPEG no larger than 2000px', async () => {
        const out = await prepare(await textPage(), { level: 'good' });
        const meta = await sharp(out.buffer).metadata();
        expect(meta.format).toBe('jpeg');
        expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(2000);
    });
});
