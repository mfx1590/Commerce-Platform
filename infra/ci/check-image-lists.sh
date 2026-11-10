#!/usr/bin/env bash
# Every app image is listed in four places, and they must agree (#439):
#
#   infra/docker/docker-compose.build.yml       the services: WHICH images exist and how they build
#   infra/docker/docker-bake.hcl                one target each (the CI cache wiring; bake merges by name)
#   infra/terraform/modules/environment/main.tf var.apps: one ECR repository each ("Must match the images…")
#   infra/docker/smoke-images.sh                APPS: one smoke check each
#
# Brand B and C's images existed for weeks with no ECR repository and no smoke check, because nothing compared these
# lists. This prints each list and fails on any difference.
#
# Deliberately NOT compared: the Helm values directories (infra/helm/values/<app>) and deploy-staging's APPS. Those
# list what is DEPLOYED, a subset that grows only when an environment can run the image (#342), not what is built.
#
#   bash infra/ci/check-image-lists.sh [repo-root]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# compose: the 2-space keys under the top-level `services:`
compose="$(awk '/^services:/{s=1; next} s && /^[^[:space:]#]/{s=0} s && /^  [a-z0-9-]+:[[:space:]]*$/{sub(/:.*/, ""); sub(/^  /, ""); print}' \
  "$ROOT/infra/docker/docker-compose.build.yml" | sort)"
bake="$(sed -n -E 's/^target "([a-z0-9-]+)".*/\1/p' "$ROOT/infra/docker/docker-bake.hcl" | sort)"
terraform="$(awk '/^variable "apps"/{v=1} v && /default *= *\[/{d=1; next} d && /\]/{exit} d {gsub(/[",[:space:]]/, ""); if ($0 != "") print}' \
  "$ROOT/infra/terraform/modules/environment/main.tf" | sort)"
smoke="$(awk '/^APPS=\(/{a=1; next} a && /^\)/{exit} a {sub(/#.*/, ""); gsub(/[" ]/, ""); sub(/:.*/, ""); if ($0 != "") print}' \
  "$ROOT/infra/docker/smoke-images.sh" | sort)"

fail=0
for name in bake terraform smoke; do
  list="${!name}"
  if [ "$list" != "$compose" ]; then
    echo "FAIL $name differs from the compose services:"
    # `|| true`: diff exits 1 on a difference, and under pipefail that would end the script before the other
    # lists are reported.
    { diff <(printf '%s\n' "$compose") <(printf '%s\n' "$list") || true; } |
      sed -n 's/^</  missing from '"$name"':/p; s/^>/  extra in '"$name"':/p'
    fail=1
  fi
done
echo "== $(printf '%s\n' "$compose" | grep -c .) images: $(printf '%s ' $compose)"
if [ "$fail" -ne 0 ]; then
  echo '== image lists disagree: add or remove the image in all four files'
  exit 1
fi
echo '== compose, bake, terraform var.apps and smoke-images.sh list the same images'
