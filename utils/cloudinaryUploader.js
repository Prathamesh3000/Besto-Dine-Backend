/**
 * Cloudinary uploader — single source of truth for compressing an
 * image buffer and pushing it to Cloudinary. Used by both the admin
 * /api/v1/upload route and the customer avatar endpoint so they share
 * the same Sharp pipeline + folder conventions.
 *
 * Returns the Cloudinary upload result object — `secure_url` is the
 * canonical persistent URL that gets stored on the model and rendered
 * by the frontend resolver as-is (no /uploads/ prefix, so it bypasses
 * the host-prepend branch in Frontend/src/utils/image.js).
 */
const cloudinary = require('cloudinary').v2;
const sharp = require('sharp');
const { sniffImage } = require('./imageSniff');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// Signature-verified formats that sharp's prebuilt binary cannot decode.
const SHARP_FALLBACK_TYPES = new Set(['heic', 'bmp', 'ico']);

async function compressAndUpload({
  buffer,
  mimetype,
  originalname,
  folder = 'bestodine/uploads',
  maxWidth = 1200,
}) {
  if (!buffer || !buffer.length) {
    throw new Error('Empty buffer — nothing to upload.');
  }

  // Every upload is re-encoded to one of three web formats. Inputs that
  // can carry transparency (PNG, GIF, SVG, ICO) become PNG, WebP stays
  // WebP, everything else (JPG, HEIC, AVIF, BMP, TIFF…) becomes JPG.
  // Same compression settings as the old disk-based pipeline so image
  // quality on existing pages stays visually identical.
  const ext = String(originalname || '').split('.').pop().toLowerCase();
  const mime = String(mimetype || '').toLowerCase();
  const isType = (exts, mimes) => exts.includes(ext) || mimes.includes(mime);
  let format = 'jpg';
  if (isType(['png', 'gif', 'svg', 'ico'], ['image/png', 'image/gif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'])) {
    format = 'png';
  } else if (isType(['webp'], ['image/webp'])) {
    format = 'webp';
  }

  let outBuf = null;
  try {
    // .rotate() applies the EXIF orientation so phone photos aren't sideways.
    const pipeline = sharp(buffer, { failOn: 'error' }).rotate().resize({ width: maxWidth, withoutEnlargement: true });
    if (format === 'png') outBuf = await pipeline.png({ quality: 80, compressionLevel: 9 }).toBuffer();
    else if (format === 'webp') outBuf = await pipeline.webp({ quality: 80 }).toBuffer();
    else outBuf = await pipeline.jpeg({ quality: 80 }).toBuffer();
  } catch (err) {
    // An SVG is only ever stored rasterised — never pass the markup on.
    if (ext === 'svg' || mime === 'image/svg+xml') throw err;
    // Sharp can't decode this one. Only formats the prebuilt binary is known
    // to lack (iPhone HEIC — no HEVC decoder — BMP, ICO) AND whose magic bytes
    // really match are handed to Cloudinary, which decodes far more formats
    // and converts to `format` on upload with the same width cap. Anything
    // else (a corrupt JPEG/PNG/GIF/WebP/TIFF/AVIF, or bytes that are not an
    // image at all) is rejected instead of being forwarded unchecked.
    if (!SHARP_FALLBACK_TYPES.has(sniffImage(buffer))) {
      const bad = new Error('Image could not be processed. Please upload a valid image file.');
      bad.status = 400;
      bad.expose = true;
      throw bad;
    }
    outBuf = null;
  }

  // Cloudinary's stream uploader takes the buffer directly — no temp
  // file on disk, so this works on read-only deploy filesystems too.
  const options = outBuf
    ? { folder, format, resource_type: 'image' }
    : { folder, format, resource_type: 'image', transformation: [{ width: maxWidth, crop: 'limit', quality: 80 }] };
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      options,
      (err, result) => (err ? reject(err) : resolve(result)),
    ).end(outBuf || buffer);
  });
}

module.exports = { compressAndUpload, cloudinary };
