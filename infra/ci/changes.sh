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
# Writes `code=…`, `images=…`, `terraform=…`, `e2e=…`, `helm=…` to stdout, and to $GITHUB_OUTPUT.
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
#   helm       helm lint/template + kubeconform over the charts and the ArgoCD manifests
#   e2e        the live auth suites and the Playwright journeys — anything `code` covers, plus the
#              realms and authorization model those suites run against
set -euo pipefail

emit() {
  printf 'code=%s\nimages=%s\nterraform=%s\ne2e=%s\nhelm=%s\n' "$1" "$2" "$3" "$4" "$5"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'code=%s\nimages=%s\nterraform=%s\ne2e=%s\nhelm=%s\n' "$1" "$2" "$3" "$4" "$5" >> "$GITHUB_OUTPUT"
  fi
}

# A push to main is never a partial build.
if [ -n "${CHANGES_ALL:-}" ]; then
  echo 'changes: CHANGES_ALL set — every group runs' >&2
  emit true true true true true
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
if match '^(infra/helm/|infra/argocd/)' || match "$CI_SCRIPTS" || match '^\.github/workflows/ci\.yml$'; then helm=true; fi

if [ "$code" = false ] && [ "$images" = false ] && [ "$terraform" = false ] && [ "$e2e" = false ] &&
  [ "$helm" = false ]; then
  echo 'changes: documentation-only change — the heavy jobs will no-op' >&2
fi

emit "$code" "$images" "$terraform" "$e2e" "$helm"
