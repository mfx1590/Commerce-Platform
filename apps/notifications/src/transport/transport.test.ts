// Transport and configuration tests (#360). No database, no network: the dev sink writes into a temp directory
// and the Resend adapter talks to an injected fetch.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { TransportError, type DeliveryMeta, type RenderedEmail } from '../types.js';
import { DevSinkTransport } from './dev-sink.js';
import { createTransport } from './index.js';
import { ResendTransport, type FetchInit, type FetchLike } from './resend.js';

const email: RenderedEmail = {
  from: { name: 'Brand A', email: 'orders@brand-a.example' },
  to: 'ada@example.test',
  replyTo: null,
  subject: 'Your Brand A order #1042 is confirmed',
  text: 'Hi Ada,\n\nThank you.',
  html: '<p>Hi Ada,</p>',
};
const meta: DeliveryMeta = {
  eventId: '11111111-2222-4333-8444-555555555555',
  kind: 'order_confirmation',
  storeCode: 'brand-a',
  locale: 'en-GB',
  displayId: 1042,
};

describe('DevSinkTransport', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'notifications-sink-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes html, text and an envelope under <dir>/<store>/<event_id>', async () => {
    const sink = new DevSinkTransport(dir);
    const result = await sink.send(email, meta);
    expect(result.providerMessageId).toBe(`dev:${meta.eventId}`);
    const base = join(dir, 'brand-a', meta.eventId);
    expect(await readFile(`${base}.html`, 'utf8')).toBe(email.html);
    expect(await readFile(`${base}.txt`, 'utf8')).toBe(
      'Subject: Your Brand A order #1042 is confirmed\n\nHi Ada,\n\nThank you.',
    );
    const envelope = JSON.parse(await readFile(`${base}.json`, 'utf8')) as Record<string, unknown>;
    expect(envelope).toMatchObject({ ...meta, to: 'ada@example.test', subject: email.subject });
    expect((await stat(`${base}.html`)).isFile()).toBe(true);
  });
});

describe('ResendTransport', () => {
  function fakeFetch(
    status: number,
    body: unknown,
    calls: { url: string; init: FetchInit }[] = [],
  ): FetchLike {
    return async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
  }

  it('posts the message with the key from the options and the event id as idempotency key', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    const t = new ResendTransport({
      apiKey: 'unit-test-key',
      fetch: fakeFetch(200, { id: 'msg_1' }, calls),
    });
    const r = await t.send({ ...email, replyTo: 'help@brand-a.example' }, meta);
    expect(r.providerMessageId).toBe('msg_1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers.authorization).toBe('Bearer unit-test-key');
    expect(calls[0]!.init.headers['idempotency-key']).toBe(`notifications/${meta.eventId}`);
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      from: 'Brand A <orders@brand-a.example>',
      to: ['ada@example.test'],
      reply_to: 'help@brand-a.example',
      subject: email.subject,
      html: email.html,
      text: email.text,
      tags: [
        { name: 'kind', value: 'order_confirmation' },
        { name: 'store', value: 'brand-a' },
        { name: 'event_id', value: meta.eventId },
      ],
    });
  });

  it('turns a refusal into a TransportError with the status and error name, never the body', async () => {
    const t = new ResendTransport({
      apiKey: 'unit-test-key',
      fetch: fakeFetch(422, {
        name: 'validation_error',
        message: 'to ada@example.test is invalid',
      }),
    });
    const err = await t.send(email, meta).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toBe('resend: HTTP 422 validation_error');
    expect((err as TransportError).retryable).toBe(false);

    const t5 = new ResendTransport({ apiKey: 'unit-test-key', fetch: fakeFetch(503, null) });
    const err5 = await t5.send(email, meta).catch((e: unknown) => e);
    expect((err5 as TransportError).message).toBe('resend: HTTP 503 error');
    expect((err5 as TransportError).retryable).toBe(true);
  });

  it('wraps a network failure without leaking anything but the error name', async () => {
    const t = new ResendTransport({
      apiKey: 'unit-test-key',
      fetch: async () => {
        throw new TypeError('fetch failed: ada@example.test');
      },
    });
    const err = await t.send(email, meta).catch((e: unknown) => e);
    expect((err as TransportError).message).toBe('resend: TypeError');
  });

  it('refuses to exist without a key', () => {
    expect(() => new ResendTransport({ apiKey: '  ' })).toThrow(/RESEND_API_KEY is not set/);
    expect(() => createTransport({ transport: 'resend', dir: '.x' }, {})).toThrow(
      /RESEND_API_KEY is not set/,
    );
    expect(createTransport({ transport: 'dev', dir: '.x' }, {})).toBeInstanceOf(DevSinkTransport);
  });
});

describe('resolveConfig', () => {
  it('defaults to the dev sink and every store with a brand profile', () => {
    const c = resolveConfig({}, []);
    expect(c).toMatchObject({
      storeCodes: ['brand-a'],
      transport: 'dev',
      dir: '.notifications',
      devTokens: false,
      once: false,
      port: 4030,
      pollMs: 5000,
      maxAttempts: 5,
    });
    expect(resolveConfig({ NOTIFICATIONS_DEV_TOKENS: '1' }, ['--once'])).toMatchObject({
      devTokens: true,
      once: true,
    });
  });

  it('refuses what must not run in production', () => {
    expect(() => resolveConfig({ NODE_ENV: 'production' })).toThrow(/NOTIFICATIONS_STORE_CODES/);
    expect(() =>
      resolveConfig({ NODE_ENV: 'production', NOTIFICATIONS_STORE_CODES: 'brand-a' }),
    ).toThrow(/refused in production/);
    expect(() =>
      resolveConfig({
        NODE_ENV: 'production',
        NOTIFICATIONS_STORE_CODES: 'brand-a',
        NOTIFICATIONS_TRANSPORT: 'resend',
        NOTIFICATIONS_DEV_TOKENS: '1',
      }),
    ).toThrow(/NOTIFICATIONS_DEV_TOKENS/);
    expect(
      resolveConfig({
        NODE_ENV: 'production',
        NOTIFICATIONS_STORE_CODES: 'brand-a',
        NOTIFICATIONS_TRANSPORT: 'resend',
      }).transport,
    ).toBe('resend');
  });

  it('refuses a store without a brand profile and an unknown transport', () => {
    expect(() => resolveConfig({ NOTIFICATIONS_STORE_CODES: 'brand-a,brand-b' })).toThrow(
      /no brand profile exists/,
    );
    expect(() => resolveConfig({ NOTIFICATIONS_TRANSPORT: 'smtp' })).toThrow(/dev.*resend/);
    expect(() => resolveConfig({ NOTIFICATIONS_POLL_MS: 'soon' })).toThrow(/NOTIFICATIONS_POLL_MS/);
  });
});
