#!/usr/bin/env bash
# Self-test for infra/helm/check-values.sh (#297): each rule must FAIL on a fixture built to break it,
# and today's real values must pass. Runs in CI's `helm` job.
#
#   bash infra/helm/check-values.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/check-values.sh"
REAL="$HERE/values"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail=0

# A clean copy of the real values, then one mutation; the result must match the expectation.
case_() {
  local name="$1" want="$2" mutate="$3" dir="$WORK/$1"
  rm -rf "$dir" && mkdir -p "$dir" && cp -R "$REAL"/. "$dir"/
  (cd "$dir" && eval "$mutate")
  local out got
  out="$(bash "$SUT" "$dir" 2>&1)" && got=pass || got=fail
  if [ "$got" = "$want" ]; then
    printf 'ok   %-58s %s\n' "$name" "$got"
  else
    printf 'FAIL %-58s want %s got %s\n' "$name" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/     /'
    fail=1
  fi
}

# A production values file that is otherwise right: https SITE_URL on its host, indexing on.
PROD_OK="sed -e 's/shop.staging.example.com/shop.example.com/g' storefront/values-staging.yaml > storefront/values-prod.yaml &&
  printf '  ROBOTS_ALLOW_INDEXING: %s\n' \"'1'\" >> storefront/values-prod.yaml"

case_ 'real values pass'                                       pass ':'
case_ 'a correct values-prod.yaml passes'                      pass "$PROD_OK"
case_ 'prod: SITE_URL missing'                                 fail "$PROD_OK && sed -i '/SITE_URL:/d' storefront/values-prod.yaml"
case_ 'prod: SITE_URL on another host'                         fail "$PROD_OK && sed -i 's#SITE_URL: .*#SITE_URL: '\"'\"'https://shop.staging.example.com'\"'\"'#' storefront/values-prod.yaml"
case_ 'prod: SITE_URL over http'                               fail "$PROD_OK && sed -i 's#https://shop.example.com#http://shop.example.com#' storefront/values-prod.yaml"
case_ 'prod: ROBOTS_ALLOW_INDEXING missing'                    fail "$PROD_OK && sed -i '/ROBOTS_ALLOW_INDEXING:/d' storefront/values-prod.yaml"
case_ 'staging: ROBOTS_ALLOW_INDEXING set'                     fail "printf '  ROBOTS_ALLOW_INDEXING: %s\n' \"'1'\" >> storefront/values-staging.yaml"
case_ 'a values-production.yaml'                               fail "$PROD_OK && mv storefront/values-prod.yaml storefront/values-production.yaml"
case_ 'a values-prd.yaml'                                      fail "$PROD_OK && mv storefront/values-prod.yaml storefront/values-prd.yaml"
case_ 'staging: a seeded dev publishable key'                  fail "sed -i 's#^env:#env:\n  STORE_PUBLISHABLE_KEY: '\"'\"'pk_brand-a_dev_00000000000000000000'\"'\"'#' storefront/values-staging.yaml"
case_ 'prod: a seeded dev publishable key'                     fail "$PROD_OK && sed -i 's#^env:#env:\n  STORE_PUBLISHABLE_KEY: '\"'\"'pk_brand-a_dev_00000000000000000000'\"'\"'#' storefront/values-prod.yaml"
# The rule is a text match over every non-dev values file, so an appended line is enough to trip it.
case_ 'another env (values-qa.yaml): a seeded dev key'         fail "cp storefront/values-staging.yaml storefront/values-qa.yaml && printf '  STORE_PUBLISHABLE_KEY: pk_brand-a_dev_00000000000000000000\n' >> storefront/values-qa.yaml"
case_ 'staging: a dev key with an upper-case store code'       fail "printf '  STORE_PUBLISHABLE_KEY: pk_Brand-A_dev_00000000000000000000\n' >> storefront/values-staging.yaml"
case_ 'staging: a dev key in another app'                      fail "printf '  STORE_PUBLISHABLE_KEY: pk_brand-b_dev_00000000000000000000\n' >> admin/values-staging.yaml"
case_ 'staging: a dev key named only in a comment passes'      pass "printf '# was pk_brand-a_dev_00000000000000000000\n' >> storefront/values-staging.yaml"
case_ 'dev: the seeded dev key is fine'                        pass "grep -q 'pk_brand-a_dev_' storefront/values-dev.yaml"

if [ "$fail" -ne 0 ]; then
  echo '== check-values.sh self-test FAILED'
  exit 1
fi
echo '== check-values.sh self-test passed'
