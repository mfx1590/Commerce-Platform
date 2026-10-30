// The `crm-sync` client-credentials provider (#646). No network: the fetch seam and the clock are injected,
// so the cache, the expiry and the in-flight sharing are asserted rather than waited for.

import { describe, expect, it } from 'vitest';
import { createClientCredentialsProvider, type TokenFetch } from './token.js';
import { CrmError } from './types.js';

const TOKEN_URL = 'http://localhost:8180/realms/staff/protocol/openid-connect/token';
// A word, never a secret-shaped literal: gitleaks scans every branch's whole history.
const SECRET = 'words-only-not-a-real-secret';

function fakeKeycloak(
  answers: { ok?: boolean; status?: number; body?: unknown }[] = [{ body: {} }],
) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fetchImpl: TokenFetch = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return {
      ok: a.ok ?? true,
      status: a.status ?? 200,
      json: async () => a.body ?? {},
    };
  };
  return { fetchImpl, calls };
}

const granted = (token: string, expiresIn = 300) => ({
  body: { access_token: token, expires_in: expiresIn },
});

describe('createClientCredentialsProvider', () => {
  it('exchanges the secret for a token, as a form POST to the realm token endpoint', async () => {
    const kc = fakeKeycloak([granted('token-one')]);
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      fetchImpl: kc.fetchImpl,
    });

    expect(provider.name).toBe('client_credentials');
    expect(await provider.token()).toBe('token-one');
    expect(kc.calls).toHaveLength(1);
    expect(kc.calls[0]!.url).toBe(TOKEN_URL);
    expect(kc.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(kc.calls[0]!.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('crm-sync');
    expect(form.get('client_secret')).toBe(SECRET);
  });

  it('CACHES the token until shortly before it expires, then exchanges once more', async () => {
    let t = 0;
    const kc = fakeKeycloak([granted('first', 300), granted('second', 300)]);
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      fetchImpl: kc.fetchImpl,
      now: () => t,
      skewMs: 30_000,
    });

    expect(await provider.token()).toBe('first');
    t = 100_000; // well inside the 300 s lifetime
    expect(await provider.token()).toBe('first');
    expect(kc.calls).toHaveLength(1);

    // Inside the skew window the old token is NOT handed out: a token that expires during the Admin API
    // call it was fetched for is the same as no token.
    t = 280_000;
    expect(await provider.token()).toBe('second');
    expect(kc.calls).toHaveLength(2);
  });

  it('shares ONE exchange between concurrent callers', async () => {
    const kc = fakeKeycloak([granted('shared')]);
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      fetchImpl: kc.fetchImpl,
    });

    // A batch of events asks at once. One exchange, not one per event.
    const tokens = await Promise.all([
      provider.token(),
      provider.token(),
      provider.token(),
      provider.token(),
    ]);
    expect(tokens).toEqual(['shared', 'shared', 'shared', 'shared']);
    expect(kc.calls).toHaveLength(1);
  });

  it('does not cache a FAILURE, and the next call tries again', async () => {
    const kc = fakeKeycloak([
      { ok: false, status: 401, body: { error: 'invalid_client' } },
      granted('later'),
    ]);
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      fetchImpl: kc.fetchImpl,
    });

    await expect(provider.token()).rejects.toThrow(CrmError);
    expect(await provider.token()).toBe('later');
    expect(kc.calls).toHaveLength(2);
  });

  it('is RETRYABLE on a refusal, and its message carries the status and Keycloak code only', async () => {
    const kc = fakeKeycloak([
      {
        ok: false,
        status: 401,
        body: { error: 'invalid_client', error_description: `secret was ${SECRET}` },
      },
    ]);
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      fetchImpl: kc.fetchImpl,
    });

    const err = await provider.token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect((err as CrmError).retryable).toBe(true);
    // THE ASSERTION THAT MATTERS: a wrong secret must not put the secret in the logs. `error_description`
    // echoes input, so it is not carried — here it even contains the secret, which is exactly the shape of
    // the accident this guards against.
    expect((err as CrmError).message).toContain('401');
    expect((err as CrmError).message).toContain('invalid_client');
    expect((err as CrmError).message).not.toContain(SECRET);
  });

  it('turns an unreachable identity provider into a retryable error that carries nothing', async () => {
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      // A fetch that throws with the request in the message, as a real one can.
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED — body client_secret=${SECRET}`);
      },
    });

    const err = await provider.token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect((err as CrmError).retryable).toBe(true);
    expect((err as CrmError).message).not.toContain(SECRET);
    expect((err as CrmError).message).toContain('could not be reached');
  });

  it('treats a 200 with no access_token as a refusal rather than an empty bearer', async () => {
    const kc = fakeKeycloak([{ ok: true, status: 200, body: { expires_in: 300 } }]);
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      fetchImpl: kc.fetchImpl,
    });
    await expect(provider.token()).rejects.toThrow(/HTTP 200/);
  });

  it('falls back to a short lifetime when the response omits expires_in', async () => {
    let t = 0;
    const kc = fakeKeycloak([{ body: { access_token: 'no-expiry' } }, granted('after')]);
    const provider = createClientCredentialsProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'crm-sync',
      clientSecret: SECRET,
      fetchImpl: kc.fetchImpl,
      now: () => t,
    });
    expect(await provider.token()).toBe('no-expiry');
    // 60 s assumed, 30 s skew: at 31 s it must be re-fetched rather than trusted indefinitely.
    t = 31_000;
    expect(await provider.token()).toBe('after');
  });
});
