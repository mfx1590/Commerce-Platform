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

NONE='code=false images=false terraform=false'
CODE_IMG='code=true images=true terraform=false'

check 'docs only'           $'docs/memory/Memory-5-infra.md\ndocs/ownership.md'  "$NONE"
check 'a single README'     'README.md'                                         "$NONE"
check 'infra README only'   'infra/README.md'                                   "$NONE"
check 'a keycloak realm'    'infra/keycloak/staff-realm.json'                   "$NONE"
check 'app source'          'apps/core/src/http/store-routes.ts'                "$CODE_IMG"
check 'a package'           'packages/db/migrations/0010_x.sql'                 "$CODE_IMG"
check 'a Dockerfile'        'apps/core/Dockerfile'                              "$CODE_IMG"
check 'the lockfile'        'pnpm-lock.yaml'                                    "$CODE_IMG"
check 'the .dockerignore'   '.dockerignore'                                     "$CODE_IMG"
check 'mixed docs + app'    $'docs/x.md\napps/admin/src/page.tsx'               "$CODE_IMG"
check 'compose build file'  'infra/docker/docker-compose.build.yml'             'code=false images=true terraform=false'
check 'the bake overlay'    'infra/docker/docker-bake.hcl'                      'code=false images=true terraform=false'
check 'terraform'           'infra/terraform/modules/network/main.tf'           'code=false images=false terraform=true'
check 'the bootstrap job'   'infra/kubernetes/bootstrap-db/job.yaml'            'code=false images=false terraform=true'
check 'a root script'       'scripts/dev.mjs'                                   'code=true images=false terraform=false'
check 'the workflow itself' '.github/workflows/ci.yml'                          'code=true images=true terraform=true'

# CHANGES_ALL wins over everything: a push to main runs the lot.
got="$(CHANGES_ALL=1 CHANGED_FILES='docs/x.md' bash "$SUT" 2>/dev/null | tr '\n' ' ')"
got="${got% }"
if [ "$got" = 'code=true images=true terraform=true' ]; then
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
