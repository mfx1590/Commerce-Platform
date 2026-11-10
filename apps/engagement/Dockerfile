# syntax=docker/dockerfile:1.7
# Image for @platform/engagement (#439). Owned by window 5 (infra); the app source is owned by window 16.
#
# Build from the REPO ROOT — the pnpm workspace is the build context:
#   docker compose -f infra/docker/docker-compose.build.yml build engagement
#   docker build -f apps/engagement/Dockerfile -t commerce-platform/engagement:dev .
#
# Contract with the app window (changing it needs a CONTRACT CHANGE issue):
#   build time      `pnpm --filter @platform/engagement... build` (the app and its workspace dependencies)
#   container start `pnpm start` = `node dist/main.js` inside the deployed package (infra/docker/entrypoint.sh)
#   runtime         a WORKER: the CDP, CRM and ops consumers. Its one HTTP server, the support API, is off unless
#                   ENGAGEMENT_SUPPORT_ENABLED=1 and then listens on ENGAGEMENT_SUPPORT_PORT (default 4040). So this
#                   image has no HEALTHCHECK on an HTTP path: nothing answers one by default. A deployment that
#                   enables the support API probes it there; the worker itself is supervised by its process.

ARG NODE_VERSION=20.19-alpine
ARG PNPM_VERSION=10.34.5

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

# Only the manifests, listed one by one on purpose. Collecting them in a `find` stage reads better
# and works with a local cache, but a REMOTE cache (type=gha) matches `COPY --from=<stage>` on the
# producing stage's cache key rather than on the content it produced — and that stage has to copy
# the whole context to search it, so any change anywhere in the repo invalidated the install layer.
# Copying from the build context instead makes the cache key the file contents themselves.
# infra/ci/check-image-manifests.sh fails the build if this list ever goes stale.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/accounting/package.json apps/accounting/
COPY apps/admin/package.json apps/admin/
COPY apps/analytics-ingest/package.json apps/analytics-ingest/
COPY apps/core/package.json apps/core/
COPY apps/engagement/package.json apps/engagement/
COPY apps/feeds/package.json apps/feeds/
COPY apps/notifications/package.json apps/notifications/
COPY apps/storefront-starter/package.json apps/storefront-starter/
COPY apps/storefronts/brand-a/package.json apps/storefronts/brand-a/
COPY apps/storefronts/brand-b/package.json apps/storefronts/brand-b/
COPY apps/storefronts/brand-c/package.json apps/storefronts/brand-c/
COPY packages/ai/package.json packages/ai/
COPY packages/auth-sdk/package.json packages/auth-sdk/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/events/package.json packages/events/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ---------- build: add the sources and build the app ----------
FROM deps AS build
ARG APP=@platform/engagement
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
# TZ=UTC in every service image (#627: node-postgres turns a `date` column into a LOCAL midnight; launch checklist).
ENV NODE_ENV=production \
    TZ=UTC \
    APP_NAME=@platform/engagement
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chmod=0755 infra/docker/entrypoint.sh /usr/local/bin/platform-entrypoint
COPY infra/docker/health-server.mjs /usr/local/lib/platform/health-server.mjs
USER node
# The support API's port, when ENGAGEMENT_SUPPORT_ENABLED=1 (see the header).
EXPOSE 4040
ENTRYPOINT ["platform-entrypoint"]
