/**
 * Jest transformer for node_modules files (integration run only).
 *
 * Some runtime dependencies ship ESM-only builds (uuid@13, and
 * sanitize-html's htmlparser2 / domhandler / entities chain). Node itself
 * can require() them, but Jest's CommonJS module runtime cannot. This
 * transformer rewrites files that use ESM syntax to CommonJS with
 * @babel/plugin-transform-modules-commonjs and leaves every other file
 * untouched (fast path), so the app loads exactly the same dependency
 * code it runs in production.
 */
const crypto = require('crypto');
const babel = require('@babel/core');

const ESM_HINT = /^\s*(import\s[\s\S]*?from\s|import\s*['"{*]|export\s)/m;

module.exports = {
    getCacheKey(sourceText, sourcePath) {
        return crypto.createHash('sha1')
            .update('bd-esm-transformer-v3\0').update(sourcePath).update('\0').update(sourceText)
            .digest('hex');
    },
    process(sourceText, sourcePath) {
        if (!ESM_HINT.test(sourceText)) return { code: sourceText };
        const out = babel.transformSync(sourceText, {
            filename: sourcePath,
            babelrc: false,
            configFile: false,
            sourceType: 'unambiguous', // files without import/export stay scripts
            compact: false,
            plugins: [
                require.resolve('@babel/plugin-transform-export-namespace-from'),
                require.resolve('@babel/plugin-transform-modules-commonjs'),
            ],
        });
        return { code: out.code };
    },
};
