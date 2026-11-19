import { refuseUnlessBi } from '../_lib/gate';
import { liveResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/** The HQ live tiles' poll (#604): every store the principal may see. HQ BI only (#900). */
export async function GET(): Promise<Response> {
  const refused = await refuseUnlessBi();
  if (refused) return refused;
  return liveResponse();
}
