#!/usr/bin/env bash
# Static checks for the Terraform tree. No AWS account, no credentials, no state:
#   terraform fmt -check -recursive     formatting
#   terraform init -backend=false       providers and module wiring only
#   terraform validate                  types, references, required arguments
#
#   bash infra/terraform/check.sh          # check formatting, fail if unformatted
#   bash infra/terraform/check.sh --fix    # rewrite files with `terraform fmt` instead
#
# Uses a local `terraform` when there is one, otherwise the official image through Docker, so the
# same command works on a laptop without Terraform installed and on a CI runner that has it.
#
# TF_DATA_DIR keeps the downloaded providers OUT of the repository. A `.terraform` directory holds
# ~700 MB of provider binaries per environment, and `pnpm format:check` walks the whole tree and
# dies on them with "Invalid string length". The cache lives in $TF_CACHE_DIR instead, so it still
# survives between runs. If you run `terraform init` by hand (the runbook does), you will get a
# local `.terraform` — delete it before running `pnpm format:check`.
set -euo pipefail

TERRAFORM_VERSION="${TERRAFORM_VERSION:-1.13}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_CACHE_DIR="${TF_CACHE_DIR:-$HOME/.cache/commerce-platform-terraform}"
ENVS=(dev staging)
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

mkdir -p "$TF_CACHE_DIR"

if command -v terraform >/dev/null 2>&1; then
  echo "== terraform $(terraform version | head -1)"
  tf() {
    local dir="$1" data="$2"
    shift 2
    mkdir -p "$TF_CACHE_DIR/$data"
    (cd "$ROOT/$dir" && TF_DATA_DIR="$TF_CACHE_DIR/$data" TF_IN_AUTOMATION=1 terraform "$@")
  }
else
  echo "== no local terraform, using hashicorp/terraform:${TERRAFORM_VERSION} via Docker"
  # MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the container paths.
  tf() {
    local dir="$1" data="$2"
    shift 2
    mkdir -p "$TF_CACHE_DIR/$data"
    MSYS_NO_PATHCONV=1 docker run --rm \
      -v "$ROOT:/work" \
      -v "$TF_CACHE_DIR/$data:/tf-data" \
      -w "/work/$dir" \
      -e TF_DATA_DIR=/tf-data \
      -e TF_IN_AUTOMATION=1 \
      "hashicorp/terraform:${TERRAFORM_VERSION}" "$@"
  }
fi

if [ "$FIX" -eq 1 ]; then
  echo "== terraform fmt -recursive"
  tf infra/terraform fmt fmt -recursive
else
  echo "== terraform fmt -check -recursive"
  tf infra/terraform fmt fmt -check -recursive
fi

for env in "${ENVS[@]}"; do
  echo "== envs/$env: init -backend=false"
  tf "infra/terraform/envs/$env" "$env" init -backend=false -input=false -no-color >/dev/null
  echo "== envs/$env: validate"
  tf "infra/terraform/envs/$env" "$env" validate -no-color
done

echo "== terraform checks passed"
