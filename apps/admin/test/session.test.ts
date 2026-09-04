import { describe, expect, it } from 'vitest';
import { codeChallengeS256, seal, unseal } from '@/lib/auth/crypto';
import type { CookieAttributes, Session } from '@/lib/auth/session';
import {
  chunkName,
  clearSessionCookies,
  isExpiring,
  joinChunks,
  openSession,
  sealSession,
  splitIntoChunks,
  writeSessionCookies,
} from '@/lib/auth/session';

const SECRET = 'test-secret-at-least-32-characters-long';

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    idToken: 'id-token',
    expiresAt: Date.now() + 300_000,
    user: {
      subject: 'sub-1',
      username: 'store-admin',
      email: 'store-admin@example.com',
      displayName: 'Store Admin',
    },
    ...overrides,
  };
}

/** Stands in for NextResponse.cookies / RequestCookies in the middleware and route handlers. */
function cookieJar() {
  const values = new Map<string, string>();
  return {
    values,
    set: (name: string, value: string, _attributes: CookieAttributes) => {
      values.set(name, value);
    },
    delete: (name: string) => {
      values.delete(name);
    },
    read: (name: string) => values.get(name),
  };
}

describe('session sealing', () => {
  it('round-trips a session through the encrypted cookie value', async () => {
    const original = session();
    const sealed = await sealSession(original, SECRET);

    expect(sealed).not.toContain('access-token');
    await expect(openSession(sealed, SECRET)).resolves.toEqual(original);
  });

  it('returns null for a value sealed with a different secret', async () => {
    const sealed = await sealSession(session(), SECRET);
    await expect(openSession(sealed, 'a-completely-different-secret-value')).resolves.toBeNull();
  });

  it('returns null for a tampered value rather than throwing', async () => {
    const sealed = await sealSession(session(), SECRET);
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    await expect(openSession(tampered, SECRET)).resolves.toBeNull();
  });

  it('rejects a decryptable payload that is not a session', async () => {
    const sealed = await seal(JSON.stringify({ hello: 'world' }), SECRET);
    await expect(openSession(sealed, SECRET)).resolves.toBeNull();
  });

  it('produces a different ciphertext each time (fresh IV)', async () => {
    const value = session();
    const first = await sealSession(value, SECRET);
    const second = await sealSession(value, SECRET);
    expect(first).not.toEqual(second);
  });
});

describe('cookie chunking', () => {
  it('splits and rejoins a value larger than one cookie', () => {
    const sealed = 'x'.repeat(9000);
    const chunks = splitIntoChunks(sealed);
    expect(chunks.length).toBeGreaterThan(1);

    const jar = cookieJar();
    writeSessionCookies(jar, sealed, false);
    expect(joinChunks(jar.read)).toEqual(sealed);
  });

  it('throws rather than silently truncating an oversized session', () => {
    expect(() => splitIntoChunks('x'.repeat(3500 * 7))).toThrow(/exceeds/);
  });

  it('clears stale chunks when the session shrinks', () => {
    const jar = cookieJar();
    writeSessionCookies(jar, 'y'.repeat(9000), false);
    expect(jar.values.has(chunkName(2))).toBe(true);

    writeSessionCookies(jar, 'z'.repeat(10), false);
    expect(jar.values.has(chunkName(1))).toBe(false);
    expect(joinChunks(jar.read)).toEqual('z'.repeat(10));
  });

  it('reads as signed-out once the cookies are cleared', () => {
    const jar = cookieJar();
    writeSessionCookies(jar, 'value', false);
    clearSessionCookies(jar);
    expect(joinChunks(jar.read)).toBeNull();
  });

  it('marks cookies httpOnly and secure only when asked', () => {
    const captured: CookieAttributes[] = [];
    writeSessionCookies(
      { set: (_n, _v, attributes) => captured.push(attributes), delete: () => {} },
      'value',
      true,
    );
    expect(captured[0]).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
  });
});

describe('expiry', () => {
  it('treats a token inside the refresh skew as expiring', () => {
    const now = Date.now();
    expect(isExpiring(session({ expiresAt: now + 30_000 }), now)).toBe(true);
    expect(isExpiring(session({ expiresAt: now + 120_000 }), now)).toBe(false);
  });
});

describe('PKCE', () => {
  it('derives the S256 challenge from the verifier (RFC 7636 test vector)', async () => {
    await expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toEqual(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('seals and unseals arbitrary strings', async () => {
    const sealed = await seal('hello', SECRET);
    await expect(unseal(sealed, SECRET)).resolves.toEqual('hello');
  });
});
