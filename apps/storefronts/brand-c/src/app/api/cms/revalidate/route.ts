import { revalidateTag } from 'next/cache';
import { cmsConfigFromEnv } from '@/lib/cms/config';
import { handleRevalidate } from '@/lib/cms/handlers';

/**
 * Sanity's publish webhook: `POST /api/cms/revalidate`, signed with `SANITY_WEBHOOK_SECRET`
 * (cms/README.md, "Revalidate on publish"). Logic in `src/lib/cms/handlers.ts`.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRevalidate(request, { config: cmsConfigFromEnv(), revalidateTag });
}
