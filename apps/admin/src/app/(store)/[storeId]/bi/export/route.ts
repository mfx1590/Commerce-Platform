import { refuseUnlessBi } from '@/app/(hq)/bi/_lib/gate';
import { exportResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** The store view's period dashboard as CSV (#604), narrowed to the store of the URL; that store's BI section first (#900). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await params;
  const refused = await refuseUnlessBi(storeId);
  if (refused) return refused;
  return exportResponse(new URL(request.url), storeId);
}
