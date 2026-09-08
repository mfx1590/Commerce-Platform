#!/usr/bin/env bash
# Static checks for the observability stack. No stack is started: this answers "are these files
# well-formed and internally consistent", not "does the pipeline work" — that is the smoke test in
# the runbook, which needs the containers up.
#
#   bash infra/observability/check.sh
#
# Same arrangement as infra/terraform/check.sh and infra/helm/check.sh: local binaries when present,
# official images through Docker otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE=infra/docker/docker-compose.yml
fail=0

echo '== the observability profile is off by default'
default_services="$(docker compose -f "$COMPOSE" config --services | sort | tr '\n' ' ')"
profile_services="$(docker compose -f "$COMPOSE" --profile observability config --services | sort | tr '\n' ' ')"
for svc in otel-collector prometheus loki tempo grafana; do
  if printf '%s' "$default_services" | grep -qw "$svc"; then
    echo "FAIL $svc starts without --profile observability; 'pnpm dev' must be unchanged"
    fail=1
  fi
  if ! printf '%s' "$profile_services" | grep -qw "$svc"; then
    echo "FAIL $svc is missing from the observability profile"
    fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "   default: $default_services"
[ "$fail" -eq 0 ] && echo "   profile: $profile_services"

echo '== host ports do not collide'
# The ones this machine and this project already own. A duplicate here is a stack that half starts
# and a morning spent wondering why.
# `|| true` because grep exits 1 when it matches nothing, and under `set -o pipefail` that would
# end the script on the happy path — no published ports at all is not an error here.
duplicates="$(docker compose -f "$COMPOSE" --profile observability config |
  grep -oE "^ +- .[0-9]+:[0-9]+" | grep -oE "[0-9]+:" | tr -d ':' | sort | uniq -d || true)"
if [ -n "$duplicates" ]; then
  echo "FAIL two services publish the same host port: $duplicates"
  fail=1
fi

echo '== dashboards are valid JSON with the fields Grafana provisioning requires'
for f in infra/observability/grafana/dashboards/*.json; do
  if ! node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const k of ["uid", "title", "panels"]) {
      if (!d[k]) throw new Error(`${process.argv[1]}: missing ${k}`);
    }
    if (!Array.isArray(d.panels) || d.panels.length === 0) {
      throw new Error(`${process.argv[1]}: no panels`);
    }
    for (const p of d.panels) {
      if (!p.datasource || !p.datasource.uid) {
        throw new Error(`${process.argv[1]}: panel "${p.title}" has no datasource uid`);
      }
    }
    console.log(`   ok ${process.argv[1]} (${d.panels.length} panels)`);
  ' "$f"; then
    fail=1
  fi
done

echo '== every datasource a panel names is provisioned'
node -e '
  const fs = require("fs");
  const ds = fs.readFileSync("infra/observability/grafana/provisioning/datasources/datasources.yaml", "utf8");
  const provisioned = new Set([...ds.matchAll(/^\s*uid:\s*(\S+)/gm)].map((m) => m[1]));
  let bad = 0;
  for (const f of fs.readdirSync("infra/observability/grafana/dashboards")) {
    if (!f.endsWith(".json")) continue;
    const d = JSON.parse(fs.readFileSync(`infra/observability/grafana/dashboards/${f}`, "utf8"));
    const used = new Set();
    for (const p of d.panels) used.add(p.datasource.uid);
    for (const v of d.templating?.list ?? []) if (v.datasource?.uid) used.add(v.datasource.uid);
    for (const uid of used) {
      if (!provisioned.has(uid)) {
        console.error(`   FAIL ${f} uses datasource "${uid}", which is not provisioned`);
        bad = 1;
      }
    }
    console.log(`   ok ${f} -> ${[...used].join(", ")}`);
  }
  process.exit(bad);
' || fail=1

echo '== prometheus config parses'
if ! MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT/infra/observability:/cfg:ro" \
  --entrypoint promtool prom/prometheus:v3.0.1 check config /cfg/prometheus.yml >/dev/null; then
  echo 'FAIL prometheus.yml did not pass promtool'
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo '== observability checks FAILED'
  exit 1
fi
echo '== observability checks passed'
