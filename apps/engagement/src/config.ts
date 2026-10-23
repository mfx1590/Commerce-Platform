// Configuration from the environment, with the production refusals in one place.
//
// Secrets: `SLACK_OPS_WEBHOOK_URL` is read here and nowhere else, never defaulted, never logged, never written
// to an alert field. There is no secret in this repository and no test uses a secret-shaped literal (the
// gitleaks rule in Memory-main): the fixtures use words.

import { SEED_IDS } from '@platform/db';
import { OPS_GROUP_ID } from './ops/consumer.js';

export type TransportName = 'dev' | 'slack';

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
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  /** Defaults to `env.NODE_ENV`. */
  nodeEnv?: string;
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

  const groups = (env.ENGAGEMENT_DLQ_GROUPS?.trim() || OPS_GROUP_ID)
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
  };
}
