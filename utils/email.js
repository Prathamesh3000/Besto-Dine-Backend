const logger = require('./logger');

/**
 * Email sender — provider-agnostic wrapper.
 *
 * Mirrors the existing `sendOtpSms` pattern in authController.js: the
 * concrete provider is chosen via an env var, and when no provider is
 * configured the email is logged to the server console (dev mode).
 *
 * Supported providers (add more by extending the switch below):
 *
 *   EMAIL_PROVIDER=sendgrid   — SendGrid REST API
 *     required: SENDGRID_API_KEY, EMAIL_FROM
 *
 *   EMAIL_PROVIDER=resend     — Resend REST API
 *     required: RESEND_API_KEY, EMAIL_FROM
 *
 *   EMAIL_PROVIDER=mailgun    — Mailgun REST API
 *     required: MAILGUN_API_KEY, MAILGUN_DOMAIN, EMAIL_FROM
 *
 *   EMAIL_PROVIDER=smtp       — any SMTP server via nodemailer (Gmail,
 *                               Outlook, Zoho, SES SMTP, Brevo, ...)
 *     required: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *     optional: SMTP_FROM (falls back to EMAIL_FROM), SMTP_SECURE
 *               (defaults to true on port 465, false otherwise)
 *
 *   EMAIL_PROVIDER unset      — uses SMTP when SMTP_HOST is set,
 *                               otherwise dev mode (logs to console only)
 *
 * SMTP is also used as an automatic FALLBACK when the configured API
 * provider fails. This matters for Resend in particular: with the
 * shared `onboarding@resend.dev` sender (no verified domain) Resend
 * only delivers to the account owner's own address and rejects every
 * other recipient — which is exactly why customers never received
 * their password-reset links.
 *
 * All API calls use Node 22's built-in `fetch`, so no external packages
 * are required. Failures are caught, logged loudly, and return false —
 * callers decide whether to treat a failed send as a hard error or fall
 * back to the on-screen temporary-credentials flow.
 *
 * Usage:
 *
 *   const { sendEmail } = require('../utils/email');
 *   const ok = await sendEmail({
 *       to: 'owner@example.com',
 *       subject: 'Welcome to BestoDine',
 *       html: '<h1>Hello</h1>...',
 *       text: 'Hello...',
 *   });
 *
 * Returns: `{ sent: boolean, provider: string, dev: boolean, error?: string }`
 */

const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';
const RESEND_URL   = 'https://api.resend.com/emails';

function getFromAddress() {
    return process.env.EMAIL_FROM || 'BestoDine <no-reply@bestodine.local>';
}

// Normalise attachment.content (Buffer | string) → base64 string for
// providers that expect base64-encoded bodies.
function toBase64(content) {
    if (Buffer.isBuffer(content)) return content.toString('base64');
    return Buffer.from(String(content || ''), 'utf8').toString('base64');
}

async function sendViaSendgrid({ to, subject, html, text, from, attachments }) {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) throw new Error('SENDGRID_API_KEY is not set');

    // Parse "Name <email@host>" or plain "email@host" into what SendGrid expects.
    const fromRaw = from || getFromAddress();
    const match = fromRaw.match(/^(.+?)\s*<(.+)>$/);
    const fromEmail = match ? match[2].trim() : fromRaw.trim();
    const fromName  = match ? match[1].trim() : undefined;

    const body = {
        personalizations: [{ to: [{ email: to }] }],
        from: fromName ? { email: fromEmail, name: fromName } : { email: fromEmail },
        subject,
        content: [
            ...(text ? [{ type: 'text/plain', value: text }] : []),
            { type: 'text/html', value: html },
        ],
        ...(Array.isArray(attachments) && attachments.length > 0 ? {
            attachments: attachments.map(a => ({
                content: toBase64(a.content),
                filename: a.filename,
                type: a.contentType || 'application/octet-stream',
                disposition: 'attachment',
            })),
        } : {}),
    };

    const res = await fetch(SENDGRID_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '<no body>');
        throw new Error(`SendGrid ${res.status}: ${errText}`);
    }
}

async function sendViaResend({ to, subject, html, text, from, attachments }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not set');

    const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            from: from || getFromAddress(),
            to: [to],
            subject,
            html,
            text,
            ...(Array.isArray(attachments) && attachments.length > 0 ? {
                attachments: attachments.map(a => ({
                    filename: a.filename,
                    content: toBase64(a.content),
                    ...(a.contentType ? { content_type: a.contentType } : {}),
                })),
            } : {}),
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '<no body>');
        throw new Error(`Resend ${res.status}: ${errText}`);
    }
}

function isSmtpConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let smtpTransport = null;
function getSmtpTransport() {
    if (smtpTransport) return smtpTransport;
    // Lazy require so deployments that never use SMTP don't pay for it.
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 587;
    const secure = process.env.SMTP_SECURE
        ? String(process.env.SMTP_SECURE).toLowerCase() === 'true'
        : port === 465;
    smtpTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return smtpTransport;
}

async function sendViaSmtp({ to, subject, html, text, attachments }) {
    if (!isSmtpConfigured()) {
        throw new Error('SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS missing)');
    }
    const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER;
    await getSmtpTransport().sendMail({
        from,
        to,
        subject,
        html,
        text,
        ...(Array.isArray(attachments) && attachments.length > 0 ? {
            attachments: attachments.map(a => ({
                filename: a.filename,
                content: a.content,
                ...(a.contentType ? { contentType: a.contentType } : {}),
            })),
        } : {}),
    });
}

async function sendViaMailgun({ to, subject, html, text, from }) {
    const apiKey = process.env.MAILGUN_API_KEY;
    const domain = process.env.MAILGUN_DOMAIN;
    if (!apiKey || !domain) throw new Error('MAILGUN_API_KEY and MAILGUN_DOMAIN must be set');

    const form = new URLSearchParams();
    form.append('from', from || getFromAddress());
    form.append('to', to);
    form.append('subject', subject);
    if (text) form.append('text', text);
    form.append('html', html);

    // Mailgun uses HTTP Basic auth with "api" as the username
    const auth = Buffer.from(`api:${apiKey}`).toString('base64');
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: form.toString(),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '<no body>');
        throw new Error(`Mailgun ${res.status}: ${errText}`);
    }
}

/**
 * Send an email. Returns a status object — never throws.
 *
 * Required props: to, subject. Must provide `html`; `text` is optional
 * but recommended as a plain-text fallback for clients that prefer it.
 */
async function sendEmail({ to, subject, html, text, attachments }) {
    if (!to || !subject || !html) {
        logger.warn('sendEmail called with missing required fields');
        return { sent: false, provider: 'none', dev: false, error: 'missing required fields' };
    }

    let provider = (process.env.EMAIL_PROVIDER || '').toLowerCase();
    // No explicit provider but SMTP credentials present → use SMTP.
    if (!provider && isSmtpConfigured()) provider = 'smtp';
    const effectiveFrom = getFromAddress();

    // Dev mode — no provider configured. Log to console so the operator
    // can read the message (e.g. a reset link) during local development.
    // Returns sent:false so the caller knows nothing left the building.
    if (!provider) {
        logger.warn(`[email] No email transport configured (set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM or EMAIL_PROVIDER). Email to ${to} was NOT sent.`);
        logger.info(`[email dev] from=${effectiveFrom} to=${to} subject="${subject}"`);
        logger.info(`[email dev] ${text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 400)}`);
        if (Array.isArray(attachments) && attachments.length > 0) {
            logger.info(`[email dev] attachments: ${attachments.map(a => `${a.filename} (${a.contentType || '?'})`).join(', ')}`);
        }
        return { sent: false, provider: 'none', dev: true };
    }

    if (provider === 'resend' && /@resend\.dev>?$/i.test(effectiveFrom.trim())) {
        logger.warn('[email] EMAIL_FROM uses the shared resend.dev sender — Resend will only deliver to the Resend account owner. Verify a domain in Resend or configure SMTP_* to reach real customers.');
    }

    // Pass the resolved From: address to each provider so they all
    // use the same identity — branded tenant or platform default.
    const envelope = { to, subject, html, text, from: effectiveFrom, attachments };
    try {
        switch (provider) {
            case 'sendgrid': await sendViaSendgrid(envelope); break;
            case 'resend':   await sendViaResend  (envelope); break;
            case 'mailgun':  await sendViaMailgun (envelope); break;
            case 'smtp':     await sendViaSmtp    (envelope); break;
            default:
                logger.warn(`Unknown EMAIL_PROVIDER: ${provider}`);
                if (!isSmtpConfigured()) {
                    return { sent: false, provider, dev: false, error: `Unknown EMAIL_PROVIDER: ${provider}` };
                }
                throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
        }

        logger.info(`Email sent via ${provider} to ${to}`);
        return { sent: true, provider, dev: false };
    } catch (err) {
        logger.error(`Email send failed (${provider}): ${err.message}`);
        // Fall back to SMTP when the primary provider refused the mail.
        if (provider !== 'smtp' && isSmtpConfigured()) {
            try {
                await sendViaSmtp(envelope);
                logger.info(`Email sent via smtp (fallback from ${provider}) to ${to}`);
                return { sent: true, provider: 'smtp', dev: false, fallbackFrom: provider };
            } catch (smtpErr) {
                logger.error(`Email SMTP fallback failed: ${smtpErr.message}`);
                return { sent: false, provider, dev: false, error: `${err.message}; smtp: ${smtpErr.message}` };
            }
        }
        return { sent: false, provider, dev: false, error: err.message };
    }
}

module.exports = { sendEmail, isSmtpConfigured };
