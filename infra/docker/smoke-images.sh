#!/usr/bin/env bash
# Smoke test for the app images built by infra/docker/docker-compose.build.yml.
# Asserts, for every image: it starts, it runs as a non-root user, and its HEALTHCHECK
# reaches "healthy" (i.e. GET /health really answers 200 on $PORT).
#
#   IMAGE_TAG=dev bash infra/docker/smoke-images.sh
#
# Used locally and by the `images` job in .github/workflows/ci.yml.
set -euo pipefail

TAG="${IMAGE_TAG:-dev}"
TIMEOUT="${SMOKE_TIMEOUT:-120}"

# app : host port (container port comes from the image's own PORT default)
APPS=(
  "core:9000"
  "admin:9001"
  "storefront-starter:9002"
  "accounting:9003"
  "analytics-ingest:9004"
  "notifications:9005"
)

cleanup() {
  for entry in "${APPS[@]}"; do
    docker rm -f "smoke-${entry%%:*}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

echo "== starting ${#APPS[@]} containers (tag: $TAG)"
for entry in "${APPS[@]}"; do
  app="${entry%%:*}"
  port="${entry##*:}"
  docker rm -f "smoke-$app" >/dev/null 2>&1 || true
  docker run -d --name "smoke-$app" -p "$port:$port" "commerce-platform/$app:$TAG" >/dev/null
done

FAIL=0
for entry in "${APPS[@]}"; do
  app="${entry%%:*}"
  port="${entry##*:}"
  name="smoke-$app"

  # 1. non-root
  uid="$(docker exec "$name" id -u)"
  if [ "$uid" = "0" ]; then
    echo "FAIL $app: container runs as root (uid 0)"
    FAIL=1
    continue
  fi

  # 2. the image's own HEALTHCHECK reaches healthy
  waited=0
  status="$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo none)"
  while [ "$status" = "starting" ] && [ "$waited" -lt "$TIMEOUT" ]; do
    sleep 3
    waited=$((waited + 3))
    status="$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo none)"
  done
  if [ "$status" != "healthy" ]; then
    echo "FAIL $app: health status '$status' after ${waited}s"
    docker logs "$name" 2>&1 | tail -20
    FAIL=1
    continue
  fi

  # 3. /health is reachable from outside the container on $PORT
  body="$(docker exec "$name" wget -q -O - "http://127.0.0.1:$port/health")"
  echo "ok   $app (uid $uid, healthy after ${waited}s) $body"
done

if [ "$FAIL" -ne 0 ]; then
  echo "== image smoke test FAILED"
  exit 1
fi
echo "== image smoke test passed for ${#APPS[@]} images"
