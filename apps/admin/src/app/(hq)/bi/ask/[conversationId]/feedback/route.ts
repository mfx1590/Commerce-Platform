import { askFeedbackResponse } from '../../../_lib/handlers';

export const dynamic = 'force-dynamic';

/** Thumbs up/down on an answer (#606): the asker only; the server answers 404 to anyone else. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  return askFeedbackResponse(request, (await params).conversationId);
}
