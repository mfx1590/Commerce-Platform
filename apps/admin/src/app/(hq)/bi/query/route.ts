import { editedQueryResponse } from '../_lib/handlers';

export const dynamic = 'force-dynamic';

/** An answer's query, edited and run as is through queryMetrics (#606): no AI, the server scopes it. */
export async function POST(request: Request): Promise<Response> {
  return editedQueryResponse(request);
}
