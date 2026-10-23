// Configuration from the environment, with the production refusals in one place.
//
// Secrets: `SLACK_OPS_WEBHOOK_URL` is read here and nowhere else, never defaulted, never logged, never written
// to an alert field. There is no secret in this repository and no test uses a secret-shaped literal (the
// gitleaks rule in Memory-main): the fixtures use words.

import { SEED_IDS } from '@platform/db';
import { CDP_GROUP_ID } from './cdp/consumer.js';
import { OPS_GROUP_ID } from './ops/consumer.js';

export type TransportName = 'dev' | 'slack';
export type CdpAdapterName = 'memory' | 'rudderstack';

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
}

export interface CdpConfig {
  /** `false` keeps the CDP consumer off entirely (the default until a RudderStack account exists). */
  enabled: boolean;
  adapter: CdpAdapterName;
  /** Only when `adapter === 'rudderstack'`. */
  writeKey?: string;
  dataPlaneUrl?: string;
  /** Only when all three are set: without them a suppression throws rather than silently doing nothing. */
  regulation?: { controlPlaneUrl: string; accessToken: string; sourceIds: string[] };
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  /** Defaults to `env.NODE_ENV`. */
  nodeEnv?: string;
}

/**
 * Every consumer group this service knows about, and the default for `ENGAGEMENT_DLQ_GROUPS`. A group missing
 * from the watch list is a group whose dead letters nobody is told about, so the default is "all of mine"
 * rather than "the one I am" (#562 review). IN PRODUCTION the variable must list EVERY group on the bus,
 * including other windows' (`accounting`, …): this default can only know its own.
 */
export const KNOWN_GROUPS = [OPS_GROUP_ID, CDP_GROUP_ID] as const;

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
    throw new Error(`${what} must be an integer >= 1 (got ${JSON.stringify(raw)})`);
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
  if (!databaseUrlApp) throw new Error('DATABASE_URL_APP is required');

  const transportRaw = (env.ENGAGEMENT_TRANSPORT?.trim() || 'dev') as TransportName;
  if (transportRaw !== 'dev' && transportRaw !== 'slack') {
    throw new Error(`ENGAGEMENT_TRANSPORT must be "dev" or "slack" (got "${transportRaw}")`);
  }
  if (isProduction && transportRaw === 'dev') {
    throw new Error(
      'ENGAGEMENT_TRANSPORT=dev is refused in production (alerts would go to a local file)',
    );
  }

  const slackWebhookUrl = env.SLACK_OPS_WEBHOOK_URL?.trim() || undefined;
  if (transportRaw === 'slack' && !slackWebhookUrl) {
    throw new Error('ENGAGEMENT_TRANSPORT=slack requires SLACK_OPS_WEBHOOK_URL');
  }

  const cdp = resolveCdp(env, isProduction);

  const groups = (env.ENGAGEMENT_DLQ_GROUPS?.trim() || KNOWN_GROUPS.join(','))
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

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
  };
}

/**
 * The CDP side (#554). OFF by default: no RudderStack account exists, and a consumer group that reads the bus
 * and sends nowhere is worse than one that is not running. `memory` is refused in production for the same
 * reason the dev sink is — CDP calls into a process's memory are calls nobody receives.
 */
function resolveCdp(env: Record<string, string | undefined>, isProduction: boolean): CdpConfig {
  const enabled = (env.ENGAGEMENT_CDP_ENABLED?.trim() || '0') === '1';
  const adapter = (env.ENGAGEMENT_CDP_ADAPTER?.trim() || 'memory') as CdpAdapterName;
  if (adapter !== 'memory' && adapter !== 'rudderstack') {
    throw new Error(`ENGAGEMENT_CDP_ADAPTER must be "memory" or "rudderstack" (got "${adapter}")`);
  }
  if (enabled && isProduction && adapter === 'memory') {
    throw new Error(
      'ENGAGEMENT_CDP_ADAPTER=memory is refused in production (nothing would be sent)',
    );
  }

  if (adapter === 'memory') return { enabled, adapter };

  const writeKey = env.RUDDERSTACK_WRITE_KEY?.trim() || undefined;
  const dataPlaneUrl = env.RUDDERSTACK_DATA_PLANE_URL?.trim() || undefined;
  if (enabled && (!writeKey || !dataPlaneUrl)) {
    throw new Error(
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
    ...(writeKey ? { writeKey } : {}),
    ...(dataPlaneUrl ? { dataPlaneUrl } : {}),
    ...(regulation ? { regulation } : {}),
  };
}
