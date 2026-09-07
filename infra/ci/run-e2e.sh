#!/usr/bin/env bash
# Runs every Playwright journey in the workspace: one per app that has a playwright config.
#
#   bash infra/ci/run-e2e.sh
#
# Discovering the journeys rather than listing them means an app that adds one is picked up without
# a workflow change — apps/admin's journey ([admin] 1.7, #30) lands this way. It also means the job
# cannot quietly become a no-op: if no journey is found at all, this fails, because the whole point
# of the job is to run them.
#
# Ports: each app's playwright config starts its own web server and derives the base URL from $PORT
# or E2E_BASE_URL. apps/admin needs the port Keycloak has registered as a redirect URI on the
# `admin-app` client — 3000 today. REQUEST #82 adds 3200 as a second one; when it lands, set
# ADMIN_E2E_PORT=3200 (it is already honoured below) and 3000 stops being a hard requirement.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ADMIN_E2E_PORT="${ADMIN_E2E_PORT:-3000}"

# `chrome` is the Google Chrome channel, which is what the Playwright configs pin
# (`channel: 'chrome'`). REQUEST #84 asks for that to be conditional on $CI; when it lands this
# becomes `chromium`, which is smaller and version-matched to Playwright.
E2E_BROWSER="${E2E_BROWSER:-chrome}"

mapfile -t configs < <(ls -1 apps/*/playwright.config.* 2>/dev/null | sort)

if [ "${#configs[@]}" -eq 0 ]; then
  echo 'FAIL: no apps/*/playwright.config.* found — this job exists to run the journeys.' >&2
  echo '      If a journey was intentionally removed, remove this job in the same PR.' >&2
  exit 1
fi

echo "== found ${#configs[@]} journey(s)"
for cfg in "${configs[@]}"; do
  echo "   $cfg"
done

fail=0
for cfg in "${configs[@]}"; do
  dir="$(dirname "$cfg")"
  app="$(basename "$dir")"
  pkg="$(node -p "require('./$dir/package.json').name")"
  has_e2e="$(node -p "Boolean((require('./$dir/package.json').scripts||{}).e2e)")"

  # The admin journey signs in against the real realm, so it has to serve on a registered
  # redirect URI. Everything else keeps whatever its config defaults to.
  port_env=()
  if [ "$app" = 'admin' ]; then
    port_env=(PORT="$ADMIN_E2E_PORT")
    echo "== $pkg (PORT=$ADMIN_E2E_PORT — must match a redirect URI on the admin-app client)"
  else
    echo "== $pkg"
  fi

  # Install the browser from the package that declares @playwright/test — `pnpm exec playwright`
  # at the workspace root cannot find it, because it is a dependency of the app, not of the root.
  # `--with-deps` installs system libraries with sudo, which is right on a runner and rude on a
  # laptop, so it is CI-only.
  if [ -n "${CI:-}" ]; then
    pnpm --filter "$pkg" exec playwright install --with-deps "$E2E_BROWSER"
  else
    pnpm --filter "$pkg" exec playwright install "$E2E_BROWSER"
  fi

  if [ "$has_e2e" = 'true' ]; then
    env "${port_env[@]+"${port_env[@]}"}" pnpm --filter "$pkg" e2e || fail=1
  else
    env "${port_env[@]+"${port_env[@]}"}" pnpm --filter "$pkg" exec playwright test || fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo '== end-to-end journeys FAILED'
  exit 1
fi
echo "== ${#configs[@]} end-to-end journey(s) passed"
