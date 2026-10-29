/**
 * Webhook signing.
 *
 *   X-BestoDine-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, t + '.' + body)>
 *
 * `body` is the exact raw request body string. Receivers should recompute
 * the HMAC over `t + '.' + rawBody`, compare in constant time and reject
 * timestamps older than a few minutes (replay protection).
 */
'use strict';

const crypto = require('crypto');

function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
    const v1 = crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`, 'utf8').digest('hex');
    return { timestamp, v1, header: `t=${timestamp},v1=${v1}` };
}

/**
 * @param {string} secret
 * @param {string} body            raw body string
 * @param {string} header          X-BestoDine-Signature value
 * @param {{ toleranceSec?: number, now?: number }} [opts]
 */
function verify(secret, body, header, opts = {}) {
    const tolerance = opts.toleranceSec ?? 300;
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (typeof header !== 'string') return false;
    const parts = {};
    for (const piece of header.split(',')) {
        const i = piece.indexOf('=');
        if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
    }
    const t = Number(parts.t);
    if (!Number.isFinite(t) || !parts.v1) return false;
    if (tolerance > 0 && Math.abs(now - t) > tolerance) return false;
    const expected = Buffer.from(sign(secret, body, t).v1, 'hex');
    let given;
    try { given = Buffer.from(parts.v1, 'hex'); } catch { return false; }
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
}

module.exports = { sign, verify };
