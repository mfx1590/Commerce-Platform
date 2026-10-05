#!/usr/bin/env bash
# Keeps two test suites from spending the same one-time code of the staff realm's `owner` (#344 follow-up).
#
#   bash infra/ci/totp-barrier.sh wait     # after the core live suites, before the auth-sdk live suites
#   bash infra/ci/totp-barrier.sh report   # after both: every owner grant Keycloak logged, by TOTP step
#
# `owner` is the one seeded staff user with TOTP (RFC 6238, 30 s steps), and Keycloak refuses a code that
# was already used. Two suites in `auth-e2e` sign owner in, each with its own helper, and neither knows
# what the other spent:
#
#   core   apps/core/test/auth-live.test.ts — tries the code of step s-1, then s, then waits for the next
#          step and uses its current code. It never computes a FUTURE code. So every code it can have spent
#          belongs to a step <= the step the clock is in when it finishes.
#   sdk    packages/auth-sdk (incl. apps/core/src/modules/hq-rbac/test/**) — helpers that use the step
#          before, at or after "now" (keycloak-realms.test.ts uses now and now+30 s). So every code it can
#          spend belongs to a step >= (the step it starts in) - 1.
#
# `wait` is run the moment the core step ends, in step S. It sleeps until the START of step S+2 — between
# 30 and 60 s, computed from the clock rather than a fixed sleep. The sdk then starts in a step >= S+2, so
# its earliest code is step S+1, strictly after anything the core could have spent (<= S). The two sets
# cannot meet, on any run, whatever the core's helper had to fall back to.
#
# #344's first fix only ordered the steps ("core first spends only the previous window"). That held when
# the previous step's code was accepted; when it was not, the core spent the CURRENT code — the one the sdk,
# starting seconds later, also needed (PR 345, run 37293071865: hq-rbac scope.test.ts, "token for owner:
# invalid_grant", 126/129). Order alone is not a separation; a step gap is.
#
# `report` reads Keycloak's event log (enabled for CI by infra/ci/compose.keycloak-events.yml) and prints
# each owner grant with its step and which side of the barrier it fell on — the evidence that they never
# shared a step. It never fails the job: it is a witness, not a gate.
set -euo pipefail

STEP=30
STATE="${TOTP_BARRIER_STATE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/totp-barrier.state}"

case "${1:-}" in
  wait)
    now="$(date +%s)"
    s=$((now / STEP))
    target=$(((s + 2) * STEP))
    echo "== totp barrier: core finished at $(date -u -d "@$now" +%T) in step $s — every owner code it could have spent is from step <= $s"
    echo "   sleeping $((target - now)) s until step $((s + 2)) begins ($(date -u -d "@$target" +%T)); the sdk's earliest code is then step $((s + 1))"
    printf 'BARRIER_STEP=%s\nBARRIER_RELEASE=%s\n' "$s" "$target" > "$STATE"
    sleep "$((target - now))"
    echo "== totp barrier released at $(date -u +%T), step $(($(date +%s) / STEP))"
    ;;
  report)
    if [ ! -f "$STATE" ]; then
      echo "== totp barrier: no state ($STATE) — the barrier did not run"
      exit 0
    fi
    # shellcheck disable=SC1090 -- written by `wait` above
    . "$STATE"
    echo "== owner grants in the staff realm (Keycloak event log); barrier at step $BARRIER_STEP, released at step $((BARRIER_RELEASE / STEP))"
    printf '   %-12s %-10s %-6s %-14s %s\n' 'time (UTC)' 'step' 'side' 'event' 'detail'
    # TOTP_BARRIER_LOG: a saved `logs --timestamps` file instead of the live container (self-test).
    if [ -n "${TOTP_BARRIER_LOG:-}" ]; then cat "$TOTP_BARRIER_LOG"; else
      docker compose -f infra/docker/docker-compose.yml logs --no-log-prefix --timestamps keycloak 2>/dev/null
    fi |
      grep -E 'type="?(LOGIN|LOGIN_ERROR)"?' | grep -E 'realmName="?staff"?' | grep -E 'username="?owner"?' |
      while IFS= read -r line; do
        ts="${line%% *}"
        epoch="$(date -u -d "$ts" +%s 2>/dev/null || echo 0)"
        step=$((epoch / STEP))
        if [ "$epoch" -lt "$BARRIER_RELEASE" ]; then side=core; else side=sdk; fi
        event="$(printf '%s' "$line" | grep -oE 'type="?[A-Z_]+"?' | head -1 | tr -d '"' | sed 's/type=//')"
        detail="$(printf '%s' "$line" | grep -oE '(error|clientId)="?[A-Za-z0-9_-]+"?' | tr -d '"' | tr '\n' ' ')"
        printf '   %-12s %-10s %-6s %-14s %s\n' "$(date -u -d "@$epoch" +%T)" "$step" "$side" "$event" "$detail"
      done || true
    echo "   (core grants must all be in steps <= $BARRIER_STEP; sdk grants in steps >= $((BARRIER_RELEASE / STEP)))"
    ;;
  *)
    echo "usage: totp-barrier.sh wait|report" >&2
    exit 2
    ;;
esac
