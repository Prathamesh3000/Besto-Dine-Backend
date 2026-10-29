# Input validation + upload hardening (plan 3A.2 / 3A.3)

## Validation

- Built on `middlewares/validate.js` (express-validator, uniform
  `400 { success:false, message, errors:[{field,message}] }`).
- Reusable chains live in `Backend/validators/`:
  - `common.js` — `optionalAmount`, `optionalText`, `optionalEnum`, `optionalBool`,
    `optionalDate`, `optionalArray`, `optionalStringArray`, `lines(...)` (per-line rules).
  - `money.js` — staff wallet, tips, purchases, suppliers, production, tenant billing.
  - `ops.js` — orders, shifts, areas, printing, inventory + recipes, halls,
    event-type / package / add-on catalog, decoration packages, combos, captain escalate.
- Policy: strict on TYPE and RANGE (ObjectIds, finite amounts with maxima,
  enums, string lengths, array caps, dates); permissive on missing fields
  (controllers keep their "X is required" messages) and on unknown keys.
  Numeric strings are accepted where forms post strings.
- Order `:id` params accept a Mongo id OR the human order number
  (`ORD-0001`), so they are checked for length/charset, not ObjectId.
- Validators sit BEFORE `idempotency()` on routes that have it, so a rejected
  payload never consumes / caches an idempotency key.
- Controllers were not changed.

## Uploads

- `utils/imageSniff.js`: magic-byte sniffer (JPEG, PNG, GIF, WebP, BMP, TIFF,
  ICO, HEIC/AVIF via `ftyp` brand, SVG by text) + `checkDeclared()` comparing the
  real type with the declared extension and MIME.
- `middlewares/uploadMiddleware.js`: `upload.single(field)` now returns
  `[multer, verifyImageContent]` (Express flattens it), so every existing
  `upload.single('image')` route (POST /upload, /auth avatar, superadmin
  marketing logo / screenshot / blog cover) is covered with no route edits.
  A file whose bytes are not an image, or disagree with its extension / MIME, gets
  `400`. JPEG/PNG/GIF/WebP/TIFF/AVIF/SVG are also trial-decoded with sharp
  (shrink-on-load) so truncated / corrupt files get `400`.
- `utils/cloudinaryUploader.js`: when sharp cannot decode, the original is
  no longer forwarded blindly. Only signature-verified HEIC / BMP / ICO (formats the
  prebuilt sharp lacks, previously relied on Cloudinary) still go to Cloudinary;
  anything else throws a `status 400` error. sharp now runs with `failOn:'error'`
  (more tolerant of benign warnings than the default).
- 5 MB limit unchanged. Not covered: `menuRoute` `scanUpload` (image/PDF for
  the AI menu scan) and the CSV importers use their own multer instances.

## Tests

- `__tests__/routeValidators.test.js` — real route files, mocked controllers/auth.
- `__tests__/imageSniff.test.js` — sniffer + middleware with real sharp and real headers.
- `__tests__/middlewareUtils.test.js` — upload cases updated to real signatures.
