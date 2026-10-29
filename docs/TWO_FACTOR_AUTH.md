# Optional TOTP two-factor authentication (Plan 3A.1)

Scope: **owner / admin (`role: 'admin'`) and superadmin only**. Never offered to or forced on
waiter, captain, chef, manager or customer. Enrolment is optional unless `TWO_FA_REQUIRED_ROLES`
says otherwise (and even then it only nudges in this phase).

## Files

| File | Role |
| --- | --- |
| `utils/totp.js` | TOTP (RFC 6238, SHA-1, 6 digits, 30 s, +-1 step), AES-256-GCM secret encryption, recovery codes, login policy |
| `controllers/twoFactorController.js` | status / setup / enable / disable / recovery regenerate / admin reset / verify, challenge token |
| `routes/twoFactorRoute.js` | mounted at `/api/v1/auth/2fa` (before `/auth` in `app.js`) |
| `models/user.js` | `twoFactor { enabled, secretEnc, recoveryHashes[], verifiedAt, lastUsedStep }` (`secretEnc` and `recoveryHashes` are `select:false` and stripped in `toJSON`) |
| `controllers/authController.js` | `login` hook (challenge instead of tokens) + exported `completeLogin` used by verify |

## Endpoints

| Method + path | Auth | Body | Result |
| --- | --- | --- | --- |
| `GET /auth/2fa/status` | session | | `{ eligible, enabled, setupRequired, verifiedAt, recoveryCodesRemaining }` |
| `POST /auth/2fa/setup` | session | | `{ secret, otpauthUri, qrDataUrl }` (shown once; 2FA stays **off** until `enable`) |
| `POST /auth/2fa/enable` | session | `{ code }` | `{ recoveryCodes: [8] }` (shown once; stored as sha256 hashes) |
| `POST /auth/2fa/disable` | session | `{ password, code \| recoveryCode }` | `{ success }` |
| `POST /auth/2fa/recovery/regenerate` | session | `{ code }` (TOTP only) | `{ recoveryCodes: [8] }`, old set dies |
| `POST /auth/2fa/reset` | session | `{ userId }` | owner (`isTenantOwner`) may reset another **admin of the same restaurant**; superadmin may reset anyone. Not yourself (use disable). Clears 2FA and bumps `tokenVersion` + revokes refresh sessions |
| `POST /auth/2fa/verify` | challenge token | `{ challengeToken, code \| recoveryCode }` | the normal login response (`token`, `refreshToken`, user...) |

## Login flow

1. `POST /auth/login` with a correct password for an admin/superadmin who has 2FA enabled returns
   `200 { success: true, twoFactorRequired: true, challengeToken }` and **no tokens, no refresh session, no shift auto-open**.
   Wrong passwords behave exactly as before (the 2FA step is never revealed).
2. `challengeToken` is a JWT signed with `JWT_SECRET`, `typ: '2fa-challenge'`, 5 minutes, carries `id`, `role`, `tv`.
   `typ` is not `user`, so `protect` / `optionalAuth` / `verifyUserToken` reject it; conversely a session token is
   not accepted by `verify`. Changing the password / reset / logout-all (tokenVersion bump) kills an outstanding challenge.
3. `POST /auth/2fa/verify` re-checks status / tokenVersion / role, checks the lockout, validates the code, then calls
   `authController.completeLogin` (tenant-suspension check, `issueSession`, shift auto-open, `buildAuthResponse`), so refresh
   sessions, `tokenVersion` and absolute session caps behave identically to a password-only login.
4. If a recovery code was used the response also has `recoveryCodesRemaining`.

## Security properties

- Replay: each accepted TOTP step is stored in `twoFactor.lastUsedStep` with an atomic conditional update
  (`lastUsedStep < step`); a step `<=` the stored one is rejected, including an older in-window code.
- Recovery codes: `XXXXX-XXXXX`, case/dash-insensitive, hashed, consumed with an atomic `$pull` (single use).
- Lockout: 5 wrong codes inside the `LOGIN_LOCK_MINUTES` window (default 15) lock further attempts on that user
  (`utils/loginAttempts.js` row keyed `2fa:<userId>`, durable in MongoDB, cleared on success / enable / disable / reset).
  Applies to superadmin too. Response `429 TWO_FA_LOCKED` + `Retry-After: 900` (an upper bound; the row expires with the window).
  This counts wrong passwords at `disable` as well.
- Per-IP backstop on `verify`, `enable`, `disable`, `regenerate`: `makeLimiter('auth-2fa')`, `AUTH_IP_LIMIT` (50) failed requests / 15 min.
- Secret at rest: AES-256-GCM, random 96-bit IV, format `v1.<iv>.<tag>.<ct>`. Key = `sha256("bestodine-2fa-key:" + TWO_FA_ENC_KEY)`,
  or, when unset, `HMAC-SHA256(JWT_SECRET, "bestodine:2fa:secret-encryption:v1")`. **Rotating the key (or JWT_SECRET when no
  TWO_FA_ENC_KEY is set) makes existing enrolments undecryptable** -> users fall back to recovery codes / admin reset. Set a dedicated
  `TWO_FA_ENC_KEY` in production so JWT_SECRET rotation does not break 2FA.
- The secret is returned only by `setup` (needed to render the QR / manual key) and is never logged.

## Env flags

| Var | Default | Meaning |
| --- | --- | --- |
| `TWO_FA_ENC_KEY` | unset | dedicated encryption key for stored secrets (falls back to a JWT_SECRET-derived key) |
| `TWO_FA_REQUIRED_ROLES` | empty | comma list (`admin,superadmin`). Unenrolled users of a listed eligible role still log in, but the login response carries `twoFactorSetupRequired: true` (and `/status` `setupRequired`). Not a hard block in this phase |

There is no on/off flag: with nobody enrolled the login path is unchanged.

## Operational notes

- Locked out admin with no device and no recovery codes: owner (or superadmin) calls `POST /auth/2fa/reset`.
  Locked-out sole owner: superadmin resets. Last resort: unset `twoFactor` on the user document.
- Clients: Frontend `Login.jsx` (`TwoFactorCodeForm`), `Admin -> Settings -> Security` and `/superadmin/security`
  (`TwoFactorSettings`), mobile-waiter `sign-in.js` (code step).
- Tokens-in-cookies work is separate; `completeLogin` goes through `issueSession`, which already calls `setAuthCookie`.

## Tests

`__tests__/totp.test.js`, `__tests__/twoFactorController.test.js`, `__tests__/twoFactorLogin.test.js` (models mocked, no DB).
