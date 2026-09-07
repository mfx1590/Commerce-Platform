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
# Writes `code=…`, `images=…`, `terraform=…` to stdout, and to $GITHUB_OUTPUT when it is set.
#
# Groups:
#   code       lint, typecheck, format, unit tests, contract tests
#   images     the app images and their smoke test
#   terraform  terraform fmt/validate, and the Kubernetes manifests that go with it
set -euo pipefail

emit() {
  printf 'code=%s\nimages=%s\nterraform=%s\n' "$1" "$2" "$3"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'code=%s\nimages=%s\nterraform=%s\n' "$1" "$2" "$3" >> "$GITHUB_OUTPUT"
  fi
}

# A push to main is never a partial build.
if [ -n "${CHANGES_ALL:-}" ]; then
  echo 'changes: CHANGES_ALL set — every group runs' >&2
  emit true true true
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

code=false
images=false
terraform=false

if match '^(apps/|packages/|scripts/|cms/|data/)' || match "$ROOT_FILES"; then code=true; fi
if match '^(apps/|packages/|infra/docker/)' || match "$ROOT_FILES"; then images=true; fi
if match '^(infra/terraform/|infra/kubernetes/)' || match '^\.github/workflows/ci\.yml$'; then terraform=true; fi

if [ "$code" = false ] && [ "$images" = false ] && [ "$terraform" = false ]; then
  echo 'changes: documentation-only change — the heavy jobs will no-op' >&2
fi

emit "$code" "$images" "$terraform"
