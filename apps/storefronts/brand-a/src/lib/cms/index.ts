import { datasetForStore } from '@platform/cms';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { getStoreOrNull } from '@/lib/store';
import { cmsConfigFromEnv } from './config';
import { PREVIEW_COOKIE, verifyPreviewToken } from './preview';
import { createReader, type CmsReader } from './reader';

/**
 * The CMS reads for pages and layouts. This module is the only place that binds the reader to
 * Next: the environment, the store from `GET /store` (its `code` picks the dataset) and the preview
 * cookie. Everything it does is in `reader.ts`, which the tests exercise with fakes.
 *
 * Wrapped in React's `cache()`: a layout, a page and its `generateMetadata` share one reader — and
 * one store lookup — per render.
 */
export const getCms = cache(async (): Promise<CmsReader> => {
  const config = cmsConfigFromEnv();
  const store = await getStoreOrNull();
  const storeCode = store?.code ?? null;
  return createReader({ config, storeCode, preview: await previewRequested(storeCode) });
});

async function previewRequested(storeCode: string | null): Promise<boolean> {
  if (storeCode === null) return false;
  const config = cmsConfigFromEnv();
  let dataset: string;
  try {
    dataset = datasetForStore(storeCode);
  } catch {
    return false;
  }
  const token = (await cookies()).get(PREVIEW_COOKIE)?.value;
  return verifyPreviewToken(config.previewSecret, dataset, token);
}

export { cmsConfigFromEnv, isCmsConfigured } from './config';
export type { CmsConfig } from './config';
export { CmsClient, CmsError, defineQuery, queryUrl } from './client';
export { createReader, resetCmsWarnings } from './reader';
export type { CmsReader } from './reader';
export { queries } from './queries';
export { cmsTags, CMS_REVALIDATE_SECONDS } from './tags';
export { PREVIEW_COOKIE, PREVIEW_MAX_AGE_SECONDS } from './preview';
