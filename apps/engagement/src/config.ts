// Configuration from the environment, with the production refusals in one place.
//
// Secrets: `SLACK_OPS_WEBHOOK_URL` is read here and nowhere else, never defaulted, never logged, never written
// to an alert field. There is no secret in this repository and no test uses a secret-shaped literal (the
// gitleaks rule in Memory-main): the fixtures use words.

import { SEED_IDS } from '@platform/db';
import { CDP_GROUP_ID } from './cdp/consumer.js';
import type { ConsentMode } from './consent.js';
// EVERY refusal in this file is a `ConfigRefusedError`, so the entry point prints its message and exits 2
// (#599 review): the restart-loop argument is the same for all of them — a process refused for a missing
// `DATABASE_URL_APP` will be refused again on the next restart, and so will one refused for a bad adapter.
// THE RULE THAT KEEPS THAT SAFE: a message here may NAME any variable, and may echo a VALUE only from a
// variable whose values are enumerable or numeric (a mode, an adapter, a group id, a port). Never echo the
// value of one that carries a credential — `DATABASE_URL_APP`, `SLACK_OPS_WEBHOOK_URL`, `TWENTY_API_KEY`,
// `RUDDERSTACK_WRITE_KEY`, `CHATWOOT_WEBHOOK_SECRET`, `ENGAGEMENT_CRM_MOCK_TOKEN` — because these messages
// are printed to the log.
import { ConfigRefusedError } from './config-error.js';
import {
  CONSENT_MODE_ENV,
  parseConsentMode,
  readConsentModeOverrides,
  storeEnvKey,
} from './consent-mode.js';
import { CRM_GROUP_ID } from './crm/consumer.js';
import { OPS_GROUP_ID } from './ops/consumer.js';

export type TransportName = 'dev' | 'slack';
export type CdpAdapterName = 'memory' | 'rudderstack';
export type CrmAdapterName = 'memory' | 'twenty';

export interface EngagementConfig {
  /** The `platform_app` role (RLS applies); the service runs an organization-scoped client. */
  databaseUrlApp: string;
  /** One process serves one organization (`ENGAGEMENT_ORGANIZATION_ID`, default the seeded HQ). */
  organizationId: string;
  transport: TransportName;
  /** Where the dev sink writes (git-ignored). */
  dir: string;
  /** Only set when `transport === 'slack'`. */
  slackWebhookUrl?: string;
  rateLimit: { max: number; windowMs: number };
  dlq: { groups: string[]; threshold: number; pollMs: number };
  cdp: CdpConfig;
  crm: CrmConfig;
  support: SupportConfig;
  /**
   * The three consumer groups. Overridable per module (#594, Integration 4) so a one-off run can read the
   * real topics from the beginning under a FRESH group, without moving the live group's offsets or writing
   * marks under its name. Defaults are the modules' own constants.
   */
  groups: { ops: string; cdp: string; crm: string };
  /**
   * `--drain`: start the consumers, read from the beginning, and stop once the bus has been quiet — the
   * one-shot mode Integration 4 measures with. NOT `--once`, which is the DLQ poll and stays what it was.
   */
  drain: { enabled: boolean; idleMs: number; minRunMs: number };
}

export interface SupportConfig {
  /** `false` keeps the HTTP server off (the default: nothing calls it until a Chatwoot app is configured). */
  enabled: boolean;
  port: number;
  /** The core Admin API the agent's reads go to. */
  adminApiUrl: string;
  /** How many of a customer's orders to detail, newest first. Bounds the fan-out per request. */
  maxOrders: number;
  /** `CHATWOOT_WEBHOOK_SECRET`; without it the webhook route answers 503 rather than accepting blindly. */
  chatwootSecret?: string;
  /** `Bearer dev:<subject>` on the support routes, like CORE_DEV_TOKENS. Refused in production. */
  devTokens: boolean;
}

export interface CrmConfig {
  /** `false` keeps the CRM consumer off entirely (the default until a Twenty instance exists). */
  enabled: boolean;
  adapter: CrmAdapterName;
  /** Only when `adapter === 'twenty'`. */
  baseUrl?: string;
  apiKey?: string;
  /** The custom field on Twenty's person object holding OUR customer id. */
  externalIdField: string;
  /** The core Admin API the PII is read from. */
  adminApiUrl: string;
  /**
   * `mock` until the `crm-sync` service account exists (#565, accepted and routed to window 2). A mock token
   * is refused in production: a CRM sync running without a real principal would be silently syncing nothing,
   * or worse, acting as somebody else.
   */
  tokenProvider: 'mock' | 'client_credentials';
  /**
   * The token the MOCK provider hands over — a **dev stand-in for the `crm-sync` principal (#565); never in
   * production** (#594, Integration 4).
   *
   * Why it exists: on the dev stack there is no service principal, so a CRM PII read cannot succeed, and the
   * consent → fetch → rollup → upsert path — the largest piece of this service — could not be measured at
   * all. With the core on `CORE_DEV_TOKENS=1` a `dev:<subject>` token lets that path run on real data. It is
   * a STAFF subject, which is why it is labelled everywhere it appears: the rule that CRM uses this
   * service's own principal and never a human's token still stands, and this is the dev exception to it,
   * refused in production twice over (the mock provider itself is refused there, and so is this value).
   */
  mockToken?: string;
}

export interface CdpConfig {
  /** `false` keeps the CDP consumer off entirely (the default until a RudderStack account exists). */
  enabled: boolean;
  /**
   * The GLOBAL consent mode (#576, owner decision 2026-10-23): `analytics` by default. A store can override
   * it, so read the effective mode with `consentModeFor(code)` and never this field directly.
   */
  consentMode: ConsentMode;
  /** Resolves the effective mode for one store code, applying any per-store override. */
  consentModeFor(storeCode: string): ConsentMode;
  /**
   * The per-store overrides, keyed by the NORMALISED store key (`BRAND_A`). Exposed so the CDP consumer can
   * fail the boot on a key that names no store once the store list is known (#586) — `resolveConfig` has no
   * database and cannot tell a typo from a store it has not heard of.
   */
  consentModeOverrides: ReadonlyMap<string, ConsentMode>;
  adapter: CdpAdapterName;
  /** Only when `adapter === 'rudderstack'`. */
  writeKey?: string;
  dataPlaneUrl?: string;
  /** Only when all three are set: without them a suppression throws rather than silently doing nothing. */
  regulation?: { controlPlaneUrl: string; accessToken: string; sourceIds: string[] };
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  /** Defaults to `process.argv`. Only `--drain` is read from it. */
  argv?: readonly string[];
  /** Defaults to `env.NODE_ENV`. */
  nodeEnv?: string;
}

/**
 * Every consumer group this service knows about, and the default for `ENGAGEMENT_DLQ_GROUPS`. A group missing
 * from the watch list is a group whose dead letters nobody is told about, so the default is "all of mine"
 * rather than "the one I am" (#562 review). IN PRODUCTION the variable must list EVERY group on the bus,
 * including other windows' (`accounting`, …): this default can only know its own.
 */
export const KNOWN_GROUPS = [OPS_GROUP_ID, CDP_GROUP_ID, CRM_GROUP_ID] as const;

/**
 * The same shape `consumer_processed.group_id` allows (packages/db 0202's CHECK) and the same rule window 15
 * applied for `ACCOUNTING_GROUP_ID` (#594): a group id that the table would reject must fail the boot here,
 * not at the first mark.
 */
const GROUP_ID = /^[a-z][a-z0-9_.-]*$/;

function groupFrom(raw: string | undefined, fallback: string, what: string): string {
  const value = raw?.trim() || fallback;
  if (!GROUP_ID.test(value)) {
    throw new ConfigRefusedError(`${what} must match ${GROUP_ID.source} (got "${value}")`);
  }
  return value;
}

const DEFAULTS = {
  dir: '.engagement',
  rateMax: 5,
  rateWindowMs: 15 * 60 * 1000,
  dlqThreshold: 1,
  dlqPollMs: 60 * 1000,
} as const;

function intFrom(raw: string | undefined, fallback: number, what: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigRefusedError(`${what} must be an integer >= 1 (got ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * Reads the environment and refuses what must not run in production:
 *  * the dev sink — an ops alert written to a local file in production is an alert nobody receives;
 *  * the Slack transport without a webhook URL, anywhere (the transport itself also refuses).
 */
export function resolveConfig(opts: ResolveOptions = {}): EngagementConfig {
  const env = opts.env ?? process.env;
  const nodeEnv = opts.nodeEnv ?? env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  const databaseUrlApp = env.DATABASE_URL_APP?.trim() ?? '';
  if (!databaseUrlApp) throw new ConfigRefusedError('DATABASE_URL_APP is required');

  const transportRaw = (env.ENGAGEMENT_TRANSPORT?.trim() || 'dev') as TransportName;
  if (transportRaw !== 'dev' && transportRaw !== 'slack') {
    throw new ConfigRefusedError(
      `ENGAGEMENT_TRANSPORT must be "dev" or "slack" (got "${transportRaw}")`,
    );
  }
  if (isProduction && transportRaw === 'dev') {
    throw new ConfigRefusedError(
      'ENGAGEMENT_TRANSPORT=dev is refused in production (alerts would go to a local file)',
    );
  }

  const slackWebhookUrl = env.SLACK_OPS_WEBHOOK_URL?.trim() || undefined;
  if (transportRaw === 'slack' && !slackWebhookUrl) {
    throw new ConfigRefusedError('ENGAGEMENT_TRANSPORT=slack requires SLACK_OPS_WEBHOOK_URL');
  }

  const cdp = resolveCdp(env, isProduction);
  const crm = resolveCrm(env, isProduction);
  const support = resolveSupport(env, isProduction);

  // The groups this process will actually run, after any override.
  const consumerGroups = {
    ops: groupFrom(env.ENGAGEMENT_OPS_GROUP_ID, OPS_GROUP_ID, 'ENGAGEMENT_OPS_GROUP_ID'),
    cdp: groupFrom(env.ENGAGEMENT_CDP_GROUP_ID, CDP_GROUP_ID, 'ENGAGEMENT_CDP_GROUP_ID'),
    crm: groupFrom(env.ENGAGEMENT_CRM_GROUP_ID, CRM_GROUP_ID, 'ENGAGEMENT_CRM_GROUP_ID'),
  };

  // The DLQ watch defaults to the groups THIS process runs, overrides included: watching
  // `engagement.cdp` while running `engagement.cdp.int4` would report on a queue nobody here is filling.
  const groups = (
    env.ENGAGEMENT_DLQ_GROUPS?.trim() ||
    [consumerGroups.ops, consumerGroups.cdp, consumerGroups.crm].join(',')
  )
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

  const drainIdleMs = intFrom(env.ENGAGEMENT_DRAIN_IDLE_MS, 10_000, 'ENGAGEMENT_DRAIN_IDLE_MS');

  // #599: the watch may cover MORE groups than this process runs — production must list every group on the
  // bus, other windows' included — but never FEWER. A group this process consumes whose dead letters nobody
  // reads is the failure this whole issue is about, and an explicit `ENGAGEMENT_DLQ_GROUPS` is the one way
  // left to create it now that the consumers and the watch share `groups`.
  const running = [
    consumerGroups.ops,
    ...(cdp.enabled ? [consumerGroups.cdp] : []),
    ...(crm.enabled ? [consumerGroups.crm] : []),
  ];
  const unwatched = running.filter((g) => !groups.includes(g));
  if (unwatched.length > 0) {
    throw new ConfigRefusedError(
      `ENGAGEMENT_DLQ_GROUPS does not watch ${unwatched.join(', ')}, which this process consumes: ` +
        `its dead letters would be nobody's (watching: ${groups.join(', ') || '(none)'})`,
    );
  }

  return {
    databaseUrlApp,
    organizationId: env.ENGAGEMENT_ORGANIZATION_ID?.trim() || SEED_IDS.organization,
    transport: transportRaw,
    dir: env.ENGAGEMENT_DIR?.trim() || DEFAULTS.dir,
    ...(transportRaw === 'slack' && slackWebhookUrl ? { slackWebhookUrl } : {}),
    rateLimit: {
      max: intFrom(env.ENGAGEMENT_ALERT_RATE_MAX, DEFAULTS.rateMax, 'ENGAGEMENT_ALERT_RATE_MAX'),
      windowMs: intFrom(
        env.ENGAGEMENT_ALERT_RATE_WINDOW_MS,
        DEFAULTS.rateWindowMs,
        'ENGAGEMENT_ALERT_RATE_WINDOW_MS',
      ),
    },
    dlq: {
      groups,
      threshold: intFrom(
        env.ENGAGEMENT_DLQ_THRESHOLD,
        DEFAULTS.dlqThreshold,
        'ENGAGEMENT_DLQ_THRESHOLD',
      ),
      pollMs: intFrom(env.ENGAGEMENT_DLQ_POLL_MS, DEFAULTS.dlqPollMs, 'ENGAGEMENT_DLQ_POLL_MS'),
    },
    cdp,
    crm,
    support,
    groups: consumerGroups,
    drain: {
      enabled: (opts.argv ?? process.argv).includes('--drain'),
      idleMs: drainIdleMs,
      // A fresh group has to join and be assigned partitions before anything can arrive, so "quiet" means
      // nothing for the idle window AFTER at least this long. Without it an empty-looking first few seconds
      // would end the run before the first batch (#594).
      minRunMs: intFrom(env.ENGAGEMENT_DRAIN_MIN_RUN_MS, 20_000, 'ENGAGEMENT_DRAIN_MIN_RUN_MS'),
    },
  };
}

/**
 * The support API (#556). OFF by default: it is an HTTP server, and one listening with nothing configured to
 * call it is a surface for no benefit. `ENGAGEMENT_DEV_TOKENS` is refused in production outright — the same
 * rule as `CORE_DEV_TOKENS`, and here it would hand out a support agent's view of any customer.
 */
function resolveSupport(
  env: Record<string, string | undefined>,
  isProduction: boolean,
): SupportConfig {
  const enabled = (env.ENGAGEMENT_SUPPORT_ENABLED?.trim() || '0') === '1';
  const devTokens = (env.ENGAGEMENT_DEV_TOKENS?.trim() || '0') === '1';
  if (devTokens && isProduction) {
    throw new ConfigRefusedError('ENGAGEMENT_DEV_TOKENS=1 is refused in production');
  }
  const secret = env.CHATWOOT_WEBHOOK_SECRET?.trim() || undefined;
  return {
    enabled,
    port: intFrom(env.ENGAGEMENT_SUPPORT_PORT, 4040, 'ENGAGEMENT_SUPPORT_PORT'),
    adminApiUrl: env.ADMIN_API_URL?.trim() || 'http://localhost:9000',
    maxOrders: intFrom(env.ENGAGEMENT_SUPPORT_MAX_ORDERS, 25, 'ENGAGEMENT_SUPPORT_MAX_ORDERS'),
    ...(secret ? { chatwootSecret: secret } : {}),
    devTokens,
  };
}

/**
 * The CRM side (#555). OFF by default, like the CDP: no Twenty instance and no service account exist yet.
 * `memory` and the mock token provider are both refused in production when it is enabled.
 */
function resolveCrm(env: Record<string, string | undefined>, isProduction: boolean): CrmConfig {
  const enabled = (env.ENGAGEMENT_CRM_ENABLED?.trim() || '0') === '1';
  const adapter = (env.ENGAGEMENT_CRM_ADAPTER?.trim() || 'memory') as CrmAdapterName;
  if (adapter !== 'memory' && adapter !== 'twenty') {
    throw new ConfigRefusedError(
      `ENGAGEMENT_CRM_ADAPTER must be "memory" or "twenty" (got "${adapter}")`,
    );
  }
  if (enabled && isProduction && adapter === 'memory') {
    throw new ConfigRefusedError(
      'ENGAGEMENT_CRM_ADAPTER=memory is refused in production (nothing would be synced)',
    );
  }

  const tokenProvider = (env.ENGAGEMENT_CRM_TOKEN_PROVIDER?.trim() || 'mock') as
    'mock' | 'client_credentials';
  if (tokenProvider !== 'mock' && tokenProvider !== 'client_credentials') {
    throw new ConfigRefusedError(
      `ENGAGEMENT_CRM_TOKEN_PROVIDER must be "mock" or "client_credentials" (got "${tokenProvider}")`,
    );
  }
  // The dev stand-in token (#594). Refused in production whether or not the CRM is enabled: a production
  // process must not even carry it, and "it was only set, not used" is not a defence for a credential.
  const mockToken = env.ENGAGEMENT_CRM_MOCK_TOKEN?.trim() || undefined;
  if (mockToken && isProduction) {
    throw new ConfigRefusedError(
      'ENGAGEMENT_CRM_MOCK_TOKEN is refused in production (it is a dev stand-in for the crm-sync principal, #565)',
    );
  }

  if (enabled && isProduction && tokenProvider === 'mock') {
    throw new ConfigRefusedError(
      'ENGAGEMENT_CRM_TOKEN_PROVIDER=mock is refused in production (no real service principal)',
    );
  }

  const base: CrmConfig = {
    enabled,
    adapter,
    externalIdField: env.TWENTY_EXTERNAL_ID_FIELD?.trim() || 'externalId',
    adminApiUrl: env.ADMIN_API_URL?.trim() || 'http://localhost:9000',
    tokenProvider,
    ...(mockToken ? { mockToken } : {}),
  };
  if (adapter === 'memory') return base;

  const baseUrl = env.TWENTY_BASE_URL?.trim() || undefined;
  const apiKey = env.TWENTY_API_KEY?.trim() || undefined;
  if (enabled && (!baseUrl || !apiKey)) {
    throw new ConfigRefusedError(
      'ENGAGEMENT_CRM_ADAPTER=twenty requires TWENTY_BASE_URL and TWENTY_API_KEY',
    );
  }
  return {
    ...base,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

// The consent-mode env contract lives in `consent-mode.ts` so the CDP consumer can share it without
// importing this file back (this one imports the consumers for `KNOWN_GROUPS`). Re-exported because it is
// part of this module's published surface.
export { storeEnvKey };

/**
 * The CDP side (#554, consent mode #576). OFF by default: no RudderStack account exists, and a consumer group
 * that reads the bus and sends nowhere is worse than one that is not running. `memory` is refused in
 * production for the same reason the dev sink is — CDP calls into a process's memory are calls nobody
 * receives.
 *
 * THE CONSENT MODE RESOLVES PER STORE. `ENGAGEMENT_CDP_CONSENT_MODE` is the global default (`analytics`), and
 * `ENGAGEMENT_CDP_CONSENT_MODE_<STORE_CODE>` overrides it for one store. Each brand is one market today
 * (A=EU, B=UK, C=US), so a per-store switch is a per-region switch and a region's legal rules become a config
 * change rather than a code change — which is the whole point of #576.
 *
 * Every per-store value is parsed AT STARTUP, not lazily, so a typo in any of them fails the boot instead of
 * silently applying the global default to that region months later.
 */
function resolveCdp(env: Record<string, string | undefined>, isProduction: boolean): CdpConfig {
  const enabled = (env.ENGAGEMENT_CDP_ENABLED?.trim() || '0') === '1';
  const consentMode = parseConsentMode(env[CONSENT_MODE_ENV], CONSENT_MODE_ENV, 'analytics');

  // Every `ENGAGEMENT_CDP_CONSENT_MODE_<STORE>`, keyed by the NORMALISED store key and parsed now so a bad
  // value fails the boot. Normalising the key is the #586 fix: it used to be stored raw and looked up
  // normalised, so `..._brand_a` was validated and then never matched, leaving that store on the global
  // default — a switch that reports success and does nothing.
  const overrides = readConsentModeOverrides(env, consentMode);
  const consentModeFor = (storeCode: string): ConsentMode =>
    overrides.get(storeEnvKey(storeCode)) ?? consentMode;
  const adapter = (env.ENGAGEMENT_CDP_ADAPTER?.trim() || 'memory') as CdpAdapterName;
  if (adapter !== 'memory' && adapter !== 'rudderstack') {
    throw new ConfigRefusedError(
      `ENGAGEMENT_CDP_ADAPTER must be "memory" or "rudderstack" (got "${adapter}")`,
    );
  }
  if (enabled && isProduction && adapter === 'memory') {
    throw new ConfigRefusedError(
      'ENGAGEMENT_CDP_ADAPTER=memory is refused in production (nothing would be sent)',
    );
  }

  if (adapter === 'memory')
    return { enabled, adapter, consentMode, consentModeFor, consentModeOverrides: overrides };

  const writeKey = env.RUDDERSTACK_WRITE_KEY?.trim() || undefined;
  const dataPlaneUrl = env.RUDDERSTACK_DATA_PLANE_URL?.trim() || undefined;
  if (enabled && (!writeKey || !dataPlaneUrl)) {
    throw new ConfigRefusedError(
      'ENGAGEMENT_CDP_ADAPTER=rudderstack requires RUDDERSTACK_WRITE_KEY and RUDDERSTACK_DATA_PLANE_URL',
    );
  }

  const controlPlaneUrl = env.RUDDERSTACK_CONTROL_PLANE_URL?.trim();
  const accessToken = env.RUDDERSTACK_ACCESS_TOKEN?.trim();
  const sourceIds = (env.RUDDERSTACK_SOURCE_IDS?.trim() || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const regulation =
    controlPlaneUrl && accessToken && sourceIds.length
      ? { controlPlaneUrl, accessToken, sourceIds }
      : undefined;

  return {
    enabled,
    adapter,
    consentMode,
    consentModeFor,
    consentModeOverrides: overrides,
    ...(writeKey ? { writeKey } : {}),
    ...(dataPlaneUrl ? { dataPlaneUrl } : {}),
    ...(regulation ? { regulation } : {}),
  };
}
