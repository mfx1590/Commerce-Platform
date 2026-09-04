#!/usr/bin/env bash
# Manager view: one line per build window — tasks done/left, commits ahead of main, open PRs, dirty worktree.
# Usage: bash scripts/status.sh      (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
git fetch -q origin 2>/dev/null || true

printf '%-12s %-18s %-9s %-7s %-6s %-6s %s\n' WINDOW BRANCH TASKS AHEAD PRs DIRTY "STATE"
for wt in "$ROOT"/../wt-*; do
  [ -d "$wt" ] || continue
  key="${wt##*/wt-}"
  br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  mem="$(ls "$wt"/docs/memory/Memory-*-"$key".md 2>/dev/null | head -1)"
  done_n=0; next_n=0
  if [ -n "$mem" ]; then
    done_n="$(awk '/^## Done/{f=1;next} /^## /{f=0} f && /^- \[x\]|^- [^(]/{c++} END{print c+0}' "$mem")"
    next_n="$(awk '/^## Next/{f=1;next} /^## /{f=0} f && /^- \[ \]/{c++} END{print c+0}' "$mem")"
    inprog="$(awk '/^## In progress/{f=1;next} /^## /{f=0} f && /^- /{print; exit}' "$mem" | sed 's/^- //' | cut -c1-40)"
  fi
  ahead="$(git rev-list --count "main..$br" 2>/dev/null || echo 0)"
  prs="$(gh pr list --head "$br" --state open --json number --jq 'length' 2>/dev/null || echo '?')"
  merged="$(gh pr list --head "$br" --state merged --json number --jq 'length' 2>/dev/null || echo '?')"
  dirty="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$next_n" = "0" ] && [ "$prs" = "0" ] && [ "$dirty" = "0" ] && [ "$ahead" = "0" ]; then state="DONE (all merged)"
  elif [ "$next_n" = "0" ] && [ "$prs" != "0" ]; then state="FINISHED — PR awaiting review"
  elif [ "${inprog:-}" != "" ] && [ "${inprog:-}" != "(nothing yet)" ]; then state="WORKING: $inprog"
  elif [ "$dirty" != "0" ]; then state="WORKING (uncommitted changes)"
  elif [ "$ahead" != "0" ] && [ "$prs" = "0" ]; then state="committed, no PR yet"
  elif [ "$prs" != "0" ]; then state="PR open — review it"
  else state="idle / not started"; fi
  printf '%-12s %-18s %-9s %-7s %-6s %-6s %s\n' "$key" "$br" "$done_n/$((done_n+next_n))" "$ahead" "$prs(+$merged)" "$dirty" "$state"
done
echo
echo "Open PRs:"; gh pr list --state open --json number,title,headRefName,statusCheckRollup --jq '.[] | "  #\(.number) [\(.headRefName)] \(.title) — checks: \((.statusCheckRollup // []) | map(.conclusion // .status) | unique | join(","))"' 2>/dev/null || echo "  (gh unavailable)"
echo "Contract/request issues:"; gh issue list --label contract-change --label request --state open --json number,title,labels --jq '.[] | "  #\(.number) \(.title)"' 2>/dev/null; gh issue list --search 'CONTRACT CHANGE in:title OR REQUEST in:title' --state open --json number,title --jq '.[] | "  #\(.number) \(.title)"' 2>/dev/null | sort -u
