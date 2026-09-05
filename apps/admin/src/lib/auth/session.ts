/**
 * Session encoding. Deliberately free of `next/headers` and `next/server` imports so the same code
 * runs in route handlers (Node runtime), in the middleware (Edge runtime) and in unit tests.
 *
 * The whole token set lives in an httpOnly cookie, AES-GCM encrypted with ADMIN_SESSION_SECRET.
 * Keycloak tokens routinely exceed the 4 KB per-cookie browser limit, so the sealed value is split
 * across numbered chunks (`admin_session.0`, `admin_session.1`, …) and reassembled on read.
 */

import { seal, unseal } from './crypto';

export const SESSION_COOKIE = 'admin_session';
/** Well under the 4096-byte per-cookie limit once the name and attributes are added. */
const CHUNK_SIZE = 3500;
/** Enough for ~21 KB of sealed tokens; also bounds how many stale chunks we clear. */
const MAX_CHUNKS = 6;

export interface SessionUser {
  /** Keycloak `sub`. Not the platform `staff_user.id` — the Admin API maps it in `GET /admin/me`. */
  subject: string;
  username: string;
  email: string;
  displayName: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  user: SessionUser;
}

/** Refresh this long before the access token actually expires. */
export const REFRESH_SKEW_MS = 60_000;

export function isExpiring(session: Session, now = Date.now()): boolean {
  return session.expiresAt - now <= REFRESH_SKEW_MS;
}

export async function sealSession(session: Session, secret: string): Promise<string> {
  return seal(JSON.stringify(session), secret);
}

export async function openSession(value: string, secret: string): Promise<Session | null> {
  const json = await unseal(value, secret);
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Session>;
  return (
    typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.idToken === 'string' &&
    typeof candidate.expiresAt === 'number' &&
    typeof candidate.user === 'object' &&
    candidate.user !== null &&
    typeof candidate.user.subject === 'string'
  );
}

export function chunkName(index: number): string {
  return `${SESSION_COOKIE}.${index}`;
}

export function splitIntoChunks(sealed: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < sealed.length; offset += CHUNK_SIZE) {
    chunks.push(sealed.slice(offset, offset + CHUNK_SIZE));
  }
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(`Session too large: ${chunks.length} chunks exceeds the ${MAX_CHUNKS} limit`);
  }
  return chunks;
}

/** Reassembles the sealed value, or null when the first chunk is missing. */
export function joinChunks(read: (name: string) => string | undefined): string | null {
  const parts: string[] = [];
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    const part = read(chunkName(index));
    if (part === undefined) break;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('');
}

export interface CookieAttributes {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge?: number;
}

export function cookieAttributes(secure: boolean, maxAgeSeconds?: number): CookieAttributes {
  const base: CookieAttributes = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  return maxAgeSeconds === undefined ? base : { ...base, maxAge: maxAgeSeconds };
}

export interface CookieWriter {
  set: (name: string, value: string, attributes: CookieAttributes) => void;
  delete: (name: string) => void;
}

/**
 * Writes the chunks the session needs and clears every chunk it does not, so a shrinking session
 * can never leave a stale tail behind that would corrupt the next read.
 */
export function writeSessionCookies(writer: CookieWriter, sealed: string, secure: boolean): void {
  const chunks = splitIntoChunks(sealed);
  chunks.forEach((chunk, index) => {
    writer.set(chunkName(index), chunk, cookieAttributes(secure));
  });
  for (let index = chunks.length; index < MAX_CHUNKS; index += 1) {
    writer.delete(chunkName(index));
  }
}

export function clearSessionCookies(writer: CookieWriter): void {
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    writer.delete(chunkName(index));
  }
}
