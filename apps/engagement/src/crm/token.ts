// The real Admin API principal for CRM sync: the `crm-sync` confidential service account (#565, built by
// #626/#635), exchanged for a bearer token through Keycloak's client-credentials grant.
//
// Until now `client_credentials` threw and `mock` was the default, so a deploy with `NODE_ENV` unset ran on
// the dev stand-in and every consented CRM event dead-lettered against the real core (#646, medium). This is
// that provider.
//
// WHAT IT IS CAREFUL ABOUT, in order of how much it would cost to get wrong:
//   * the SECRET and the TOKEN never leave this module. Nothing here logs, and the only thing a failure
//     carries outward is the HTTP status plus Keycloak's short `error` code (`invalid_client`,
//     `unauthorized_client`) — never `error_description`, never the body, never a header;
//   * one token is cached until shortly before it expires, and the IN-FLIGHT fetch is cached too, so a batch
//     of events does one exchange rather than one per event (the concurrency half of the same idea #590's
//     review raised about `warm()`);
//   * a token failure is RETRYABLE. A wrong secret looks exactly like a Keycloak restart from here, and the
//     consumer's retries plus the dead-letter queue are the right place for that decision, not a crash.
//
// The client is READ-ONLY by code (auth-sdk's `READ_ONLY_SERVICE_CLIENTS`): the staff verifier refuses any
// non-GET from it before permissions are even consulted. Its reach is OpenFGA tuples on its own
// `staff_user` row — `support` on brand A only — so a token from here can read exactly the customers the
// tuples allow and nothing else.

import { CrmError, type TokenProvider } from './types.js';

/** The slice of `fetch` this needs: a form POST with a timeout. */
export type TokenFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClientCredentialsOptions {
  /** The realm's token endpoint, built in `config.ts` from `KEYCLOAK_URL` and the staff realm. */
  tokenUrl: string;
  clientId: string;
  /** From `CRM_SYNC_CLIENT_SECRET` (Vault in production). Never logged, never in an error. */
  clientSecret: string;
  fetchImpl?: TokenFetch;
  now?: () => number;
  timeoutMs?: number;
  /** Refresh this long before the token actually expires. */
  skewMs?: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

export function createClientCredentialsProvider(opts: ClientCredentialsOptions): TokenProvider {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as TokenFetch);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  // 30 s: comfortably longer than one Admin API call, so a token handed out is still valid when it arrives.
  const skewMs = opts.skewMs ?? 30_000;

  let cached: { value: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function exchange(): Promise<string> {
    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      res = await doFetch(opts.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
        }).toString(),
        ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch {
      // The error itself is dropped on purpose: a fetch error can carry the request, and the request carries
      // the secret. The class and the fact that it is retryable are all a consumer needs.
      throw new CrmError('crm-sync token: the identity provider could not be reached', {
        retryable: true,
      });
    }

    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token) {
      // A wrong secret, a disabled client and a Keycloak restart are indistinguishable from here, and all
      // three are an operator's problem rather than this event's: retryable, then the dead-letter queue.
      // `error` is Keycloak's short code; `error_description` is not carried, because it echoes input.
      const code = typeof body.error === 'string' ? ` (${body.error})` : '';
      throw new CrmError(`crm-sync token: HTTP ${res.status}${code}`, { retryable: true });
    }

    const lifetimeMs = (typeof body.expires_in === 'number' ? body.expires_in : 60) * 1000;
    cached = { value: body.access_token, expiresAt: now() + lifetimeMs };
    return body.access_token;
  }

  return {
    name: 'client_credentials',
    async token(): Promise<string> {
      if (cached && cached.expiresAt - now() > skewMs) return cached.value;
      // One exchange for however many callers arrive while it is in flight: a batch of 50 events must not
      // open 50 token requests, and a failure must not be cached.
      inFlight ??= exchange().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
