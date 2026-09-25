#!/usr/bin/env bash
# Self-test for infra/ci/changes.sh. Runs in the `changes` job before the classifier is trusted,
# the same way scripts/check-ownership.test.sh guards the ownership check.
#
#   bash infra/ci/changes.test.sh
#
# A wrong answer here is expensive in both directions: a false negative silently skips the tests
# that would have caught a bug, and a false positive gives back the 13-minute image build this
# whole task exists to avoid.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/changes.sh"

fail=0

check() {
  local name="$1" files="$2" want="$3" got
  got="$(CHANGED_FILES="$files" bash "$SUT" 2>/dev/null | tr '\n' ' ')"
  got="${got% }"
  if [ "$got" = "$want" ]; then
    printf 'ok   %-34s %s\n' "$name" "$got"
  else
    printf 'FAIL %-34s want [%s] got [%s]\n' "$name" "$want" "$got"
    fail=1
  fi
}

NONE='code=false images=false terraform=false e2e=false helm=false observ=false perf=false'
CODE_IMG='code=true images=true terraform=false e2e=true helm=false observ=false perf=false'
# Root files every package resolves through, so the storefront's bundle can change with them.
ROOT_IMG='code=true images=true terraform=false e2e=true helm=false observ=false perf=true'
# infra/docker/** rebuilds images and is what the e2e stack boots from, but says nothing about charts.
DOCKER_CHG='code=false images=true terraform=false e2e=true helm=false observ=false perf=false'
# infra/ci/** is the pipeline itself, so every job that uses those scripts has to re-run.
CI_SCRIPT_CHG='code=false images=true terraform=false e2e=true helm=true observ=true perf=false'
# Source changes no longer rebuild the images on a PR — a push to main does that.
CODE_ONLY='code=true images=false terraform=false e2e=true helm=false observ=false perf=false'

check 'docs only'           $'docs/memory/Memory-5-infra.md\ndocs/ownership.md'  "$NONE"
check 'a single README'     'README.md'                                         "$NONE"
check 'infra README only'   'infra/README.md'                                   "$NONE"
# A source change alone must NOT rebuild the six images on a PR — that is the point of the change.
check 'app source'          'apps/core/src/http/store-routes.ts'                "$CODE_ONLY"
check 'a package'           'packages/db/migrations/0010_x.sql'                 "$CODE_ONLY"
check 'app source + a doc'  $'apps/core/src/x.ts\nREADME.md'                    "$CODE_ONLY"
# What an image is built FROM still does.
check 'a Dockerfile'        'apps/core/Dockerfile'                              "$CODE_IMG"
check 'a nested Dockerfile' 'apps/storefront-starter/Dockerfile'                'code=true images=true terraform=false e2e=true helm=false observ=false perf=true'
check 'the lockfile'        'pnpm-lock.yaml'                                    "$ROOT_IMG"
check 'root package.json'   'package.json'                                      "$ROOT_IMG"
check 'the .dockerignore'   '.dockerignore'                                     "$ROOT_IMG"
check 'mixed docs + app'    $'docs/x.md\napps/admin/src/page.tsx'               "$CODE_ONLY"
check 'compose build file'  'infra/docker/docker-compose.build.yml'             "$DOCKER_CHG"
check 'the bake overlay'    'infra/docker/docker-bake.hcl'                      "$DOCKER_CHG"
check 'terraform'           'infra/terraform/modules/network/main.tf'           'code=false images=false terraform=true e2e=false helm=false observ=false perf=false'
check 'the bootstrap job'   'infra/kubernetes/bootstrap-db/job.yaml'            'code=false images=false terraform=true e2e=false helm=false observ=false perf=false'
check 'a root script'       'scripts/dev.mjs'                                   'code=true images=false terraform=false e2e=true helm=false observ=false perf=false'
check 'the workflow itself' '.github/workflows/ci.yml'                          'code=true images=true terraform=true e2e=true helm=true observ=true perf=true'
# Any other workflow is still code: prettier formats them, so format:check has to run.
check 'another workflow'    '.github/workflows/deploy-staging.yml'              'code=true images=false terraform=false e2e=true helm=false observ=false perf=false'
# infra/ci/*.sh are the pipeline itself: a change to them must be exercised by the jobs that use them.
check 'the classifier'      'infra/ci/changes.sh'                               "$CI_SCRIPT_CHG"
check 'the manifest guard'  'infra/ci/check-image-manifests.sh'                 "$CI_SCRIPT_CHG"
check 'the e2e runner'      'infra/ci/run-e2e.sh'                               "$CI_SCRIPT_CHG"
# The realms and the authorization model are what the live auth suites run against.
check 'a keycloak realm'    'infra/keycloak/staff-realm.json'                   'code=false images=false terraform=false e2e=true helm=false observ=false perf=false'
check 'the openfga model'   'infra/openfga/model.fga'                           'code=false images=false terraform=false e2e=true helm=false observ=false perf=false'
# The charts and the ArgoCD manifests are their own group: nothing else needs re-checking for them.
check 'the chart'           'infra/helm/platform-app/values.yaml'                'code=false images=false terraform=false e2e=false helm=true observ=false perf=false'
check 'a chart template'    'infra/helm/platform-app/templates/deployment.yaml'  'code=false images=false terraform=false e2e=false helm=true observ=false perf=false'
check 'an app values file'  'infra/helm/values/core/values-staging.yaml'         'code=false images=false terraform=false e2e=false helm=true observ=false perf=false'
check 'an argocd app'       'infra/argocd/applications/core-dev.yaml'            'code=false images=false terraform=false e2e=false helm=true observ=false perf=false'
# The observability stack is its own group; the compose file is shared with the dev stack.
check 'a collector config'  'infra/observability/otel-collector.yaml'            'code=false images=false terraform=false e2e=false helm=false observ=true perf=false'
check 'a dashboard'         'infra/observability/grafana/dashboards/x.json'      'code=false images=false terraform=false e2e=false helm=false observ=true perf=false'
# The storefront and what it builds from fire the performance budget; nothing else does.
STOREFRONT='code=true images=false terraform=false e2e=true helm=false observ=false perf=true'
check 'storefront source'   'apps/storefront-starter/src/app/page.tsx'          "$STOREFRONT"
check 'the ui package'      'packages/ui/src/button.tsx'                         "$STOREFRONT"
check 'the contracts'       'packages/contracts/openapi/store.yaml'              "$STOREFRONT"
check 'the cms'             'cms/src/index.ts'                                   "$STOREFRONT"
check 'the compose file'    'infra/docker/docker-compose.yml'                    'code=false images=true terraform=false e2e=true helm=false observ=true perf=false'

# CHANGES_ALL wins over everything: a push to main runs the lot.
got="$(CHANGES_ALL=1 CHANGED_FILES='docs/x.md' bash "$SUT" 2>/dev/null | tr '\n' ' ')"
got="${got% }"
if [ "$got" = 'code=true images=true terraform=true e2e=true helm=true observ=true perf=true' ]; then
  printf 'ok   %-34s %s\n' 'CHANGES_ALL overrides' "$got"
else
  printf 'FAIL %-34s got [%s]\n' 'CHANGES_ALL overrides' "$got"
  fail=1
fi

# No base sha and no CHANGED_FILES must fail loudly rather than classify everything as "nothing".
if (unset CHANGED_FILES; bash "$SUT" >/dev/null 2>&1); then
  printf 'FAIL %-34s exited 0 with no input\n' 'refuses to guess'
  fail=1
else
  printf 'ok   %-34s exits non-zero with no input\n' 'refuses to guess'
fi

if [ "$fail" -ne 0 ]; then
  echo '== changes.sh self-test FAILED'
  exit 1
fi
echo '== changes.sh self-test passed'
