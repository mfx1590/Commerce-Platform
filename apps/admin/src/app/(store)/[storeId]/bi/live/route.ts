import { liveResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** The store view's live tiles' poll (#604): narrowed to the store of the URL; the API refuses another one. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  return liveResponse((await params).storeId);
}
