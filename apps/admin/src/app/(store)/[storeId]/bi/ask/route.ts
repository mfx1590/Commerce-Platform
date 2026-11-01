import { askResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** The store view's BI Q&A (#606): narrowed to the store of the URL; the API refuses another one. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  return askResponse(request, (await params).storeId);
}
