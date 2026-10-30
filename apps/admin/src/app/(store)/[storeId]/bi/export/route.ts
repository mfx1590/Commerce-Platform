import { exportResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** The store view's period dashboard as CSV (#604), narrowed to the store of the URL. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  return exportResponse(new URL(request.url), (await params).storeId);
}
