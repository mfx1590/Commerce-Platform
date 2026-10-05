#!/usr/bin/env bash
# Boots apps/core for real against a freshly migrated and seeded database, and waits for
# GET /health to answer 200.
#
#   bash infra/ci/boot-smoke.sh                     # boot, check /health, stop, drop the database
#   CORE_SMOKE_KEEP=1 bash infra/ci/boot-smoke.sh   # boot, check /health, and LEAVE IT RUNNING
#   bash infra/ci/boot-smoke.sh --stop              # stop a kept core and drop its database
#
# Keep mode exists for the brand storefront journeys (#295): they run against a live core, and this
# is the one place that knows how to make one. The kept server's pid, database and log path go to
# $CORE_SMOKE_STATE; `--stop` reads them back. `--stop` always exits 0 — it runs in an `always()` step
# and must never turn a red job green or a green job red; it only cleans up. With nothing kept it is a
# no-op. A kept core also gets CORE_STORE_API_FALLBACK_URL (Prism on :4010, unless set): the core
# answers the catalogue, carts and orders itself and proxies the rest of /store/* to the mock, which is
# how the storefronts' core runs are set up locally.
#
# Why this exists: every other check in the pipeline reasons about the code without running the
# server. `medusa build` succeeding says the TypeScript compiled; the unit tests say the modules
# behave; the image smoke test says a container starts and answers a health endpoint served by the
# scaffold fallback. None of them load Medusa's own runtime — its config, its plugin and module
# loaders, its database and Redis connections. A loader failure there is a production outage that CI
# otherwise reports as green, and it is exactly the class of failure Integration 1 hit.
#
# It needs a database that looks like a real one. Core runs a readiness check at start (migrations
# applied, stores seeded with a channel and a live key, Medusa's schema migrated), so booting against
# an empty database proves nothing about the loaders — it just fails earlier for a different reason.
#
# That database is its OWN: `platform_boot_smoke` on the compose Postgres, dropped and recreated on
# every run, never the shared `platform` database. On a laptop other windows are using `platform`;
# re-seeding it underneath them, or leaving it half-migrated when this fails, is not acceptable.
# The compose services themselves are never stopped either — only `up -d`, which is additive.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PORT="${CORE_SMOKE_PORT:-9000}"
TIMEOUT="${CORE_SMOKE_TIMEOUT:-180}"
DB="${CORE_SMOKE_DB:-platform_boot_smoke}"
PG_CONTAINER="${CORE_SMOKE_PG_CONTAINER:-commerce-platform-postgres-1}"
PG_HOSTPORT="${CORE_SMOKE_PG_HOSTPORT:-localhost:5433}"
LOG="${CORE_SMOKE_LOG:-$(mktemp -t core-boot-XXXXXX.log)}"
KEEP="${CORE_SMOKE_KEEP:-0}"
STATE="${CORE_SMOKE_STATE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/core-boot-smoke.state}"

# A throwaway database name reaches SQL unquoted below — refuse anything that is not a plain identifier.
case "$DB" in
  *[!a-z0-9_]* | '' | [0-9]*) echo "CORE_SMOKE_DB must be a plain lowercase identifier, got '$DB'" >&2; exit 2 ;;
esac

# Every URL points at the throwaway database. These are exported, and loadDotenv() never overrides an
# exported variable, so a developer's .env cannot redirect a migration onto the shared database.
export DATABASE_URL="postgres://platform:platform@$PG_HOSTPORT/$DB"
export DATABASE_URL_APP="postgres://platform_app:platform_app@$PG_HOSTPORT/$DB"
export DATABASE_URL_MEDUSA_OWNER="postgres://medusa_owner:medusa_owner@$PG_HOSTPORT/$DB"
export MEDUSA_DB_OWNER_PASSWORD="${MEDUSA_DB_OWNER_PASSWORD:-medusa_owner}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6381}"
export JWT_SECRET="${JWT_SECRET:-boot-smoke}"
export COOKIE_SECRET="${COOKIE_SECRET:-boot-smoke}"
export PORT

psql_admin() {
  docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U platform -d postgres -qc "$1"
}

if [ "${1:-}" = '--stop' ]; then
  if [ ! -f "$STATE" ]; then
    echo "== no kept core ($STATE absent) — nothing to stop"
    exit 0
  fi
  # shellcheck disable=SC1090 -- written by this script below: KEPT_PID, KEPT_DB, KEPT_LOG
  . "$STATE"
  echo "== stopping the kept core (pid $KEPT_PID) and dropping $KEPT_DB"
  # The whole process group: setsid made the kept pnpm a group leader, and killing pnpm alone can
  # leave the node server it spawned holding :9000 and a database connection.
  kill -TERM -- "-$KEPT_PID" 2>/dev/null || kill "$KEPT_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$KEPT_PID" 2>/dev/null || break; sleep 0.5; done
  kill -KILL -- "-$KEPT_PID" 2>/dev/null || kill -9 "$KEPT_PID" 2>/dev/null || true
  echo '---- last 20 lines of the core log ----'
  tail -20 "$KEPT_LOG" 2>/dev/null | sed 's/^/   /' || true
  psql_admin "DROP DATABASE IF EXISTS $KEPT_DB WITH (FORCE)" >/dev/null 2>&1 ||
    echo "   (could not drop $KEPT_DB — the Postgres container may already be gone)"
  rm -f "$STATE"
  exit 0
fi

if [ "$KEEP" = '1' ]; then
  export CORE_STORE_API_FALLBACK_URL="${CORE_STORE_API_FALLBACK_URL:-http://127.0.0.1:4010}"
fi

app_pid=''
kept=0
cleanup() {
  # A core handed over in keep mode belongs to `--stop` now.
  [ "$kept" = 1 ] && return
  if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  # Leave the shared Postgres server as we found it. FORCE because the app may still hold a
  # connection for a moment after being killed.
  psql_admin "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== fresh database $DB on $PG_HOSTPORT (the shared 'platform' database is not touched)"
psql_admin "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
psql_admin "CREATE DATABASE $DB OWNER platform"

echo '== migrations and seed (packages/db)'
pnpm db:migrate
pnpm db:seed

echo "== Medusa's own schema"
pnpm --filter @platform/core db:medusa:migrate

echo '== building @platform/core and its workspace dependencies'
# Through turbo so `dependsOn: ^build` builds @platform/db and friends first — a direct
# `pnpm --filter` run compiles against packages with no dist/.
pnpm exec turbo run build --filter=@platform/core

echo "== starting the server on :$PORT (log: $LOG)"
# setsid in keep mode: the server outlives this script (and, on CI, this step), so it gets its own
# session rather than this shell's process group.
if [ "$KEEP" = '1' ] && command -v setsid >/dev/null 2>&1; then
  setsid pnpm --filter @platform/core start > "$LOG" 2>&1 < /dev/null &
else
  pnpm --filter @platform/core start > "$LOG" 2>&1 &
fi
app_pid=$!

waited=0
until curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo 'FAIL: the server exited before answering /health' >&2
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

if [ "$KEEP" = '1' ]; then
  printf 'KEPT_PID=%s\nKEPT_DB=%s\nKEPT_LOG=%s\n' "$app_pid" "$DB" "$LOG" > "$STATE"
  kept=1
  echo "== kept running on :$PORT (database $DB, log $LOG); stop with: bash infra/ci/boot-smoke.sh --stop"
fi
