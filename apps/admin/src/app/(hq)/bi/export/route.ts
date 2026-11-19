import { refuseUnlessBi } from '../_lib/gate';
import { exportResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/** The HQ period dashboard as CSV (#604): `?from=&to=` like the page. HQ BI only (#900). */
export async function GET(request: Request): Promise<Response> {
  const refused = await refuseUnlessBi();
  if (refused) return refused;
  return exportResponse(new URL(request.url));
}
