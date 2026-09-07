# syntax=docker/dockerfile:1.7
# Image for @platform/analytics-ingest. Owned by window 5 (infra); the app source is owned by window 12.
#
# Build from the REPO ROOT — the pnpm workspace is the build context:
#   docker compose -f infra/docker/docker-compose.build.yml build analytics-ingest
#   docker build -f apps/analytics-ingest/Dockerfile -t commerce-platform/analytics-ingest:dev .
#
# Contract with the app window (changing it needs a CONTRACT CHANGE issue):
#   build time      `pnpm --filter @platform/analytics-ingest... build` (the app and its workspace dependencies)
#   container start `pnpm start` inside the deployed package (infra/docker/entrypoint.sh)
#   runtime         listens on $PORT and answers `GET /health` with 200
# The app is still a Phase 0 scaffold with no `start` script, so the entrypoint serves
# infra/docker/health-server.mjs instead. Adding a `start` script is the only change needed
# to switch this image over to the analytics ingest worker — the Dockerfile stays as is.

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
ARG APP=@platform/analytics-ingest
COPY . .
# The "..." suffix builds the app AND its workspace dependencies (@platform/db, events,
# contracts) in topological order. Without it the app compiles against packages that have no
# dist/ yet and tsc reports "Cannot find module '@platform/db'".
RUN pnpm --filter "$APP..." build
RUN pnpm --filter "$APP" --prod --legacy deploy /out

# ---------- runtime ----------
# pnpm is installed globally with npm, NOT with corepack: the deployed package.json carries no
# `packageManager` field, so a corepack shim would resolve "latest" and try to download pnpm over
# the network on every container start — as the unprivileged `node` user, with an empty cache.
FROM node:${NODE_VERSION} AS runtime
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
ENV NODE_ENV=production \
    APP_NAME=@platform/analytics-ingest \
    PORT=9004
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chmod=0755 infra/docker/entrypoint.sh /usr/local/bin/platform-entrypoint
COPY infra/docker/health-server.mjs /usr/local/lib/platform/health-server.mjs
USER node
EXPOSE 9004
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["platform-entrypoint"]
