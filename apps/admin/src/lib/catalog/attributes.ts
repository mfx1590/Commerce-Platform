/**
 * Catalog attributes a specialist fills in (#870 wave 1 item 5, PR A): variant shipping and customs
 * data, compare-at prices, product SEO and attributes. Pure — no React, no `next/*`.
 *
 * The Admin API declares `hs_code` and `origin_country` as plain strings and `weight_g` /
 * `dimensions_mm` as plain integers (no pattern, no minimum); the core checks `origin_country`
 * (ISO 3166-1 alpha-2) and a non-negative `weight_g` only. So the admin states and checks the
 * formats itself, here, for the form and the server action alike.
 */

/**
 * An HS (Harmonized System) code: the 6 internationally agreed digits, optionally extended to 8 or
 * 10 by a national tariff. People type it with dots or spaces (`6302.60.00`); it is stored as
 * digits only.
 */
export const HS_CODE = /^(\d{6}|\d{8}|\d{10})$/;

export function normalizeHsCode(raw: string): string {
  return raw.replace(/[\s.]/g, '');
}

/** ISO 3166-1 alpha-2, upper case (the core's own check). */
export const COUNTRY = /^[A-Z]{2}$/;

export function normalizeCountry(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * A whole, non-negative number of grams or millimetres typed in a field: '' → null (not set);
 * anything that is not a whole number ≥ 0 → 'invalid' (said under the field, never rounded).
 */
export function parseWhole(raw: string): number | null | 'invalid' {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return 'invalid';
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : 'invalid';
}

/**
 * Currencies whose compare-at price does not show a saving (compare-at ≤ price). A WARNING, not a
 * block (manager 11-19): a specialist may set it on purpose (a price that is about to change).
 */
export function compareAtWarnings(
  prices: readonly {
    currency: string;
    amount_minor: number | null;
    compare_at_minor?: number | null;
  }[],
): string[] {
  return prices
    .filter(
      (price) =>
        price.amount_minor !== null &&
        price.compare_at_minor !== null &&
        price.compare_at_minor !== undefined &&
        price.compare_at_minor <= price.amount_minor,
    )
    .map((price) => price.currency);
}

/** What a variant is still missing for shipping and customs, in words (for the list and filter). */
export function missingVariantData(variant: {
  barcode: string | null;
  weight_g: number | null;
  dimensions_mm?: { l?: number; w?: number; h?: number } | null;
  hs_code: string | null;
  origin_country: string | null;
}): string[] {
  const missing: string[] = [];
  if (!variant.barcode) missing.push('barcode');
  if (variant.weight_g === null) missing.push('weight');
  const d = variant.dimensions_mm;
  if (!d || d.l === undefined || d.w === undefined || d.h === undefined) missing.push('dimensions');
  if (!variant.hs_code) missing.push('HS code');
  if (!variant.origin_country) missing.push('origin');
  return missing;
}

// ---------------------------------------------------------------------------- product SEO

/** The SEO keys the storefront's product page reads (`seo.title`, `seo.description`, `seo.canonical`). */
export const SEO_KEYS = ['title', 'description', 'canonical'] as const;
export type SeoKey = (typeof SEO_KEYS)[number];

/** Search engines cut longer titles and descriptions: a hint, not a limit. */
export const SEO_LENGTHS = { title: 60, description: 160 } as const;

/**
 * The `seo` object to save: the three keys the page edits (blank → removed) merged over whatever
 * else the product already carries, so a key another tool wrote is never lost by saving here.
 */
export function mergeSeo(
  existing: Readonly<Record<string, unknown>> | undefined,
  edited: Partial<Record<SeoKey, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const key of SEO_KEYS) {
    const value = edited[key]?.trim();
    if (value) out[key] = value;
    else delete out[key];
  }
  return out;
}

/** A canonical is an absolute https URL or a path on the store (`/products/x`); nothing else. */
export function canonicalProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value.startsWith('/')) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? null : 'Use an https:// address or a path starting with /.';
  } catch {
    return 'Use an https:// address or a path starting with /.';
  }
}

// ---------------------------------------------------------------------------- product attributes

export interface AttributeRow {
  key: string;
  value: string;
}

/**
 * Attributes as rows for editing. Text and numbers are editable; any other value (a list, an
 * object, true/false) another tool wrote is kept as it is and shown read-only.
 */
export function attributeRows(attributes: Readonly<Record<string, unknown>> | undefined): {
  rows: AttributeRow[];
  kept: Record<string, unknown>;
} {
  const rows: AttributeRow[] = [];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (typeof value === 'string' || typeof value === 'number')
      rows.push({ key, value: String(value) });
    else kept[key] = value;
  }
  return { rows, kept };
}

/** Rows back to the attributes object: blank keys dropped, the last of a duplicate key wins. */
export function attributesFrom(
  rows: readonly AttributeRow[],
  kept: Readonly<Record<string, unknown>>,
) {
  const out: Record<string, unknown> = { ...kept };
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== '') out[key] = row.value.trim();
  }
  return out;
}

/** Duplicate keys among the rows (said under the editor; the last one would win). */
export function duplicateKeys(rows: readonly AttributeRow[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    if (seen.has(key)) dup.add(key);
    seen.add(key);
  }
  return [...dup];
}

/** Tags as people type them (comma-separated): trimmed, blanks dropped, duplicates removed. */
export function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ''),
    ),
  ];
}

/** The kinds of variant data a product can be missing, in the order the list and CSV show them. */
export const DATA_KINDS = ['barcode', 'weight', 'dimensions', 'HS code', 'origin'] as const;

/**
 * Per kind, how many of the product's variants lack it (for the catalog list and its CSV). The
 * list API cannot filter on this, so it is shown per row and exported, not filtered (#870 gap).
 */
export function productDataGaps(
  variants: readonly Parameters<typeof missingVariantData>[0][],
): Record<(typeof DATA_KINDS)[number], number> {
  const counts = Object.fromEntries(DATA_KINDS.map((kind) => [kind, 0])) as Record<
    (typeof DATA_KINDS)[number],
    number
  >;
  for (const variant of variants) {
    for (const kind of missingVariantData(variant))
      counts[kind as (typeof DATA_KINDS)[number]] += 1;
  }
  return counts;
}

/** "2 variants lack weight · 1 lacks HS code", or null when nothing is missing. */
export function describeGaps(counts: Record<(typeof DATA_KINDS)[number], number>): string | null {
  const parts = DATA_KINDS.filter((kind) => counts[kind] > 0).map(
    (kind) => `${counts[kind]} ${counts[kind] === 1 ? 'lacks' : 'lack'} ${kind}`,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}
