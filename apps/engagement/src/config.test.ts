import { SEED_IDS } from '@platform/db';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { buildTransport } from './main.js';

const APP_URL = 'postgres://platform_app:platform_app@127.0.0.1:5433/platform';
const WEBHOOK = 'https://hooks.slack.example/services/team-alpha/channel-ops/token-words-only';
const base = { DATABASE_URL_APP: APP_URL };

describe('resolveConfig', () => {
  it('defaults to the dev sink, the seeded organization and .engagement', () => {
    const c = resolveConfig({ env: base });
    expect(c).toMatchObject({
      databaseUrlApp: APP_URL,
      organizationId: SEED_IDS.organization,
      transport: 'dev',
      dir: '.engagement',
    });
    expect(c.slackWebhookUrl).toBeUndefined();
    expect(c.rateLimit).toEqual({ max: 5, windowMs: 900_000 });
    expect(c.dlq).toEqual({ groups: ['engagement.ops'], threshold: 1, pollMs: 60_000 });
  });

  it('requires the app database URL', () => {
    expect(() => resolveConfig({ env: {} })).toThrow(/DATABASE_URL_APP is required/);
    expect(() => resolveConfig({ env: { DATABASE_URL_APP: '  ' } })).toThrow(
      /DATABASE_URL_APP is required/,
    );
  });

  it('refuses the dev sink in production: an alert in a local file is an alert nobody gets', () => {
    expect(() => resolveConfig({ env: base, nodeEnv: 'production' })).toThrow(
      /ENGAGEMENT_TRANSPORT=dev is refused in production/,
    );
    // ...and the same configuration is fine outside production.
    expect(resolveConfig({ env: base, nodeEnv: 'development' }).transport).toBe('dev');
  });

  it('takes the Slack transport with a webhook URL, in production too', () => {
    const c = resolveConfig({
      env: { ...base, ENGAGEMENT_TRANSPORT: 'slack', SLACK_OPS_WEBHOOK_URL: WEBHOOK },
      nodeEnv: 'production',
    });
    expect(c.transport).toBe('slack');
    expect(c.slackWebhookUrl).toBe(WEBHOOK);
  });

  it('refuses the Slack transport without a webhook URL', () => {
    expect(() => resolveConfig({ env: { ...base, ENGAGEMENT_TRANSPORT: 'slack' } })).toThrow(
      /requires SLACK_OPS_WEBHOOK_URL/,
    );
    expect(() =>
      resolveConfig({
        env: { ...base, ENGAGEMENT_TRANSPORT: 'slack', SLACK_OPS_WEBHOOK_URL: ' ' },
      }),
    ).toThrow(/requires SLACK_OPS_WEBHOOK_URL/);
  });

  it('never carries a webhook URL that the transport would not use', () => {
    // dev transport + a URL in the environment: the config does not pass it on.
    const c = resolveConfig({ env: { ...base, SLACK_OPS_WEBHOOK_URL: WEBHOOK } });
    expect(c.transport).toBe('dev');
    expect(c.slackWebhookUrl).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain('hooks.slack.example');
  });

  it('rejects an unknown transport name', () => {
    expect(() => resolveConfig({ env: { ...base, ENGAGEMENT_TRANSPORT: 'pagerduty' } })).toThrow(
      /must be "dev" or "slack"/,
    );
  });

  it('reads the numbers and rejects nonsense', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_ALERT_RATE_MAX: '2',
        ENGAGEMENT_ALERT_RATE_WINDOW_MS: '30000',
        ENGAGEMENT_DLQ_THRESHOLD: '10',
        ENGAGEMENT_DLQ_POLL_MS: '5000',
      },
    });
    expect(c.rateLimit).toEqual({ max: 2, windowMs: 30_000 });
    expect(c.dlq).toMatchObject({ threshold: 10, pollMs: 5000 });

    for (const bad of ['0', '-1', 'soon', '1.5']) {
      expect(() => resolveConfig({ env: { ...base, ENGAGEMENT_ALERT_RATE_MAX: bad } })).toThrow(
        /ENGAGEMENT_ALERT_RATE_MAX must be an integer/,
      );
    }
  });

  it('watches the groups it is given, trimmed, and its own group by default', () => {
    expect(
      resolveConfig({
        env: { ...base, ENGAGEMENT_DLQ_GROUPS: 'engagement.ops, accounting ,engagement.cdp' },
      }).dlq.groups,
    ).toEqual(['engagement.ops', 'accounting', 'engagement.cdp']);
    expect(resolveConfig({ env: { ...base, ENGAGEMENT_DLQ_GROUPS: ' ' } }).dlq.groups).toEqual([
      'engagement.ops',
    ]);
  });

  it('takes an explicit organization and directory', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_ORGANIZATION_ID: '99999999-9999-4999-8999-999999999999',
        ENGAGEMENT_DIR: '/var/tmp/alerts',
      },
    });
    expect(c.organizationId).toBe('99999999-9999-4999-8999-999999999999');
    expect(c.dir).toBe('/var/tmp/alerts');
  });
});

describe('buildTransport', () => {
  it('builds the dev sink in the configured directory', () => {
    const t = buildTransport(resolveConfig({ env: { ...base, ENGAGEMENT_DIR: 'alerts-here' } }));
    expect(t.name).toBe('dev');
  });

  it('builds the Slack transport from the config', () => {
    const t = buildTransport(
      resolveConfig({
        env: { ...base, ENGAGEMENT_TRANSPORT: 'slack', SLACK_OPS_WEBHOOK_URL: WEBHOOK },
      }),
    );
    expect(t.name).toBe('slack');
    expect(JSON.stringify(t)).not.toContain('hooks.slack.example');
  });
});
