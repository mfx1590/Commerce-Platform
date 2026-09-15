#!/usr/bin/env bash
# Smoke test for the app images built by infra/docker/docker-compose.build.yml.
#
#   IMAGE_TAG=dev bash infra/docker/smoke-images.sh
#
# It checks what an image can be held responsible for on its own, and nothing else. Which checks
# apply is decided per image from its deployed package.json, not from a hard-coded list:
#
#   every image   runs as a non-root user, and carries the artefact its `start` command needs.
#
#   scaffold      no `start` script yet, so the entrypoint serves infra/docker/health-server.mjs.
#                 Nothing external is involved, so the image's own HEALTHCHECK must reach `healthy`
#                 and GET /health must return 200.
#
#   app           has a `start` script (apps/core: `node .medusa/server/src/server.js`, the Next.js
#                 apps: `next start`). The build output must be present in the deployed package —
#                 that is the check that would have caught the core regression, where `pnpm deploy`
#                 silently dropped .medusa and the container died with MODULE_NOT_FOUND.
#
#                 A real app is deliberately NOT booted here. It needs a migrated database, a cache
#                 and real secrets, and it is *correct* for it to refuse to start without them —
#                 apps/core's medusa-config throws on a missing DATABASE_URL_APP by design. Proving
#                 that a configured app serves /health is the staging deploy's job (tasks 2.3/2.4),
#                 not an image test's.
#
# Used locally and by the `images` job in .github/workflows/ci.yml.
set -euo pipefail

TAG="${IMAGE_TAG:-dev}"
TIMEOUT="${SMOKE_TIMEOUT:-120}"

# app : host port (container port comes from the image's own PORT default)
APPS=(
  "core:9000"
  "admin:3000"           # matches the app's hard-coded `next start --port 3000` (REQUEST #68)
  "storefront-starter:3100"
  "accounting:9003"
  "analytics-ingest:9004"
  "notifications:9005"
  "feeds:4020"
  "storefront-brand-a:3101"
)

# Build outputs we know how to recognise, in the order we look for them.
BUILD_OUTPUTS=(".medusa/server" ".next" "dist")

cleanup() {
  for entry in "${APPS[@]}"; do
    docker rm -f "smoke-${entry%%:*}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

FAIL=0

for entry in "${APPS[@]}"; do
  app="${entry%%:*}"
  port="${entry##*:}"
  image="commerce-platform/$app:$TAG"

  # 1. non-root — read from the image itself, so it holds whether or not a container stays up.
  user="$(docker image inspect -f '{{.Config.User}}' "$image")"
  if [ -z "$user" ] || [ "$user" = "root" ] || [ "$user" = "0" ]; then
    echo "FAIL $app: image runs as '${user:-root}'"
    FAIL=1
    continue
  fi

  # 2. scaffold or real app?
  start_cmd="$(docker run --rm --entrypoint node "$image" \
    -p '(require("./package.json").scripts||{}).start || ""' 2>/dev/null || echo '')"

  if [ -z "$start_cmd" ]; then
    # ---- scaffold: the image is self-contained, so hold it to a real health check ----
    docker rm -f "smoke-$app" >/dev/null 2>&1 || true
    docker run -d --name "smoke-$app" -p "$port:$port" "$image" >/dev/null

    waited=0
    status="$(docker inspect -f '{{.State.Health.Status}}' "smoke-$app" 2>/dev/null || echo none)"
    while [ "$status" = "starting" ] && [ "$waited" -lt "$TIMEOUT" ]; do
      sleep 3
      waited=$((waited + 3))
      status="$(docker inspect -f '{{.State.Health.Status}}' "smoke-$app" 2>/dev/null || echo none)"
    done

    if [ "$status" != "healthy" ]; then
      echo "FAIL $app (scaffold): health status '$status' after ${waited}s"
      docker logs "smoke-$app" 2>&1 | tail -20
      FAIL=1
      continue
    fi

    body="$(docker exec "smoke-$app" wget -q -O - "http://127.0.0.1:$port/health")"
    echo "ok   $app  scaffold  user=$user  healthy in ${waited}s  $body"
  else
    # ---- real app: the build output must be in the deployed package ----
    found=""
    for out in "${BUILD_OUTPUTS[@]}"; do
      if docker run --rm --entrypoint sh "$image" -c "[ -e ./$out ]" 2>/dev/null; then
        found="$out"
        break
      fi
    done

    if [ -z "$found" ]; then
      echo "FAIL $app (app): no build output in the deployed package."
      echo "     Looked for: ${BUILD_OUTPUTS[*]} under /app. start is: $start_cmd"
      echo "     'pnpm deploy' packs like npm does and skips dot-directories — the app's Dockerfile"
      echo "     has to copy such an output across explicitly (see apps/core/Dockerfile)."
      FAIL=1
      continue
    fi

    echo "ok   $app  app       user=$user  build output $found  start: $start_cmd"
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "== image smoke test FAILED"
  exit 1
fi
echo "== image smoke test passed for ${#APPS[@]} images"
