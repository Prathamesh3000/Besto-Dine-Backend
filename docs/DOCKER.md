# Running BestoDine in Docker (local / staging)

Files: `Backend/Dockerfile`, `Backend/.dockerignore`, `Backend/.env.docker.example`,
`docker-compose.yml` (repo root). This stack is for **local development and
staging only**. It was written without Docker available on the authoring
machine, so the first `docker compose up --build` is its first real test.

## What you get

| Service | Image | Notes |
|---------|-------|-------|
| `backend` | built from `Backend/Dockerfile` | Node 22 LTS (RELEASE_CHECKLIST: Node >= 20.9 for `sharp`), non-root `node` user, `tini` as PID 1, `NODE_ENV=production` in the image, HEALTHCHECK on `/health`. Port 5000. |
| `mongo-staging` | `mongo:7` | single-node replica set `rs0` (the app uses transactions), initiated automatically by its healthcheck. Published on `127.0.0.1:27018`. |
| `redis` | `redis:7-alpine` | shared rate-limit counters + Socket.IO adapter (`REDIS_URL`). No persistence. |
| `seed` (profile) | same image as backend | one-shot `Seed/seedStaging.js`. |

The Mongo service is deliberately called `mongo-staging` and the database
`bestodine_staging`: `utils/stagingGuard.js` (used by the seed script) only
accepts a database named `bestodine_staging` on a localhost host or a host
whose name contains `staging`.

## Run

```bash
cp Backend/.env.docker.example Backend/.env.docker   # edit JWT_SECRET at least
docker compose up --build -d
docker compose ps                                     # backend should become "healthy"
curl http://localhost:5000/health                     # {"status":"ok","db":"connected",...}
curl http://localhost:5000/api/public/v1/openapi.json
```

The compose file works without `.env.docker` only if you export `JWT_SECRET`
yourself; the server exits with `FATAL: missing required env JWT_SECRET`
otherwise.

## Seed demo data

```bash
docker compose --profile seed run --rm seed
```

Creates the "Staging Cafe" tenant (slug `staging-cafe`; users admin / waiter /
chef / captain with password `Staging@123`). **Destructive**: it drops the
`bestodine_staging` database first. `Seed/seedStaging.js` needs
`__tests__/integration/helpers/seed.js`, which is why `.dockerignore`
re-includes just that folder.

## Stop / reset

```bash
docker compose down        # stop, keep data (volumes: mongo-data, uploads, logs)
docker compose down -v     # stop and WIPE the database and uploads
docker compose logs -f backend
```

## Safety rails

* `MONGO_URL`, `REDIS_URL`, `NODE_ENV`, `APP_ENV` and `PORT` are set under
  `environment:` in the compose file. Those override `env_file`, so a
  production `.env` pasted into `.env.docker` still cannot redirect the stack
  to Atlas.
* The Dockerfile bakes in no `.env`; `.dockerignore` excludes `.env*` (except
  `.env.docker.example`), `node_modules`, logs, uploads, `*.zip`, `.git`,
  tests and docs.
* The compose stack runs the app with `NODE_ENV=development` because
  production mode refuses to start without real Razorpay keys, a non-localhost
  `FRONTEND_URL`, etc. (`config.assertProductionConfig`), and refuses
  `RAZORPAY_MOCK=true`. A real deployment must run the image with
  `NODE_ENV=production` (the image default) and complete production
  configuration.

## Vendored `bestodine-types`

`utils/billing.js` does `require('../vendor/bestodine-types/cjs/engine')`.
That folder is a committed, pre-built copy of the monorepo package
`packages/types` (see `vendor/bestodine-types/MANIFEST.json` for file hashes).
The image build context is `Backend/`, so `COPY . .` includes `vendor/` as
ordinary source; it is not ignored and needs no build step. The monorepo's
`packages/` folder is not needed (and not reachable from the build context).
If `packages/types` changes, refresh the vendored copy before building.

## What is NOT included

* Frontend (build and host it separately; set `ALLOWED_ORIGINS` / `FRONTEND_URL`).
* TLS / reverse proxy (set `TRUST_PROXY` behind one), backups (`BACKUP_RESTORE.md`),
  monitoring, multi-node Mongo, Redis persistence.
* Atlas / production configuration of any kind.
* The thermal print agent, desktop shell and mobile app.
* Dev tooling (jest, eslint, mongodb-memory-server) is omitted by `npm ci --omit=dev`.

## Known caveats

* `server.js` calls `dns.setServers(['8.8.8.8','1.1.1.1'])`. This affects SRV
  lookups (Atlas `mongodb+srv://`), not plain `mongodb://mongo-staging`
  hostnames resolved through Docker's DNS, so the compose stack is unaffected.
  Containers without outbound internet cannot resolve Atlas SRV records.
* `uploads/` is a volume, so uploaded files survive restarts but are local to
  that volume (multi-instance deployments need Cloudinary or shared storage).
