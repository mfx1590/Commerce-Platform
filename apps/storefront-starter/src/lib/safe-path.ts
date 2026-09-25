/**
 * The one definition of "a path on this site", used by every redirect that takes a target from
 * outside: the referral landing's `?to=`, and sign-in's `returnTo`.
 *
 * It lives in one module because it existed in two, and the second copy is what shipped the
 * open redirect below.
 *
 * **The defect this exists to prevent.** WHATWG URL parsing **strips tab, newline and carriage
 * return before parsing**, so a target that merely starts with a single `/` can still resolve to
 * another origin:
 *
 *     new URL('/\t/evil.example', 'https://shop.example').origin  // → 'https://evil.example'
 *
 * A guard that rejects `//` and backslashes does not see it, and `searchParams.get()` decodes
 * `%09`, `%0A` and `%0D` into those raw characters — so `?to=%2F%09%2Fevil.example` is enough. On a
 * publicly shared referral link that lends the brand's domain to someone else's page; on sign-in's
 * `returnTo` it hands a freshly authenticated customer to them.
 *
 * Control characters are therefore rejected outright, and **every caller also asserts the resolved
 * origin** (`isSameOrigin`) before redirecting. Two layers on purpose: the first is a rule about
 * strings and could be reasoned around again, the second is what the browser will actually do.
 */

/**
 * C0 controls, DEL, and the Unicode line separators a parser may also fold.
 *
 * Checked by code point rather than with a regular expression: a literal control character in a
 * regex literal is both an ESLint error (`no-control-regex`, rightly — it usually means a typo) and,
 * for U+2028, a syntax error, since it ends the line for the TypeScript parser. Naming the code
 * points says what is refused without depending on how the source file survives an editor.
 */
function hasControlOrSeparator(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

export function isSafeInternalPath(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || value === '') return false;
  // Anything a URL parser might strip, fold or reinterpret has no business in a path we trust.
  if (hasControlOrSeparator(value)) return false;
  if (!value.startsWith('/')) return false;
  // `//host` and `/\host` are protocol-relative: the browser reads them as another origin.
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  if (value.includes('\\')) return false;
  return true;
}

/**
 * The second layer: what the browser will actually resolve. Called after building the destination,
 * so a bypass of the string rule still cannot leave this origin.
 */
export function isSameOrigin(destination: URL, origin: string): boolean {
  try {
    return destination.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
