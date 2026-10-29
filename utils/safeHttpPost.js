/**
 * SSRF-guarded outbound POST for tenant-supplied URLs (webhooks).
 *
 * A tenant owner controls the URL, so it is treated as hostile input:
 *   - https only, no credentials in the URL, standard-ish ports only
 *   - the hostname is resolved HERE and every address must be public
 *     (loopback / private / link-local / CGNAT / metadata / multicast are
 *     blocked — same table as utils/imageLiveness)
 *   - the socket is then connected to the address that was validated (a
 *     custom `lookup` pins it), so a DNS answer cannot change between the
 *     check and the connection (rebinding)
 *   - redirects are never followed (a 3xx is reported as a failure)
 *   - hard timeout and a response-size cap
 *
 * Never throws: resolves `{ ok, status, error?, blocked? }`.
 */
'use strict';

const dns = require('dns');
const net = require('net');
const https = require('https');
const { isPrivateAddress } = require('./imageLiveness');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_PORTS = new Set(['', '443', '8443']);

/**
 * Static URL validation (no DNS). Returns `{ ok: true, url }` or
 * `{ ok: false, error }`. Used at endpoint create/update time and again
 * before every delivery.
 */
function validateWebhookUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, error: 'Invalid URL' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed' };
    if (u.username || u.password) return { ok: false, error: 'Credentials in the URL are not allowed' };
    if (!ALLOWED_PORTS.has(u.port)) return { ok: false, error: 'Only ports 443 and 8443 are allowed' };
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return { ok: false, error: 'Invalid URL' };
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        return { ok: false, error: 'This host is not allowed' };
    }
    if (net.isIP(host) && isPrivateAddress(host)) return { ok: false, error: 'This address is not allowed' };
    return { ok: true, url: u };
}

/** Resolve + validate every address; returns the list or throws a blocked error. */
async function resolvePublic(host, lookup) {
    const bare = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) {
        if (isPrivateAddress(bare)) throw Object.assign(new Error('Address is not public'), { blocked: true });
        return [{ address: bare, family: net.isIP(bare) }];
    }
    const addrs = await lookup(bare, { all: true, verbatim: true });
    if (!addrs || !addrs.length) throw Object.assign(new Error('Host did not resolve'), { blocked: true });
    for (const a of addrs) {
        if (isPrivateAddress(a.address)) {
            throw Object.assign(new Error('Host resolves to a non-public address'), { blocked: true });
        }
    }
    return addrs;
}

/**
 * @param {string} url
 * @param {{ body: string, headers?: object, timeoutMs?: number, maxBytes?: number }} opts
 * @param {{ lookup?: Function, request?: Function }} [deps]  test seams
 */
async function safePost(url, opts, deps = {}) {
    const lookup = deps.lookup || dns.promises.lookup;
    const request = deps.request || https.request;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes || MAX_RESPONSE_BYTES;

    const v = validateWebhookUrl(url);
    if (!v.ok) return { ok: false, status: null, blocked: true, error: v.error };
    const u = v.url;

    let addrs;
    try {
        addrs = await resolvePublic(u.hostname, lookup);
    } catch (err) {
        return { ok: false, status: null, blocked: !!err.blocked, error: err.blocked ? err.message : `DNS lookup failed: ${err.message}` };
    }
    const pinned = addrs[0];
    const body = String(opts.body ?? '');

    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        let req;
        try {
            req = request({
                protocol: 'https:',
                hostname: u.hostname.replace(/^\[|\]$/g, ''),
                port: u.port || 443,
                path: `${u.pathname}${u.search}`,
                method: 'POST',
                servername: net.isIP(u.hostname) ? undefined : u.hostname,
                // Pin the connection to the address validated above.
                lookup: (_h, _o, cb) => {
                    if (_o && _o.all) return cb(null, [{ address: pinned.address, family: pinned.family }]);
                    return cb(null, pinned.address, pinned.family);
                },
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent': 'BestoDine-Webhooks/1',
                    ...(opts.headers || {}),
                },
                timeout: timeoutMs,
            }, (res) => {
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        res.destroy();
                        done({ ok: false, status: res.statusCode, error: 'Response too large' });
                    }
                });
                res.on('end', () => {
                    const code = res.statusCode || 0;
                    if (code >= 300 && code < 400) return done({ ok: false, status: code, error: 'Redirects are not followed' });
                    if (code >= 200 && code < 300) return done({ ok: true, status: code });
                    return done({ ok: false, status: code, error: `HTTP ${code}` });
                });
                res.on('error', (err) => done({ ok: false, status: res.statusCode || null, error: err.message }));
            });
        } catch (err) {
            return done({ ok: false, status: null, error: err.message });
        }
        req.on('timeout', () => { req.destroy(new Error('Timed out')); });
        req.on('error', (err) => done({ ok: false, status: null, error: err.message || 'Request failed' }));
        req.write(body);
        req.end();
    });
}

module.exports = { safePost, validateWebhookUrl, resolvePublic, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES };
