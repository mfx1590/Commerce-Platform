'use client';

import { useTranslations } from 'next-intl';
import { memo, useEffect, useRef, useState } from 'react';

/**
 * The hero's video loop itself — the client island of `HeroMedia` (#330). See
 * `src/components/hero-media.tsx` for the rules; this file holds the parts that need the browser:
 * waiting for `load`, honouring `prefers-reduced-motion` (now and when it changes), and the pause /
 * play control.
 *
 * Exported through `memo`: in the app it is a client reference either way; in the server-tree
 * renderer the CMS suites use (`test/cms-render.ts`, which calls function components directly) a
 * memo element is flattened like any client reference instead of being called without React.
 */

const REDUCE = '(prefers-reduced-motion: reduce)';

/** Mount the video only after `load`, and only while motion is welcome. */
function useVideoAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia(REDUCE);
    let loaded = document.readyState === 'complete';
    const decide = () => setAllowed(loaded && !motion.matches);
    const onLoad = () => {
      loaded = true;
      decide();
    };

    decide();
    if (!loaded) window.addEventListener('load', onLoad, { once: true });
    motion.addEventListener('change', decide);
    return () => {
      window.removeEventListener('load', onLoad);
      motion.removeEventListener('change', decide);
    };
  }, []);

  return allowed;
}

export const HeroLoop = memo(function HeroLoop({ src }: { src: string }) {
  const allowed = useVideoAllowed();
  const t = useTranslations('common');
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  if (!allowed) return null;

  function toggle() {
    const element = ref.current;
    if (element === null) return;
    if (element.paused) {
      void element.play()?.catch(() => undefined);
      setPlaying(true);
    } else {
      element.pause();
      setPlaying(false);
    }
  }

  return (
    <>
      <video
        ref={ref}
        className="pointer-events-none absolute inset-0 h-full w-full rounded-lg object-cover"
        src={src}
        muted
        loop
        playsInline
        autoPlay
        preload="none"
        aria-hidden="true"
        data-testid="hero-video"
      />
      <button
        type="button"
        onClick={toggle}
        aria-pressed={!playing}
        className="absolute bottom-3 right-3 rounded-md bg-background/80 px-3 py-1 text-sm font-medium text-foreground shadow"
      >
        {playing ? t('pauseVideo') : t('playVideo')}
      </button>
    </>
  );
});
