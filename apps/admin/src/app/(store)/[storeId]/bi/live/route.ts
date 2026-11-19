import { refuseUnlessBi } from '@/app/(hq)/bi/_lib/gate';
import { liveResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** The store view's live tiles' poll (#604): narrowed to the store of the URL; that store's BI section first (#900), and the API refuses another one. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await params;
  const refused = await refuseUnlessBi(storeId);
  if (refused) return refused;
  return liveResponse(storeId);
}
