/**
 * POST /csp-report (and /api/csp-report) — receives CSP violation reports
 * (legacy `application/csp-report` and Reporting API `application/reports+json`).
 *
 * Unauthenticated by nature (browsers send it without credentials), so it is
 * deliberately tiny: 4 KB body cap, per-IP rate limit, always 204, fields are
 * truncated before logging, nothing is stored or echoed.
 */
const express = require('express');
const logger = require('../utils/logger');
const { makeLimiter } = require('../utils/rateLimitStore');

const cut = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : v === undefined ? undefined : String(v).slice(0, n));

function summarise(raw) {
    const r = (raw && (raw['csp-report'] || raw.body || raw)) || {};
    return {
        directive: cut(r['effective-directive'] || r['violated-directive'] || r.effectiveDirective),
        blocked: cut(r['blocked-uri'] || r.blockedURL || r.blockedUri),
        document: cut(r['document-uri'] || r.documentURL || r.documentUri),
        source: cut(r['source-file'] || r.sourceFile),
        line: Number(r['line-number'] || r.lineNumber) || undefined,
        disposition: cut(r.disposition),
    };
}

function createCspReportRouter() {
    const router = express.Router();
    const limiter = makeLimiter({
        name: 'csp-report',
        windowMs: 60 * 1000,
        max: 30,
        standardHeaders: false,
        legacyHeaders: false,
        handler: (req, res) => res.status(204).end(), // over budget: drop silently
    });
    router.post(
        '/',
        limiter,
        express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '4kb' }),
        (req, res) => {
            const body = req.body;
            const items = Array.isArray(body) ? body.slice(0, 5) : [body];
            for (const it of items) {
                if (it && typeof it === 'object') logger.warn('csp.violation', summarise(it));
            }
            res.status(204).end();
        },
        // Oversized / malformed body: still answer 204, never an HTML error page.
        // eslint-disable-next-line no-unused-vars
        (err, req, res, next) => res.status(204).end(),
    );
    return router;
}

module.exports = { createCspReportRouter, summarise };
