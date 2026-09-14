#!/usr/bin/env bash
# Boots apps/core for real against the local stack and waits for GET /health to answer 200.
#
#   bash infra/ci/boot-smoke.sh
#
# Why this exists: every other check in the pipeline reasons about the code without running the
# server. `medusa build` succeeding says the TypeScript compiled; the unit tests say the modules
# behave; the image smoke test says a container starts and answers a health endpoint served by the
# scaffold fallback. None of them load Medusa's own runtime — its config, its module loaders, its
# database and Redis connections. A loader failure there is a production outage that CI currently
# reports as green, and it is exactly the class of failure Integration 1 hit.
#
# It stops the app afterwards and leaves the shared docker stack alone: the services are started
# with `up -d` (additive) and never `down`, because other windows may be using them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PORT="${CORE_SMOKE_PORT:-9000}"
TIMEOUT="${CORE_SMOKE_TIMEOUT:-180}"
LOG="${CORE_SMOKE_LOG:-$(mktemp -t core-boot-XXXXXX.log)}"

: "${DATABASE_URL:=postgres://platform:platform@localhost:5433/platform}"
: "${DATABASE_URL_APP:=postgres://platform_app:platform_app@localhost:5433/platform}"
: "${REDIS_URL:=redis://localhost:6381}"
: "${JWT_SECRET:=boot-smoke}"
: "${COOKIE_SECRET:=boot-smoke}"
export DATABASE_URL DATABASE_URL_APP REDIS_URL JWT_SECRET COOKIE_SECRET
export PORT

app_pid=''
cleanup() {
  if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "== building @platform/core and its workspace dependencies"
# Through turbo so `dependsOn: ^build` builds @platform/db and friends first — a direct
# `pnpm --filter` run compiles against packages with no dist/.
pnpm exec turbo run build --filter=@platform/core

echo "== starting the server on :$PORT (log: $LOG)"
pnpm --filter @platform/core start > "$LOG" 2>&1 &
app_pid=$!

waited=0
until curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "FAIL: the server exited before answering /health" >&2
    echo '---- last 60 lines ----' >&2
    tail -60 "$LOG" >&2
    exit 1
  fi
  if [ "$waited" -ge "$TIMEOUT" ]; then
    echo "FAIL: /health did not answer 200 within ${TIMEOUT}s" >&2
    echo '---- last 60 lines ----' >&2
    tail -60 "$LOG" >&2
    exit 1
  fi
  sleep 3
  waited=$((waited + 3))
done

echo "== /health answered 200 after ${waited}s — Medusa's loaders, config, database and Redis are all live"
tail -5 "$LOG" | sed 's/^/   /'
