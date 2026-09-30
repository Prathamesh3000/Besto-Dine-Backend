/**
 * Indian mobile number normalisation — shared by OTP login
 * (controllers/authController.js) and hotel self-signup.
 */
'use strict';

const MOBILE_REGEX = /^[6-9]\d{9}$/; // Indian mobile: 10 digits starting with 6-9

/** Normalise '+91 98765-43210' / '919876543210' / '09876543210' → '9876543210'; null when invalid. */
function normalizeMobile(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    let m = String(raw).replace(/[\s\-()]/g, '');
    if (m.startsWith('+91')) m = m.slice(3);
    else if (m.length === 12 && m.startsWith('91')) m = m.slice(2);
    else if (m.length === 11 && m.startsWith('0')) m = m.slice(1);
    return MOBILE_REGEX.test(m) ? m : null;
}

module.exports = { MOBILE_REGEX, normalizeMobile };
