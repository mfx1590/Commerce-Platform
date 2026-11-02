import { askFeedbackResponse } from '@/app/(hq)/bi/_lib/handlers';

export const dynamic = 'force-dynamic';

/** Thumbs up/down on an answer (#606), store view: the asker only. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  return askFeedbackResponse(request, (await params).conversationId);
}
