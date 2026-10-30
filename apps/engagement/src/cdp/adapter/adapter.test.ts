// The CDP adapters: the in-memory one, and RudderStack against an injected fetch.
//
// Test keys are WORDS, never digit/hex tails (the gitleaks rule in Memory-main).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CdpError,
  sendCall,
  type CdpCall,
  type CdpIdentifyCall,
  type CdpTrackCall,
} from '../types.js';
import { MemoryCdpAdapter } from './memory.js';
import { identityOf, RudderStackCdpAdapter, type FetchLike } from './rudderstack.js';

const CUSTOMER = '77777777-7777-4777-8777-777777777777';
// Computed, never a committed 64-hex literal (the gitleaks rule in Memory-main).
const EMAIL_HASH = createHash('sha256').update('adapter-fixture@example.test').digest('hex');
const WRITE_KEY = 'write-key-words-only';
const TOKEN = 'control-plane-token-words-only';
const DATA_PLANE = 'https://dataplane.rudderstack.example';
const CONTROL_PLANE = 'https://api.rudderstack.example';

const identify: CdpIdentifyCall = {
  kind: 'identify',
  identity: { userId: CUSTOMER, anonymousId: null },
  traits: { customer_id: CUSTOMER, status: 'registered', store_code: 'brand-a' },
  timestamp: '2026-10-23T10:00:00.000Z',
  messageId: '11111111-1111-4111-8111-111111111111',
};

const track: CdpTrackCall = {
  kind: 'track',
  event: 'Order Completed',
  identity: { userId: CUSTOMER, anonymousId: null },
  properties: {
    order_id: '22222222-2222-4222-8222-222222222222',
    total_minor: 10494,
    currency: 'EUR',
  },
  timestamp: '2026-10-23T10:00:00.000Z',
  messageId: '33333333-3333-4333-8333-333333333333',
};

const suppress: CdpCall = {
  kind: 'suppress',
  identity: { userId: CUSTOMER, anonymousId: null },
  timestamp: '2026-10-23T10:00:00.000Z',
  messageId: '44444444-4444-4444-8444-444444444444',
};

function recorder(
  reply: { ok: boolean; status: number; body?: string } = { ok: true, status: 200 },
) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: reply.ok, status: reply.status, text: async () => reply.body ?? '' };
  };
  return { calls, fetchImpl };
}

describe('memory adapter', () => {
  it('records each kind separately and in arrival order', async () => {
    const a = new MemoryCdpAdapter();
    expect(a.name).toBe('memory');
    await sendCall(a, identify);
    await sendCall(a, track);
    await sendCall(a, suppress);

    expect(a.identifies).toHaveLength(1);
    expect(a.tracks).toHaveLength(1);
    expect(a.suppressions).toHaveLength(1);
    expect(a.count).toBe(3);
    expect(a.all.map((c) => c.kind)).toEqual(['identify', 'track', 'suppress']);
  });

  it('RECORDS BOTH ids of a suppression, so a test can see the whole erasure (#657)', async () => {
    const a = new MemoryCdpAdapter();
    await a.suppress({
      ...suppress,
      kind: 'suppress',
      identity: { userId: CUSTOMER, anonymousId: EMAIL_HASH },
    });
    // Not "an id was suppressed" but "these ids were": the HIGH finding of #657 was a suppression that
    // carried one id, and a recorder that kept only one could not have shown it.
    expect(a.suppressions[0]!.identity).toEqual({ userId: CUSTOMER, anonymousId: EMAIL_HASH });
    expect(a.isSuppressed(CUSTOMER)).toBe(true);
    expect(a.isSuppressed(EMAIL_HASH)).toBe(true);
  });

  it('answers whether an identity was suppressed, by either key', async () => {
    const a = new MemoryCdpAdapter();
    expect(a.isSuppressed(CUSTOMER)).toBe(false);
    await a.suppress({ ...suppress, kind: 'suppress' });
    expect(a.isSuppressed(CUSTOMER)).toBe(true);
    expect(a.isSuppressed('someone-else')).toBe(false);

    const b = new MemoryCdpAdapter();
    await b.suppress({
      ...suppress,
      kind: 'suppress',
      identity: { userId: null, anonymousId: 'hash-alpha' },
    });
    expect(b.isSuppressed('hash-alpha')).toBe(true);
  });

  it('fails every kind when asked to, so retry paths are testable', async () => {
    const a = new MemoryCdpAdapter();
    a.failWith = new Error('boom');
    await expect(a.identify(identify)).rejects.toThrow('boom');
    await expect(a.track(track)).rejects.toThrow('boom');
    await expect(a.suppress({ ...suppress, kind: 'suppress' })).rejects.toThrow('boom');
    expect(a.count).toBe(0);
  });

  it('reset clears the record and the failure', async () => {
    const a = new MemoryCdpAdapter();
    await a.track(track);
    a.failWith = new Error('boom');
    a.reset();
    expect(a.count).toBe(0);
    await a.track(track);
    expect(a.count).toBe(1);
  });
});

describe('sendCall', () => {
  it('routes each kind to its own method', async () => {
    const a = new MemoryCdpAdapter();
    for (const call of [identify, track, suppress]) await sendCall(a, call);
    expect([a.identifies.length, a.tracks.length, a.suppressions.length]).toEqual([1, 1, 1]);
  });
});

describe('identityOf', () => {
  it('prefers the customer id and falls back to the hash', () => {
    expect(identityOf({ identity: { userId: CUSTOMER, anonymousId: 'hash-alpha' } })).toEqual({
      userId: CUSTOMER,
    });
    expect(identityOf({ identity: { userId: null, anonymousId: 'hash-alpha' } })).toEqual({
      anonymousId: 'hash-alpha',
    });
  });

  it('refuses a call with no identity at all', () => {
    expect(() => identityOf({ identity: { userId: null, anonymousId: null } })).toThrow(CdpError);
  });
});

describe('rudderstack adapter', () => {
  it('refuses to exist without a write key or a data plane', () => {
    expect(() => new RudderStackCdpAdapter({ writeKey: '', dataPlaneUrl: DATA_PLANE })).toThrow(
      /RUDDERSTACK_WRITE_KEY/,
    );
    expect(() => new RudderStackCdpAdapter({ writeKey: WRITE_KEY, dataPlaneUrl: ' ' })).toThrow(
      /data plane URL/,
    );
  });

  it('posts identify with the key as HTTP Basic and an empty password', async () => {
    const r = recorder();
    const a = new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: DATA_PLANE,
      fetchImpl: r.fetchImpl,
    });
    expect(a.name).toBe('rudderstack');
    await a.identify(identify);

    expect(r.calls[0]!.url).toBe(`${DATA_PLANE}/v1/identify`);
    const expected = Buffer.from(`${WRITE_KEY}:`).toString('base64');
    expect(r.calls[0]!.headers.authorization).toBe(`Basic ${expected}`);
    expect(JSON.parse(r.calls[0]!.body)).toEqual({
      userId: CUSTOMER,
      traits: identify.traits,
      timestamp: identify.timestamp,
      messageId: identify.messageId,
    });
  });

  it('posts track with the event name, properties and the outbox id as messageId', async () => {
    const r = recorder();
    const a = new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: DATA_PLANE,
      fetchImpl: r.fetchImpl,
    });
    await a.track(track);
    expect(r.calls[0]!.url).toBe(`${DATA_PLANE}/v1/track`);
    expect(JSON.parse(r.calls[0]!.body)).toEqual({
      userId: CUSTOMER,
      event: 'Order Completed',
      properties: track.properties,
      timestamp: track.timestamp,
      messageId: track.messageId,
    });
  });

  it('sends anonymousId when there is no customer id', async () => {
    const r = recorder();
    const a = new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: DATA_PLANE,
      fetchImpl: r.fetchImpl,
    });
    await a.track({ ...track, identity: { userId: null, anonymousId: 'hash-alpha' } });
    const body = JSON.parse(r.calls[0]!.body);
    expect(body.anonymousId).toBe('hash-alpha');
    expect(body.userId).toBeUndefined();
  });

  it('trims a trailing slash off the data plane rather than posting a double slash', async () => {
    const r = recorder();
    const a = new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: `${DATA_PLANE}/`,
      fetchImpl: r.fetchImpl,
    });
    await a.track(track);
    expect(r.calls[0]!.url).toBe(`${DATA_PLANE}/v1/track`);
  });

  it('REFUSES a suppression it cannot make, instead of pretending', async () => {
    const r = recorder();
    const a = new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: DATA_PLANE,
      fetchImpl: r.fetchImpl,
    });
    await expect(a.suppress({ ...suppress, kind: 'suppress' })).rejects.toThrow(
      /control-plane token and destination ids/,
    );
    expect(r.calls).toHaveLength(0);
  });

  /** The regulation adapter, with the destination ids `suppress_with_delete` documents (#657). */
  const withRegulation = (r: ReturnType<typeof recorder>) =>
    new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: DATA_PLANE,
      fetchImpl: r.fetchImpl,
      regulation: {
        controlPlaneUrl: CONTROL_PLANE,
        accessToken: TOKEN,
        destinationIds: ['destination-alpha'],
      },
    });

  it('suppresses a customer id as a suppress_with_delete regulation on the DESTINATIONS', async () => {
    // The names and the casing are the documented ones: `suppress_with_delete` takes `destinationIds`, and
    // naming sources there is an error. This used to send `sourceIds` with `Suppress_With_Delete`, so the
    // call was rejected outright (#657).
    const r = recorder();
    await withRegulation(r).suppress({ ...suppress, kind: 'suppress' });

    expect(r.calls[0]!.url).toBe(`${CONTROL_PLANE}/v2/regulations`);
    expect(r.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(r.calls[0]!.body)).toEqual({
      regulationType: 'suppress_with_delete',
      destinationIds: ['destination-alpha'],
      users: [{ userId: CUSTOMER }],
    });
  });

  it('suppresses BOTH ids in one regulation when the erasure knows both (#657, HIGH)', async () => {
    // The finding: the gate returns both ids for `customer.erased`, and this sent `userId ?? anonymousId` —
    // so in `analytics` mode the guest-period profile, keyed by the hash, survived the erasure. The hash
    // travels beside the mandatory `userId` as a custom identifier, which is how the API expresses "the same
    // person, known by a second key".
    const r = recorder();
    await withRegulation(r).suppress({
      ...suppress,
      kind: 'suppress',
      identity: { userId: CUSTOMER, anonymousId: EMAIL_HASH },
    });

    const body = JSON.parse(r.calls[0]!.body) as { users: Record<string, string>[] };
    expect(body.users).toEqual([{ userId: CUSTOMER, email_hash: EMAIL_HASH }]);
    // One regulation, not two: both keys name one person.
    expect(r.calls).toHaveLength(1);
  });

  it('REFUSES a hash-only erasure rather than suppressing the wrong profile (#657)', async () => {
    // `userId` is mandatory in the regulation API and `anonymousId` is not a documented key, so there is no
    // way to erase a hash-keyed profile through it. Sending the hash AS a userId would match a different
    // profile and report success — an erasure that deletes nothing. It throws, the event dead-letters, and a
    // person sees it. Unreachable today: `customer.erased` always carries a customer_id.
    const r = recorder();
    await expect(
      withRegulation(r).suppress({
        ...suppress,
        kind: 'suppress',
        identity: { userId: null, anonymousId: EMAIL_HASH },
      }),
    ).rejects.toThrow(/requires a userId/);
    expect(r.calls).toHaveLength(0);
  });

  it('a refusal is a CdpError with the status only, and 429/5xx are retryable', async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
      [401, false],
    ] as [number, boolean][]) {
      const r = recorder({ ok: false, status, body: '<html>the write key was ...</html>' });
      const a = new RudderStackCdpAdapter({
        writeKey: WRITE_KEY,
        dataPlaneUrl: DATA_PLANE,
        fetchImpl: r.fetchImpl,
      });
      const err = (await a.track(track).catch((e: unknown) => e)) as CdpError;
      expect(err).toBeInstanceOf(CdpError);
      expect(err.message).toBe(`rudderstack /v1/track: HTTP ${status}`);
      expect(err.retryable).toBe(retryable);
      // The body is never in the error: it can echo the payload or the credential back.
      expect(err.message).not.toContain('html');
      expect(err.message).not.toContain(WRITE_KEY);
    }
  });

  it('a thrown fetch never leaks the URL or the key into the error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError(`fetch failed for ${DATA_PLANE}/v1/track?key=${WRITE_KEY}`);
    };
    const a = new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: DATA_PLANE,
      fetchImpl,
    });
    const err = (await a.track(track).catch((e: unknown) => e)) as CdpError;
    expect(err.message).toBe('rudderstack /v1/track: request failed TypeError');
    expect(err.message).not.toContain(WRITE_KEY);
    expect(err.retryable).toBe(true);
  });

  it('keeps the write key out of the object and off every request body', async () => {
    const r = recorder();
    const a = new RudderStackCdpAdapter({
      writeKey: WRITE_KEY,
      dataPlaneUrl: DATA_PLANE,
      fetchImpl: r.fetchImpl,
    });
    await a.identify(identify);
    expect(JSON.stringify(a)).not.toContain(WRITE_KEY);
    expect(r.calls[0]!.body).not.toContain(WRITE_KEY);
    // It is in the Authorization header and nowhere else — base64, not plaintext.
    expect(r.calls[0]!.headers.authorization).not.toContain(WRITE_KEY);
  });
});
