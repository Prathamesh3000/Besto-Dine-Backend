/**
 * stagingGuard — the one check that keeps every staging tool off production.
 *
 * Seed/seedStaging.js DROPS the database it is pointed at, and the staging
 * scripts (scripts/staging-db.js, scripts/staging-health.js) must never be
 * aimed at the live Atlas cluster by a copied .env. So every one of them
 * calls assertStagingDb(process.env.MONGO_URL) before touching anything.
 *
 * A URL is "staging" only when ALL of these hold:
 *   1. the database name is exactly `bestodine_staging`;
 *   2. the host is local (127.0.0.1 / localhost / ::1) OR the hostname
 *      contains "staging" (e.g. a dedicated Atlas cluster named
 *      bestodine-staging.xxxxx.mongodb.net);
 *   3. the URL does not mention the production cluster (`bestodine-in`).
 *
 * No dependencies, no I/O — safe to unit test and to require anywhere.
 */

const STAGING_DB_NAME = 'bestodine_staging';
const PRODUCTION_MARKER = 'bestodine-in';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Pull hosts + database name out of a mongodb:// or mongodb+srv:// URL
 * without the Node URL class (it does not accept comma-separated hosts).
 * Returns null when the string is not a MongoDB connection URL.
 */
function parseMongoUrl(url) {
    if (typeof url !== 'string') return null;
    const m = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(url.trim());
    if (!m) return null;
    const [, protocol, authority, pathname] = m;
    // Strip credentials (user:pass@) — they may contain '@' when URL-encoded,
    // so split on the LAST '@'.
    const at = authority.lastIndexOf('@');
    const hostPart = at === -1 ? authority : authority.slice(at + 1);
    if (!hostPart) return null;
    const hosts = hostPart.split(',').map((h) => {
        // IPv6 literal "[::1]:27017" → "[::1]"; otherwise drop ":port".
        if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1).toLowerCase();
        return h.split(':')[0].toLowerCase();
    }).filter(Boolean);
    const dbName = decodeURIComponent((pathname || '').replace(/^\/+/, ''));
    return { protocol: protocol.toLowerCase(), hosts, dbName };
}

/**
 * true only for a URL that points at the staging database (see header).
 * Never throws — any unparsable input is simply "not staging".
 */
function isStagingMongoUrl(url) {
    const parsed = parseMongoUrl(url);
    if (!parsed) return false;
    if (url.toLowerCase().includes(PRODUCTION_MARKER)) return false;
    if (parsed.dbName !== STAGING_DB_NAME) return false;
    if (!parsed.hosts.length) return false;
    return parsed.hosts.every((host) => LOCAL_HOSTS.has(host) || host.includes('staging'));
}

/** Hide credentials when echoing a URL in an error message. */
function redactMongoUrl(url) {
    if (typeof url !== 'string') return String(url);
    return url.replace(/^(mongodb(?:\+srv)?:\/\/)([^@/]*)@/i, '$1***@');
}

/**
 * Throw loudly unless `url` is the staging database.
 * @param {string} url   the MongoDB URL about to be used
 * @param {string} what  who is asking (for the error message), e.g. 'seedStaging'
 */
function assertStagingDb(url, what = 'this script') {
    if (isStagingMongoUrl(url)) return url;
    throw new Error(
        `\n` +
        `==================================================================\n` +
        `  REFUSING TO RUN: ${what} only works against the STAGING database.\n` +
        `  MONGO_URL = ${typeof url === 'string' && url.trim() ? redactMongoUrl(url) : '(empty)'}\n` +
        `  Required: database name "${STAGING_DB_NAME}" on 127.0.0.1/localhost\n` +
        `  (or a host whose name contains "staging"), and never "${PRODUCTION_MARKER}".\n` +
        `  Run through:  npm run <script>:staging   (loads Backend/.env.staging)\n` +
        `==================================================================\n`,
    );
}

module.exports = {
    STAGING_DB_NAME,
    PRODUCTION_MARKER,
    parseMongoUrl,
    isStagingMongoUrl,
    assertStagingDb,
    redactMongoUrl,
};
