# Backend/config

`config/index.js` is the one place the backend should read environment
variables. It loads `Backend/.env`, coerces every variable listed in
`.env.example` to its type with a default, collects type errors, and exports
a deeply **frozen** object.

```js
const config = require('../config');

config.isProduction          // NODE_ENV === 'production'
config.jwt.secret            // JWT_SECRET
config.razorpay.keyId        // RAZORPAY_KEY_ID
config.email.smtp.port       // SMTP_PORT as a number (default 587)
config.jobs.shiftAutocloseHours  // null = use the job's built-in default
```

## Production check

`config.assertProductionConfig()` is a no-op unless `NODE_ENV=production`.
In production it throws one error listing every problem:

- missing `MONGO_URL`, `JWT_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`, `FRONTEND_URL`, `ALLOWED_ORIGINS`;
- any of those still holding a `.env.example` placeholder;
- `JWT_SECRET` shorter than 32 characters;
- `FRONTEND_URL` pointing at localhost;
- a typed variable that did not parse (e.g. `SMTP_PORT=abc`).

`config.productionConfigProblems()` returns the same list without throwing
(useful for a health/diagnostics endpoint).

`server.js` should call it once, right after its imports:

```js
const config = require('./config');
try { config.assertProductionConfig(); }
catch (e) { console.error(`FATAL: ${e.message}`); process.exit(1); }
```

## Migration path

Today about 110 `process.env.X` reads remain across `server.js`,
`controllers/`, `middlewares/` and `utils/`. Already migrated:
`utils/logger.js`. Move the rest incrementally, one file per change:

1. Replace `process.env.X` with the matching `config.*` field. If a variable
   is missing from `config/index.js`, add it there (with its type and
   default) and to `.env.example` in the same change.
2. Delete the file's local parsing/fallback code (`Number(process.env.X) || 30`,
   `=== 'true'` checks, etc.) — `config` already did it. Where a module
   keeps its own default, `config` stores `null` for "unset".
3. Tests that set `process.env.X` before `require()`ing a module must set
   it before the first `require('../config')` too (config is read once), or
   mock the module with `jest.mock('../config', () => ({ ... }))`.
4. When no `process.env` reads remain outside `config/`, the boot check in
   `server.js` (`REQUIRED_ENV` / `PRODUCTION_REQUIRED_ENV`) can be replaced
   by `assertProductionConfig()` alone.

Suggested order: `utils/email.js`, `utils/razorpayBilling.js`,
`utils/orderRefund.js`, `utils/invoicePdf.js`, the background-job utils,
then middlewares, then controllers, then `server.js`.
