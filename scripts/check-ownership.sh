#!/usr/bin/env bash
# Ownership check (docs/ownership.md is the source of truth).
# Fails (exit 1) if the current branch changed files outside the paths allowed for its prefix.
#
# Usage:
#   scripts/check-ownership.sh                 # compares origin/main...HEAD (main...HEAD only without the remote ref)
#   OWNERSHIP_BRANCH=core/phase1 OWNERSHIP_FILES=$'apps/core/x.ts\npackages/db/y.sql' scripts/check-ownership.sh
#                                              # test mode: no git needed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAP="$ROOT/docs/ownership.md"

BR="${OWNERSHIP_BRANCH:-${GITHUB_HEAD_REF:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}}"
PREFIX="${BR%%/*}"

case "$PREFIX" in
  main|integration) echo "ownership: branch '$BR' may write anywhere"; exit 0 ;;
esac

ROW="$(grep -E "^\| \`$PREFIX/\` " "$MAP" || true)"
if [ -z "$ROW" ]; then
  echo "ownership: no row for prefix '$PREFIX' in docs/ownership.md (branch '$BR')"; exit 1
fi

# Column 4 of the markdown row holds backticked globs; strip trailing "(notes)" and <placeholders> -> *
PATTERNS="$(printf '%s\n' "$ROW" | awk -F'|' '{print $4}' | grep -o '`[^`]*`' | tr -d '`' | sed -E 's/ \(.*$//; s/<[^>]*>/*/g')"
PATTERNS="$PATTERNS
docs/memory/Memory-*-$PREFIX.md
.claude/CLAUDE.local.md
pnpm-lock.yaml"  # lockfile: every window adds deps; conflicts are re-resolved with pnpm install at merge

# glob -> anchored ERE: ** = anything (incl. /), * = anything but /, ? = one char; escape the rest.
glob_to_re() {
  # 1) replace glob operators with tokens, 2) escape regex metacharacters, 3) expand tokens.
  printf '%s' "$1" | sed -E \
    -e 's#\*\*/#@@DSS@@#g' \
    -e 's#/\*\*$#@@SDS@@#' \
    -e 's#\*\*#@@DS@@#g' \
    -e 's#\*#@@S@@#g' \
    -e 's#\?#@@Q@@#g' \
    -e 's/[][^$.+{}()|\\]/\\&/g' \
    -e 's#@@DSS@@#(.*/)?#g' \
    -e 's#@@SDS@@#(/.*)?#g' \
    -e 's#@@DS@@#.*#g' \
    -e 's#@@S@@#[^/]*#g' \
    -e 's#@@Q@@#[^/]#g'
}

RES=()
while IFS= read -r p; do
  [ -z "$p" ] && continue
  RES+=("^$(glob_to_re "$p")$")
done <<< "$PATTERNS"

if [ -n "${OWNERSHIP_FILES+x}" ]; then
  FILES="$OWNERSHIP_FILES"
else
  # Prefer origin/main: the local `main` branch belongs to the repo-root checkout and goes stale whenever that
  # checkout has not pulled, so a window that merged a newer origin/main saw main's own commits as its violations
  # (window 16, 2026-10-30). The local main is only the fallback for a clone without the remote ref.
  BASE="$(git -C "$ROOT" merge-base origin/main HEAD 2>/dev/null || git -C "$ROOT" merge-base main HEAD)"
  FILES="$(git -C "$ROOT" diff --name-only "$BASE...HEAD")"
fi

FAIL=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  ok=0
  for re in "${RES[@]}"; do
    if printf '%s' "$f" | grep -Eq "$re"; then ok=1; break; fi
  done
  if [ $ok -eq 0 ]; then echo "ownership violation: $f (branch $BR, prefix $PREFIX)"; FAIL=1; fi
done <<< "$FILES"

if [ $FAIL -eq 0 ]; then echo "ownership: OK ($BR)"; fi
exit $FAIL
