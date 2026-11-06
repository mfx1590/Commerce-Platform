import type { RecommendationKind } from '../store-api';
import type { RecommendationSurface } from '../recommendations';
// The consent switch is plain ESM so next.config.mjs can fail the build on a bad value.
import { analyticsConsentMode as parseConsentMode, CONSENT_MODES } from './consent-mode.mjs';

/**
 * The two recommendation events (#609), defined HERE until the CDP tracking plan carries them —
 * `data/cdp/tracking-plan.json` is window 16's file (REQUEST #725). When the plan lands,
 * this definition must match its entries property for property.
 *
 * What an event may carry is the plan's rule: ids, counts, positions and enums. No customer id, no
 * e-mail hash, no cookie, no session id — the storefront has no identity to give a browser event, so
 * these are anonymous by construction, which is what the 2026-10-23 `analytics` consent mode allows.
 * Plain module (no `'use client'`): the server and the client tracker both import it.
 */

export const RECOMMENDATION_EVENTS = ['recommendation_viewed', 'recommendation_clicked'] as const;
export type RecommendationEventName = (typeof RECOMMENDATION_EVENTS)[number];

interface Common {
  /** The kind SERVED, from the response — `popular` on a fallback rail, never the asked kind. */
  kind: RecommendationKind;
  surface: RecommendationSurface;
  /** The product ids shown, in rail order. */
  product_ids: string[];
}

export interface RecommendationViewed extends Common {
  event: 'recommendation_viewed';
  count: number;
}

export interface RecommendationClicked extends Common {
  event: 'recommendation_clicked';
  product_id: string;
  /** 1-based position of the clicked card in the rail. */
  position: number;
}

export type RecommendationEvent = RecommendationViewed | RecommendationClicked;

/** The property names each event may carry, so a test can pin the shape against the plan. */
export const RECOMMENDATION_EVENT_PROPERTIES = {
  recommendation_viewed: ['event', 'kind', 'surface', 'product_ids', 'count'],
  recommendation_clicked: ['event', 'kind', 'surface', 'product_ids', 'product_id', 'position'],
} as const satisfies Record<RecommendationEventName, readonly string[]>;

export interface RailContext {
  kind: RecommendationKind;
  surface: RecommendationSurface;
  productIds: string[];
}

export function viewedEvent(rail: RailContext): RecommendationViewed {
  return {
    event: 'recommendation_viewed',
    kind: rail.kind,
    surface: rail.surface,
    product_ids: rail.productIds,
    count: rail.productIds.length,
  };
}

/** `null` for a position outside the rail, so a stray click never produces a bogus event. */
export function clickedEvent(rail: RailContext, position: number): RecommendationClicked | null {
  const productId = rail.productIds[position - 1];
  if (productId === undefined) return null;
  return {
    event: 'recommendation_clicked',
    kind: rail.kind,
    surface: rail.surface,
    product_ids: rail.productIds,
    product_id: productId,
    position,
  };
}

/** Consent mode (the 2026-10-23 rule, #576), as `consent-mode.mjs` explains; strict sends nothing. */
export { CONSENT_MODES };
export type ConsentMode = (typeof CONSENT_MODES)[number];

export function analyticsConsentMode(
  env: Record<string, string | undefined> = process.env,
): ConsentMode {
  return parseConsentMode(env);
}
