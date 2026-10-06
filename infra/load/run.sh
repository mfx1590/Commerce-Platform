#!/usr/bin/env bash
# The #359 load run, the same on a laptop and in CI (.github/workflows/load.yml):
#
#   bash infra/load/run.sh [out-dir]   # target (10 min) + pool knee (~5.5 min) + placement ceiling (~6.5 min) + report
#   LOAD_SKIP_POOL=1 LOAD_SKIP_CEILING=1 bash infra/load/run.sh    # the target run only
#   LOAD_SKIP_TARGET=1 bash infra/load/run.sh                       # the two ramps only (~12 min)
#   DURATION=1m BROWSE_RPS=5 ORDERS_PER_MIN=6 LOAD_SKIP_POOL=1 LOAD_SKIP_CEILING=1 bash infra/load/run.sh   # smoke
#
# Needs the compose stack's Postgres (127.0.0.1:5433) and Redis (127.0.0.1:6381) up, and Docker for the
# pinned k6 image. It never starts, stops or touches the stack's containers; it runs one `docker run` of
# grafana/k6 per phase. Everything it writes goes to a FRESH database (`platform_boot_smoke`, created and
# dropped by infra/ci/boot-smoke.sh keep mode) — the shared `platform` database is not read or written.
#
#   1. boot-smoke keep mode: fresh DB, migrate, seed, Medusa migrate, build, start the core on :9000
#   2. top-up-stock on that DB (floor LOAD_STOCK_FLOOR, default 600) so 300 + 450 orders cannot drain it
#   3. pg-sampler.mjs at 1 s on that DB, per phase
#   4. k6 load.js (browse 50 rps + place 30/min, 10 min); pool.js (GET /store 50→800 req/s, the app-pool
#      knee); ceiling.js (placement 30→960 /min on one store, the store-row lock's knee)
#   5. report.mjs → <out>/report.md; then the core is stopped and its DB dropped, whatever happened
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
OUT="${1:-$ROOT/infra/load/out/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
# Native path where there is one (Git Bash: `pwd -W` → C:/…): node and bash both read it, whereas Git Bash's
# /tmp is a different directory to node on Windows.
OUT="$(cd "$OUT" && { pwd -W 2>/dev/null || pwd; })"
export K6_IMAGE="${K6_IMAGE:-grafana/k6:2.3.0}"
DB=platform_boot_smoke
export DURATION="${DURATION:-10m}" BROWSE_RPS="${BROWSE_RPS:-50}" ORDERS_PER_MIN="${ORDERS_PER_MIN:-30}"

# 127.0.0.1, never localhost: on the Windows laptop localhost resolves to ::1 first, where Docker's IPv6
# loopback proxy is known to die (Memory: docker-ipv6-loopback-reset).
export CORE_SMOKE_PG_HOSTPORT="${CORE_SMOKE_PG_HOSTPORT:-127.0.0.1:5433}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6381}"
export CORE_SMOKE_STATE="$OUT/core.state"
export CORE_SMOKE_LOG="$OUT/core.log"

# How k6, inside its container, reaches the core on this host.
case "$(uname -s)" in
  # On Linux the container also runs as this user: grafana/k6 runs as its own non-root uid, which cannot
  # write the bind-mounted output directory (the first runner run lost every summary to "permission denied").
  Linux) NET=(--network host --user "$(id -u):$(id -g)"); BASE=http://127.0.0.1:9000 ;;
  *) NET=(); BASE=http://host.docker.internal:9000 ;;
esac
# Docker Desktop on Windows wants a Windows path for the bind mount; Git Bash would mangle it otherwise.
if command -v cygpath >/dev/null 2>&1; then
  HOST_OUT="$(cygpath -w "$OUT")"; HOST_K6="$(cygpath -w "$ROOT/infra/load/k6")"; export MSYS_NO_PATHCONV=1
else
  HOST_OUT="$OUT"; HOST_K6="$ROOT/infra/load/k6"
fi

sampler_pid=''
sampler_out=''
# A stop FILE, not a signal: in Git Bash on Windows `kill -INT` never reaches the native node process, and
# `wait` then hung the laptop run after k6 had finished. The sampler checks for the file once a second.
stop_sampler() {
  if [ -n "$sampler_pid" ]; then
    : > "$sampler_out.stop"
    wait "$sampler_pid" 2>/dev/null || true
  fi
  sampler_pid=''
}
cleanup() {
  stop_sampler
  bash infra/ci/boot-smoke.sh --stop || true
}
trap cleanup EXIT

node -e '
  const os = require("os");
  const meta = { started: new Date().toISOString(), host: process.env.GITHUB_ACTIONS ? "GitHub-hosted runner (" + (process.env.RUNNER_NAME || "") + ")" : "laptop",
    os: os.type() + " " + os.release(), cpu: (os.cpus()[0] || {}).model, cores: os.cpus().length,
    memory_gb: Math.round(os.totalmem() / 2 ** 30), node: process.version,
    k6_image: process.env.K6_IMAGE, duration: process.env.DURATION, browse_rps: Number(process.env.BROWSE_RPS),
    orders_per_min: Number(process.env.ORDERS_PER_MIN), db_pool_max: Number(process.env.DB_POOL_MAX || 10),
    ceiling_steps: (process.env.CEILING_STEPS || "30,60,120,240,480,960").split(",").map(Number), ceiling_step: process.env.CEILING_STEP || "1m" };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(meta, null, 1));
' "$OUT/meta.json"

echo "== 1. a fresh core on :9000 (boot-smoke keep mode, database $DB)"
CORE_SMOKE_KEEP=1 bash infra/ci/boot-smoke.sh

echo "== 2. stock on $DB only (floor ${LOAD_STOCK_FLOOR:-600})"
DATABASE_URL="postgres://platform:platform@$CORE_SMOKE_PG_HOSTPORT/$DB" \
  pnpm --filter @platform/db top-up-stock "${LOAD_STOCK_FLOOR:-600}"

run_k6() {
  local name="$1" script="$2"; shift 2
  echo "== k6 $name ($script) against $BASE"
  sampler_out="$OUT/pg-$name.jsonl"
  node infra/load/pg-sampler.mjs "$sampler_out" "$DB" &
  sampler_pid=$!
  local rc=0
  docker run --rm "${NET[@]}" -v "$HOST_K6:/scripts:ro" -v "$HOST_OUT:/out" \
    -e BASE_URL="$BASE" -e DURATION -e BROWSE_RPS -e ORDERS_PER_MIN -e CEILING_STEPS -e CEILING_STEP \
    -e POOL_STEPS -e POOL_STEP_S \
    "$K6_IMAGE" run --quiet "$@" "/scripts/$script" || rc=$?
  stop_sampler
  echo "== k6 $name exited $rc (99 = a threshold failed; the report says which)"
  echo "$rc" > "$OUT/$name.exit"
}

if [ -z "${LOAD_SKIP_TARGET:-}" ]; then
  echo "== 3+4. target run"
  run_k6 load load.js
fi
if [ -z "${LOAD_SKIP_POOL:-}" ]; then
  run_k6 pool pool.js
fi
if [ -z "${LOAD_SKIP_CEILING:-}" ]; then
  echo "== stock again before the ceiling run"
  DATABASE_URL="postgres://platform:platform@$CORE_SMOKE_PG_HOSTPORT/$DB" \
    pnpm --filter @platform/db top-up-stock "${LOAD_STOCK_FLOOR:-600}"
  run_k6 ceiling ceiling.js --out csv=/out/ceiling-raw.csv.gz
fi

echo "== 5. report"
node infra/load/report.mjs "$OUT"
echo "== report: $OUT/report.md"
