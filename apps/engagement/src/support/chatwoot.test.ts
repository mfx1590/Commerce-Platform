// The Chatwoot receiver: signature, freshness, replay, and the hashing on arrival.
//
// Test secrets are WORDS (the gitleaks rule).

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createChatwootReceiver, hashEmail, signBody } from './chatwoot.js';
import type { SupportError } from './types.js';

const SECRET = 'chatwoot-webhook-secret-words-only';
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'conversation_created',
    created_at: '2026-10-23T11:59:30.000Z',
    account: { id: 7 },
    conversation: { id: 4242 },
    contact: { email: 'ada@example.test', name: 'Ada Lovelace' },
    ...over,
  });
}

function receiver(over: Partial<Parameters<typeof createChatwootReceiver>[0]> = {}) {
  return createChatwootReceiver({ secret: SECRET, now: () => NOW, ...over });
}

describe('hashEmail', () => {
  it('is sha256 of the lowercased, trimmed address', () => {
    expect(hashEmail('  Ada@Example.test ')).toBe(hashEmail('ada@example.test'));
    expect(hashEmail('ada@example.test')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEmail('ada@example.test')).not.toContain('ada');
  });
});

describe('the signature is a real HMAC', () => {
  it('is HMAC-SHA256 over the raw body, hex', () => {
    const body = payload();
    expect(signBody(SECRET, body)).toBe(
      createHmac('sha256', SECRET).update(body, 'utf8').digest('hex'),
    );
    expect(signBody(SECRET, body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is NOT the keyed hash the first version used (#573 review)', () => {
    // sha256(secret + '.' + body) is not an HMAC: no inner/outer padding, and it is the construction
    // length-extension attacks are written about. This asserts the old value is rejected.
    const body = payload();
    const keyedHash = createHash('sha256').update(`${SECRET}.${body}`).digest('hex');
    expect(signBody(SECRET, body)).not.toBe(keyedHash);
    expect(() => receiver().receive(body, keyedHash)).toThrow(/Bad signature/);
  });

  it('depends on the key: another secret gives another digest', () => {
    const body = payload();
    expect(signBody(SECRET, body)).not.toBe(signBody('another-secret-in-words', body));
  });

  it('accepts a bare hex digest OR a `sha256=` prefixed one, case-insensitively', () => {
    const body = payload();
    const hex = signBody(SECRET, body);
    expect(receiver().receive(body, hex).conversationId).toBe('4242');
    expect(receiver().receive(body, `sha256=${hex}`).conversationId).toBe('4242');
    expect(receiver().receive(body, hex.toUpperCase()).conversationId).toBe('4242');
    expect(receiver().receive(body, `  sha256=${hex}  `).conversationId).toBe('4242');
  });
});

describe('signature', () => {
  it('refuses to exist without a secret', () => {
    expect(() => createChatwootReceiver({ secret: '' })).toThrow(/CHATWOOT_WEBHOOK_SECRET/);
  });

  it('accepts a correctly signed delivery', () => {
    const body = payload();
    const link = receiver().receive(body, signBody(SECRET, body));
    expect(link.conversationId).toBe('4242');
    expect(link.accountId).toBe('7');
    expect(link.event).toBe('conversation_created');
  });

  it('401s a missing signature', () => {
    const err = (() => {
      try {
        receiver().receive(payload(), undefined);
      } catch (e) {
        return e as SupportError;
      }
    })();
    expect(err?.status).toBe(401);
    expect(err?.message).toBe('Missing signature');
  });

  it('401s a WRONG signature', () => {
    const body = payload();
    const err = (() => {
      try {
        receiver().receive(body, signBody('another-secret-in-words', body));
      } catch (e) {
        return e as SupportError;
      }
    })();
    expect(err?.status).toBe(401);
    expect(err?.code).toBe('unauthorized');
  });

  it('401s a signature of a DIFFERENT body (a tampered payload)', () => {
    const signature = signBody(SECRET, payload());
    const tampered = payload({ conversation: { id: 9999 } });
    expect(() => receiver().receive(tampered, signature)).toThrow(/Bad signature/);
  });

  it('401s a signature of the wrong length without throwing from the compare', () => {
    expect(() => receiver().receive(payload(), 'short')).toThrow(/Bad signature/);
  });
});

describe('payload shape', () => {
  it('400s a body that is not JSON', () => {
    const body = 'not json';
    expect(() => receiver().receive(body, signBody(SECRET, body))).toThrow(/not JSON/);
  });

  it('400s a payload with no conversation', () => {
    const body = payload({ conversation: undefined });
    expect(() => receiver().receive(body, signBody(SECRET, body))).toThrow(/no conversation/);
  });

  it('accepts a flat conversation_id as well as a nested one', () => {
    const body = payload({ conversation: undefined, conversation_id: 77 });
    expect(receiver().receive(body, signBody(SECRET, body)).conversationId).toBe('77');
  });

  it('400s a payload with no event', () => {
    const body = payload({ event: undefined });
    expect(() => receiver().receive(body, signBody(SECRET, body))).toThrow(/no event/);
  });

  it('REJECTS a payload with no usable timestamp rather than waving it through', () => {
    // Without a timestamp the freshness guard does not exist, so accepting one would mean no replay
    // protection at all for that delivery.
    const body = payload({ created_at: undefined, conversation: { id: 4242 } });
    const err = (() => {
      try {
        receiver().receive(body, signBody(SECRET, body));
      } catch (e) {
        return e as SupportError;
      }
    })();
    expect(err?.status).toBe(400);
    expect(err?.message).toMatch(/no usable timestamp/);
  });
});

describe('freshness', () => {
  it('accepts a delivery inside the window', () => {
    const body = payload({ created_at: '2026-10-23T11:56:00.000Z' });
    expect(receiver().receive(body, signBody(SECRET, body)).event).toBe('conversation_created');
  });

  it('401s a delivery older than the window', () => {
    const body = payload({ created_at: '2026-10-23T11:50:00.000Z' });
    const err = (() => {
      try {
        receiver().receive(body, signBody(SECRET, body));
      } catch (e) {
        return e as SupportError;
      }
    })();
    expect(err?.status).toBe(401);
    expect(err?.message).toMatch(/freshness window/);
  });

  it('401s a delivery from the FUTURE by more than the window (a skewed or forged clock)', () => {
    const body = payload({ created_at: '2026-10-23T12:10:00.000Z' });
    expect(() => receiver().receive(body, signBody(SECRET, body))).toThrow(/freshness window/);
  });

  it('honours a configured window', () => {
    const body = payload({ created_at: '2026-10-23T11:50:00.000Z' });
    const r = receiver({ maxAgeMs: 20 * 60 * 1000 });
    expect(r.receive(body, signBody(SECRET, body)).conversationId).toBe('4242');
  });
});

describe('replay', () => {
  it('409s the SAME delivery sent twice', () => {
    const r = receiver();
    const body = payload();
    const signature = signBody(SECRET, body);
    expect(r.receive(body, signature).conversationId).toBe('4242');

    const err = (() => {
      try {
        r.receive(body, signature);
      } catch (e) {
        return e as SupportError;
      }
    })();
    expect(err?.status).toBe(409);
    expect(err?.code).toBe('replayed');
  });

  it('catches a re-send whose body was cosmetically changed', () => {
    // The digest is over (conversation, event, timestamp), not the body, so re-ordering or padding the JSON
    // does not buy a second delivery. Each needs its own valid signature, which an attacker replaying a
    // captured body does not have — but a well-meaning retry with a re-serialised body is still one delivery.
    const r = receiver();
    const first = payload();
    r.receive(first, signBody(SECRET, first));

    const resent = JSON.stringify({
      conversation: { id: 4242 },
      event: 'conversation_created',
      created_at: '2026-10-23T11:59:30.000Z',
      account: { id: 7 },
      contact: { email: 'ada@example.test', name: 'Ada Lovelace' },
    });
    expect(() => r.receive(resent, signBody(SECRET, resent))).toThrow(/already been received/);
  });

  it('lets a genuinely different delivery of the same conversation through', () => {
    const r = receiver();
    const a = payload();
    r.receive(a, signBody(SECRET, a));
    const b = payload({ event: 'message_created' });
    expect(r.receive(b, signBody(SECRET, b)).event).toBe('message_created');
  });

  it('bounds its memory, dropping the oldest digest', () => {
    const r = receiver({ seenMax: 2 });
    for (const id of [1, 2, 3]) {
      const body = payload({ conversation: { id } });
      r.receive(body, signBody(SECRET, body));
    }
    expect(r.seenCount()).toBeLessThanOrEqual(2);
    // The first conversation has been forgotten, so its delivery would be accepted again — the documented
    // limit of an in-memory guard, and why the stub has no side effect to replay.
    const first = payload({ conversation: { id: 1 } });
    expect(r.receive(first, signBody(SECRET, first)).conversationId).toBe('1');
  });
});

describe('the contact address', () => {
  it('is HASHED on arrival and never returned raw', () => {
    const body = payload();
    const link = receiver().receive(body, signBody(SECRET, body));
    expect(link.emailHash).toBe(hashEmail('ada@example.test'));
    const text = JSON.stringify(link);
    expect(text).not.toContain('ada@example.test');
    expect(text).not.toContain('Ada Lovelace');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  it('reads the sender from meta when there is no top-level contact', () => {
    const body = payload({ contact: undefined, meta: { sender: { email: 'grace@example.test' } } });
    expect(receiver().receive(body, signBody(SECRET, body)).emailHash).toBe(
      hashEmail('grace@example.test'),
    );
  });

  it('is null when the payload carries no address, rather than an empty hash', () => {
    const body = payload({ contact: { name: 'Ada Lovelace' } });
    expect(receiver().receive(body, signBody(SECRET, body)).emailHash).toBeNull();
  });
});
