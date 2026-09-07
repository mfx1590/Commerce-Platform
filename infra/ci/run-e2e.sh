#!/usr/bin/env bash
# Runs every Playwright journey in the workspace: one per app that has a playwright config.
#
#   bash infra/ci/run-e2e.sh
#
# Discovering the journeys rather than listing them means an app that adds one is picked up without
# a workflow change — apps/admin's journey ([admin] 1.7, #30) lands this way. It also means the job
# cannot quietly become a no-op: if no journey is found at all, this fails, because the whole point
# of the job is to run them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# apps/admin signs in against the real realm, so it has to serve on a port Keycloak has registered
# as a redirect URI on the `admin-app` client. Both 3000 and 3200 are registered (REQUEST #82);
# 3200 is the default because an unrelated project holds 3000 on the owner's machine.
# ADMIN_APP_URL has to agree, or Keycloak sends the browser to the wrong callback.
ADMIN_E2E_PORT="${ADMIN_E2E_PORT:-3200}"

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

  # The web server in a playwright config builds and starts the app, but not the workspace packages
  # it imports — on a clean runner the storefront build fails with "Can't resolve '@platform/ui'".
  # `<pkg>^...` is turbo's dependencies-only filter: it builds @platform/ui and @platform/contracts
  # and leaves the app to its own config. Same trap as running vitest without turbo, and as
  # `pnpm --filter <app> build` in the Dockerfiles.
  echo "== $pkg: building workspace dependencies"
  pnpm exec turbo run build --filter="$pkg^..."

  # Browser choice. On CI, Playwright's own chromium — smaller, and version-matched to the
  # @playwright/test in the lockfile. Locally, the Chrome already on the machine, so nothing is
  # downloaded. A config that still pins `channel: 'chrome'` forces the Chrome channel either way:
  # installing chromium for it would fail at run time with "Chromium distribution 'chrome' is not
  # found". REQUEST #84 asks windows 3 and 4 to make that conditional; this picks chromium up by
  # itself the moment they do, with no change here.
  if [ -n "${E2E_BROWSER:-}" ]; then
    browser="$E2E_BROWSER"
  elif [ -n "${CI:-}" ] && ! grep -Eq "channel: *['\"]chrome['\"]" "$cfg"; then
    browser=chromium
  else
    browser=chrome
  fi

  # Install from the package that declares @playwright/test — `pnpm exec playwright` at the
  # workspace root cannot find it, because it is a dependency of the app, not of the root.
  # `--with-deps` installs system libraries with sudo: right on a runner, rude on a laptop.
  echo "== $pkg: installing browser '$browser'"
  if [ -n "${CI:-}" ]; then
    pnpm --filter "$pkg" exec playwright install --with-deps "$browser"
  else
    pnpm --filter "$pkg" exec playwright install "$browser"
  fi

  run_env=()
  if [ "$app" = 'admin' ]; then
    run_env=(PORT="$ADMIN_E2E_PORT" ADMIN_APP_URL="http://localhost:$ADMIN_E2E_PORT")
    echo "== $pkg (PORT=$ADMIN_E2E_PORT, ADMIN_APP_URL=http://localhost:$ADMIN_E2E_PORT)"
  else
    echo "== $pkg"
  fi

  if [ "$has_e2e" = 'true' ]; then
    env "${run_env[@]+"${run_env[@]}"}" pnpm --filter "$pkg" e2e || fail=1
  else
    env "${run_env[@]+"${run_env[@]}"}" pnpm --filter "$pkg" exec playwright test || fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo '== end-to-end journeys FAILED'
  exit 1
fi
echo "== ${#configs[@]} end-to-end journey(s) passed"
