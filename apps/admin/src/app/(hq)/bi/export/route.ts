import { exportResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/** The HQ period dashboard as CSV (#604): `?from=&to=` like the page. */
export async function GET(request: Request): Promise<Response> {
  return exportResponse(new URL(request.url));
}
