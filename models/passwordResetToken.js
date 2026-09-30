const mongoose = require('mongoose');

/**
 * Password-reset tokens for customer accounts.
 *
 * Until this existed there was no customer password-reset path at all:
 * the "Forgot password?" link on the customer login page called a
 * handler that showed a toast reading "Password reset link will be
 * sent to your email" and did nothing else. No endpoint, no token, no
 * email. A customer who forgot their password could not recover it.
 *
 * Design notes
 * ------------
 * • Only a SHA-256 hash of the token is stored. The raw token exists
 *   solely in the emailed link. A database leak therefore cannot be
 *   replayed into account takeover — the same reason passwords are
 *   hashed.
 * • TTL index on `expiresAt` lets MongoDB expire rows itself, matching
 *   the existing Otp model rather than inventing a second convention.
 * • `usedAt` makes a token single-use. Reset links sit in inboxes for
 *   years; a link that still works months later is a standing key to
 *   the account.
 */
const passwordResetTokenSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    // Tenant scope. A multi-tenant deploy must not let a token minted
    // for one restaurant's customer be redeemed against another's.
    restaurant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Restaurant',
        default: null,
        index: true,
    },
    // SHA-256 of the raw token. NEVER store the raw value.
    tokenHash: {
        type: String,
        required: true,
        index: true,
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: 0 }, // TTL — MongoDB drops expired docs
    },
    // Set the moment the token is redeemed. Single-use enforcement.
    usedAt: {
        type: Date,
        default: null,
    },
    // Recorded for the security-notification email and for audit.
    requestedIp: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
