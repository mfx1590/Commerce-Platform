import { refuseUnlessBi } from '@/app/(hq)/bi/_lib/gate';
import { editedQueryResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** An answer's query, edited and run as is (#606), narrowed to the store of the URL; that store's BI section first (#900). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await params;
  const refused = await refuseUnlessBi(storeId);
  if (refused) return refused;
  return editedQueryResponse(request, storeId);
}
