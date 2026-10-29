# syntax=docker/dockerfile:1
# BestoDine backend image (Express 5 + Mongoose 9, CommonJS).
# Node 22 LTS: RELEASE_CHECKLIST.md requires Node >= 20.9 (sharp 0.35) and
# recommends 22. Build context is the Backend/ folder:
#   docker build -t bestodine-backend ./Backend
# No .env is baked in (see .dockerignore): pass configuration at run time
# with --env-file / the compose file. See docs/DOCKER.md.

# ---- stage 1: production dependencies only ---------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# --omit=dev: no jest / eslint / mongodb-memory-server in the image.
RUN npm ci --omit=dev && npm cache clean --force

# ---- stage 2: runtime ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=5000
# tini = PID 1: forwards SIGTERM/SIGINT to node (server.js drains on SIGTERM)
# and reaps zombies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Application source. This includes vendor/bestodine-types (the vendored
# copy of packages/types that utils/billing.js requires as
# ../vendor/bestodine-types/cjs/engine); it is NOT ignored by .dockerignore
# and needs no build step, so the image works without the monorepo's
# packages/ folder.
COPY . .
# Writable runtime folders for the non-root user (mount volumes over these).
RUN mkdir -p /app/uploads /app/logs && chown -R node:node /app/uploads /app/logs
USER node
EXPOSE 5000
# /health answers 200 whenever the process is serving (reports db state in
# the body). Use /readyz in an orchestrator if you want "Mongo connected".
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
