import { resolveDataset, type DatasetSource } from '@platform/cms';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { getStoreOrNull } from '@/lib/store';
import { cmsConfigFromEnv } from './config';
import { PREVIEW_COOKIE, verifyPreviewToken } from './preview';
import { createReader, type CmsReader } from './reader';

/**
 * The CMS reads for pages and layouts. This module is the only place that binds the reader to
 * Next: the environment, the store from `GET /store` (its `content_space_id`, else its `code`,
 * picks the dataset — `resolveDataset`, #521) and the preview cookie. Everything it does is in
 * `reader.ts`, which the tests exercise with fakes.
 *
 * Wrapped in React's `cache()`: a layout, a page and its `generateMetadata` share one reader — and
 * one store lookup — per render.
 */
export const getCms = cache(async (): Promise<CmsReader> => {
  const config = cmsConfigFromEnv();
  const source = datasetSource(await getStoreOrNull());
  return createReader({ config, ...source, preview: await previewRequested(source) });
});

/**
 * The dataset inputs from a `GET /store` answer — the only place a dataset name may come from.
 * `null` store (the lookup failed) → nothing, and the reader renders without content.
 */
export function datasetSource(
  store: { code: string; content_space_id?: string | null | undefined } | null,
): DatasetSource {
  return store === null
    ? { storeCode: null, contentSpaceId: null }
    : { storeCode: store.code, contentSpaceId: store.content_space_id ?? null };
}

async function previewRequested(source: DatasetSource): Promise<boolean> {
  const dataset = resolveDataset(source);
  if (dataset === null) return false;
  const config = cmsConfigFromEnv();
  const token = (await cookies()).get(PREVIEW_COOKIE)?.value;
  return verifyPreviewToken(config.previewSecret, dataset, token);
}

export { cmsConfigFromEnv, isCmsConfigured } from './config';
export type { CmsConfig } from './config';
export { CmsClient, CmsError, defineQuery, queryUrl } from './client';
export { createReader, resetCmsWarnings } from './reader';
export type { CmsReader, RoutedDocument } from './reader';
export { campaignIsLive } from './schedule';
export { heroVideo, normalizeHeroVideo } from './hero-video';
export { queries } from './queries';
export { cmsTags, CMS_REVALIDATE_SECONDS } from './tags';
export { PREVIEW_COOKIE, PREVIEW_MAX_AGE_SECONDS } from './preview';
