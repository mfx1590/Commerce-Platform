#!/bin/sh
# Entrypoint for every app image (infra/docker/images contract).
#
#   1. `docker run <image> <cmd>`  -> runs <cmd> verbatim (debugging: `sh`, `node -v`, ...).
#   2. package.json has a `start`  -> `pnpm start` (the real app: Medusa, Next.js, a worker).
#   3. otherwise                   -> the scaffold health server, so /health answers while
#                                     windows 1/3/4 are still building Phase 1.
#
# Step 2 is the contract with the app windows: `pnpm --filter <app> build` at image build time,
# `pnpm start` (== `pnpm --filter <app> start` from the repo root) at container start. Adding a
# `start` script to an app is all it takes to switch this image from scaffold to real app.
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if node -e 'const s=require("/app/package.json").scripts||{};process.exit(s.start?0:1)'; then
  exec pnpm start
fi

echo "[${APP_NAME:-app}] no \"start\" script yet — serving the scaffold health server." >&2
exec node /usr/local/lib/platform/health-server.mjs
