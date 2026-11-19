import { refuseUnlessBi } from '@/app/(hq)/bi/_lib/gate';
import { askFeedbackResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** Thumbs up/down on an answer (#606), store view: the asker only; that store's BI section first (#900). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ storeId: string; conversationId: string }> },
): Promise<Response> {
  const { storeId, conversationId } = await params;
  const refused = await refuseUnlessBi(storeId);
  if (refused) return refused;
  return askFeedbackResponse(request, conversationId);
}
