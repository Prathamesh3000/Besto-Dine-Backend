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

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

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

  // Same compression rules as the old disk-based pipeline so image
  // quality on existing pages stays visually identical.
  const ext = String(originalname || '').split('.').pop().toLowerCase();
  let pipeline = sharp(buffer).resize({ width: maxWidth, withoutEnlargement: true });
  let outBuf;
  let format = 'jpg';

  if (ext === 'png' || mimetype === 'image/png') {
    outBuf = await pipeline.png({ quality: 80, compressionLevel: 9 }).toBuffer();
    format = 'png';
  } else if (ext === 'webp' || mimetype === 'image/webp') {
    outBuf = await pipeline.webp({ quality: 80 }).toBuffer();
    format = 'webp';
  } else {
    outBuf = await pipeline.jpeg({ quality: 80 }).toBuffer();
    format = 'jpg';
  }

  // Cloudinary's stream uploader takes the buffer directly — no temp
  // file on disk, so this works on read-only deploy filesystems too.
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder, format, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result)),
    ).end(outBuf);
  });
}

module.exports = { compressAndUpload, cloudinary };
