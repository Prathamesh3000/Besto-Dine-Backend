/**
 * Platform password policy — shared by customer self-service
 * (register + reset, controllers/authController.js) and hotel self-signup
 * (controllers/publicController.js registerRestaurant).
 *
 * 8+ characters with uppercase, lowercase, digit and special character —
 * i.e. at least a "Good" rating on the frontend meter ("Strong" is 12+).
 * Mirrors Frontend/src/utils/passwordPolicy.js (MIN_LENGTH /
 * MIN_PASSWORD_SCORE) — change both together. The exported names keep
 * their STRONG_* prefix for backwards compatibility with callers.
 */
'use strict';

const STRONG_PASSWORD_MIN_LENGTH = 8;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_\-+=<>?]).{8,}$/;
const STRONG_PASSWORD_MESSAGE = `Password must be at least ${STRONG_PASSWORD_MIN_LENGTH} characters with uppercase, lowercase, number, and special character`;

/** true when `pw` is a string meeting the policy (Good or Strong). */
function isStrongPassword(pw) {
    return typeof pw === 'string' && pw.length <= 128 && STRONG_PASSWORD_REGEX.test(pw);
}

module.exports = {
    STRONG_PASSWORD_MIN_LENGTH,
    STRONG_PASSWORD_REGEX,
    STRONG_PASSWORD_MESSAGE,
    isStrongPassword,
};
