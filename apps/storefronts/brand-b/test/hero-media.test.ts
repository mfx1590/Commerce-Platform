// @vitest-environment jsdom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enGB from '../messages/en-GB.json';
import { HERO_VIDEO_MAX_WIDTH, HeroMedia, heroVideoSrc } from '@/components/hero-media';

/**
 * #330: the hero's optional loop. Under `prefers-reduced-motion: reduce` the poster renders alone
 * and no `<video>` ever exists (so nothing is requested); otherwise the loop mounts only after the
 * page's `load` event, muted, looping, inline, `preload="none"`, hidden from assistive technology,
 * with a pause / play control.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIDEO = {
  _type: 'heroVideo' as const,
  cloudinaryUrl: 'https://res.cloudinary.com/demo/video/upload/v1/loop.mp4',
};

/** A `matchMedia` whose reduced-motion answer the test controls, with change listeners. */
function motionPreference(reduce: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: reduce,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    set(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

let root: Root;
let readyState: DocumentReadyState;

beforeEach(() => {
  readyState = 'interactive';
  vi.spyOn(document, 'readyState', 'get').mockImplementation(() => readyState);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function render(video: typeof VIDEO | null) {
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'en-GB',
        messages: enGB,
        timeZone: 'Europe/London',
        children: createElement(HeroMedia, {
          video,
          children: createElement('img', { alt: 'poster', 'data-testid': 'poster' }),
        }),
      }),
    ),
  );
}

async function pageLoads() {
  readyState = 'complete';
  await act(async () => {
    window.dispatchEvent(new Event('load'));
  });
}

const videoElement = () => document.querySelector('[data-testid="hero-video"]');

describe('HeroMedia — motion welcome', () => {
  it('shows the poster first and mounts the loop only after the page has loaded', async () => {
    motionPreference(false);
    await render(VIDEO);
    expect(document.querySelector('[data-testid="poster"]')).not.toBeNull();
    expect(videoElement(), 'nothing about the video before load').toBeNull();

    await pageLoads();
    const video = videoElement() as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    expect(video!.muted).toBe(true);
    expect(video!.loop).toBe(true);
    expect(video!.autoplay).toBe(true);
    expect(video!.hasAttribute('playsinline')).toBe(true);
    expect(video!.getAttribute('preload')).toBe('none');
    expect(video!.getAttribute('aria-hidden')).toBe('true');
    expect(video!.getAttribute('src')).toBe(heroVideoSrc(VIDEO));
  });

  it('offers a visible pause / play control', async () => {
    motionPreference(false);
    await render(VIDEO);
    await pageLoads();
    const button = document.querySelector('button')!;
    expect(button.textContent).toBe('Pause video');

    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
    await act(async () => button.click());
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(button.textContent).toBe('Play video');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('removes the loop if reduced motion is switched on later', async () => {
    const motion = motionPreference(false);
    await render(VIDEO);
    await pageLoads();
    expect(videoElement()).not.toBeNull();
    await act(async () => motion.set(true));
    expect(videoElement()).toBeNull();
  });
});

describe('HeroMedia — prefers-reduced-motion: reduce', () => {
  it('renders the poster alone and never creates the video, even after load', async () => {
    motionPreference(true);
    await render(VIDEO);
    await pageLoads();
    expect(document.querySelector('[data-testid="poster"]')).not.toBeNull();
    expect(videoElement()).toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('button')).toBeNull();
  });
});

describe('HeroMedia — no video, or an end-to-end build', () => {
  it('a hero without a video is the poster alone', async () => {
    motionPreference(false);
    await render(null);
    await pageLoads();
    expect(document.querySelector('video')).toBeNull();
  });

  it('never mounts the loop under E2E_LOCAL_IMAGES (no request leaves the machine)', async () => {
    vi.stubEnv('E2E_LOCAL_IMAGES', '1');
    motionPreference(false);
    await render(VIDEO);
    await pageLoads();
    expect(document.querySelector('video')).toBeNull();
  });
});

describe('heroVideoSrc', () => {
  it('goes through the shared Cloudinary loader with a capped width', () => {
    expect(heroVideoSrc(VIDEO)).toBe(
      `https://res.cloudinary.com/demo/video/upload/c_limit,w_${HERO_VIDEO_MAX_WIDTH},q_auto,f_auto/v1/loop.mp4`,
    );
  });
});
