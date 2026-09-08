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

  # Browser choice, by intent rather than by inspection (REQUEST #99). The script says what it
  # wants through E2E_CHANNEL and installs exactly that; it does not read anyone's config.
  #
  # Grepping the config for `channel: 'chrome'` was the previous mechanism and it failed silently
  # in both directions — double quotes, a variable, or the string in a comment all changed the
  # outcome without changing behaviour. `playwright test --list --reporter=json` was the suggested
  # alternative, but this Playwright version does not report `use.channel` in that output (checked:
  # the project object carries name, testDir, timeout and no `use`), so there is nothing to parse.
  #
  # On CI both browsers are installed. That is deliberate, and temporary: apps/storefront-starter
  # honours E2E_CHANNEL, apps/admin still pins `channel: 'chrome'` in its config and ignores the
  # variable (REQUEST #154). Installing only what this script intends would leave the admin journey
  # failing at run time with "Chromium distribution 'chrome' is not found". Installing both costs
  # one download and cannot be wrong. When every config honours E2E_CHANNEL this collapses back to
  # a single install of "$channel".
  if [ -n "${E2E_CHANNEL+x}" ]; then
    channel="$E2E_CHANNEL" # caller was explicit; obey it exactly
  elif [ -n "${CI:-}" ]; then
    channel='' # bundled chromium: version-matched to @playwright/test, lighter to install
  else
    channel='chrome' # the Chrome already on the machine, so nothing is downloaded
  fi
  # UNSET rather than export empty for bundled chromium. The configs read
  # `process.env.E2E_CHANNEL ?? (CI ? undefined : 'chrome')`, and `??` does not catch an empty
  # string — exporting '' would hand Playwright `channel: ''`, which is not a channel. Unset lets
  # their documented fallback apply. REQUEST #154 asks for a falsy check so that empty can mean
  # "bundled chromium" explicitly, and this becomes a plain export.
  if [ -z "$channel" ]; then
    unset E2E_CHANNEL
  else
    export E2E_CHANNEL="$channel"
  fi

  if [ -n "${CI:-}" ]; then
    browsers='chromium chrome'
  elif [ -z "$channel" ]; then
    browsers='chromium'
  else
    browsers="$channel"
  fi

  # Install from the package that declares @playwright/test — `pnpm exec playwright` at the
  # workspace root cannot find it, because it is a dependency of the app, not of the root.
  # `--with-deps` installs system libraries with sudo: right on a runner, rude on a laptop.
  echo "== $pkg: E2E_CHANNEL='$channel', installing: $browsers"
  if [ -n "${CI:-}" ]; then
    # shellcheck disable=SC2086 -- $browsers is a deliberate word list
    pnpm --filter "$pkg" exec playwright install --with-deps $browsers
  else
    # shellcheck disable=SC2086
    pnpm --filter "$pkg" exec playwright install $browsers
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
