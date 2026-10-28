/**
 * Menu-scan image helpers (sharp).
 *
 *   assess(buffer)  → quality report (sharpness, brightness, size) — never throws
 *   prepare(buffer) → straightened, contrast-normalised, sharpened JPEG for the reader
 *
 * Sharpness is the variance of a Laplacian over a greyscale copy scaled to
 * 800px, so photos of different sizes are comparable. The thresholds are a
 * heuristic: a menu page is mostly white paper, which scores lower than a
 * photo of a street, so the bar is deliberately modest. A "blurry" verdict
 * only triggers a warning and a second reading pass; it never blocks.
 */
'use strict';

const sharp = require('sharp');

const BLURRY_BELOW = 45;
const SOFT_BELOW = 120;
const MIN_LONG_EDGE = 900;
const TOO_DARK = 70;
const TOO_BRIGHT = 235;
const MAX_LONG_EDGE = 2000;

async function assess(buffer) {
    const warnings = [];
    try {
        const { data, info } = await sharp(buffer, { failOn: 'none' })
            .rotate()
            .greyscale()
            .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
            .raw()
            .toBuffer({ resolveWithObject: true });
        const meta = await sharp(buffer, { failOn: 'none' }).metadata();
        const swap = meta.orientation && meta.orientation >= 5;
        const width = swap ? meta.height : meta.width;
        const height = swap ? meta.width : meta.height;

        const { width: w, height: h } = info;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const brightness = sum / data.length;

        // Variance of the 4-neighbour Laplacian over interior pixels.
        let lapSum = 0;
        let lapSq = 0;
        let n = 0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                const v = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
                lapSum += v;
                lapSq += v * v;
                n++;
            }
        }
        const mean = n ? lapSum / n : 0;
        const sharpness = n ? lapSq / n - mean * mean : 0;

        const level = sharpness < BLURRY_BELOW ? 'blurry' : sharpness < SOFT_BELOW ? 'soft' : 'good';
        if (level === 'blurry') warnings.push('This photo looks blurry. We will read it twice and ask you to check more rows.');
        else if (level === 'soft') warnings.push('This photo is a little soft. Please check the prices carefully.');
        if (Math.max(width || 0, height || 0) < MIN_LONG_EDGE) warnings.push('This photo is small. A closer, larger photo reads better.');
        if (brightness < TOO_DARK) warnings.push('This photo is dark. Retake it with more light if many rows look wrong.');
        else if (brightness > TOO_BRIGHT) warnings.push('This photo is very bright or washed out. Avoid glare when you retake it.');

        return { ok: level !== 'blurry', level, sharpness: Math.round(sharpness), brightness: Math.round(brightness), width, height, warnings };
    } catch {
        return { ok: false, level: 'unreadable', sharpness: 0, brightness: 0, width: 0, height: 0, warnings: ['We could not open this image.'] };
    }
}

async function prepare(buffer, { level } = {}) {
    let img = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const long = Math.max(meta.width || 0, meta.height || 0);
    // Small or soft photos are enlarged a little: text strokes get more pixels to read.
    const target = (level === 'blurry' || level === 'soft' || long < 1200) ? Math.min(Math.max(long, 1600), MAX_LONG_EDGE) : Math.min(long, MAX_LONG_EDGE);
    img = img.resize({ width: target, height: target, fit: 'inside', kernel: 'lanczos3' }).normalise();
    img = level === 'blurry' ? img.sharpen({ sigma: 1.6, m1: 1.2, m2: 2 }) : img.sharpen({ sigma: 1 });
    const out = await img.jpeg({ quality: 88 }).toBuffer();
    return { buffer: out, mediaType: 'image/jpeg' };
}

module.exports = { assess, prepare, BLURRY_BELOW, SOFT_BELOW };
