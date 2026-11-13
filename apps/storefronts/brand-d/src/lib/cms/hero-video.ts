import type { CampaignLandingDocument, Hero, HeroVideo, PageDocument } from '@platform/cms';
import { CLOUDINARY_VIDEO_URL_PATTERN } from '@platform/cms';

/**
 * The hero video as the storefront may use it (#330). The schema (`heroPoster`) refuses a video
 * without an image and a URL that is not a Cloudinary video delivery URL, but the renderer does not
 * trust the dataset (same rule as `safeHref` and the embed allow-list): a stored hero whose video
 * breaks either rule is exposed WITHOUT the video, and the image renders alone. So, for whoever
 * renders it: `hero.video` present ⇒ `hero.image` present and `video.cloudinaryUrl` matches
 * `CLOUDINARY_VIDEO_URL_PATTERN`. Reduced motion, the pause control and the poster-first loading
 * order are the renderer's (window 3), not this module's.
 */
export function heroVideo(hero: Pick<Hero, 'image' | 'video'>): HeroVideo | null {
  const video = hero.video;
  if (video === undefined || video === null || typeof video !== 'object') return null;
  if (hero.image === undefined || hero.image === null || typeof hero.image !== 'object')
    return null;
  if (
    typeof video.cloudinaryUrl !== 'string' ||
    !CLOUDINARY_VIDEO_URL_PATTERN.test(video.cloudinaryUrl)
  ) {
    return null;
  }
  return video;
}

function withPolicy<H extends Hero>(hero: H): H {
  if (hero.video === undefined) return hero;
  if (heroVideo(hero) !== null) return hero;
  const { video: _dropped, ...rest } = hero;
  return rest as H;
}

/**
 * The document with every hero — the top-level one and the heroes among its blocks — holding a
 * `video` only when `heroVideo()` accepts it. A new object where something changed, the same
 * object otherwise; `null` stays `null`.
 */
export function normalizeHeroVideo<T extends PageDocument | CampaignLandingDocument | null>(
  document: T,
): T {
  if (document === null) return document;
  let changed = false;
  const out: PageDocument | CampaignLandingDocument = { ...document };

  if (document.hero !== undefined && document.hero !== null && typeof document.hero === 'object') {
    const hero = withPolicy(document.hero);
    if (hero !== document.hero) {
      out.hero = hero;
      changed = true;
    }
  }

  if (Array.isArray(document.blocks)) {
    const blocks = document.blocks.map((block) =>
      block !== null && typeof block === 'object' && block._type === 'hero'
        ? withPolicy(block)
        : block,
    );
    if (blocks.some((block, index) => block !== document.blocks?.[index])) {
      out.blocks = blocks as typeof document.blocks;
      changed = true;
    }
  }

  return changed ? (out as T) : document;
}
