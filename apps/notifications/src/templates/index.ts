// Template entry point: one `render` per notification kind, and the locale rule.
import {
  isLocale,
  LOCALES,
  type Locale,
  type NotificationData,
  type NotificationKind,
  type RenderContext,
  type RenderedContent,
} from '../types.js';
import { renderOrderConfirmation } from './order-confirmation.js';
import { renderShipmentShipped } from './shipment-shipped.js';

export { FIXTURES, fixtureFor } from './fixtures.js';
export { strings } from './strings.js';
export { renderOrderConfirmation, renderShipmentShipped };

export function render<K extends NotificationKind>(
  kind: K,
  data: NotificationData[K],
  ctx: RenderContext,
): RenderedContent {
  switch (kind) {
    case 'order_confirmation':
      return renderOrderConfirmation(data as NotificationData['order_confirmation'], ctx);
    case 'shipment_shipped':
      return renderShipmentShipped(data as NotificationData['shipment_shipped'], ctx);
    default:
      throw new Error(`no template for kind "${String(kind)}"`);
  }
}

/**
 * The locale an email is rendered in: the order's own locale when a template exists for it; otherwise the
 * first template whose language matches (`de-AT` → `de-DE`, `en-US` → `en-GB`); otherwise the brand's default.
 * A customer who checked out in German must not get an English confirmation because of a region tag.
 */
export function pickLocale(requested: string | null | undefined, fallback: Locale): Locale {
  if (!requested) return fallback;
  const normalised = requested.trim().replace('_', '-');
  if (isLocale(normalised)) return normalised;
  const language = normalised.split('-')[0]?.toLowerCase();
  const byLanguage = LOCALES.find((l) => l.split('-')[0] === language);
  return byLanguage ?? fallback;
}
