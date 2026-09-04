#!/usr/bin/env bash
# Usage: ./scripts/new-window.sh <window-number> <phase>
# Creates ../wt-<key> on branch <key>/phase<N>, writes .claude/CLAUDE.local.md, prints the start message to paste.
set -euo pipefail
N="${1:?window number}"; PH="${2:?phase}"
ROOT="$(git rev-parse --show-toplevel)"
ROW="$(grep -E "^\| $N \| [a-z]+ \| .*Memory-$N-" "$ROOT/docs/memory/Memory-main.md" | head -1)"
[ -n "$ROW" ] || { echo "window $N not in Memory-main window index"; exit 1; }
KEY="$(echo "$ROW" | awk -F'|' '{gsub(/ /,"",$3); print $3}')"
MEM="docs/memory/Memory-$N-$KEY.md"
OWNED="$(grep -E "^\| \`$KEY/\` " "$ROOT/docs/ownership.md" | awk -F'|' '{print $4}' | sed 's/^ *//;s/ *$//')"
BR="$KEY/phase$PH"; WT="$ROOT/../wt-$KEY"
git -C "$ROOT" fetch -q origin main || true
if [ ! -d "$WT" ]; then git -C "$ROOT" worktree add "$WT" -b "$BR" main; else echo "worktree exists: $WT"; fi
mkdir -p "$WT/.claude"
cat > "$WT/.claude/CLAUDE.local.md" <<EOF
I am window $N ($KEY). I write only: $OWNED. Contracts are frozen at the tag named in docs/memory/Memory-main.md. My memory file is $MEM. Branch: $BR.
EOF
echo "Worktree: $WT  Branch: $BR"
echo "Now:  cd $WT && claude"
printf "Then paste: docs/start-messages/%02d-%s.md\n" "$N" "$KEY"
