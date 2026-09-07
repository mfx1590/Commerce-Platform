#!/usr/bin/env bash
# Waits for the services the live auth suites need, and FAILS if any of them does not come up.
#
#   bash infra/ci/wait-for-auth-stack.sh
#
# This exists because of how those suites are written. They gate themselves on reachability:
#
#   const live = await reachable();
#   describe.runIf(live)('… (live Keycloak + Postgres + OpenFGA)', …)
#
# which is right for a laptop with nothing running — but in CI it means a mis-wired service turns a
# required check into a green no-op that asserts nothing. So the URLs are probed here first, loudly,
# before vitest is allowed to decide anything.
#
# Both Keycloak realms are checked, not just `staff`: they are imported from infra/keycloak by the
# same container start, and a realm that failed to import is exactly the kind of thing that would
# otherwise show up as "0 tests, all green".
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8180}"
OPENFGA_API_URL="${OPENFGA_API_URL:-http://localhost:8081}"
PGHOST_PORT="${PGHOST_PORT:-5433}"
TIMEOUT="${WAIT_TIMEOUT:-180}"

wait_for() {
  local name="$1" url="$2" waited=0
  printf 'waiting for %-28s %s\n' "$name" "$url"
  until curl -fsS --max-time 5 "$url" >/dev/null 2>&1; do
    if [ "$waited" -ge "$TIMEOUT" ]; then
      echo "FAIL: $name did not answer at $url within ${TIMEOUT}s" >&2
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  printf '  up after %ss\n' "$waited"
}

fail=0

# Keycloak: both realms must be importable and discoverable.
wait_for 'keycloak (staff realm)' "$KEYCLOAK_URL/realms/staff/.well-known/openid-configuration" || fail=1
wait_for 'keycloak (customers realm)' "$KEYCLOAK_URL/realms/customers/.well-known/openid-configuration" || fail=1

# OpenFGA.
wait_for 'openfga' "$OPENFGA_API_URL/healthz" || fail=1

# Postgres: the live suites create throw-away databases through @platform/db/testing.
waited=0
printf 'waiting for %-28s localhost:%s\n' 'postgres' "$PGHOST_PORT"
until docker exec commerce-platform-postgres-1 pg_isready -U platform -d platform >/dev/null 2>&1; do
  if [ "$waited" -ge "$TIMEOUT" ]; then
    echo "FAIL: postgres was not ready within ${TIMEOUT}s" >&2
    fail=1
    break
  fi
  sleep 3
  waited=$((waited + 3))
done
[ "$fail" -eq 0 ] && printf '  up after %ss\n' "$waited"

if [ "$fail" -ne 0 ]; then
  echo
  echo '== the auth stack is not up. The live suites would have SKIPPED and this job would have'
  echo '== reported success while testing nothing, which is why this check exists.'
  docker compose -f infra/docker/docker-compose.yml ps 2>/dev/null || true
  docker compose -f infra/docker/docker-compose.yml logs --tail=40 keycloak openfga 2>/dev/null || true
  exit 1
fi

echo '== auth stack is up: keycloak (staff + customers), openfga, postgres'
