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
#   every image   also runs the Node major in .nvmrc (`node -v` inside the image): the runtime moves once,
#                 everywhere (Node 22 move, step 0), and an image left on the old base is caught here.
#
#   storefronts   the one exception to "not booted": with one real JPEG mounted under public/, each must
#                 answer ONE /_next/image request as image/webp. Next loads sharp lazily, at the first
#                 optimised image, not at boot, so a sharp that cannot load on this base image (a missing
#                 linux-musl prebuild, a Node ABI it does not support) passes every other check and only
#                 fails in front of a shopper. webp, not 200, is the proof: without a working sharp Next
#                 returns the original JPEG. A storefront needs no database for that, only KEYCLOAK_URL
#                 (production refuses to boot without it: the CSP's form-action), given a loopback
#                 placeholder here.
#
# Used locally and by the `images` job in .github/workflows/ci.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAG="${IMAGE_TAG:-dev}"
TIMEOUT="${SMOKE_TIMEOUT:-120}"
NODE_MAJOR="${SMOKE_NODE_MAJOR:-$(tr -d ' v\r\n' < "$ROOT/.nvmrc")}"

FIXTURE_DIR=''

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
  "storefront-brand-b:3102"
  "storefront-brand-c:3103"
  "storefront-brand-d:3104"
  "engagement:4040"      # a real app (has `start`): only non-root and dist/ are checked, it is not booted
)

# Build outputs we know how to recognise, in the order we look for them.
BUILD_OUTPUTS=(".medusa/server" ".next" "dist")

cleanup() {
  for entry in "${APPS[@]}"; do
    docker rm -f "smoke-${entry%%:*}" "smoke-img-${entry%%:*}" >/dev/null 2>&1 || true
  done
  [ -n "$FIXTURE_DIR" ] && rm -rf "$FIXTURE_DIR"
  return 0
}
trap cleanup EXIT

# The storefront image fixture: a real JPEG from the repo, mounted read-only as the app's public/__smoke/.
FIXTURE_DIR="$(mktemp -d)"
cp "$ROOT/apps/admin/public/medusa-face.jpg" "$FIXTURE_DIR/face.jpg"
chmod 755 "$FIXTURE_DIR"; chmod 644 "$FIXTURE_DIR/face.jpg"
HOST_FIXTURE_DIR="$FIXTURE_DIR"
if command -v cygpath >/dev/null 2>&1; then HOST_FIXTURE_DIR="$(cygpath -w "$FIXTURE_DIR")"; export MSYS_NO_PATHCONV=1; fi

# One optimised image from a booted storefront: 0 when it came back as image/webp (sharp ran).
next_image() {
  local app="$1" port="$2" image="$3" waited=0 code="" ctype=""
  docker rm -f "smoke-img-$app" >/dev/null 2>&1 || true
  # KEYCLOAK_URL: a loopback placeholder, never contacted; production refuses to boot (starter) or to
  # answer a matched path (brands' middleware) without it.
  docker run -d --name "smoke-img-$app" -p "$port:$port" -e KEYCLOAK_URL=http://127.0.0.1:8180 \
    -v "$HOST_FIXTURE_DIR:/app/public/__smoke:ro" "$image" >/dev/null
  local url="http://127.0.0.1:$port/_next/image?url=%2F__smoke%2Fface.jpg&w=64&q=75"
  while [ "$waited" -lt "$TIMEOUT" ]; do
    read -r code ctype < <(curl -s -o /dev/null -H 'Accept: image/webp,*/*' \
      -w '%{http_code} %{content_type}\n' "$url" 2>/dev/null || true) || true
    [ "$code" = "200" ] && break
    # a container that died will not come back: fail now, not after the timeout
    [ "$(docker inspect -f '{{.State.Running}}' "smoke-img-$app" 2>/dev/null)" = "true" ] || break
    sleep 3
    waited=$((waited + 3))
  done
  if [ "$code" = "200" ] && [ "$ctype" = "image/webp" ]; then
    echo "     /_next/image -> 200 image/webp after ${waited}s (sharp loaded)"
    docker rm -f "smoke-img-$app" >/dev/null 2>&1 || true
    return 0
  fi
  echo "FAIL $app: /_next/image answered '$code' '$ctype' after ${waited}s (want 200 image/webp)"
  docker logs "smoke-img-$app" 2>&1 | tail -20
  docker rm -f "smoke-img-$app" >/dev/null 2>&1 || true
  return 1
}

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

  # 1b. the runtime: the Node major .nvmrc names, in every image
  node_v="$(docker run --rm --entrypoint node "$image" -v 2>/dev/null || echo none)"
  case "$node_v" in
    "v$NODE_MAJOR".*) ;;
    *)
      echo "FAIL $app: image runs Node '$node_v', .nvmrc says $NODE_MAJOR"
      FAIL=1
      continue
      ;;
  esac

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

    echo "ok   $app  app       user=$user  node $node_v  build output $found  start: $start_cmd"

    # 3. storefronts: one optimised image, so a broken sharp fails here and not in production
    case "$app" in
      storefront-*) next_image "$app" "$port" "$image" || FAIL=1 ;;
    esac
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "== image smoke test FAILED"
  exit 1
fi
echo "== image smoke test passed for ${#APPS[@]} images"
