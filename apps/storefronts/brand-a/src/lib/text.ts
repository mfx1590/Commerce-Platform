/**
 * Text from the Store API, made safe to render: pure, no imports, usable from server and client
 * components alike.
 */

/**
 * The first candidate that has text, whitespace collapsed; `undefined` when none does (#837).
 * Every step is skipped when it is missing OR empty after trimming. A `??` chain falls past `null`
 * and `undefined` only, so an empty `subtitle` (the onboarding wizard's default) stopped it with
 * `""` and an empty description reached the page.
 */
export function firstText(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    // ASCII whitespace only: `\s` would also fold an ideographic space (U+3000) or a no-break
    // space, which Japanese text and French typography use on purpose, into a plain space.
    const text = candidate?.replace(ASCII_WHITESPACE, ' ').trim();
    if (text) return text;
  }
  return undefined;
}

const ASCII_WHITESPACE = /[\t\n\v\f\r ]+/g;

/**
 * Like `firstText`, but for prose that keeps its paragraphs (JSON-LD `description`): line endings
 * normalised, trailing spaces and runs of blank lines tidied, the newlines themselves kept.
 */
export function firstBlock(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const text = candidate
      ?.replace(/\r\n?/g, '\n')
      .replace(/[\t\v\f ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text) return text;
  }
  return undefined;
}

// ── display names (wizard-shaped data) ───────────────────────────────────────────────────────────
//
// The Store API declares these strings without `minLength`, and the onboarding wizard can leave
// them empty. A `??` fallback stops at `""`, which renders an empty heading, link, alt or title.

/** What the starter calls a store with no name. */
export const STORE_NAME_FALLBACK = 'Storefront';

/** The store's name, or `STORE_NAME_FALLBACK` when it is missing or blank. */
export function storeDisplayName(store: { name?: string | null } | null | undefined): string {
  return firstText(store?.name) ?? STORE_NAME_FALLBACK;
}

/** A product's name, or its handle when the title is blank: never an empty heading or link. */
export function productName(product: { title: string; handle: string }): string {
  return firstText(product.title) ?? product.handle;
}

/** A category's name, or its handle when the name is blank. */
export function categoryName(category: { name: string; handle: string }): string {
  return firstText(category.name) ?? category.handle;
}

/** An image's own alt text, or the name of what it shows when that is missing or blank. */
export function imageAlt(alt: string | null | undefined, name: string): string {
  return firstText(alt) ?? name;
}
