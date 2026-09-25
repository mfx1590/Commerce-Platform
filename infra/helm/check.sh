#!/usr/bin/env bash
# Static checks for the Helm charts. No cluster, no credentials:
#   helm lint       chart structure and values
#   helm template   every app × every environment actually renders
#   kubeconform     the rendered manifests are valid Kubernetes objects
#
#   bash infra/helm/check.sh            # all of it
#   bash infra/helm/check.sh --render   # also print the manifests, for reading a diff by hand
#
# Uses local binaries when they exist, otherwise the official images through Docker — the same
# arrangement as infra/terraform/check.sh, so a laptop with nothing installed can still run it.
#
# kubeconform is given the datree CRD catalogue as a second schema location. Without it, the
# ExternalSecret and ArgoCD Application objects would be "missing schema" and silently skipped,
# which would make this check pass while saying nothing about the two object types most likely to be
# wrong. -strict rejects unknown fields; a typo in a manifest is exactly what this is for.
set -euo pipefail

HELM_VERSION="${HELM_VERSION:-3.16.3}"
KUBECONFORM_VERSION="${KUBECONFORM_VERSION:-v0.6.7}"
KUBE_VERSION="${KUBE_VERSION:-1.31.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDER=0
[ "${1:-}" = "--render" ] && RENDER=1

CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

cd "$ROOT"

if command -v helm >/dev/null 2>&1; then
  helm_cmd() { helm "$@"; }
  echo "== $(helm version --short 2>/dev/null || echo helm)"
else
  echo "== no local helm, using alpine/helm:${HELM_VERSION} via Docker"
  helm_cmd() {
    MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT:/work" -w /work \
      "alpine/helm:${HELM_VERSION}" "$@"
  }
fi

if command -v kubeconform >/dev/null 2>&1; then
  kubeconform_cmd() { kubeconform "$@"; }
else
  kubeconform_cmd() {
    MSYS_NO_PATHCONV=1 docker run --rm -i \
      "ghcr.io/yannh/kubeconform:${KUBECONFORM_VERSION}" "$@"
  }
fi

CHART=infra/helm/platform-app

echo "== helm lint $CHART"
# Lint with a real values file: the chart fails fast on a missing image tag or ingress host, which
# is the point, so linting with defaults alone would only prove that the failure works.
helm_cmd lint "$CHART" --values infra/helm/values/core/values-dev.yaml

fail=0
count=0
for values in infra/helm/values/*/values-*.yaml; do
  app="$(basename "$(dirname "$values")")"
  env="$(basename "$values" .yaml)"
  env="${env#values-}"
  count=$((count + 1))

  echo "== helm template $app ($env)"
  if ! rendered="$(helm_cmd template "$app" "$CHART" --values "$values" --namespace "commerce-$env" 2>&1)"; then
    echo "FAIL $app/$env did not render:"
    printf '%s\n' "$rendered" | sed 's/^/    /'
    fail=1
    continue
  fi

  [ "$RENDER" -eq 1 ] && printf '%s\n' "$rendered"

  if ! printf '%s\n' "$rendered" |
    kubeconform_cmd -strict -summary \
      -kubernetes-version "$KUBE_VERSION" \
      -schema-location default \
      -schema-location "$CRD_SCHEMAS" \
      -; then
    echo "FAIL $app/$env produced manifests kubeconform rejected"
    fail=1
  fi
done

# Storefront values that fail silently: nothing in the pod errors, only a customer or a crawler
# notices (#257). kubeconform cannot see either, so they are asserted here.
#   SITE_URL               must be https://<ingress.host>: it is the OIDC redirect URI, and without
#                          it the pod falls back to http://localhost:3100 and sign-in breaks.
#   ROBOTS_ALLOW_INDEXING  '1' in values-prod.yaml and nowhere else. robots.ts fails closed when it
#                          is unset; staging with it set outranks the real site for its own name.
value_of() { sed -n -E "s/^[[:space:]]+$1:[[:space:]]*'?([^' #]*)'?.*/\1/p" "$2" | head -n 1; }
for values in infra/helm/values/storefront/values-*.yaml; do
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

# The ArgoCD manifests are plain YAML, not a chart, so they are validated directly.
echo "== kubeconform infra/argocd"
for manifest in $(find infra/argocd -name '*.yaml' | sort); do
  if ! kubeconform_cmd -strict -summary \
    -kubernetes-version "$KUBE_VERSION" \
    -schema-location default \
    -schema-location "$CRD_SCHEMAS" \
    - < "$manifest"; then
    echo "FAIL $manifest"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "== helm checks FAILED"
  exit 1
fi
echo "== helm checks passed ($count app/environment combinations, plus infra/argocd)"
