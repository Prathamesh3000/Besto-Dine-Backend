/**
 * Magic-byte image sniffer (plan 3A.3) — no dependency.
 *
 * `sniffImage(buffer)` reports what a file REALLY is from its leading bytes,
 * so a renamed `evil.html` / `shell.php` / zip never passes as `photo.jpg`.
 *
 *   jpeg  FF D8 FF
 *   png   89 'PNG' 0D 0A 1A 0A
 *   gif   'GIF87a' | 'GIF89a'
 *   webp  'RIFF' <size> 'WEBP'
 *   bmp   'BM' + a known DIB header size
 *   tiff  'II*\0' | 'MM\0*'
 *   ico   00 00 01 00 + image count
 *   heic / avif   ISO-BMFF 'ftyp' box with a known brand
 *   svg   text that opens with <svg (optionally after BOM / <?xml / comments / doctype)
 *
 * `checkDeclared({ originalname, mimetype }, buffer)` compares the sniffed
 * type with the declared extension and MIME and returns
 * { ok, type, reason }.
 */
const path = require('path');

const ASCII = (buf, start, end) => buf.toString('latin1', start, end);

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

function looksLikeSvg(buf) {
    // Decode a bounded head only — the file may be several MB.
    let head = buf.toString('utf8', 0, Math.min(buf.length, 2048));
    if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
    // Reject anything with NUL bytes (binary masquerading as text).
    if (head.includes('\u0000')) return false;
    head = head.replace(/^\s+/, '');
    // Skip an XML prolog, comments and a doctype, then expect <svg.
    for (let i = 0; i < 8; i++) {
        const m = head.match(/^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*/i);
        if (!m) break;
        head = head.slice(m[0].length);
    }
    return /^<svg[\s>/]/i.test(head);
}

/** @returns {'jpeg'|'png'|'gif'|'webp'|'bmp'|'tiff'|'ico'|'heic'|'avif'|'svg'|null} */
function sniffImage(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 8 && buf[0] === 0x89 && ASCII(buf, 1, 4) === 'PNG'
        && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
    if (buf.length >= 6) {
        const g = ASCII(buf, 0, 6);
        if (g === 'GIF87a' || g === 'GIF89a') return 'gif';
    }
    if (buf.length >= 12 && ASCII(buf, 0, 4) === 'RIFF' && ASCII(buf, 8, 12) === 'WEBP') return 'webp';
    if (buf.length >= 18 && buf[0] === 0x42 && buf[1] === 0x4d && BMP_DIB_SIZES.has(buf.readUInt32LE(14))) return 'bmp';
    const tag4 = ASCII(buf, 0, 4);
    if (tag4 === 'II*\u0000' || tag4 === 'MM\u0000*') return 'tiff';
    if (buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf.readUInt16LE(4) > 0) return 'ico';
    if (buf.length >= 12 && ASCII(buf, 4, 8) === 'ftyp') {
        const brand = ASCII(buf, 8, 12);
        if (AVIF_BRANDS.has(brand)) return 'avif';
        if (HEIC_BRANDS.has(brand)) return 'heic';
        return null;
    }
    if (looksLikeSvg(buf)) return 'svg';
    return null;
}

// Extension → sniffed types that are acceptable for it. HEIC and AVIF share
// the ISO-BMFF container (and the mif1 brand), so either may carry either name.
const EXT_TYPES = {
    '.jpg': ['jpeg'], '.jpeg': ['jpeg'], '.jfif': ['jpeg'], '.pjpeg': ['jpeg'], '.pjp': ['jpeg'],
    '.png': ['png'],
    '.gif': ['gif'],
    '.webp': ['webp'],
    '.bmp': ['bmp'],
    '.tif': ['tiff'], '.tiff': ['tiff'],
    '.svg': ['svg'],
    '.ico': ['ico'],
    '.heic': ['heic', 'avif'], '.heif': ['heic', 'avif'],
    '.avif': ['avif', 'heic'],
};

// Specific image/* MIME types → acceptable sniffed types. Anything not listed
// (empty, application/octet-stream, an unknown image/x-…) is judged by the
// extension alone, as before.
const MIME_TYPES = {
    'image/jpeg': ['jpeg'], 'image/jpg': ['jpeg'], 'image/pjpeg': ['jpeg'],
    'image/png': ['png'], 'image/x-png': ['png'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'image/bmp': ['bmp'], 'image/x-ms-bmp': ['bmp'], 'image/x-bmp': ['bmp'],
    'image/tiff': ['tiff'], 'image/tiff-fx': ['tiff'],
    'image/svg+xml': ['svg'],
    'image/x-icon': ['ico'], 'image/vnd.microsoft.icon': ['ico'], 'image/ico': ['ico'],
    'image/heic': ['heic', 'avif'], 'image/heif': ['heic', 'avif'],
    'image/heic-sequence': ['heic', 'avif'], 'image/heif-sequence': ['heic', 'avif'],
    'image/avif': ['avif', 'heic'],
};

function checkDeclared(file, buf) {
    const type = sniffImage(buf);
    if (!type) return { ok: false, type: null, reason: 'File content is not a recognised image' };
    const ext = path.extname((file && file.originalname) || '').toLowerCase();
    const mime = String((file && file.mimetype) || '').toLowerCase();
    const byExt = EXT_TYPES[ext];
    if (byExt && !byExt.includes(type)) {
        return { ok: false, type, reason: 'File content does not match its file extension' };
    }
    const byMime = MIME_TYPES[mime];
    if (byMime && !byMime.includes(type)) {
        return { ok: false, type, reason: 'File content does not match its declared type' };
    }
    return { ok: true, type };
}

// Formats the sharp prebuilt binary decodes. HEIC (no HEVC decoder), BMP and
// ICO are NOT in this set — those are handed to Cloudinary after the
// signature check, exactly as before.
const SHARP_DECODABLE = new Set(['jpeg', 'png', 'gif', 'webp', 'tiff', 'avif', 'svg']);

module.exports = { sniffImage, checkDeclared, EXT_TYPES, MIME_TYPES, SHARP_DECODABLE };
