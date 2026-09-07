# syntax=docker/dockerfile:1.7
# Image for @platform/storefront-starter. Owned by window 5 (infra); the app source is owned by window 3.
#
# Build from the REPO ROOT — the pnpm workspace is the build context:
#   docker compose -f infra/docker/docker-compose.build.yml build storefront-starter
#   docker build -f apps/storefront-starter/Dockerfile -t commerce-platform/storefront-starter:dev .
#
# Contract with the app window (changing it needs a CONTRACT CHANGE issue):
#   build time      `pnpm --filter @platform/storefront-starter... build` (the app and its workspace dependencies)
#   container start `pnpm start` inside the deployed package (infra/docker/entrypoint.sh)
#   runtime         listens on $PORT and answers `GET /health` with 200
# `next build` writes .next and the app's `start` is `next start --port 3100`, so the deployed
# package carries .next and the entrypoint runs the real server. infra/docker/health-server.mjs is
# only the fallback for apps that still have no `start` script.
#
# PORT is set to 3100 to match that hard-coded `--port`, so the HEALTHCHECK probes the port the app
# actually listens on. REQUEST #68 asks window 3 to drop `--port` — `next start` honours $PORT —
# after which this image goes back to the 900x allocation.
#
# KNOWN RUNTIME GAP (REQUEST #68): this app's config is next.config.ts, and `next start` loads it
# at RUNTIME, which needs `typescript` — a devDependency, so `pnpm deploy --prod` drops it and the
# container dies with "Failed to load next.config.ts". apps/admin already avoids this by using
# next.config.mjs. Shipping the TypeScript compiler in a production image to paper over it would be
# the wrong trade, so this is left for window 3 to fix in the app.

ARG NODE_VERSION=20.19-alpine
ARG PNPM_VERSION=10.34.5

# ---------- build: install the workspace, build the app, prune to a deployable package ----------
# corepack is safe here: /repo/package.json pins `packageManager` and the build runs as root.
FROM node:${NODE_VERSION} AS build
ARG PNPM_VERSION
ARG APP=@platform/storefront-starter
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
# The "..." suffix builds the app AND its workspace dependencies (@platform/db, events,
# contracts) in topological order. Without it the app compiles against packages that have no
# dist/ yet and tsc reports "Cannot find module '@platform/db'".
RUN pnpm --filter "$APP..." build
RUN pnpm --filter "$APP" --prod --legacy deploy /out

# `pnpm deploy` packs the package the way npm would, and npm's packing rules skip dot-directories,
# so .next — the entire output of `next build` — is left behind and `next start` finds nothing to
# serve. Copy it across explicitly. public/ and the next config are ordinary files and come along.
RUN cp -r /repo/apps/storefront-starter/.next /out/.next && test -d /out/.next

# ---------- runtime ----------
# pnpm is installed globally with npm, NOT with corepack: the deployed package.json carries no
# `packageManager` field, so a corepack shim would resolve "latest" and try to download pnpm over
# the network on every container start — as the unprivileged `node` user, with an empty cache.
FROM node:${NODE_VERSION} AS runtime
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
ENV NODE_ENV=production \
    APP_NAME=@platform/storefront-starter \
    PORT=3100
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chmod=0755 infra/docker/entrypoint.sh /usr/local/bin/platform-entrypoint
COPY infra/docker/health-server.mjs /usr/local/lib/platform/health-server.mjs
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["platform-entrypoint"]
