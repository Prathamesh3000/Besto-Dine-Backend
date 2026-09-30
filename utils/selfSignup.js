/**
 * Hotel self-signup constants shared by publicController (signup) and
 * superadminController (approval restarts the trial clock).
 */
'use strict';

// Trial length when the tenant's snapshot plan has no trialDays of its own.
const SELF_SIGNUP_TRIAL_DAYS = 14;

module.exports = { SELF_SIGNUP_TRIAL_DAYS };
