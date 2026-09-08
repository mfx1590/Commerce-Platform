// The two feed file writers (#146): Google Merchant RSS 2.0 (XML) and Meta commerce catalogue (CSV).
//
// **Both renderers are deterministic on purpose: no timestamps, no generation ids, no random ordering.** The
// publish job hashes these bytes to decide whether anything changed, so a `lastBuildDate` element would make
// every publish look like a change and defeat the idempotency #146 asks for. Item order comes from
// `buildFeedItems` (product handle, then variant position).
import type { FeedChannel, FeedItem } from './feed-types';

/**
 * Minor-unit exponent per currency. Feeds quote prices in major units ("19.99 EUR"), so this cannot be skipped.
 * Only the zero- and three-decimal currencies that differ from the default of 2 are listed (ISO 4217).
 */
const CURRENCY_EXPONENT: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** `1999, EUR` → `"19.99 EUR"` — the format both channels expect. */
export function formatPrice(amountMinor: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  const exponent = CURRENCY_EXPONENT[code] ?? 2;
  const negative = amountMinor < 0;
  const digits = Math.abs(Math.round(amountMinor))
    .toString()
    .padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction} ${code}`;
}

// ------------------------------------------------------------------------------------- Google Merchant (XML)

const GOOGLE_AVAILABILITY: Record<FeedItem['availability'], string> = {
  in_stock: 'in_stock',
  out_of_stock: 'out_of_stock',
  preorder: 'preorder',
  backorder: 'backorder',
};

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name: string, value: string | null): string {
  return value === null || value === '' ? '' : `      <${name}>${escapeXml(value)}</${name}>\n`;
}

/**
 * Google Merchant Center RSS 2.0 with the `g:` namespace. `condition` is written as the constant `new`: this
 * platform sells new goods, and the catalogue has no field for anything else (revisit if resale ever lands).
 */
export function renderGoogleFeed(
  items: readonly FeedItem[],
  feed: { name: string; link: string | null },
): string {
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n' +
    '  <channel>\n' +
    `    <title>${escapeXml(feed.name)}</title>\n` +
    `    <link>${escapeXml(feed.link ?? '')}</link>\n` +
    `    <description>${escapeXml(feed.name)}</description>\n`;

  const body = items
    .map((i) => {
      let out = '    <item>\n';
      out += tag('g:id', i.id);
      out += tag('g:title', i.title);
      out += tag('g:description', i.description);
      out += tag('g:link', i.link);
      out += tag('g:image_link', i.image_link);
      out += tag('g:availability', GOOGLE_AVAILABILITY[i.availability]);
      out += tag('g:condition', 'new');
      out += tag('g:price', formatPrice(i.price.amount_minor, i.price.currency));
      if (i.sale_price) {
        out += tag('g:sale_price', formatPrice(i.sale_price.amount_minor, i.sale_price.currency));
      }
      out += tag('g:brand', i.brand);
      out += tag('g:gtin', i.gtin);
      out += tag('g:item_group_id', i.item_group_id);
      out += '    </item>\n';
      return out;
    })
    .join('');

  return `${head}${body}  </channel>\n</rss>\n`;
}

// ------------------------------------------------------------------------------------------------ Meta (CSV)

const META_AVAILABILITY: Record<FeedItem['availability'], string> = {
  in_stock: 'in stock',
  out_of_stock: 'out of stock',
  preorder: 'preorder',
  backorder: 'available for order',
};

const META_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'brand',
  'sale_price',
  'item_group_id',
  'gtin',
] as const;

export function escapeCsv(value: string | null): string {
  const v = value ?? '';
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Meta commerce catalogue CSV. CRLF line endings, as the spec's examples use. */
export function renderMetaFeed(items: readonly FeedItem[]): string {
  const rows = items.map((i) =>
    [
      i.id,
      i.title,
      i.description,
      META_AVAILABILITY[i.availability],
      'new',
      formatPrice(i.price.amount_minor, i.price.currency),
      i.link,
      i.image_link,
      i.brand,
      i.sale_price ? formatPrice(i.sale_price.amount_minor, i.sale_price.currency) : null,
      i.item_group_id,
      i.gtin,
    ]
      .map(escapeCsv)
      .join(','),
  );
  return [META_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

/** Renders for the feed's channel. Only the two channels of #146 are renderable; see RENDERABLE_CHANNELS. */
export function renderFeed(
  channel: FeedChannel,
  items: readonly FeedItem[],
  feed: { name: string; link: string | null },
): string {
  switch (channel) {
    case 'google_merchant':
      return renderGoogleFeed(items, feed);
    case 'meta':
      return renderMetaFeed(items);
    default:
      throw new Error(`no renderer for channel ${channel}`);
  }
}
