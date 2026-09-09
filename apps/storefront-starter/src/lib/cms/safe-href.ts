/**
 * Defence in depth for CMS-supplied links. The schema already rejects anything but a storefront
 * path or an `https://` URL, but the renderer must not trust stored data: a document written
 * before the rule tightened, or through the API directly, could still carry `javascript:`,
 * `//host` or `http://`. Every component that renders an `href` from the CMS classifies it here;
 * anything unsafe renders as plain text (`null` href), never as a link.
 */

export type SafeHref =
  | { kind: 'internal'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'unsafe'; href: null };

export function safeHref(raw: string | undefined | null): SafeHref {
  const value = raw?.trim() ?? '';
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    return { kind: 'internal', href: value };
  }
  if (/^https:\/\/[^\s/?#]+/.test(value)) {
    return { kind: 'external', href: value };
  }
  return { kind: 'unsafe', href: null };
}
