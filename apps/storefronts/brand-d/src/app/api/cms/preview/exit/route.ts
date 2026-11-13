import { handlePreviewExit } from '@/lib/cms/handlers';

/** Leave preview mode: `GET /api/cms/preview/exit?redirect=/en-GB`. */
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return handlePreviewExit(request, { secure: process.env.NODE_ENV === 'production' });
}
