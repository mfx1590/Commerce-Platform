// Resend adapter (#360): `POST https://api.resend.com/emails` with Node's own `fetch`. No SDK — the call is one
// request, and a dependency that pins its own HTTP client and retry policy is more surface than the request.
//
// The key comes from the environment and is held in a closure: it is never on the instance, never in an error,
// never in a log. The test-mode proof (an order placed on the laptop → one email in the provider's test inbox)
// is the 2b gate; nothing here is exercised against the real API before the owner has an account.
import {
  TransportError,
  type DeliveryMeta,
  type RenderedEmail,
  type SendResult,
  type Transport,
} from '../types.js';

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface ResendTransportOptions {
  apiKey: string;
  /** Injected by tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export const RESEND_BASE_URL = 'https://api.resend.com';
export const RESEND_KEY_ENV = 'RESEND_API_KEY';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class ResendTransport implements Transport {
  readonly name = 'resend';
  readonly send: (email: RenderedEmail, meta: DeliveryMeta) => Promise<SendResult>;

  constructor(options: ResendTransportOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey === '') {
      throw new Error(
        `ResendTransport: ${RESEND_KEY_ENV} is not set (keys come from the environment only; see README)`,
      );
    }
    const doFetch: FetchLike =
      options.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
    const baseUrl = (options.baseUrl ?? RESEND_BASE_URL).replace(/\/$/, '');
    const timeoutMs = options.timeoutMs ?? 15_000;

    this.send = async (email, meta) => {
      const body = JSON.stringify({
        from: `${email.from.name} <${email.from.email}>`,
        to: [email.to],
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: [
          { name: 'kind', value: meta.kind },
          { name: 'store', value: meta.storeCode },
          { name: 'event_id', value: meta.eventId },
        ],
      });
      let res: FetchResponse;
      try {
        res = await doFetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            // Resend de-duplicates on this key for 24 h: a second attempt after a timeout is not a second email.
            'idempotency-key': `notifications/${meta.eventId}`,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new TransportError(
          `resend: ${err instanceof Error ? err.name : 'request failed'}`,
          true,
        );
      }
      if (!res.ok) {
        let label = 'error';
        try {
          const parsed = await res.json();
          if (isRecord(parsed) && typeof parsed.name === 'string') label = parsed.name;
        } catch {
          /* no body or not JSON — the status is the label */
        }
        throw new TransportError(
          `resend: HTTP ${res.status} ${label}`,
          res.status === 429 || res.status >= 500,
        );
      }
      const parsed = await res.json().catch(() => null);
      return {
        providerMessageId: isRecord(parsed) && typeof parsed.id === 'string' ? parsed.id : null,
      };
    };
  }
}
