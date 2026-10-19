import type { HeroVideo } from '@platform/cms';
import { cloudinaryImageLoader } from '@platform/ui/image-loader';
import type { ReactNode } from 'react';
import { localImagesEnabled } from '@/lib/e2e-images';
import { HeroLoop } from './hero-loop';

/**
 * A hero's media: the poster image, and — when the hero has a video — a muted loop over it (#330).
 *
 * The rules the renderer owes the field (`src/lib/cms/README.md` → "Hero video", brand A's DESIGN.md
 * §7):
 *
 * - **The poster is the content.** It is rendered by the server as before, sizes the box (no layout
 *   shift) and stays the LCP candidate. The video is an overlay of exactly that box.
 * - **The video never competes with the first paint.** No `<video>` exists until the page's `load`
 *   event, so nothing about it is requested before then; `preload="none"` until it mounts.
 * - **`prefers-reduced-motion: reduce` → the poster alone**, and the video is never requested. If
 *   the preference turns on later, the video is removed.
 * - Muted, looping, `playsInline`, `aria-hidden` (it is decoration; the poster carries the meaning),
 *   with a visible pause / play control (WCAG 2.2.2: the loops run longer than five seconds).
 * - The URL goes through the shared Cloudinary loader with a capped width.
 * - Never in an end-to-end build (`E2E_LOCAL_IMAGES`, #327): no request leaves the machine.
 */

/** Wide enough for a full-bleed hero on a large screen; Cloudinary never upscales (`c_limit`). */
export const HERO_VIDEO_MAX_WIDTH = 1600;

export function heroVideoSrc(video: HeroVideo): string {
  return cloudinaryImageLoader({ src: video.cloudinaryUrl, width: HERO_VIDEO_MAX_WIDTH });
}

export function HeroMedia({ video, children }: { video: HeroVideo | null; children: ReactNode }) {
  // No hooks here: this is markup the server renders around the poster; the browser-side rules live
  // in the `HeroLoop` island.
  const loop = video !== null && !localImagesEnabled();
  return (
    <div className="relative" data-testid="hero-media">
      {children}
      {loop ? <HeroLoop src={heroVideoSrc(video)} /> : null}
    </div>
  );
}
