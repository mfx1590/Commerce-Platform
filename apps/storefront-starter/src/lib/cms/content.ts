import { createTranslator } from 'next-intl';
import { cache } from 'react';
import { getCms } from './index';
import { cmsConfigFromEnv } from './config';
import { contentMessagesFor } from './messages';
import type { CmsReader } from './reader';

/**
 * What every CMS component needs to render: the locale, the `content` translator and where images
 * come from. Built once per request by `getContent()`; the tests build it with
 * `createContentContext()` and no Next at all.
 */

export type ContentTranslator = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

export interface ImageSource {
  projectId: string;
  dataset: string;
}

export interface ContentContext {
  locale: string;
  t: ContentTranslator;
  /** `null` when there is no CMS: image blocks render nothing rather than a broken URL. */
  images: ImageSource | null;
  preview: boolean;
}

export function createContentContext(options: {
  locale: string;
  images?: ImageSource | null | undefined;
  preview?: boolean | undefined;
}): ContentContext {
  const t = createTranslator({
    locale: options.locale,
    messages: { content: contentMessagesFor(options.locale) },
    namespace: 'content',
  });
  return {
    locale: options.locale,
    t: (key, values) => (t as unknown as ContentTranslator)(key, values),
    images: options.images ?? null,
    preview: options.preview === true,
  };
}

/** The reader and the context for this request; one per render. */
export const getContent = cache(
  async (locale: string): Promise<{ cms: CmsReader; ctx: ContentContext }> => {
    const cms = await getCms();
    const config = cmsConfigFromEnv();
    const images =
      config.projectId !== null && cms.dataset !== null
        ? { projectId: config.projectId, dataset: cms.dataset }
        : null;
    return { cms, ctx: createContentContext({ locale, images, preview: cms.preview }) };
  },
);
