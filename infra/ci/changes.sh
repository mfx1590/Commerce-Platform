#!/usr/bin/env bash
# Decides which CI job groups a change needs to run. Called by the `changes` job in
# .github/workflows/ci.yml; `infra/ci/changes.test.sh` is its self-test, the same arrangement
# scripts/check-ownership.sh and scripts/check-ownership.test.sh use.
#
# Usage:
#   infra/ci/changes.sh <base-sha>        # classify <base-sha>...HEAD
#   CHANGES_ALL=1 infra/ci/changes.sh     # everything runs (pushes to main)
#   CHANGED_FILES=$'a\nb' infra/ci/changes.sh   # test mode, no git needed
#
# Writes `code=…`, `images=…`, `terraform=…`, `e2e=…`, `helm=…`, `observ=…`, `perf=…`, `perf_apps=…` and
# `perf_unmeasured=…` to stdout, and to $GITHUB_OUTPUT. `perf_apps` is a JSON array of storefront
# directories for the perf job's matrix; `perf_unmeasured` is a JSON array of changed brand storefront
# directories that have no `perf` script, which the perf check fails on rather than reporting a vacuous
# pass (#336 review). `STOREFRONTS=$'a\nb'` overrides the directory scan (test mode).
#
# Groups:
#   code       lint, typecheck, format, unit tests, contract tests
#   images     the app images and their smoke test. On a PR this fires only when something that
#              defines HOW an image is built changes — a Dockerfile, .dockerignore, infra/docker/**
#              or infra/ci/**. NOT on apps/** or packages/**: rebuilding six images because one
#              source file moved cost ~10 minutes of runner time per push and exhausted the monthly
#              budget. A push to main still builds everything, so a source change that breaks its
#              own image is caught at merge rather than never.
#   terraform  terraform fmt/validate, and the Kubernetes manifests that go with it
#   helm       helm lint/template + kubeconform over the charts and the ArgoCD manifests, and the
#              derived deployed customers realm (infra/deploy/, from infra/keycloak/customers-realm.json)
#   observ     the observability stack: compose profile, collector/Prometheus config, dashboards
#   e2e        the live auth suites and the Playwright journeys — anything `code` covers, plus the
#              realms and authorization model those suites run against
#   perf       the storefront performance budget (bundle + Lighthouse, ~5 min per storefront), run
#              once per storefront in `perf_apps`. A storefront is every directory under
#              apps/storefront-starter or apps/storefronts/* whose package.json has a `perf` script.
#              A change inside one storefront measures that storefront; a change to what they all build
#              from (packages/ui, packages/contracts, cms/, the root files) measures all of them.
#              Narrower than `code` so a core-only PR does not pay for a storefront build (#257); per
#              storefront so a brand's theme is measured with its own budgets, not the starter's (#283).
set -euo pipefail

emit() {
  printf 'code=%s\nimages=%s\nterraform=%s\ne2e=%s\nhelm=%s\nobserv=%s\nperf=%s\nperf_apps=%s\nperf_unmeasured=%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'code=%s\nimages=%s\nterraform=%s\ne2e=%s\nhelm=%s\nobserv=%s\nperf=%s\nperf_apps=%s\nperf_unmeasured=%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" >> "$GITHUB_OUTPUT"
  fi
}

# Every storefront the perf job can measure: the starter and each brand, if it has a `perf` script.
# A brand scaffold without one is reported rather than silently left unmeasured.
storefronts() {
  if [ -n "${STOREFRONTS+x}" ]; then
    printf '%s\n' "$STOREFRONTS" | sed '/^$/d'
    return
  fi
  local root dir
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  for dir in "$root"/apps/storefront-starter "$root"/apps/storefronts/*; do
    [ -f "$dir/package.json" ] || continue
    if grep -q '"perf":' "$dir/package.json"; then
      printf '%s\n' "${dir#"$root"/}"
    else
      echo "changes: ${dir#"$root"/} has no perf script — the perf job cannot measure it" >&2
    fi
  done
}

# The storefronts given on stdin, as a JSON array of strings.
json_array() {
  local out='' item
  while IFS= read -r item; do
    [ -n "$item" ] && out="$out${out:+,}\"$item\""
  done
  printf '[%s]' "$out"
}

# A push to main is never a partial build.
if [ -n "${CHANGES_ALL:-}" ]; then
  echo 'changes: CHANGES_ALL set — every group runs' >&2
  emit true true true true true true true "$(storefronts | json_array)" '[]'
  exit 0
fi

if [ -n "${CHANGED_FILES+x}" ]; then
  changed="$CHANGED_FILES"
elif [ "$#" -ge 1 ] && [ -n "$1" ]; then
  changed="$(git diff --name-only "$1...HEAD")"
else
  echo 'changes: no base sha and no CHANGED_FILES — refusing to guess' >&2
  exit 2
fi

{
  echo 'changes: files in this diff:'
  printf '%s\n' "$changed" | sed 's/^/  /'
} >&2

match() { printf '%s\n' "$changed" | grep -Eq "$1"; }

# Workspace-level files change what every package resolves to, or how every image is built, so they
# count as both code and images. `.github/workflows/ci.yml` counts as everything: a change to the
# pipeline should be exercised by the whole pipeline.
ROOT_FILES='^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig\.base\.json|eslint\.config\.mjs|\.prettierrc|\.prettierignore|\.dockerignore|\.github/workflows/ci\.yml)$'

# infra/ci/*.sh ARE the pipeline: changes.sh decides what runs, check-image-manifests.sh gates the
# image build, wait-for-auth-stack.sh and run-e2e.sh are the e2e job. A change to any of them has to
# be exercised by the jobs that use it, or it ships untested.
CI_SCRIPTS='^infra/ci/'

code=false
images=false
terraform=false
e2e=false
helm=false
observ=false
perf=false

# Any workflow file counts as code, not just ci.yml: prettier formats .github/workflows/**, so a
# workflow that lands unformatted would pass its own PR and then break `format:check` on somebody
# else's unrelated one. Found by this very PR, which changed only deploy-staging.yml and classified
# as nothing at all.
if match '^(apps/|packages/|scripts/|cms/|data/)' || match "$ROOT_FILES" || match '^\.github/workflows/'; then code=true; fi
# Deliberately narrower than `code`: see the note at the top of this file.
if match '(^|/)Dockerfile$' || match '^\.dockerignore$' || match '^infra/docker/' || match "$CI_SCRIPTS" ||
  match '^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json)$' || match '^\.github/workflows/ci\.yml$'; then
  images=true
fi
if match '^(infra/terraform/|infra/kubernetes/)' || match '^\.github/workflows/ci\.yml$'; then terraform=true; fi
if [ "$code" = true ] || match '^(infra/keycloak/|infra/openfga/|infra/docker/)' || match "$CI_SCRIPTS"; then e2e=true; fi
# infra/deploy/ is what gets deployed alongside the charts (the derived customers realm, #297), and the
# customers realm export is its input: a change to either must re-run the derivation's self-test.
if match '^(infra/helm/|infra/argocd/|infra/deploy/)' || match '^infra/keycloak/customers-realm\.json$' ||
  match "$CI_SCRIPTS" || match '^\.github/workflows/ci\.yml$'; then helm=true; fi
# The compose file is shared: it defines both the dev stack and the observability profile.
if match '^(infra/observability/|infra/docker/docker-compose\.yml$)' || match "$CI_SCRIPTS" ||
  match '^\.github/workflows/ci\.yml$'; then observ=true; fi
# The storefronts' shared workspace dependencies are @platform/ui, @platform/contracts and @platform/cms
# (cms/). A new one in any storefront's package.json belongs in this pattern too.
if match '^(packages/(ui|contracts)/|cms/)' || match "$ROOT_FILES"; then
  perf_apps="$(storefronts)"
else
  perf_apps="$(storefronts | while IFS= read -r dir; do
    if match "^$dir/"; then printf '%s\n' "$dir"; fi
  done)"
fi
if [ -n "$perf_apps" ]; then perf=true; fi
# A changed brand storefront the perf job cannot measure (no `perf` script yet). Named here so the perf
# check can fail on it: without this, a PR touching only that brand got "no storefront changed".
measurable="$(storefronts)"
perf_unmeasured="$(printf '%s\n' "$changed" | sed -n -E 's#^(apps/storefronts/[^/]+)/.*#\1#p' | sort -u |
  while IFS= read -r dir; do
    if ! printf '%s\n' "$measurable" | grep -qxF "$dir"; then printf '%s\n' "$dir"; fi
  done)"
if [ -n "$perf_unmeasured" ]; then
  echo "changes: storefronts changed that the perf job cannot measure (no perf script): $perf_unmeasured" >&2
fi
perf_apps="$(printf '%s\n' "$perf_apps" | json_array)"
perf_unmeasured="$(printf '%s\n' "$perf_unmeasured" | json_array)"

if [ "$code" = false ] && [ "$images" = false ] && [ "$terraform" = false ] && [ "$e2e" = false ] &&
  [ "$helm" = false ] && [ "$observ" = false ] && [ "$perf" = false ]; then
  echo 'changes: documentation-only change — the heavy jobs will no-op' >&2
fi

emit "$code" "$images" "$terraform" "$e2e" "$helm" "$observ" "$perf" "$perf_apps" "$perf_unmeasured"
