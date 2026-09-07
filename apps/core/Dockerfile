# syntax=docker/dockerfile:1.7
# Image for @platform/core (Medusa 2). Owned by window 5 (infra); the app source is owned by window 1.
#
# Build from the REPO ROOT — the pnpm workspace is the build context:
#   docker compose -f infra/docker/docker-compose.build.yml build core
#   docker build -f apps/core/Dockerfile -t commerce-platform/core:dev .
#
# Contract with the app window (changing it needs a CONTRACT CHANGE issue):
#   build time      `pnpm --filter @platform/core... build` — the app and its workspace dependencies
#   container start `pnpm start` inside the deployed package (infra/docker/entrypoint.sh)
#   runtime         listens on $PORT and answers `GET /health` with 200
#
# `medusa build` emits .medusa/server and apps/core's `start` is `node .medusa/server/src/server.js`,
# so the deployed package carries .medusa and the entrypoint runs the real server — the scaffold
# health server in infra/docker/health-server.mjs is only a fallback for apps that still have no
# `start` script.
#
# Two Medusa-specific steps below (ts-node and the build-time placeholder environment) are commented
# where they appear. Both are build-stage only; neither reaches the runtime image.

ARG NODE_VERSION=20.19-alpine
ARG PNPM_VERSION=10.34.5

# ---------- manifests: every package.json, and nothing else ----------
# The install layer must not depend on source files. Extracting the manifests in their own stage
# means BuildKit checksums only what `COPY --from` actually copies, so `pnpm install` is re-run when
# a dependency changes and cached when a source file changes. Doing it with `find` rather than one
# `COPY apps/<name>/package.json` line per package means a new workspace package needs no Dockerfile
# edit — the thing a hand-maintained list always gets wrong eventually.
FROM node:${NODE_VERSION} AS manifests
WORKDIR /src
COPY . .
RUN set -eu; mkdir -p /manifests; \
    find . -name package.json -not -path '*/node_modules/*' | while read -r f; do \
      mkdir -p "/manifests/$(dirname "$f")"; cp "$f" "/manifests/$f"; \
    done; \
    cp pnpm-lock.yaml pnpm-workspace.yaml /manifests/

# ---------- deps: the workspace install, cached on the manifests alone ----------
# corepack is safe here: /repo/package.json pins `packageManager` and the build runs as root.
FROM node:${NODE_VERSION} AS deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ---------- build: add the sources and build the app ----------
FROM deps AS build
ARG APP=@platform/core

# Everything that does not depend on the sources goes above `COPY . .`, so a source-only change
# reuses these layers instead of re-downloading a 24 MB package on every push.
#
# WORKAROUND, remove when REQUEST #60 lands. `medusa build` loads medusa-config.ts, and the Medusa
# CLI does a bare `require('ts-node')` to do it. apps/core does not declare ts-node (it uses tsx), so
# `pnpm --filter @platform/core build` fails identically on a laptop, in CI and here — this is not a
# container problem. Installing it globally rather than with `pnpm add` is deliberate: `pnpm add`
# rewrites the lockfile inside the image, which would quietly un-freeze every other dependency.
# NODE_PATH is what lets a global package satisfy a bare require() from deep inside .pnpm.
RUN npm install -g ts-node@10.9.2 && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules

# `medusa build` evaluates medusa-config.ts, which throws when these are missing: the config reads
# process.env directly and nothing calls loadDotenv() on the CLI path, so there is no .env to fall
# back on. These placeholders only have to parse — the build connects to nothing and bakes none of
# them into the output. Real values arrive at runtime (External Secrets in staging, .env locally).
ENV DATABASE_URL_APP=postgres://build:build@127.0.0.1:5432/build \
    REDIS_URL=redis://127.0.0.1:6379 \
    JWT_SECRET=build-time-placeholder \
    COOKIE_SECRET=build-time-placeholder

COPY . .

# The "..." suffix builds the app AND its workspace dependencies (@platform/db, @platform/events,
# @platform/contracts) in topological order. Without it the app compiles against packages that have
# no dist/ yet and tsc reports "Cannot find module '@platform/db'".
RUN pnpm --filter "$APP..." build
RUN pnpm --filter "$APP" --prod --legacy deploy /out

# `pnpm deploy` packs the package the way npm would, and npm's packing rules skip dot-directories.
# `medusa build` writes its entire output to .medusa/server, so the deployed package would contain
# every source file and none of the build. Copy it across explicitly; `start` is
# `node .medusa/server/src/server.js`, so without this the container exits with MODULE_NOT_FOUND.
RUN cp -r /repo/apps/core/.medusa /out/.medusa && test -f /out/.medusa/server/src/server.js

# ---------- runtime ----------
# pnpm is installed globally with npm, NOT with corepack: the deployed package.json carries no
# `packageManager` field, so a corepack shim would resolve "latest" and try to download pnpm over
# the network on every container start — as the unprivileged `node` user, with an empty cache.
FROM node:${NODE_VERSION} AS runtime
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
ENV NODE_ENV=production \
    APP_NAME=@platform/core \
    PORT=9000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chmod=0755 infra/docker/entrypoint.sh /usr/local/bin/platform-entrypoint
COPY infra/docker/health-server.mjs /usr/local/lib/platform/health-server.mjs
USER node
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["platform-entrypoint"]
