#!/usr/bin/env bash
# Static rules over the Helm values files — the failures kubeconform cannot see because every one of
# them renders valid Kubernetes:
#
#   bash infra/helm/check-values.sh [values-dir]     # default infra/helm/values; exit 1 on any failure
#
# Called by infra/helm/check.sh; infra/helm/check-values.test.sh runs it against fixture directories so
# each rule is shown to fail, not just to pass on today's files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALUES="${1:-$ROOT/infra/helm/values}"
fail=0
shopt -s nullglob

# Storefront values that fail silently: nothing in the pod errors, only a customer or a crawler
# notices (#257). kubeconform cannot see either, so they are asserted here.
#   SITE_URL               must be https://<ingress.host>: it is the OIDC redirect URI, and without
#                          it the pod falls back to http://localhost:3100 and sign-in breaks.
#   ROBOTS_ALLOW_INDEXING  '1' in values-prod.yaml and nowhere else. robots.ts fails closed when it
#                          is unset; staging with it set outranks the real site for its own name.
value_of() { sed -n -E "s/^[[:space:]]+$1:[[:space:]]*'?([^' #]*)'?.*/\1/p" "$2" | head -n 1; }
for values in "$VALUES"/storefront/values-*.yaml; do
  env="$(basename "$values" .yaml)"
  env="${env#values-}"
  host="$(value_of host "$values")"
  site="$(value_of SITE_URL "$values")"
  robots="$(value_of ROBOTS_ALLOW_INDEXING "$values")"
  echo "== storefront/$env: SITE_URL=${site:-<unset>} ROBOTS_ALLOW_INDEXING=${robots:-<unset>}"
  if [ "$site" != "https://$host" ]; then
    echo "FAIL storefront/$env: SITE_URL must be 'https://$host' (the ingress host), got '${site:-<unset>}'"
    fail=1
  fi
  if [ "$env" = prod ] && [ "$robots" != 1 ]; then
    echo "FAIL storefront/prod: ROBOTS_ALLOW_INDEXING must be '1', or production is unindexed"
    fail=1
  elif [ "$env" != prod ] && [ -n "$robots" ]; then
    echo "FAIL storefront/$env: ROBOTS_ALLOW_INDEXING is production-only; remove it"
    fail=1
  fi
done

# Only `values-prod.yaml` is production. A `values-production.yaml` or `values-prd.yaml` would render
# as a separate environment and slip past the production-only rules above, so it is refused (#297).
for values in "$VALUES"/*/values-*.yaml; do
  case "$(basename "$values")" in
    values-production.yaml | values-prd.yaml | values-prod-*.yaml | values-production-*.yaml)
      echo "FAIL $values: production is values-prod.yaml, exactly — rename it"
      fail=1
      ;;
  esac
done

# The seeded DEV publishable keys (pk_<store>_dev_…, packages/db seed) answer on every laptop's
# database. Every deployed environment except dev must use its own store's key, from the secret store
# (#297, brand A's LAUNCH.md): a dev key there means the environment serves whatever store the dev seed
# says it is. Applied to EVERY values file whose environment is not `dev` — not only files named
# values-staging/values-prod, so a values-qa.yaml or values-preview.yaml is covered the day it appears —
# and case-insensitively, so an upper-case store code is caught too (#344 review). Comments are ignored:
# a file may say in prose which key it no longer carries.
for values in "$VALUES"/*/values-*.yaml; do
  env="$(basename "$values" .yaml)"
  env="${env#values-}"
  [ "$env" = dev ] && continue
  if grep -Ev '^[[:space:]]*#' "$values" | grep -Eiq 'pk_[a-z0-9_-]+_dev_'; then
    echo "FAIL $values: carries a seeded dev publishable key — read STORE_PUBLISHABLE_KEY from <env>/stores/<store>/storefront"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "== values checks FAILED ($VALUES)"
  exit 1
fi
echo "== values checks passed ($VALUES)"
