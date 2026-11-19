import { refuseUnlessBi } from '../_lib/gate';
import { editedQueryResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/** An answer's query, edited and run as is through queryMetrics (#606): no AI, the server scopes it. HQ BI only (#900). */
export async function POST(request: Request): Promise<Response> {
  const refused = await refuseUnlessBi();
  if (refused) return refused;
  return editedQueryResponse(request);
}
