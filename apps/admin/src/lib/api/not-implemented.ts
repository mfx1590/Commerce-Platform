import type { AdminError, ApiResult } from './admin-client';
import type { ApiMode } from './api-mode';

/**
 * "The core does not serve this route yet" (#118), told apart from "this record does not exist"
 * and from "your session ended".
 *
 * Against the core only (Prism serves every documented path, and a contract test that forces
 * `Prefer: code=401` must still see a 401):
 *
 * - a **404 without the contract's `not_found` code** is a route the core has not mounted — the
 *   core's own missing-record 404s always say `not_found`;
 * - a **401 while `GET /admin/me` with the same token answers 200** is the same thing seen through
 *   Medusa's admin auth, which catches unmatched `/admin/*` with a 401 until #265 lands. The
 *   session is demonstrably fine, so the session-ended panel would be a lie.
 *
 * Either becomes status 501 with code `not_implemented` and the route in `details`, which
 * `ApiStatePanel` renders as its own panel. Every other result passes through untouched.
 */

export const NOT_IMPLEMENTED = 'not_implemented';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `GET /admin/stores/{id}/customers` — ids folded so the label names the route, not the row. */
export function routeLabel(method: string, path: string): string {
  const [bare = path] = path.split('?');
  return `${method.toUpperCase()} ${bare.replace(UUID, '{id}')}`;
}

export function notImplementedError(method: string, path: string): AdminError {
  const route = routeLabel(method, path);
  return {
    code: NOT_IMPLEMENTED,
    message: `The core does not serve ${route} yet.`,
    details: { route },
  };
}

export async function reclassifyUnmounted<T>(
  result: ApiResult<T>,
  request: { method: string; path: string },
  context: { mode: ApiMode; meStatus: () => Promise<number> },
): Promise<ApiResult<T>> {
  if (result.ok || context.mode !== 'core') return result;
  const unmounted =
    (result.status === 404 && result.error.code !== 'not_found') ||
    (result.status === 401 &&
      !request.path.startsWith('/admin/me') &&
      (await context.meStatus()) === 200);
  if (!unmounted) return result;
  return { ok: false, status: 501, error: notImplementedError(request.method, request.path) };
}
