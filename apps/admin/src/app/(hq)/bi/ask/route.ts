import { askResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/** HQ BI Q&A (#606): a question over every store the principal may see (the server scopes it). */
export async function POST(request: Request): Promise<Response> {
  return askResponse(request);
}
