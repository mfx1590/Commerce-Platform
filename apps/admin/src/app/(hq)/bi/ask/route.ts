import { refuseUnlessBi } from '../_lib/gate';
import { askResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/**
 * HQ BI Q&A (#606): a question over every store the principal may see (the server scopes it).
 * HQ BI only (#900): a principal without the section never spends AI tokens here.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = await refuseUnlessBi();
  if (refused) return refused;
  return askResponse(request);
}
