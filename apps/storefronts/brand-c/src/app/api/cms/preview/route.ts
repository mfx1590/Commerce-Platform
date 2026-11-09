import { resolveDataset } from '@platform/cms';
import { cmsConfigFromEnv } from '@/lib/cms/config';
import { handlePreview } from '@/lib/cms/handlers';
import { datasetSource } from '@/lib/cms';
import { getStoreOrNull } from '@/lib/store';

/**
 * Enter preview mode: `GET /api/cms/preview?secret=…&redirect=/en-GB/pages/about`.
 * Outside the locale tree like `/health` and `/auth/*` — a Studio "open preview" link must not grow
 * a locale prefix. Logic in `src/lib/cms/handlers.ts`.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  // The dataset comes from the store row only (#521) — never from this request's query, path or
  // headers — and an unknown store yields `null`, which `handlePreview` answers with 503.
  const dataset = resolveDataset(datasetSource(await getStoreOrNull()));
  return handlePreview(request, {
    config: cmsConfigFromEnv(),
    dataset,
    secure: process.env.NODE_ENV === 'production',
  });
}
