/**
 * Is the admin's own session still alive at Keycloak? (#353)
 *
 * The session cookie is self-contained: once sealed, nothing on the server can revoke it, so a copy
 * taken before Sign out would keep working until its access token expired. The middleware therefore
 * asks Keycloak (`sessionIsLive`, the userinfo endpoint) whether the session behind the cookie still
 * exists, and sends the browser to sign-in when it does not — fail **closed**, including when
 * Keycloak cannot be reached.
 *
 * Asking on every request would put Keycloak on every page load and every prefetch, so a "live"
 * answer is remembered for `LIVENESS_TTL_MS` per Keycloak session id (`sid`). Best effort by design:
 * the cache is per process, so a replayed cookie can be accepted for up to 30 s after Sign out on an
 * instance that had just checked it. Only positive answers are cached; "not live" ends the session.
 *
 * This is the admin app's check of its own session. The core is not involved: it keeps verifying
 * access tokens offline against the realm's keys.
 *
 * Free of `next/*` imports: it runs in the middleware and in unit tests.
 */

export const LIVENESS_TTL_MS = 30_000;

const liveUntil = new Map<string, number>();

export async function isSessionLive(
  sessionId: string,
  probe: () => Promise<boolean>,
  now = Date.now(),
): Promise<boolean> {
  const until = sessionId === '' ? undefined : liveUntil.get(sessionId);
  if (until !== undefined && until > now) return true;
  const live = await probe();
  if (live && sessionId !== '') {
    liveUntil.set(sessionId, now + LIVENESS_TTL_MS);
  } else {
    liveUntil.delete(sessionId);
  }
  return live;
}

/** A session just proven live another way (a successful refresh). */
export function markLive(sessionId: string, now = Date.now()): void {
  if (sessionId !== '') liveUntil.set(sessionId, now + LIVENESS_TTL_MS);
}

/** Sign out on this process: the session is not live here from now on, whatever was cached. */
export function forgetSession(sessionId: string): void {
  liveUntil.delete(sessionId);
}

/** For tests. */
export function resetLivenessCache(): void {
  liveUntil.clear();
}
