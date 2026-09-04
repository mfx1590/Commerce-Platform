#!/usr/bin/env bash
# Fails if the current branch changed files outside its allowed paths (docs/ownership.md).
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
BR="${GITHUB_HEAD_REF:-$(git rev-parse --abbrev-ref HEAD)}"
PREFIX="${BR%%/*}"
case "$PREFIX" in main|integration) echo "ownership: $BR may write anywhere"; exit 0;; esac
ROW="$(grep -E "^\| \`$PREFIX/\` " "$ROOT/docs/ownership.md" || true)"
[ -n "$ROW" ] || { echo "ownership: no row for prefix '$PREFIX' in docs/ownership.md"; exit 1; }
PATTERNS="$(echo "$ROW" | awk -F'|' '{print $4}' | grep -o '`[^`]*`' | tr -d '`' | sed 's/ (.*//')"
PATTERNS="$PATTERNS
docs/memory/Memory-*-$PREFIX.md
.claude/CLAUDE.local.md
CHANGELOG.md"
BASE="$(git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD)"
FAIL=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  ok=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    p="${p//\*\*/*}"
    case "$f" in $p) ok=1; break;; esac
    # allow directory prefix match for patterns ending in /*
    dir="${p%%\**}"; [ -n "$dir" ] && [[ "$f" == "$dir"* ]] && { ok=1; break; }
  done <<< "$PATTERNS"
  [ $ok -eq 1 ] || { echo "ownership violation: $f (branch $BR)"; FAIL=1; }
done < <(git diff --name-only "$BASE"...HEAD)
[ $FAIL -eq 0 ] && echo "ownership: OK"
exit $FAIL
