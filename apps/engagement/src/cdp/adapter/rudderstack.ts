// The RudderStack adapter: HTTP data-plane calls, plus the regulation endpoint for a suppression.
//
// NOT exercised against a real workspace — no RudderStack account exists (#553). Live use is on the launch
// checklist. Everything here is therefore built to be read and tested rather than trusted: the write key never
// leaves this object, a refusal is reduced to a status and an error name, and the request shape is asserted
// against an injected fetch.
//
// Shape (RudderStack HTTP API, same as Segment's): POST /v1/identify and /v1/track with
// `{ userId | anonymousId, event, properties | traits, timestamp, messageId }`, authenticated by the write key
// as HTTP Basic with an EMPTY password. A suppression is not a data-plane call: it is
// POST /v2/regulations on the control plane (`sourceIds`, `regulationType: "Suppress_With_Delete"`), which
// needs a personal access token rather than the write key — a different credential, so it is a separate option
// and the adapter refuses a suppression it cannot make rather than pretending one happened.

import type { CdpAdapter, CdpIdentifyCall, CdpSuppressCall, CdpTrackCall } from '../types.js';
import { CdpError } from '../types.js';

/** The slice of `fetch` this adapter uses, so a test injects one instead of opening a socket. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RudderStackOptions {
  /** The source write key. Environment only (`RUDDERSTACK_WRITE_KEY`); never a default, never logged. */
  writeKey: string;
  /** The data plane, e.g. `https://hosted.rudderlabs.example`. */
  dataPlaneUrl: string;
  /**
   * For suppressions only: the control-plane URL, a personal access token and the source ids to suppress in.
   * Without all three, `suppress` throws instead of silently doing nothing — an erasure that quietly fails is
   * the one failure this service must never hide.
   */
  regulation?: {
    controlPlaneUrl: string;
    accessToken: string;
    sourceIds: string[];
  };
  fetchImpl?: FetchLike;
}

export class RudderStackCdpAdapter implements CdpAdapter {
  readonly name = 'rudderstack';
  readonly #writeKey: string;
  readonly #dataPlaneUrl: string;
  readonly #regulation: RudderStackOptions['regulation'];
  readonly #fetch: FetchLike;

  constructor(opts: RudderStackOptions) {
    if (!opts.writeKey?.trim()) {
      throw new Error('rudderstack: RUDDERSTACK_WRITE_KEY is required');
    }
    if (!opts.dataPlaneUrl?.trim()) {
      throw new Error('rudderstack: a data plane URL is required');
    }
    this.#writeKey = opts.writeKey.trim();
    this.#dataPlaneUrl = opts.dataPlaneUrl.trim().replace(/\/+$/, '');
    this.#regulation = opts.regulation;
    this.#fetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async identify(call: CdpIdentifyCall): Promise<void> {
    await this.#post('/v1/identify', {
      ...identityOf(call),
      traits: call.traits,
      timestamp: call.timestamp,
      messageId: call.messageId,
    });
  }

  async track(call: CdpTrackCall): Promise<void> {
    await this.#post('/v1/track', {
      ...identityOf(call),
      event: call.event,
      properties: call.properties,
      timestamp: call.timestamp,
      messageId: call.messageId,
    });
  }

  async suppress(call: CdpSuppressCall): Promise<void> {
    const r = this.#regulation;
    if (!r) {
      // Loud on purpose: the caller asked for an erasure and this adapter cannot make one.
      throw new CdpError('rudderstack: suppression needs a control-plane token and source ids');
    }
    const id = call.identity.userId ?? call.identity.anonymousId;
    if (!id) throw new CdpError('rudderstack: suppression needs an identity');

    const url = `${r.controlPlaneUrl.replace(/\/+$/, '')}/v2/regulations`;
    const body = JSON.stringify({
      regulationType: 'Suppress_With_Delete',
      sourceIds: r.sourceIds,
      users: [call.identity.userId ? { userId: id } : { anonymousId: id }],
    });
    await this.#send(url, { authorization: `Bearer ${r.accessToken}` }, body, 'regulation');
  }

  async #post(path: string, payload: Record<string, unknown>): Promise<void> {
    // Basic auth, write key as the user and an empty password: `base64("<key>:")`.
    const basic = Buffer.from(`${this.#writeKey}:`).toString('base64');
    await this.#send(
      `${this.#dataPlaneUrl}${path}`,
      { authorization: `Basic ${basic}` },
      JSON.stringify(payload),
      path,
    );
  }

  async #send(
    url: string,
    auth: Record<string, string>,
    body: string,
    what: string,
  ): Promise<void> {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body,
      });
    } catch (err) {
      // A fetch failure's message can contain the URL, and the URL can contain the credential: name only.
      const name = err instanceof Error ? err.name : 'Error';
      throw new CdpError(`rudderstack ${what}: request failed ${name}`, { retryable: true });
    }
    if (!res.ok) {
      throw new CdpError(`rudderstack ${what}: HTTP ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
  }
}

/** RudderStack takes one of the two; `userId` wins when we know the customer. */
export function identityOf(call: {
  identity: { userId: string | null; anonymousId: string | null };
}): { userId: string } | { anonymousId: string } {
  if (call.identity.userId) return { userId: call.identity.userId };
  if (call.identity.anonymousId) return { anonymousId: call.identity.anonymousId };
  // The consumer drops an identity-less event long before this; a throw here is a programming error, loudly.
  throw new CdpError('rudderstack: a call needs a userId or an anonymousId');
}
