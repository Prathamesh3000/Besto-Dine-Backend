# Backend staging environment

A throw-away copy of the backend that never touches production: its own
database (`bestodine_staging`), its own port (5001), its own JWT secret,
Razorpay **test** keys, and no email / SMS / Cloudinary / Redis / Sentry
(all of those fall back to console logging).

Everything runs through `scripts/with-env.js`, which loads `.env.staging`
*before* `config/index.js` loads `.env` — dotenv never overrides a variable
that is already set, so the staging values win without touching `.env`.
The scripts work the same from PowerShell, cmd and Git Bash.

| Command | What it does |
|---|---|
| `npm run db:staging` | Starts a persistent local MongoDB on `127.0.0.1:27018` (data in `Backend/.staging-db/`). Keep the terminal open; Ctrl+C stops it and keeps the data. |
| `npm run seed:staging` | **Drops** `bestodine_staging` and recreates the "Staging Cafe" tenant + demo data + logins (see below). Refuses to run against anything but the staging DB. |
| `npm run start:staging` | `node server.js` on port 5001 with `.env.staging`. |
| `npm run dev:staging` | Same with nodemon. |
| `npm run health:staging` | Prints `GET /health`; exits non-zero unless it says `appEnv: "staging"`. |

Order: `db:staging` (terminal 1) → `seed:staging` → `start:staging` (terminal 2).
Point a frontend at `http://localhost:5001` (origins `localhost:5173` / `5174` are allowed).

## Safety guard

`utils/stagingGuard.js` → `assertStagingDb(url)` is called at the top of
`Seed/seedStaging.js`, `scripts/staging-db.js` and `scripts/staging-health.js`.
It accepts a URL only when the database name is exactly `bestodine_staging`,
the host is local (`127.0.0.1` / `localhost`) **or** the hostname contains
`staging`, and the URL never mentions the production cluster (`bestodine-in`).
Unit tests: `__tests__/stagingGuard.test.js`.

`/health` reports `appEnv` (from `APP_ENV`) and `dbName`; the desktop e2e
harness only crawls when `appEnv === "staging"`.

## Seeded logins (all `mustChangePassword: false`, password `Staging@123`)

| Role | Email |
|---|---|
| admin (tenant owner) | `admin@staging.bestodine.test` |
| waiter | `waiter@staging.bestodine.test` |
| chef | `chef@staging.bestodine.test` |
| customer | `customer@staging.bestodine.test` |

Tenant: **Staging Cafe**, slug `staging-cafe`, Premium plan with every module
on, active subscription, GST 5 %, service charge 0, printers disabled.
Data: 2 areas, 8 tables (QR tokens printed by the seed), 4 categories,
12 menu items, 5 orders in mixed statuses (incl. Paid and preparing),
1 coupon (`STAGING10`), a few notifications.

## Local MongoDB details

`scripts/staging-db.js` uses the `mongod` binary that `mongodb-memory-server`
already downloads for the integration tests, started as a **single-node
replica set** (the app uses multi-document transactions for order
creation, wallets, tips and refunds — a plain standalone would reject them)
with on-disk WiredTiger storage so data survives restarts. The connection
string stays plain `mongodb://127.0.0.1:27018/bestodine_staging`.

* Reset everything: stop `db:staging`, delete `Backend/.staging-db/`, start
  again, run `seed:staging`.
* Another port / data dir: `STAGING_DB_PORT=27019 STAGING_DB_PATH=...`
  (and change `MONGO_URL` in `.env.staging` to match).

## Using a real Atlas free-tier cluster instead (later)

When several people need the same staging data, swap the local mongod for a
free M0 cluster. Nothing in the code changes — only `.env.staging`.

1. **Project** — in [Atlas](https://cloud.mongodb.com) create a *new project*
   (e.g. `BestoDine Staging`). Keep it separate from the production project
   so staging users can never see production data.
2. **Cluster** — *Build a Database* → **M0 Free** → region close to you →
   name it **`bestodine-staging`**. The guard requires `staging` in the
   hostname, which the cluster name gives you
   (`bestodine-staging.xxxxx.mongodb.net`).
3. **Database user** — *Database Access* → *Add New Database User* →
   password auth, a new random password, role **Read and write to any
   database** (or scoped to `bestodine_staging`). Never reuse the production
   user.
4. **Network access** — *Network Access* → *Add IP Address* → your current
   IP (or `0.0.0.0/0` for a short-lived staging cluster you will delete).
5. **Connection string** — *Connect* → *Drivers* → copy the SRV URL, then
   insert the database name `bestodine_staging` before the `?`:

   ```
   MONGO_URL=mongodb+srv://<user>:<url-encoded-password>@bestodine-staging.xxxxx.mongodb.net/bestodine_staging?retryWrites=true&w=majority
   ```

   Paste it into `.env.staging`. `npm run seed:staging` will refuse the URL
   if the host lacks `staging`, the db name is wrong, or it mentions
   `bestodine-in`.
6. You no longer need `npm run db:staging`; `seed:staging`,
   `start:staging` and `health:staging` work unchanged.

M0 limits (512 MB, shared CPU) are plenty for the seed data. Delete the
cluster when the campaign is over.
