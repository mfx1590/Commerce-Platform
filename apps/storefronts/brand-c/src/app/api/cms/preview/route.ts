import { datasetForStore } from '@platform/cms';
import { cmsConfigFromEnv } from '@/lib/cms/config';
import { handlePreview } from '@/lib/cms/handlers';
import { getStoreOrNull } from '@/lib/store';

/**
 * Enter preview mode: `GET /api/cms/preview?secret=…&redirect=/en-GB/pages/about`.
 * Outside the locale tree like `/health` and `/auth/*` — a Studio "open preview" link must not grow
 * a locale prefix. Logic in `src/lib/cms/handlers.ts`.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const store = await getStoreOrNull();
  let dataset: string | null = null;
  try {
    dataset = store ? datasetForStore(store.code) : null;
  } catch {
    dataset = null;
  }
  return handlePreview(request, {
    config: cmsConfigFromEnv(),
    dataset,
    secure: process.env.NODE_ENV === 'production',
  });
}
