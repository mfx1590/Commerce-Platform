#!/usr/bin/env bash
# Every app Dockerfile lists the workspace package.json files it copies into the `deps` stage, one
# COPY per package. That list is what makes the pnpm install layer cacheable against a REMOTE cache
# (see the comment in any apps/*/Dockerfile), and it is exactly the kind of list that goes stale the
# first time somebody adds a workspace package.
#
#   bash infra/ci/check-image-manifests.sh
#
# Failure modes it catches:
#   * a new workspace package whose manifest no Dockerfile copies — pnpm install would fail inside
#     the image with ERR_PNPM_OUTDATED_LOCKFILE, long after the PR that caused it;
#   * a package that was deleted or renamed but is still listed — the build fails on a missing file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Expand the globs in pnpm-workspace.yaml rather than searching the tree for package.json files.
# A `find` also turns up build output — apps/storefront-starter/.next/package.json is written by
# `next build` — and a denylist of build directories rots the next time a tool invents one.
#
# Reading the workspace file directly rather than asking `pnpm -r list`: this check runs in the
# `images` job, which has no reason to install a package manager, and a guard that fails because a
# tool is missing is a guard nobody trusts. Only node is needed, and node is everywhere here.
mapfile -t expected < <(
  node -e '
    const fs = require("fs");
    const path = require("path");
    const globs = fs
      .readFileSync("pnpm-workspace.yaml", "utf8")
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*-\s*["\x27]?([^"\x27#]+?)["\x27]?\s*$/))
      .filter(Boolean)
      .map((m) => m[1]);
    const out = [];
    for (const glob of globs) {
      if (!glob.endsWith("/*")) continue;
      const base = glob.slice(0, -2);
      let entries = [];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const manifest = path.posix.join(base, e.name, "package.json");
        if (fs.existsSync(manifest)) out.push(manifest);
      }
    }
    process.stdout.write(out.sort().join("\n") + "\n");
  '
)

if [ "${#expected[@]}" -eq 0 ]; then
  echo 'check-image-manifests: found no workspace manifests at all — wrong directory?' >&2
  exit 2
fi

fail=0
# apps/* AND apps/storefronts/*: brand storefronts live one level deeper (docs/ownership.md gives
# window 10 `apps/storefronts/<brand>/**`). A glob that only looked at apps/* would silently stop
# checking a whole class of image.
for dockerfile in apps/*/Dockerfile apps/storefronts/*/Dockerfile; do
  missing=()
  for manifest in "${expected[@]}"; do
    grep -qF "COPY $manifest " "$dockerfile" || missing+=("$manifest")
  done

  # Anything listed that no longer exists.
  stale=()
  while IFS= read -r listed; do
    [ -z "$listed" ] && continue
    [ -f "$listed" ] || stale+=("$listed")
  done < <(grep -oE '^COPY (apps|packages)/[^ ]*/package\.json' "$dockerfile" | sed 's/^COPY //')

  if [ "${#missing[@]}" -ne 0 ] || [ "${#stale[@]}" -ne 0 ]; then
    fail=1
    echo "FAIL $dockerfile"
    for m in ${missing[@]+"${missing[@]}"}; do
      echo "  missing: COPY $m $(dirname "$m")/"
    done
    for s in ${stale[@]+"${stale[@]}"}; do
      echo "  stale (no such file): $s"
    done
  else
    echo "ok   $dockerfile  (${#expected[@]} manifests)"
  fi
done

# Every service image runs in UTC (#627): node-postgres turns a `date` column into a LOCAL midnight Date, so a
# container in another zone shifts dates by a day. The runtime stage (after the last FROM) must set TZ=UTC.
for dockerfile in apps/*/Dockerfile apps/storefronts/*/Dockerfile; do
  if ! awk '/^FROM /{final=""} {final = final "\n" $0} END{print final}' "$dockerfile" | grep -qE '^[[:space:]]*(ENV[[:space:]]+)?TZ=UTC([[:space:]]|\\|$)'; then
    fail=1
    echo "FAIL $dockerfile"
    echo "  missing: TZ=UTC in the runtime stage's ENV"
  fi
done

# One Node base everywhere (#806 review): infra/docker/docker-compose.build.yml passes NODE_VERSION as a build
# arg, which OVERRIDES each Dockerfile's `ARG NODE_VERSION=` default for every CI and staging build. A Dependabot
# base-image bump edits the Dockerfiles only, so without this check the images would silently keep the old base.
compose_node="$(sed -nE 's/^[[:space:]]+NODE_VERSION:[[:space:]]*([^[:space:]#]+).*/\1/p' infra/docker/docker-compose.build.yml | head -1)"
node_fail=0
for dockerfile in apps/*/Dockerfile apps/storefronts/*/Dockerfile; do
  file_node="$(sed -nE 's/^ARG NODE_VERSION=([^[:space:]]+).*/\1/p' "$dockerfile" | head -1)"
  if [ -z "$compose_node" ] || [ "$file_node" != "$compose_node" ]; then
    fail=1
    node_fail=1
    echo "FAIL $dockerfile"
    echo "  NODE_VERSION: Dockerfile default '${file_node:-none}', docker-compose.build.yml arg '${compose_node:-none}'"
  fi
done

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'

== image manifest lists are out of date, an image does not set TZ=UTC, or the Node base disagrees.
Manifests: add or remove the COPY lines in the `deps` stage of the Dockerfiles named above, so that every
workspace package.json is copied before `pnpm install`. Keep them sorted.
EOF
  if [ "$node_fail" -ne 0 ]; then
    cat >&2 <<'EOF'
Node base: every Dockerfile's `ARG NODE_VERSION=` and the `NODE_VERSION` build arg in
infra/docker/docker-compose.build.yml must name the same tag; the compose arg wins in every CI and staging
build. A Dependabot base-image PR (the `docker` group) edits the Dockerfiles only: edit the compose arg by
hand in that same PR, to the tag the Dockerfiles now name.
EOF
  fi
  exit 1
fi
echo "== every app Dockerfile copies all ${#expected[@]} workspace manifests"
