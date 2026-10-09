/**
 * Liveness probe for the container image: `infra/README.md` requires every app to listen on `$PORT`
 * and answer `GET /health` with 200. Now that this package has a `start` script,
 * `infra/docker/entrypoint.sh` runs Next instead of the fallback health server, so the route has to
 * come from the app itself or the HEALTHCHECK never passes.
 *
 * Deliberately shallow: it reports that the process is serving, not that the Store API is reachable.
 * A dependency check here would take the pod out of rotation for someone else's outage.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok', app: 'storefront-starter' }, { status: 200 });
}
