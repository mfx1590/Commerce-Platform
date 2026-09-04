/**
 * Web Crypto helpers shared by the route handlers (Node runtime) and the middleware (Edge runtime).
 * Only `globalThis.crypto` is used, so nothing here depends on `node:crypto`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Returns `Uint8Array<ArrayBuffer>` rather than the default `Uint8Array<ArrayBufferLike>`:
 * TypeScript 5.7 narrowed `BufferSource`, and a possibly-shared buffer is not assignable to it.
 */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** SHA-256 so any secret length yields a valid 256-bit AES key. */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** AES-GCM with a fresh 96-bit IV prefixed to the ciphertext. */
export async function seal(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  );
  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.length);
  return toBase64Url(payload);
}

/** Returns null for anything that does not decrypt — a tampered or stale cookie is just "signed out". */
export async function unseal(value: string, secret: string): Promise<string | null> {
  try {
    const payload = fromBase64Url(value);
    if (payload.length <= 12) return null;
    const key = await deriveKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.subarray(0, 12) },
      key,
      payload.subarray(12),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

/** PKCE (RFC 7636) S256: the verifier is 43–128 unreserved characters. */
export function createCodeVerifier(): string {
  return randomBase64Url(32);
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}
