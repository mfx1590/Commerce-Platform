// Transports: the dev sink on a temp dir, Slack against an injected fetch.
//
// Test values are WORDS, never digit/hex tails — the gitleaks rule in Memory-main: one secret-shaped literal on
// any branch reddens the secret-scan job on every open PR, and history cannot be rewritten.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Alert } from '../types.js';
import { DevSinkAlertTransport } from './dev-sink.js';
import { escapeMrkdwn, SlackAlertTransport, slackPayload, type FetchLike } from './slack.js';
import { TransportError } from './types.js';

const WEBHOOK = 'https://hooks.slack.example/services/team-alpha/channel-ops/token-words-only';

const alert = (over: Partial<Alert> = {}): Alert => ({
  rule: 'payment-failed',
  severity: 'warn',
  title: 'Payment failed on brand-a',
  fields: { store: 'brand-a', amount: '10494 EUR', reason: 'insufficient_funds' },
  organizationId: '00000000-0000-4000-8000-000000000001',
  storeId: '00000000-0000-4000-8000-00000000a001',
  storeCode: 'brand-a',
  topic: 'payment.failed',
  outboxId: '11111111-1111-4111-8111-111111111111',
  occurredAt: '2026-10-23T10:00:00.000Z',
  suppressed: 0,
  ...over,
});

describe('dev sink', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engagement-sink-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per alert and creates the directory', async () => {
    const t = new DevSinkAlertTransport(join(dir, 'nested'));
    expect(t.name).toBe('dev');
    await t.send(alert());
    await t.send(alert({ rule: 'refund-failed', severity: 'critical' }));

    const lines = (await readFile(t.file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).rule).toBe('payment-failed');
    expect(JSON.parse(lines[1]!)).toMatchObject({ rule: 'refund-failed', severity: 'critical' });
  });

  it('writes to <dir>/ops-alerts.jsonl', async () => {
    const t = new DevSinkAlertTransport(dir);
    expect(t.file).toBe(join(dir, 'ops-alerts.jsonl'));
  });
});

describe('slack mrkdwn', () => {
  it('escapes only the three special characters', () => {
    expect(escapeMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeMrkdwn('plain-value_1')).toBe('plain-value_1');
  });

  it('cannot be made to inject a Slack link through a field value', () => {
    const p = slackPayload(alert({ fields: { reason: '<https://evil.example|click me>' } }));
    expect(p.text).not.toContain('<https://evil.example|');
    expect(p.text).toContain('&lt;https://evil.example|click me&gt;');
  });

  it('renders severity, title and every field, and names the suppressed burst', () => {
    const p = slackPayload(alert({ severity: 'critical', suppressed: 4 }));
    expect(p.text).toContain(':rotating_light:');
    expect(p.text).toContain('*Payment failed on brand-a*');
    expect(p.text).toContain('• amount: `10494 EUR`');
    expect(p.text).toContain('4 more of this rule suppressed');
    expect(p.blocks[0]!).toMatchObject({ type: 'section', text: { type: 'mrkdwn' } });
  });

  it('says nothing about suppression when nothing was suppressed', () => {
    expect(slackPayload(alert()).text).not.toContain('suppressed');
    expect(slackPayload(alert()).text).toContain(':warning:');
  });
});

describe('slack transport', () => {
  function recorder(
    reply: { ok: boolean; status: number; body?: string } = { ok: true, status: 200 },
  ) {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return {
        ok: reply.ok,
        status: reply.status,
        text: async () => reply.body ?? '',
      };
    };
    return { calls, fetchImpl };
  }

  it('refuses to exist without a webhook URL (no default, ever)', () => {
    expect(() => new SlackAlertTransport({ webhookUrl: '' })).toThrow(/SLACK_OPS_WEBHOOK_URL/);
    expect(() => new SlackAlertTransport({ webhookUrl: '   ' })).toThrow(/SLACK_OPS_WEBHOOK_URL/);
  });

  it('posts the rendered payload as JSON to the webhook', async () => {
    const r = recorder();
    const t = new SlackAlertTransport({ webhookUrl: WEBHOOK, fetchImpl: r.fetchImpl });
    expect(t.name).toBe('slack');
    await t.send(alert());

    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe(WEBHOOK);
    expect(r.calls[0]!.headers['content-type']).toBe('application/json');
    const body = JSON.parse(r.calls[0]!.body);
    expect(body.text).toContain('Payment failed on brand-a');
    expect(body.blocks).toHaveLength(1);
  });

  it('a refusal becomes a TransportError with the status and Slack s error word only', async () => {
    const r = recorder({ ok: false, status: 400, body: 'invalid_payload' });
    const t = new SlackAlertTransport({ webhookUrl: WEBHOOK, fetchImpl: r.fetchImpl });
    await expect(t.send(alert())).rejects.toThrow('slack: HTTP 400 invalid_payload');
    await expect(t.send(alert())).rejects.toBeInstanceOf(TransportError);
  });

  it('drops a long or HTML body instead of putting it in the error', async () => {
    const leaky = `<html>the payload was https://hooks.slack.example/services/team-alpha ...</html>`;
    const r = recorder({ ok: false, status: 500, body: leaky });
    const t = new SlackAlertTransport({ webhookUrl: WEBHOOK, fetchImpl: r.fetchImpl });
    await expect(t.send(alert())).rejects.toThrow('slack: HTTP 500');
    await t.send(alert()).catch((err: unknown) => {
      expect((err as Error).message).not.toContain('hooks.slack.example');
      expect((err as Error).message).not.toContain('html');
    });
  });

  it('marks 429 and 5xx retryable, a 4xx not', async () => {
    const cases: [number, boolean][] = [
      [429, true],
      [503, true],
      [400, false],
      [404, false],
    ];
    for (const [status, retryable] of cases) {
      const r = recorder({ ok: false, status, body: 'no_service' });
      const t = new SlackAlertTransport({ webhookUrl: WEBHOOK, fetchImpl: r.fetchImpl });
      const err = await t.send(alert()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).retryable).toBe(retryable);
    }
  });

  it('a thrown fetch never leaks the webhook URL into the error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError(`fetch failed for ${WEBHOOK}`);
    };
    const t = new SlackAlertTransport({ webhookUrl: WEBHOOK, fetchImpl });
    const err = await t.send(alert()).catch((e: unknown) => e);
    expect((err as Error).message).toBe('slack: request failed TypeError');
    expect((err as Error).message).not.toContain('hooks.slack.example');
    expect((err as TransportError).retryable).toBe(true);
  });

  it('never puts the webhook URL in the alert or anywhere but the request', async () => {
    const r = recorder();
    const t = new SlackAlertTransport({ webhookUrl: WEBHOOK, fetchImpl: r.fetchImpl });
    const a = alert();
    await t.send(a);
    expect(JSON.stringify(a)).not.toContain('hooks.slack.example');
    expect(r.calls[0]!.body).not.toContain('hooks.slack.example');
    // The URL is not an enumerable property of the transport either (private field).
    expect(JSON.stringify(t)).not.toContain('hooks.slack.example');
  });
});
