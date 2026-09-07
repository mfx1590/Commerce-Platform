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

NONE='code=false images=false terraform=false e2e=false'
CODE_IMG='code=true images=true terraform=false e2e=true'
IMG_E2E='code=false images=true terraform=false e2e=true'
# Source changes no longer rebuild the images on a PR — a push to main does that.
CODE_ONLY='code=true images=false terraform=false e2e=true'

check 'docs only'           $'docs/memory/Memory-5-infra.md\ndocs/ownership.md'  "$NONE"
check 'a single README'     'README.md'                                         "$NONE"
check 'infra README only'   'infra/README.md'                                   "$NONE"
# A source change alone must NOT rebuild the six images on a PR — that is the point of the change.
check 'app source'          'apps/core/src/http/store-routes.ts'                "$CODE_ONLY"
check 'a package'           'packages/db/migrations/0010_x.sql'                 "$CODE_ONLY"
check 'app source + a doc'  $'apps/core/src/x.ts\nREADME.md'                    "$CODE_ONLY"
# What an image is built FROM still does.
check 'a Dockerfile'        'apps/core/Dockerfile'                              "$CODE_IMG"
check 'a nested Dockerfile' 'apps/storefront-starter/Dockerfile'                "$CODE_IMG"
check 'the lockfile'        'pnpm-lock.yaml'                                    "$CODE_IMG"
check 'root package.json'   'package.json'                                      "$CODE_IMG"
check 'the .dockerignore'   '.dockerignore'                                     "$CODE_IMG"
check 'mixed docs + app'    $'docs/x.md\napps/admin/src/page.tsx'               "$CODE_ONLY"
check 'compose build file'  'infra/docker/docker-compose.build.yml'             "$IMG_E2E"
check 'the bake overlay'    'infra/docker/docker-bake.hcl'                      "$IMG_E2E"
check 'terraform'           'infra/terraform/modules/network/main.tf'           'code=false images=false terraform=true e2e=false'
check 'the bootstrap job'   'infra/kubernetes/bootstrap-db/job.yaml'            'code=false images=false terraform=true e2e=false'
check 'a root script'       'scripts/dev.mjs'                                   'code=true images=false terraform=false e2e=true'
check 'the workflow itself' '.github/workflows/ci.yml'                          'code=true images=true terraform=true e2e=true'
# infra/ci/*.sh are the pipeline itself: a change to them must be exercised by the jobs that use them.
check 'the classifier'      'infra/ci/changes.sh'                               "$IMG_E2E"
check 'the manifest guard'  'infra/ci/check-image-manifests.sh'                 "$IMG_E2E"
check 'the e2e runner'      'infra/ci/run-e2e.sh'                               "$IMG_E2E"
# The realms and the authorization model are what the live auth suites run against.
check 'a keycloak realm'    'infra/keycloak/staff-realm.json'                   'code=false images=false terraform=false e2e=true'
check 'the openfga model'   'infra/openfga/model.fga'                           'code=false images=false terraform=false e2e=true'

# CHANGES_ALL wins over everything: a push to main runs the lot.
got="$(CHANGES_ALL=1 CHANGED_FILES='docs/x.md' bash "$SUT" 2>/dev/null | tr '\n' ' ')"
got="${got% }"
if [ "$got" = 'code=true images=true terraform=true e2e=true' ]; then
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
