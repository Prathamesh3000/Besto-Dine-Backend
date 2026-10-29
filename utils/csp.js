/**
 * Content-Security-Policy for the BestoDine SPA (plan task 3A.4).
 *
 * One policy builder, three consumers:
 *   - app.js feeds it to helmet (API responses),
 *   - docs/COOKIE_AUTH_AND_CSP.md + Frontend/public/_headers carry the same
 *     policy for the static host that actually serves the SPA,
 *   - __tests__/csp.test.js pins it.
 *
 * CSP_MODE = off | report-only | enforce   (default report-only)
 *
 * Third parties come from grepping the Frontend: Razorpay Checkout (script +
 * frames + beacons), Google Identity Services, Cloudinary / Unsplash and a few
 * QR / avatar / barcode image hosts, Google Fonts + Flaticon icon CSS, Sentry
 * ingest, Nominatim geocoding. Extend without a code change via
 * CSP_EXTRA_{SCRIPT,STYLE,FONT,IMG,CONNECT,FRAME}_SRC (comma separated).
 */

const MODES = ['off', 'report-only', 'enforce'];

function cspMode(env = process.env) {
    const v = String(env.CSP_MODE || '').trim().toLowerCase();
    return MODES.includes(v) ? v : 'report-only';
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** wss:// / ws:// twin of an http(s) origin, so sockets are covered on old Safari. */
function wsTwin(origin) {
    try {
        const u = new URL(origin);
        if (u.protocol === 'https:') return `wss://${u.host}`;
        if (u.protocol === 'http:') return `ws://${u.host}`;
    } catch { /* not a URL */ }
    return null;
}

function buildDirectives(env = process.env) {
    const isProd = env.NODE_ENV === 'production';
    const extra = (name) => list(env[`CSP_EXTRA_${name}_SRC`]);

    // API origins the browser may talk to besides 'self' (REST + socket.io).
    // Production serves /api and /socket.io same-origin (VITE_API_URL=/api/v1),
    // so this is usually empty; set CSP_API_ORIGINS when the API has its own host.
    const apiOrigins = list(env.CSP_API_ORIGINS);
    const apiWs = apiOrigins.map(wsTwin).filter(Boolean);
    const dev = isProd ? [] : ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'];

    const d = {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://checkout.razorpay.com', 'https://accounts.google.com/gsi/client', ...extra('SCRIPT')],
        // React sets inline style attributes everywhere; no inline <script> is used.
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net',
            'https://cdn-uicons.flaticon.com', 'https://accounts.google.com/gsi/style', ...extra('STYLE')],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net',
            'https://cdn-uicons.flaticon.com', ...extra('FONT')],
        'img-src': ["'self'", 'data:', 'blob:', ...apiOrigins,
            'https://res.cloudinary.com', 'https://images.unsplash.com', 'https://plus.unsplash.com',
            'https://ui-avatars.com', 'https://barcode.tec-it.com', 'https://quickchart.io',
            'https://api.qrserver.com', 'https://img.icons8.com',
            'https://*.googleusercontent.com', 'https://*.razorpay.com', ...extra('IMG')],
        'media-src': ["'self'", 'data:', 'blob:', ...apiOrigins, 'https://res.cloudinary.com'],
        'connect-src': ["'self'", ...apiOrigins, ...apiWs, ...dev,
            'https://*.ingest.sentry.io', 'https://*.sentry.io',
            'https://nominatim.openstreetmap.org',
            'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://lumberjack.razorpay.com',
            'https://accounts.google.com/gsi/', ...extra('CONNECT')],
        'frame-src': ['https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://accounts.google.com/gsi/',
            'https://www.youtube.com', 'https://player.vimeo.com', ...extra('FRAME')],
        'worker-src': ["'self'", 'blob:'],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'", 'https://api.razorpay.com'],
        'frame-ancestors': ["'self'"],
    };
    const report = String(env.CSP_REPORT_URI || '/csp-report').trim();
    if (report) d['report-uri'] = [report];
    if (isProd && cspMode(env) === 'enforce') d['upgrade-insecure-requests'] = [];
    return d;
}

/** Serialise to the header value (also used to render docs / _headers). */
function serialize(directives = buildDirectives()) {
    return Object.entries(directives)
        .map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k))
        .join('; ');
}

/** `contentSecurityPolicy` option for helmet, or false when CSP_MODE=off. */
function helmetCspOption(env = process.env) {
    const mode = cspMode(env);
    if (mode === 'off') return false;
    return { useDefaults: false, reportOnly: mode === 'report-only', directives: buildDirectives(env) };
}

module.exports = { MODES, cspMode, buildDirectives, serialize, helmetCspOption };
