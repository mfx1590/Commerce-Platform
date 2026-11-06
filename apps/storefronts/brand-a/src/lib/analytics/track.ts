import type { RecommendationEvent } from './recommendation-events';

/**
 * The browser analytics seam. There is no analytics destination yet (PostHog is deferred, D11;
 * LAUNCH 8.3), so the default sink makes no request, sets no cookie and stores nothing: it pushes
 * the event onto `window.dataLayer` and dispatches a `platform:analytics` DOM event. A destination
 * added at launch subscribes to either, and the e2e suite reads `dataLayer`.
 */

export const ANALYTICS_DOM_EVENT = 'platform:analytics';

type AnalyticsWindow = Window & { dataLayer?: unknown[] };

export function track(event: RecommendationEvent): void {
  if (typeof window === 'undefined') return;
  const target = window as AnalyticsWindow;
  (target.dataLayer ??= []).push(event);
  target.dispatchEvent(new CustomEvent(ANALYTICS_DOM_EVENT, { detail: event }));
}
