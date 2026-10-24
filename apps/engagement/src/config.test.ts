import { SEED_IDS } from '@platform/db';
import { describe, expect, it } from 'vitest';
import { KNOWN_GROUPS, resolveConfig, storeEnvKey } from './config.js';
import { assertConsentModeOverridesKnown } from './consent-mode.js';
import { buildCdpAdapter, buildCrmAdapter, buildTokenProvider, buildTransport } from './main.js';

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
    // Every group this service knows about, not just its own: a group missing from the watch list is a group
    // whose dead letters nobody hears about (#562 review).
    // Asserted against KNOWN_GROUPS rather than a literal: adding a consumer group should not need a test
    // edit, only an entry there (and the test below pins what the list must contain).
    expect(c.dlq).toEqual({ groups: [...KNOWN_GROUPS], threshold: 1, pollMs: 60_000 });
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

  it('watches the groups it is given, trimmed, and ALL of its own groups by default', () => {
    expect(
      resolveConfig({
        env: { ...base, ENGAGEMENT_DLQ_GROUPS: 'engagement.ops, accounting ,engagement.cdp' },
      }).dlq.groups,
    ).toEqual(['engagement.ops', 'accounting', 'engagement.cdp']);
    expect(resolveConfig({ env: { ...base, ENGAGEMENT_DLQ_GROUPS: ' ' } }).dlq.groups).toEqual([
      ...KNOWN_GROUPS,
    ]);
    // Every group this service actually runs is in it — the point of the default.
    expect([...KNOWN_GROUPS]).toEqual(['engagement.ops', 'engagement.cdp', 'engagement.crm']);
    // KNOWN_GROUPS is the default, and it can only know this service's own groups: production must list
    // every group on the bus, other windows' included.
    expect(resolveConfig({ env: base }).dlq.groups).toEqual([...KNOWN_GROUPS]);
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

describe('resolveConfig — the CDP side (#554)', () => {
  it('is OFF by default, on the memory adapter and the analytics consent mode', () => {
    const c = resolveConfig({ env: base });
    expect(c.cdp).toMatchObject({ enabled: false, adapter: 'memory', consentMode: 'analytics' });
    // The owner's default (#576), and it applies to every store until one is overridden.
    expect(c.cdp.consentModeFor('brand-a')).toBe('analytics');
    expect(c.cdp.consentModeFor('brand-z')).toBe('analytics');
  });

  it('turns on with the memory adapter outside production', () => {
    const c = resolveConfig({ env: { ...base, ENGAGEMENT_CDP_ENABLED: '1' } });
    expect(c.cdp).toMatchObject({ enabled: true, adapter: 'memory' });
  });

  // In production the ops transport must be slack anyway (the dev sink is refused), so these set it: the
  // point here is the CDP refusal, not the one the transport tests already cover.
  const prodBase = { ...base, ENGAGEMENT_TRANSPORT: 'slack', SLACK_OPS_WEBHOOK_URL: WEBHOOK };

  it('refuses the memory adapter in production when enabled: nothing would be sent', () => {
    expect(() =>
      resolveConfig({
        env: { ...prodBase, ENGAGEMENT_CDP_ENABLED: '1', ENGAGEMENT_CDP_ADAPTER: 'memory' },
        nodeEnv: 'production',
      }),
    ).toThrow(/memory is refused in production/);
  });

  it('allows the memory adapter in production while the consumer is OFF', () => {
    const c = resolveConfig({ env: prodBase, nodeEnv: 'production' });
    expect(c.cdp).toMatchObject({ enabled: false, adapter: 'memory' });
  });

  it('rejects an unknown adapter name', () => {
    expect(() => resolveConfig({ env: { ...base, ENGAGEMENT_CDP_ADAPTER: 'segment' } })).toThrow(
      /must be "memory" or "rudderstack"/,
    );
  });

  it('requires a write key and a data plane for rudderstack when enabled', () => {
    expect(() =>
      resolveConfig({
        env: { ...base, ENGAGEMENT_CDP_ENABLED: '1', ENGAGEMENT_CDP_ADAPTER: 'rudderstack' },
      }),
    ).toThrow(/RUDDERSTACK_WRITE_KEY and RUDDERSTACK_DATA_PLANE_URL/);
  });

  it('reads the rudderstack credentials and the regulation block', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_CDP_ENABLED: '1',
        ENGAGEMENT_CDP_ADAPTER: 'rudderstack',
        RUDDERSTACK_WRITE_KEY: 'write-key-words-only',
        RUDDERSTACK_DATA_PLANE_URL: 'https://dataplane.rudderstack.example',
        RUDDERSTACK_CONTROL_PLANE_URL: 'https://api.rudderstack.example',
        RUDDERSTACK_ACCESS_TOKEN: 'control-plane-token-words-only',
        RUDDERSTACK_SOURCE_IDS: 'source-alpha, source-beta',
      },
    });
    expect(c.cdp).toMatchObject({
      enabled: true,
      adapter: 'rudderstack',
      consentMode: 'analytics',
      writeKey: 'write-key-words-only',
      dataPlaneUrl: 'https://dataplane.rudderstack.example',
      regulation: {
        controlPlaneUrl: 'https://api.rudderstack.example',
        accessToken: 'control-plane-token-words-only',
        sourceIds: ['source-alpha', 'source-beta'],
      },
    });
  });

  it('leaves the regulation block out unless all three parts are set', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_CDP_ENABLED: '1',
        ENGAGEMENT_CDP_ADAPTER: 'rudderstack',
        RUDDERSTACK_WRITE_KEY: 'write-key-words-only',
        RUDDERSTACK_DATA_PLANE_URL: 'https://dataplane.rudderstack.example',
        RUDDERSTACK_CONTROL_PLANE_URL: 'https://api.rudderstack.example',
      },
    });
    expect(c.cdp.regulation).toBeUndefined();
  });

  it('never carries rudderstack credentials when the adapter is memory', () => {
    const c = resolveConfig({
      env: { ...base, RUDDERSTACK_WRITE_KEY: 'write-key-words-only' },
    });
    expect(JSON.stringify(c)).not.toContain('write-key-words-only');
  });
});

describe('the CDP consent mode resolves PER STORE (#576)', () => {
  it('defaults to analytics globally — the owner decision of 2026-10-23', () => {
    expect(resolveConfig({ env: base }).cdp.consentMode).toBe('analytics');
  });

  it('takes a global strict', () => {
    const c = resolveConfig({ env: { ...base, ENGAGEMENT_CDP_CONSENT_MODE: 'strict' } });
    expect(c.cdp.consentMode).toBe('strict');
    expect(c.cdp.consentModeFor('brand-a')).toBe('strict');
  });

  it('A PER-STORE OVERRIDE BEATS THE GLOBAL DEFAULT, and only for that store', () => {
    // One region made strict without touching code — the point of #576.
    const c = resolveConfig({ env: { ...base, ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A: 'strict' } });
    expect(c.cdp.consentMode).toBe('analytics');
    expect(c.cdp.consentModeFor('brand-a')).toBe('strict');
    expect(c.cdp.consentModeFor('brand-b')).toBe('analytics');
    expect(c.cdp.consentModeFor('brand-c')).toBe('analytics');
  });

  it('and the other way round: a store can be analytics under a strict global', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_CDP_CONSENT_MODE: 'strict',
        ENGAGEMENT_CDP_CONSENT_MODE_BRAND_C: 'analytics',
      },
    });
    expect(c.cdp.consentModeFor('brand-a')).toBe('strict');
    expect(c.cdp.consentModeFor('brand-c')).toBe('analytics');
  });

  it('maps a store code to its env key the way apps/notifications does', () => {
    expect(storeEnvKey('brand-a')).toBe('BRAND_A');
    expect(storeEnvKey('brand-a-2')).toBe('BRAND_A_2');
    expect(storeEnvKey('BRAND_B')).toBe('BRAND_B');
  });

  it('THROWS on an unknown mode rather than falling back to the open one', () => {
    // A typo like `strcit` must never silently become `analytics`.
    expect(() =>
      resolveConfig({ env: { ...base, ENGAGEMENT_CDP_CONSENT_MODE: 'strcit' } }),
    ).toThrow(/ENGAGEMENT_CDP_CONSENT_MODE must be "analytics" or "strict"/);
  });

  it('THROWS on an unknown per-store mode, at startup, naming the variable', () => {
    expect(() =>
      resolveConfig({ env: { ...base, ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A: 'off' } }),
    ).toThrow(/ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A must be "analytics" or "strict"/);
  });

  it('an empty per-store value falls back to the global rather than throwing', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_CDP_CONSENT_MODE: 'strict',
        ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A: '  ',
      },
    });
    expect(c.cdp.consentModeFor('brand-a')).toBe('strict');
  });
});

describe('the override KEYS are normalised and validated (#586)', () => {
  // The #585 review's finding: the key was stored RAW and looked up NORMALISED, so a lowercase or oddly
  // punctuated key parsed, validated, and then matched no store — leaving that store on the open default
  // while the configuration said otherwise. Every spelling of one store's key must reach that store.
  it.each([
    ['ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A'],
    ['ENGAGEMENT_CDP_CONSENT_MODE_brand_a'],
    ['ENGAGEMENT_CDP_CONSENT_MODE_brand-a'],
    ['ENGAGEMENT_CDP_CONSENT_MODE_Brand_A'],
  ])('%s switches brand-a to strict', (key) => {
    const c = resolveConfig({ env: { ...base, [key]: 'strict' } });
    expect(c.cdp.consentModeFor('brand-a')).toBe('strict');
    expect(c.cdp.consentModeFor('brand-b')).toBe('analytics');
    expect([...c.cdp.consentModeOverrides.keys()]).toEqual(['BRAND_A']);
  });

  it('refuses two spellings of one store that DISAGREE', () => {
    expect(() =>
      resolveConfig({
        env: {
          ...base,
          ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A: 'strict',
          'ENGAGEMENT_CDP_CONSENT_MODE_brand-a': 'analytics',
        },
      }),
    ).toThrow(/both set the consent mode for store "BRAND_A" and disagree/);
  });

  it('allows two spellings that agree, because there is nothing to get wrong', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A: 'strict',
        'ENGAGEMENT_CDP_CONSENT_MODE_brand-a': 'strict',
      },
    });
    expect(c.cdp.consentModeFor('brand-a')).toBe('strict');
  });

  it('keeps a key that names no store instead of guessing, for the post-warm check to reject', () => {
    // `resolveConfig` has no database, so a typo and a store it has not heard of look identical here. It
    // neither drops the key nor applies it to something: it exposes it, and
    // `assertConsentModeOverridesKnown` rejects it once the store list exists. That is why the consumer
    // runs that check right after `warm()` rather than at config time.
    const c = resolveConfig({ env: { ...base, ENGAGEMENT_CDP_CONSENT_MODE_BRANDA: 'strict' } });
    expect(c.cdp.consentModeFor('brand-a')).toBe('analytics');
    expect(c.cdp.consentModeOverrides.get('BRANDA')).toBe('strict');
  });
});

describe('assertConsentModeOverridesKnown (#586)', () => {
  const codes = ['brand-a', 'brand-b', 'brand-c'];

  it('passes when every override names a real store', () => {
    expect(() =>
      assertConsentModeOverridesKnown(new Map([['BRAND_A', 'strict']]), codes),
    ).not.toThrow();
  });

  it('passes trivially when there are no overrides', () => {
    expect(() => assertConsentModeOverridesKnown(new Map(), [])).not.toThrow();
  });

  it('FAILS on a typo, naming the variable and the codes that do exist', () => {
    // The message has to be actionable at 3am: which variable, and what the valid values would have been.
    expect(() => assertConsentModeOverridesKnown(new Map([['BRANDA', 'strict']]), codes)).toThrow(
      /ENGAGEMENT_CDP_CONSENT_MODE_BRANDA: no such store[\s\S]*brand-a, brand-b, brand-c/,
    );
  });

  it('normalises the STORE side too, so a code with punctuation matches its key', () => {
    expect(() =>
      assertConsentModeOverridesKnown(new Map([['BRAND_A_2', 'strict']]), ['brand-a-2']),
    ).not.toThrow();
  });

  it('reports every unknown key at once, not one per boot', () => {
    expect(() =>
      assertConsentModeOverridesKnown(
        new Map([
          ['BRANDA', 'strict'],
          ['BRAND_D', 'strict'],
        ]),
        codes,
      ),
    ).toThrow(/BRANDA, ENGAGEMENT_CDP_CONSENT_MODE_BRAND_D/);
  });
});

describe('buildCdpAdapter', () => {
  it('builds the memory adapter by default', () => {
    expect(buildCdpAdapter(resolveConfig({ env: base })).name).toBe('memory');
  });

  it('builds the rudderstack adapter from the config, keeping the key out of the object', () => {
    const a = buildCdpAdapter(
      resolveConfig({
        env: {
          ...base,
          ENGAGEMENT_CDP_ENABLED: '1',
          ENGAGEMENT_CDP_ADAPTER: 'rudderstack',
          RUDDERSTACK_WRITE_KEY: 'write-key-words-only',
          RUDDERSTACK_DATA_PLANE_URL: 'https://dataplane.rudderstack.example',
        },
      }),
    );
    expect(a.name).toBe('rudderstack');
    expect(JSON.stringify(a)).not.toContain('write-key-words-only');
  });
});

describe('resolveConfig — the CRM side (#555)', () => {
  const prodBase = { ...base, ENGAGEMENT_TRANSPORT: 'slack', SLACK_OPS_WEBHOOK_URL: WEBHOOK };

  it('is OFF by default, on the memory adapter and the mock token provider', () => {
    const c = resolveConfig({ env: base });
    expect(c.crm).toEqual({
      enabled: false,
      adapter: 'memory',
      externalIdField: 'externalId',
      adminApiUrl: 'http://localhost:9000',
      tokenProvider: 'mock',
    });
  });

  it('turns on with the memory adapter outside production', () => {
    const c = resolveConfig({ env: { ...base, ENGAGEMENT_CRM_ENABLED: '1' } });
    expect(c.crm).toMatchObject({ enabled: true, adapter: 'memory', tokenProvider: 'mock' });
  });

  it('refuses the memory adapter in production when enabled', () => {
    expect(() =>
      resolveConfig({
        env: { ...prodBase, ENGAGEMENT_CRM_ENABLED: '1' },
        nodeEnv: 'production',
      }),
    ).toThrow(/memory is refused in production/);
  });

  it('REFUSES the mock token provider in production: no real service principal', () => {
    expect(() =>
      resolveConfig({
        env: {
          ...prodBase,
          ENGAGEMENT_CRM_ENABLED: '1',
          ENGAGEMENT_CRM_ADAPTER: 'twenty',
          TWENTY_BASE_URL: 'https://crm.example/rest',
          TWENTY_API_KEY: 'twenty-api-key-words-only',
          ENGAGEMENT_CRM_TOKEN_PROVIDER: 'mock',
        },
        nodeEnv: 'production',
      }),
    ).toThrow(/mock is refused in production/);
  });

  it('rejects unknown adapter and provider names', () => {
    expect(() => resolveConfig({ env: { ...base, ENGAGEMENT_CRM_ADAPTER: 'hubspot' } })).toThrow(
      /must be "memory" or "twenty"/,
    );
    expect(() =>
      resolveConfig({ env: { ...base, ENGAGEMENT_CRM_TOKEN_PROVIDER: 'password' } }),
    ).toThrow(/must be "mock" or "client_credentials"/);
  });

  it('requires a base URL and a key for twenty when enabled', () => {
    expect(() =>
      resolveConfig({
        env: { ...base, ENGAGEMENT_CRM_ENABLED: '1', ENGAGEMENT_CRM_ADAPTER: 'twenty' },
      }),
    ).toThrow(/TWENTY_BASE_URL and TWENTY_API_KEY/);
  });

  it('reads the twenty settings, the external-id field and the Admin API URL', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_CRM_ENABLED: '1',
        ENGAGEMENT_CRM_ADAPTER: 'twenty',
        TWENTY_BASE_URL: 'https://crm.example/rest',
        TWENTY_API_KEY: 'twenty-api-key-words-only',
        TWENTY_EXTERNAL_ID_FIELD: 'platformCustomerId',
        ADMIN_API_URL: 'http://core.internal:9000',
      },
    });
    expect(c.crm).toMatchObject({
      enabled: true,
      adapter: 'twenty',
      baseUrl: 'https://crm.example/rest',
      apiKey: 'twenty-api-key-words-only',
      externalIdField: 'platformCustomerId',
      adminApiUrl: 'http://core.internal:9000',
    });
  });

  it('never carries twenty credentials when the adapter is memory', () => {
    const c = resolveConfig({ env: { ...base, TWENTY_API_KEY: 'twenty-api-key-words-only' } });
    expect(JSON.stringify(c)).not.toContain('twenty-api-key-words-only');
  });
});

describe('buildCrmAdapter / buildTokenProvider', () => {
  it('builds the memory adapter by default', () => {
    expect(buildCrmAdapter(resolveConfig({ env: base })).name).toBe('memory');
  });

  it('builds the twenty adapter, keeping the key out of the object', () => {
    const a = buildCrmAdapter(
      resolveConfig({
        env: {
          ...base,
          ENGAGEMENT_CRM_ENABLED: '1',
          ENGAGEMENT_CRM_ADAPTER: 'twenty',
          TWENTY_BASE_URL: 'https://crm.example/rest',
          TWENTY_API_KEY: 'twenty-api-key-words-only',
        },
      }),
    );
    expect(a.name).toBe('twenty');
    expect(JSON.stringify(a)).not.toContain('twenty-api-key-words-only');
  });

  it('gives the mock token provider, named so nothing mistakes it for a principal', () => {
    expect(buildTokenProvider(resolveConfig({ env: base })).name).toBe('mock');
  });

  it('THROWS for client_credentials rather than falling back to the mock (#565 is not built)', () => {
    expect(() =>
      buildTokenProvider(
        resolveConfig({ env: { ...base, ENGAGEMENT_CRM_TOKEN_PROVIDER: 'client_credentials' } }),
      ),
    ).toThrow(/not implemented yet \(REQUEST #565\)/);
  });
});

describe('resolveConfig — the support API (#556)', () => {
  const prodBase = { ...base, ENGAGEMENT_TRANSPORT: 'slack', SLACK_OPS_WEBHOOK_URL: WEBHOOK };

  it('is OFF by default, with no dev tokens and no webhook secret', () => {
    const c = resolveConfig({ env: base });
    expect(c.support).toEqual({
      enabled: false,
      port: 4040,
      adminApiUrl: 'http://localhost:9000',
      maxOrders: 25,
      devTokens: false,
    });
    expect(c.support.chatwootSecret).toBeUndefined();
  });

  it('turns on with a port, an Admin API URL and an order cap', () => {
    const c = resolveConfig({
      env: {
        ...base,
        ENGAGEMENT_SUPPORT_ENABLED: '1',
        ENGAGEMENT_SUPPORT_PORT: '5050',
        ENGAGEMENT_SUPPORT_MAX_ORDERS: '10',
        ADMIN_API_URL: 'http://core.internal:9000',
      },
    });
    expect(c.support).toMatchObject({
      enabled: true,
      port: 5050,
      maxOrders: 10,
      adminApiUrl: 'http://core.internal:9000',
    });
  });

  it('carries the Chatwoot secret when it is set', () => {
    const c = resolveConfig({
      env: { ...base, CHATWOOT_WEBHOOK_SECRET: 'chatwoot-webhook-secret-words-only' },
    });
    expect(c.support.chatwootSecret).toBe('chatwoot-webhook-secret-words-only');
  });

  it('REFUSES dev tokens in production: they would hand out an agent view of any customer', () => {
    expect(() =>
      resolveConfig({ env: { ...prodBase, ENGAGEMENT_DEV_TOKENS: '1' }, nodeEnv: 'production' }),
    ).toThrow(/ENGAGEMENT_DEV_TOKENS=1 is refused in production/);
  });

  it('allows dev tokens outside production', () => {
    expect(resolveConfig({ env: { ...base, ENGAGEMENT_DEV_TOKENS: '1' } }).support.devTokens).toBe(
      true,
    );
  });

  it('rejects a nonsense port or order cap', () => {
    for (const bad of ['0', '-1', 'soon']) {
      expect(() => resolveConfig({ env: { ...base, ENGAGEMENT_SUPPORT_PORT: bad } })).toThrow(
        /ENGAGEMENT_SUPPORT_PORT must be an integer/,
      );
    }
    expect(() => resolveConfig({ env: { ...base, ENGAGEMENT_SUPPORT_MAX_ORDERS: '0' } })).toThrow(
      /ENGAGEMENT_SUPPORT_MAX_ORDERS must be an integer/,
    );
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
