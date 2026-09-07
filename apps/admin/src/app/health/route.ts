import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe for the container image (`apps/admin/Dockerfile`, REQUEST #68): the app must listen
 * on `$PORT` and answer `GET /health` with 200.
 *
 * Deliberately unauthenticated and excluded from the middleware's matcher — a probe that gets
 * redirected to the sign-in page is a probe that never reports healthy, so the pod would never
 * become ready and the deploy would roll back.
 *
 * It reports only that this process is up. It does **not** check Keycloak or the Admin API: a
 * liveness probe that fails when a dependency is down gets the container killed and restarted, which
 * fixes nothing and removes the instance that could have served the error pages. Readiness against
 * dependencies is a separate concern for Phase 2.
 */
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
