/**
 * POST /menu/scan: read photos / a PDF of a menu card and return a DRAFT.
 *
 * Nothing is saved. The owner reviews and fixes the draft in the browser, and
 * only then is it sent through the existing CSV importer (POST /menu/import),
 * which keeps its plan limits, duplicate skipping and category creation.
 */
'use strict';

const logger = require('../utils/logger');
const { assess, prepare } = require('../utils/menuScan/imageQuality');
const { readMenu, isConfigured } = require('../utils/menuScan/extractor');
const { buildDraft, mergePasses } = require('../utils/menuScan/draft');

const MAX_FILES = 6;

function fail(res, status, code, message) {
    return res.status(status).json({ success: false, code, message });
}

exports.scanMenu = async (req, res) => {
    try {
        if (!isConfigured()) {
            return fail(res, 503, 'SCAN_NOT_CONFIGURED', 'Menu scanning is not switched on for this server yet.');
        }
        const files = Array.isArray(req.files) ? req.files : [];
        if (files.length === 0) return fail(res, 400, 'NO_FILES', 'Choose at least one photo or PDF of your menu.');
        if (files.length > MAX_FILES) return fail(res, 400, 'TOO_MANY_FILES', `Upload at most ${MAX_FILES} files at a time.`);

        // 1. Look at every file: quality report + a cleaned-up copy for the reader.
        const pages = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const index = i + 1;
            if (f.mimetype === 'application/pdf') {
                pages.push({ index, name: f.originalname, kind: 'pdf', level: 'good', quality: { ok: true, level: 'good', warnings: [] }, payload: { index, mediaType: 'application/pdf', data: f.buffer.toString('base64') } });
                continue;
            }
            const quality = await assess(f.buffer);
            if (quality.level === 'unreadable') {
                return fail(res, 400, 'UNREADABLE_IMAGE', `We could not open "${f.originalname}". Choose a JPG, PNG or WebP photo.`);
            }
            const prepared = await prepare(f.buffer, { level: quality.level });
            pages.push({ index, name: f.originalname, kind: 'image', level: quality.level, quality, payload: { index, mediaType: prepared.mediaType, data: prepared.buffer.toString('base64') } });
        }

        // 2. First reading of everything.
        let raw = await readMenu(pages.map((p) => p.payload));

        // 3. Blurry pages get a second, independent reading; disagreements are flagged.
        const hard = pages.filter((p) => p.level === 'blurry');
        if (hard.length > 0) {
            const hardIdx = new Set(hard.map((p) => p.index));
            const onHard = raw.filter((it) => hardIdx.has(Number.isInteger(it?.page) ? it.page : 1));
            const rest = raw.filter((it) => !hardIdx.has(Number.isInteger(it?.page) ? it.page : 1));
            const second = await readMenu(hard.map((p) => p.payload));
            raw = [...rest, ...mergePasses(onHard, second)];
        }

        // 4. Build the review rows. Boxes only make sense for photos.
        const pdfPages = new Set(pages.filter((p) => p.kind === 'pdf').map((p) => p.index));
        const rows = buildDraft(raw, pages).map((r) => (pdfPages.has(r.page) ? { ...r, box: null } : r));
        if (rows.length === 0) {
            return fail(res, 422, 'NOTHING_FOUND', 'We could not find any dishes. Try a clearer, closer photo of the menu.');
        }

        const categories = [...new Set(rows.map((r) => r.category))];
        return res.json({
            success: true,
            data: {
                rows,
                categories,
                pages: pages.map(({ index, name, kind, quality }) => ({ index, name, kind, quality })),
                needsCheckCount: rows.filter((r) => r.needsCheck).length,
            },
        });
    } catch (err) {
        const status = Number(err?.status);
        logger.error('menu scan failed', { error: err?.message, status: status || undefined });
        if (status === 429 || status === 529 || status === 503) {
            return fail(res, 503, 'SCAN_BUSY', 'The menu reader is busy right now. Please try again in a minute.');
        }
        if (status === 401 || status === 403) {
            return fail(res, 503, 'SCAN_NOT_CONFIGURED', 'Menu scanning is not set up correctly on this server.');
        }
        return fail(res, 502, 'SCAN_FAILED', 'We could not read the menu this time. Please try again.');
    }
};
