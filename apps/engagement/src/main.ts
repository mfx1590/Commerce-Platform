// The entry point. `start` runs the ops consumer plus the DLQ poll until SIGTERM; `once` (--once) runs a
// single DLQ poll and exits, which is how a script or a CI job drives the watch without a long-lived process.
//
// There is no HTTP server yet: 16.1 is a consumer. The support API arrives with #556.

import { pathToFileURL } from 'node:url';
import { createOrganizationClient, createPool } from '@platform/db';
import { resolveConfig, type EngagementConfig } from './config.js';
import { createCdpConsumer } from './cdp/consumer.js';
import { MemoryCdpAdapter } from './cdp/adapter/memory.js';
import { RudderStackCdpAdapter } from './cdp/adapter/rudderstack.js';
import type { CdpAdapter } from './cdp/types.js';
import { createCrmConsumer } from './crm/consumer.js';
import { createAdminApiReader, mockTokenProvider } from './crm/admin-api.js';
import { MemoryCrmAdapter } from './crm/adapter/memory.js';
import { TwentyCrmAdapter } from './crm/adapter/twenty.js';
import type { CrmAdapter, TokenProvider } from './crm/types.js';
import { createOpsConsumer } from './ops/consumer.js';
import { createRateLimiter } from './ops/rate-limit.js';
import { runDlqWatch } from './ops/dlq-watch.js';
import { DevSinkAlertTransport } from './transport/dev-sink.js';
import { SlackAlertTransport } from './transport/slack.js';
import type { AlertTransport } from './transport/types.js';
import type { EngagementLogLine } from './types.js';

export function buildTransport(config: EngagementConfig): AlertTransport {
  if (config.transport === 'slack') {
    return new SlackAlertTransport({ webhookUrl: config.slackWebhookUrl as string });
  }
  return new DevSinkAlertTransport(config.dir);
}

/** The CDP adapter the config asks for. `memory` is what runs until a RudderStack account exists. */
export function buildCdpAdapter(config: EngagementConfig): CdpAdapter {
  if (config.cdp.adapter === 'rudderstack') {
    return new RudderStackCdpAdapter({
      writeKey: config.cdp.writeKey as string,
      dataPlaneUrl: config.cdp.dataPlaneUrl as string,
      ...(config.cdp.regulation ? { regulation: config.cdp.regulation } : {}),
    });
  }
  return new MemoryCdpAdapter();
}

/** The CRM adapter the config asks for. `memory` is what runs until a Twenty instance exists. */
export function buildCrmAdapter(config: EngagementConfig): CrmAdapter {
  if (config.crm.adapter === 'twenty') {
    return new TwentyCrmAdapter({
      baseUrl: config.crm.baseUrl as string,
      apiKey: config.crm.apiKey as string,
      externalIdField: config.crm.externalIdField,
    });
  }
  return new MemoryCrmAdapter();
}

/**
 * The Admin API principal. Only the mock exists today: the real `crm-sync` service account is #565, accepted
 * and routed to window 2, and `client_credentials` is refused here until it is built rather than silently
 * falling back to the mock.
 */
export function buildTokenProvider(config: EngagementConfig): TokenProvider {
  if (config.crm.tokenProvider === 'client_credentials') {
    throw new Error(
      'ENGAGEMENT_CRM_TOKEN_PROVIDER=client_credentials is not implemented yet (REQUEST #565)',
    );
  }
  return mockTokenProvider();
}

function logLine(line: EngagementLogLine): void {
  // One JSON object per line: greppable, and it cannot accidentally interpolate an alert field into prose.
  console.info(JSON.stringify(line));
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = resolveConfig();
  const pool = createPool(config.databaseUrlApp);
  const hq = createOrganizationClient(pool, { organizationId: config.organizationId });
  const transport = buildTransport(config);

  if (once) {
    const limiter = createRateLimiter(config.rateLimit);
    const r = await runDlqWatch({
      groups: config.dlq.groups,
      threshold: config.dlq.threshold,
      organizationId: config.organizationId,
      limiter,
      transport,
      log: logLine,
    });
    console.info(
      JSON.stringify({
        service: 'engagement',
        module: 'ops',
        event: 'dlq_poll',
        groups: config.dlq.groups.length,
        sent: r.sent.length,
        suppressed: r.suppressed,
        transport: transport.name,
      }),
    );
    await pool.end();
    return;
  }

  const consumer = createOpsConsumer({
    hq,
    transport,
    rateLimit: config.rateLimit,
    log: logLine,
  });
  // Its own limiter, not the consumer's: a flood of payment failures must not use up the window a stuck DLQ
  // needs. The keys differ already (rule + group vs rule + store); a separate limiter keeps that true whatever
  // a future rule is called.
  const watchLimiter = createRateLimiter(config.rateLimit);
  await consumer.start();

  // The CDP consumer is its own group and runs only when enabled (off until an account exists, #554).
  const cdp = config.cdp.enabled
    ? createCdpConsumer({
        hq,
        pool,
        adapter: buildCdpAdapter(config),
        log: (line) => console.info(JSON.stringify(line)),
      })
    : null;
  if (cdp) await cdp.start();

  // The CRM consumer, likewise its own group and off until a CRM and a service account exist (#555, #565).
  const crm = config.crm.enabled
    ? createCrmConsumer({
        hq,
        pool,
        adapter: buildCrmAdapter(config),
        customers: createAdminApiReader({
          baseUrl: config.crm.adminApiUrl,
          tokens: buildTokenProvider(config),
        }),
        log: (line) => console.info(JSON.stringify(line)),
      })
    : null;
  if (crm) await crm.start();

  const timer = setInterval(() => {
    void runDlqWatch({
      groups: config.dlq.groups,
      threshold: config.dlq.threshold,
      organizationId: config.organizationId,
      limiter: watchLimiter,
      transport,
      log: logLine,
    }).catch((err: unknown) => {
      logLine({
        service: 'engagement',
        module: 'ops',
        event: 'dlq_poll',
        error_class: err instanceof Error ? err.name : 'Error',
      });
    });
  }, config.dlq.pollMs);
  timer.unref?.();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await consumer.stop();
    if (cdp) await cdp.stop();
    if (crm) await crm.stop();
    await pool.end();
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

// Only when run directly (`node dist/main.js`), never on import from a test. `pathToFileURL` because a Windows
// path (`C:\...`) is not a URL path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // The CLASS only, never the error itself: a thrown error's message or stack can carry a webhook URL, a
    // write key or a row it was handling (#562 review). The class is what a restart policy needs.
    console.error(
      JSON.stringify({
        service: 'engagement',
        module: 'ops',
        event: 'crashed',
        error_class: err instanceof Error ? err.name : 'Error',
      }),
    );
    process.exitCode = 1;
  });
}

export { main };
