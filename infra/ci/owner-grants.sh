#!/usr/bin/env bash
# The witness for #346: every grant Keycloak logged for the staff realm's `owner` in this job, by TOTP step.
#
#   bash infra/ci/owner-grants.sh            # after the live suites; never fails the job
#
# `owner` is the one seeded staff user with a TOTP (RFC 6238, 30 s steps), and Keycloak refuses a code that was
# already used. The live suites used to sign owner in independently and collided on a step (PR 345's run
# 37293071865, 126/129), which infra/ci/totp-barrier.sh papered over with a 30–60 s wait between them. #387
# (auth-sdk) and #401 (core) replaced that with one shared owner-token fixture per suite, so no suite depends on
# running before or after another, and the wait is gone. This prints what actually happened, so every run is
# its own evidence: the owner logins, the TOTP step each fell in, and a warning for every REFUSED owner login.
# Keycloak refuses a code that was already used, so a collision shows up as a refused login (LOGIN_ERROR) — not as
# two successes: two successful logins in one 30 s step mean two DIFFERENT codes were accepted, which is exactly
# what the shared fixture is for (#407 first warned on that, wrongly). It reads Keycloak's event log, which the CI-only overlay
# infra/ci/compose.keycloak-events.yml enables; it is a witness, not a gate, and always exits 0.
#
# OWNER_GRANTS_LOG=<file> reads a saved `docker compose logs --timestamps` output instead of the container
# (for a laptop check of the parsing).
set -uo pipefail

STEP=30

if [ -n "${OWNER_GRANTS_LOG:-}" ]; then
  logs="$(cat "$OWNER_GRANTS_LOG")"
else
  logs="$(docker compose -f infra/docker/docker-compose.yml logs --no-log-prefix --timestamps keycloak 2>/dev/null || true)"
fi

rows="$(printf '%s\n' "$logs" |
  grep -E 'type="?(LOGIN|LOGIN_ERROR)"?' | grep -E 'realmName="?staff"?' | grep -E 'username="?owner"?' |
  while IFS= read -r line; do
    ts="${line%% *}"
    epoch="$(date -u -d "$ts" +%s 2>/dev/null || echo 0)"
    event="$(printf '%s' "$line" | grep -oE 'type="?[A-Z_]+"?' | head -1 | tr -d '"' | sed 's/type=//')"
    detail="$(printf '%s' "$line" | grep -oE '(error|clientId)="?[A-Za-z0-9_-]+"?' | tr -d '"' | tr '\n' ' ')"
    printf '%s %s %s %s\n' "$epoch" "$((epoch / STEP))" "$event" "$detail"
  done)"

echo "== owner logins in the staff realm (Keycloak event log), by TOTP step"
if [ -z "$rows" ]; then
  echo "   none logged (no live suite signed owner in, or the events overlay was not used)"
  exit 0
fi
printf '   %-10s %-10s %-12s %s\n' 'time (UTC)' 'step' 'event' 'detail'
printf '%s\n' "$rows" | while read -r epoch step event detail; do
  printf '   %-10s %-10s %-12s %s\n' "$(date -u -d "@$epoch" +%T)" "$step" "$event" "$detail"
done

ok="$(printf '%s\n' "$rows" | awk '$3 == "LOGIN"' | wc -l | tr -d ' ')"
failed="$(printf '%s\n' "$rows" | awk '$3 == "LOGIN_ERROR"' | wc -l | tr -d ' ')"
echo "   successful owner logins: $ok; refused: $failed"
if [ "$failed" -gt 0 ]; then
  # A refused owner login is what a one-time-code collision looks like (or a wrong password / expired code); the
  # error column above says which. The live suites' own result decides the job — this only names what happened.
  echo "   ⚠ $failed refused owner login(s) — the error column says why (a reused one-time code is refused)"
else
  echo "   no owner login was refused"
fi
exit 0
