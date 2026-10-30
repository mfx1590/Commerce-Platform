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
// POST /v2/regulations on the control plane (`destinationIds`, `regulationType: "suppress_with_delete"` —
// the names and the casing come from the docs; see `suppress` below, #657), which needs a personal access
// token rather than the write key — a different credential, so it is a separate option and the adapter
// refuses a suppression it cannot make rather than pretending one happened.

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
   * For suppressions only: the control-plane URL, a personal access token and the DESTINATION ids to delete
   * from. Destinations rather than sources because that is what `suppress_with_delete` takes (#657; the docs
   * say a `sourceIds` there is an error). Without all three, `suppress` throws instead of silently doing
   * nothing — an erasure that quietly fails is the one failure this service must never hide.
   */
  regulation?: {
    controlPlaneUrl: string;
    accessToken: string;
    destinationIds: string[];
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

  /**
   * An erasure. It must reach EVERY profile this person has, which is the whole point of #657's HIGH
   * finding: the gate returns both ids for `customer.erased`, and this used to send `userId ?? anonymousId`
   * — one id — so in `analytics` mode a guest's hash-keyed profile survived the erasure.
   *
   * THE SHAPE COMES FROM THE DOCS, and they constrain it more than the issue assumed
   * (https://www.rudderstack.com/docs/api/user-suppression-api, read 2026-10-30):
   *   * `users` is an array of USERS, and "the userId field is mandatory for all users". There is no
   *     documented `anonymousId` key, so `users: [{userId}, {anonymousId}]` is not a shape this API accepts;
   *   * additional identifiers for the SAME person go beside `userId` in the same entry ("you can pass
   *     additional custom identifiers such as email in the users object"). Our hash is exactly that: the
   *     same person, known to the CDP under a second key;
   *   * `suppress_with_delete` takes `destinationIds`, NOT `sourceIds` — "specify only destinationIds with
   *     the suppress_with_delete regulation", otherwise the API answers an error. This code sent `sourceIds`
   *     with that regulation type, so the call was rejected outright.
   *
   * What is NOT possible, stated rather than papered over: a hash-only identity cannot be suppressed through
   * this API, because `userId` is mandatory. Sending the hash AS a `userId` would match userId-keyed
   * profiles and silently miss the anonymousId-keyed one — an erasure that reports success and deletes
   * nothing. So it throws, the event dead-letters, and a person sees it. It cannot happen today
   * (`customer.erased` always carries a customer_id; a guest who never registered produces no erasure at
   * all — the gap recorded in data/cdp/README.md), and when a guest-erasure path exists this is the line
   * that has to be answered first.
   */
  async suppress(call: CdpSuppressCall): Promise<void> {
    const r = this.#regulation;
    if (!r) {
      // Loud on purpose: the caller asked for an erasure and this adapter cannot make one.
      throw new CdpError(
        'rudderstack: suppression needs a control-plane token and destination ids',
      );
    }
    const { userId, anonymousId } = call.identity;
    if (!userId && !anonymousId) throw new CdpError('rudderstack: suppression needs an identity');
    if (!userId) {
      throw new CdpError(
        'rudderstack: cannot suppress an anonymousId-only identity — the regulation API requires a userId, ' +
          'and sending the hash as one would suppress a different profile',
      );
    }

    const url = `${r.controlPlaneUrl.replace(/\/+$/, '')}/v2/regulations`;
    const body = JSON.stringify({
      regulationType: 'suppress_with_delete',
      destinationIds: r.destinationIds,
      // TWO entries when both ids are known (#660 review, manager decision), because one is not enough and
      // the doc does not promise what the issue assumed:
      //   * `{ userId, email_hash }` — the customer-keyed profile, with the hash as a custom identifier
      //     beside the mandatory `userId`, which is the documented way to name one person by two keys;
      //   * `{ userId: <email_hash> }` — the GUEST-keyed profile. Nothing in the doc says a custom
      //     identifier is matched against `anonymousId`, and a guest's track calls carry the hash ONLY as
      //     `anonymousId`, so the first entry most likely leaves that profile in place. Naming the hash in
      //     the `userId` position is safe HERE because in this service a hash is never a customer id (it is
      //     a sha256 of an address, and customer ids are uuids), so it cannot collide with another person,
      //     and destinations that key users by `anonymousId` — Mixpanel's `distinct_id`, for instance — are
      //     then named exactly.
      // UNVERIFIED until a real workspace exists: no RudderStack account has ever received one of these, so
      // whether the second entry reaches the hash-keyed profile is reasoned, not observed (launch checklist).
      // Linking the two profiles on `identify` is a separate decision and deliberately not done here.
      users: [
        { userId, ...(anonymousId ? { email_hash: anonymousId } : {}) },
        ...(anonymousId ? [{ userId: anonymousId }] : []),
      ],
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
