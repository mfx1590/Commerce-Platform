'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { clickedEvent, viewedEvent, type RailContext } from '@/lib/analytics/recommendation-events';
import { track } from '@/lib/analytics/track';

/** Half the rail on screen counts as seen — a rail scrolled past at the edge does not. */
const VIEW_THRESHOLD = 0.5;

/**
 * Adds the two analytics events to a server-rendered rail without re-rendering it: the cards stay
 * server components, this only observes. `recommendation_viewed` fires once per mount, when the rail
 * is first half visible; `recommendation_clicked` fires for a click on any link inside a card,
 * found by its `data-rail-position`.
 */
export function RecommendationTracker({
  rail,
  children,
}: {
  rail: RailContext;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Primitives in the deps so a parent re-render with an equal rail does not re-arm the observer.
  const { kind, surface } = rail;
  const ids = rail.productIds.join(',');

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const context: RailContext = { kind, surface, productIds: ids === '' ? [] : ids.split(',') };

    let seen = false;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (seen || !entries.some((entry) => entry.isIntersecting)) return;
              seen = true;
              track(viewedEvent(context));
              observer?.disconnect();
            },
            { threshold: VIEW_THRESHOLD },
          );
    observer?.observe(element);

    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('a') == null) return;
      const card = target.closest<HTMLElement>('[data-rail-position]');
      const clicked = clickedEvent(context, Number(card?.dataset.railPosition));
      if (clicked !== null) track(clicked);
    };
    element.addEventListener('click', onClick);

    return () => {
      observer?.disconnect();
      element.removeEventListener('click', onClick);
    };
  }, [kind, surface, ids]);

  return <div ref={ref}>{children}</div>;
}
