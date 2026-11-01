import { editedQueryResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** An answer's query, edited and run as is (#606), narrowed to the store of the URL. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  return editedQueryResponse(request, (await params).storeId);
}
