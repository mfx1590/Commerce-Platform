import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Preview mode: an httpOnly cookie whose value is an HMAC over the dataset and an expiry, signed
 * with `SANITY_PREVIEW_SECRET`. Nothing in the cookie is secret and nothing in it can be forged
 * without the secret; the read token itself never leaves the server.
 *
 * Pure functions here; `handlers.ts` turns them into responses and `index.ts` reads the cookie.
 */

export const PREVIEW_COOKIE = 'cms_preview';
export const PREVIEW_MAX_AGE_SECONDS = 60 * 60 * 2;

function hmac(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('base64url');
}

/** Constant-time comparison; `null`/empty never matches (an unset secret must not equal ""). */
export function secretsMatch(expected: string | null, given: string | null): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signPreviewToken(secret: string, dataset: string, expiresAt: number): string {
  return `${expiresAt}.${hmac(secret, `${dataset}|${expiresAt}`)}`;
}

export function verifyPreviewToken(
  secret: string | null,
  dataset: string,
  token: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!secret || !token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return secretsMatch(signPreviewToken(secret, dataset, expiresAt), token);
}

/**
 * Only a same-site path may be the redirect target: an open redirect on the preview link would hand
 * an editor to somebody else's site. `//host` and backslash tricks are rejected too.
 */
export function safeRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  return value;
}

export interface CookieAttributes {
  maxAge: number;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, attrs: CookieAttributes): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${attrs.maxAge}`,
  ];
  if (attrs.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Reads one cookie out of a `Cookie` header without a parser dependency. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
