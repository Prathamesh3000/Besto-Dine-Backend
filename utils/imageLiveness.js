// Shared image-URL liveness check used by the category and menu-item
// image auto-healers.
//
// Returns one of:
//   'alive'   → HTTP < 400 (renders fine)
//   'dead'    → HTTP 404 / 410 (definitively gone — safe to replace)
//   'unknown' → timeout / network error / any other status that persists
//               through retries (e.g. a 403 or a 429 rate-limit that
//               never clears). Callers MUST NOT act on 'unknown': a flaky
//               scan must never overwrite a working image, and a rate
//               limit is not proof an image is gone.
//
// Rate-limit resilience: image hosts (Unsplash in particular) throttle
// bursts of HEAD requests with HTTP 429. A naive loop over hundreds of
// menu items trips this immediately, and every throttled URL would be
// (correctly but uselessly) classified 'unknown', so nothing gets
// healed. To get definitive answers without hammering the host we:
//   1. Serialize network checks through a single gate and space them
//      MIN_GAP_MS apart (cache hits bypass the gate — most checks).
//   2. Retry a 429 / timeout / network error with exponential backoff
//      before giving up and returning 'unknown'.
// A 404/410 is definitive even under load, so it's never retried.
//
// Results are cached per process so repeated checks of the same URL
// within a run hit the network once. Call resetLivenessCache() at the
// start of each run so a URL that died (or came back) between runs is
// re-checked.

const dns = require('dns');
const net = require('net');

const _cache = new Map();

// ── SSRF guard ───────────────────────────────────────────────────────
// The healers HEAD whatever URL is stored on a menu item / category —
// data an admin controls. Without a guard, that is a server-side
// request primitive: an admin could point an image at
// http://169.254.169.254/ (cloud metadata) or an internal service and
// use the healer as a port scanner. So a URL is only ever fetched when:
//   1. it is https,
//   2. its host is on the allowlist (known image CDNs, the app's own
//      host, plus IMAGE_HOST_ALLOWLIST from env), and
//   3. every address it resolves to is public (no loopback / private /
//      link-local / CGNAT / multicast / reserved ranges).
// Redirects are followed manually (max 3) and every hop is re-checked.
// A URL that fails the guard is reported 'unknown', which callers
// already treat as "do not act".
const DEFAULT_IMAGE_HOSTS = [
    'res.cloudinary.com',
    'images.unsplash.com',
    'plus.unsplash.com',
    'images.pexels.com',
    'cdn.pixabay.com',
    'upload.wikimedia.org',
    'i.imgur.com',
    'ui-avatars.com',
];

function _hostOf(u) {
    try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

function _allowedHosts() {
    const extra = String(process.env.IMAGE_HOST_ALLOWLIST || '')
        .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    const own = [process.env.PUBLIC_BASE_URL, process.env.BACKEND_URL, process.env.API_BASE_URL, process.env.FRONTEND_URL]
        .map(_hostOf).filter(Boolean);
    return new Set([...DEFAULT_IMAGE_HOSTS, ...extra, ...own]);
}

const _blocked = new net.BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => _blocked.addSubnet(a, p, 'ipv4'));
[
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
    ['64:ff9b::', 96], ['2001:db8::', 32],
].forEach(([a, p]) => _blocked.addSubnet(a, p, 'ipv6'));

function isPrivateAddress(ip) {
    const fam = net.isIP(ip);
    if (!fam) return true;
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) — check the embedded v4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return _blocked.check(mapped[1], 'ipv4');
    return _blocked.check(ip, fam === 6 ? 'ipv6' : 'ipv4');
}

/** true when `url` is safe to fetch server-side (see guard notes above). */
async function isSafeImageUrl(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!_allowedHosts().has(host)) return false;
    if (net.isIP(host)) return !isPrivateAddress(host);
    try {
        const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
        if (!addrs.length) return false;
        return addrs.every((a) => !isPrivateAddress(a.address));
    } catch {
        return false;
    }
}

const BASE_GAP_MS = 200;      // baseline spacing between live network checks
const MAX_GAP_MS = 3000;      // ceiling for the adaptive gap
const TIMEOUT_MS = 7000;      // per-attempt HEAD timeout
const MAX_RETRIES = 3;        // retries on 429 / timeout / network error
const BACKOFF_MS = [1000, 3000, 6000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single serialization gate + last-request timestamp so concurrent
// callers don't burst the host. Each network check waits its turn and
// then waits out any remaining gap since the previous one.
let _gate = Promise.resolve();
let _lastAt = 0;

// Adaptive throttle: Unsplash 429s a sustained burst even at a fixed
// gap, so we widen the gap on every throttle signal and slowly relax it
// on success. This lets the daily background job find its own sustainable
// rate instead of stampeding into a wall of 429s and healing nothing.
let _gapMs = BASE_GAP_MS;
function _onThrottled() { _gapMs = Math.min(MAX_GAP_MS, Math.round(_gapMs * 1.5) + 100); }
function _onSuccess()   { _gapMs = Math.max(BASE_GAP_MS, _gapMs - 25); }

// One HEAD attempt → 'alive' | 'dead' | 'retry' | 'unknown'.
const MAX_REDIRECTS = 3;

async function _attempt(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        let current = url;
        let res;
        for (let hop = 0; ; hop++) {
            if (!(await isSafeImageUrl(current))) return 'unknown';
            res = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
            const loc = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && loc) {
                if (hop >= MAX_REDIRECTS) return 'unknown';
                current = new URL(loc, current).toString();
                continue;
            }
            break;
        }
        if (res.status < 400) return 'alive';
        if (res.status === 404 || res.status === 410) return 'dead';
        if (res.status === 429 || res.status >= 500) return 'retry'; // transient — back off
        return 'unknown'; // e.g. 403 — don't act, don't retry
    } catch {
        return 'retry'; // timeout / network error — back off
    } finally {
        clearTimeout(timer);
    }
}

async function _checkLive(url) {
    for (let i = 0; i <= MAX_RETRIES; i++) {
        const r = await _attempt(url);
        if (r === 'alive' || r === 'dead') { _onSuccess(); return r; }
        if (r === 'unknown') return r; // definitive non-retryable (e.g. 403)
        // r === 'retry' — throttle / transient. Widen the gap and back off.
        _onThrottled();
        if (i < MAX_RETRIES) await sleep(BACKOFF_MS[i] || 6000);
    }
    return 'unknown';
}

async function urlStatus(url) {
    if (!url || typeof url !== 'string') return 'unknown';
    if (_cache.has(url)) return _cache.get(url);

    // Queue this network check behind the gate, spaced MIN_GAP_MS apart.
    const run = _gate.then(async () => {
        const wait = Math.max(0, _lastAt + _gapMs - Date.now());
        if (wait) await sleep(wait);
        _lastAt = Date.now();
        return _checkLive(url);
    });
    // Keep the gate chain alive regardless of this check's outcome.
    _gate = run.then(() => {}, () => {});

    const result = await run;
    _cache.set(url, result);
    return result;
}

function resetLivenessCache() {
    _cache.clear();
}

module.exports = { urlStatus, resetLivenessCache, isSafeImageUrl, isPrivateAddress };
