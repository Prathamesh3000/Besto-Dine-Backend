/**
 * Drift guard for vendor/bestodine-types (a COPY of packages/types/dist made
 * by scripts/sync-types.js). Fails when the vendored files were edited by
 * hand, partially updated, or the package was rebuilt without re-syncing.
 * Fix: `npm run build` in packages/types, then `node scripts/sync-types.js`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VENDOR = path.join(__dirname, '..', 'vendor', 'bestodine-types');
const PKG_DIST = path.join(__dirname, '..', '..', 'packages', 'types', 'dist');
const PKG_VECTORS = path.join(__dirname, '..', '..', 'packages', 'types', 'golden-vectors.json');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function list(dir, base = dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return list(p, base);
        return e.name === 'MANIFEST.json' ? [] : [path.relative(base, p).split(path.sep).join('/')];
    }).sort();
}

describe('vendored @bestodine/types copy', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'MANIFEST.json'), 'utf8'));

    test('contains exactly the files in its manifest, byte for byte', () => {
        expect(list(VENDOR)).toEqual(Object.keys(manifest.files).sort());
        for (const [file, hash] of Object.entries(manifest.files)) {
            expect({ file, hash: sha(path.join(VENDOR, file)) }).toEqual({ file, hash });
        }
    });

    const haveDist = fs.existsSync(PKG_DIST);
    (haveDist ? test : test.skip)('matches the current packages/types build (rebuilt without re-syncing?)', () => {
        expect(list(PKG_DIST)).toEqual(list(VENDOR));
        for (const f of list(PKG_DIST)) {
            expect({ f, hash: sha(path.join(VENDOR, f)) }).toEqual({ f, hash: sha(path.join(PKG_DIST, f)) });
        }
    });

    test('golden vectors match the package source of truth', () => {
        expect(sha(path.join(VENDOR, 'golden-vectors.json'))).toBe(sha(PKG_VECTORS));
    });
});
