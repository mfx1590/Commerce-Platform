// The entry point. `start` runs the ops consumer plus the DLQ poll until SIGTERM; `once` (--once) runs a
// single DLQ poll and exits, which is how a script or a CI job drives the watch without a long-lived process.
//
// There is no HTTP server yet: 16.1 is a consumer. The support API arrives with #556.

import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createOrganizationClient, createPool } from '@platform/db';
import { resolveConfig, type EngagementConfig } from './config.js';
import { assertConsentModeOverridesKnown, ConsentModeConfigError } from './consent-mode.js';
import { summariseDrain, waitForIdle, type DrainLogLine } from './drain.js';
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
import { can } from '@platform/auth-sdk';
import { createAgentAuth, type PermissionChecker } from './support/auth.js';
import { createSupportReader } from './support/admin-api.js';
import { createChatwootReceiver } from './support/chatwoot.js';
import { createSupportServer } from './support/server.js';
import { createRateLimiter } from './ops/rate-limit.js';
import { createStoreCodes } from './ops/store-codes.js';
import { readDeadLetters } from '@platform/events';
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
  // `ENGAGEMENT_CRM_MOCK_TOKEN` is the dev stand-in for the crm-sync principal (#565); never in production,
  // where both the mock provider and the value itself are refused by `resolveConfig`.
  return config.crm.mockToken ? mockTokenProvider(config.crm.mockToken) : mockTokenProvider();
}

/**
 * The real permission check: auth-sdk's `can` over OpenFGA, keyed on `staff_user.id` (the OpenFGA subject, not
 * the Keycloak `sub`). `can` fails closed by throwing when OpenFGA is unreachable, which `requireSupport`
 * turns into a 503 rather than a 403 — an agent is not forbidden, we cannot tell.
 */
export function openFgaChecker(): PermissionChecker {
  return {
    can: (staffUserId, relation, object) =>
      can(staffUserId, relation as Parameters<typeof can>[1], object),
  };
}

function logLine(line: EngagementLogLine): void {
  // One JSON object per line: greppable, and it cannot accidentally interpolate an alert field into prose.
  console.info(JSON.stringify(line));
}

/**
 * `--drain` (#594, Integration 4 step 3): start every enabled consumer on the REAL topics from the
 * beginning, wait for the bus to go quiet, stop, and print one report.
 *
 * Why it is a mode of its own rather than a script: the measurement has to be the real wiring — the same
 * consumers, the same handlers, the same marks — differing only in the group id and in stopping by itself.
 * A fresh group (`ENGAGEMENT_*_GROUP_ID`) re-reads the topics without moving the live group's offsets, and
 * `fromBeginning` is what makes a fresh group see the history rather than wait for the next message.
 *
 * The counts come from the log lines the consumers already emit, so the report says exactly what an operator
 * reading the log would conclude — and each consumer's own counters are printed beside them as a
 * cross-check. If the two ever disagree, the report is wrong and says so.
 */
async function runDrain(deps: {
  config: EngagementConfig;
  pool: ReturnType<typeof createPool>;
  hq: ReturnType<typeof createOrganizationClient>;
  transport: AlertTransport;
}): Promise<void> {
  const { config, pool, hq, transport } = deps;
  const lines: DrainLogLine[] = [];
  const collect = (line: DrainLogLine): void => {
    lines.push(line);
    console.info(JSON.stringify(line));
  };

  let lastBatchAt: number | null = null;
  const onBatch = (): void => {
    lastBatchAt = Date.now();
  };

  // The same check the long-running path makes, before anything starts (#590).
  const storeCodes = createStoreCodes(hq);
  if (config.cdp.enabled) {
    await storeCodes.warm();
    assertConsentModeOverridesKnown(config.cdp.consentModeOverrides, storeCodes.codes());
  }

  const ops = createOpsConsumer({
    hq,
    transport,
    rateLimit: config.rateLimit,
    groupId: config.groups.ops,
    fromBeginning: true,
    onBatch,
    log: collect,
  });
  const cdp = config.cdp.enabled
    ? createCdpConsumer({
        hq,
        pool,
        adapter: buildCdpAdapter(config),
        consentModeFor: config.cdp.consentModeFor,
        consentModeOverrides: config.cdp.consentModeOverrides,
        storeCodes,
        groupId: config.groups.cdp,
        fromBeginning: true,
        onBatch,
        log: collect,
      })
    : null;
  const crm = config.crm.enabled
    ? createCrmConsumer({
        hq,
        pool,
        adapter: buildCrmAdapter(config),
        customers: createAdminApiReader({
          baseUrl: config.crm.adminApiUrl,
          tokens: buildTokenProvider(config),
        }),
        groupId: config.groups.crm,
        fromBeginning: true,
        onBatch,
        log: collect,
      })
    : null;

  const started: { stop(): Promise<void> }[] = [];
  const startedAt = Date.now();
  let stop: Awaited<ReturnType<typeof waitForIdle>> = 'empty';
  try {
    await ops.start();
    started.push(ops);
    if (cdp) {
      await cdp.start();
      started.push(cdp);
    }
    if (crm) {
      await crm.start();
      started.push(crm);
    }
    stop = await waitForIdle({
      lastBatchAt: () => lastBatchAt,
      startedAt,
      idleMs: config.drain.idleMs,
      minRunMs: config.drain.minRunMs,
    });
  } finally {
    for (const s of [...started].reverse()) await s.stop().catch(() => undefined);
  }

  // The dead letters of THESE groups, after they stopped: the number the gate cares about (expected 0).
  const deadLetters: Record<string, number> = {};
  for (const [module, groupId] of [
    ['ops', config.groups.ops],
    ['cdp', config.groups.cdp],
    ['crm', config.groups.crm],
  ] as const) {
    if (module === 'cdp' && !cdp) continue;
    if (module === 'crm' && !crm) continue;
    try {
      deadLetters[groupId] = (await readDeadLetters(groupId, { timeoutMs: 10_000 })).length;
    } catch {
      // An unreadable DLQ is reported as unknown, never as zero: zero is a gate line.
      deadLetters[groupId] = -1;
    }
  }

  console.info(
    JSON.stringify({
      service: 'engagement',
      event: 'drained',
      stop,
      elapsed_ms: Date.now() - startedAt,
      groups: config.groups,
      enabled: { ops: true, cdp: Boolean(cdp), crm: Boolean(crm) },
      report: summariseDrain(lines),
      // The consumers' own counters, beside the log-derived report, as two paths to one answer.
      counters: {
        ops: { sent: ops.sent, suppressed: ops.suppressed },
        ...(cdp ? { cdp: { sent: cdp.sent, dropped: cdp.dropped } } : {}),
        ...(crm
          ? { crm: { upserted: crm.upserted, removed: crm.removed, skipped: crm.skipped } }
          : {}),
      },
      dead_letters: deadLetters,
      transport: transport.name,
      cdp_adapter: config.cdp.enabled ? config.cdp.adapter : null,
      crm_adapter: config.crm.enabled ? config.crm.adapter : null,
    }),
  );
  await pool.end();
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = resolveConfig();
  const pool = createPool(config.databaseUrlApp);
  const hq = createOrganizationClient(pool, { organizationId: config.organizationId });
  const transport = buildTransport(config);

  // `--drain` is the one-shot measurement mode (#594); `--once` below is the DLQ poll and is unchanged.
  if (config.drain.enabled) {
    await runDrain({ config, pool, hq, transport });
    return;
  }

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

  // ONE store-code cache for the process, warmed HERE — before a single consumer starts (#590 review).
  //
  // This is where the per-store consent-mode override keys are checked, and the order is the whole point: a
  // consumer that is already running keeps the event loop alive, so a throw after `start()` could only set an
  // exit code that never takes effect. The process would sit there with a bad configuration, consuming. The
  // check needs the store list, which is why it cannot be in `resolveConfig`; it needs nothing else, which is
  // why it can be the first thing that happens.
  //
  // It runs only when the CDP is enabled, the limit agreed on #586: a consumer that is not running applies no
  // mode to anything. Now that the check lives here it COULD cover the disabled case too, at the cost of one
  // query on every boot — a decision for the manager, not a thing to widen quietly.
  const storeCodes = createStoreCodes(hq);
  if (config.cdp.enabled) {
    await storeCodes.warm();
    assertConsentModeOverridesKnown(config.cdp.consentModeOverrides, storeCodes.codes());
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

  // The CDP consumer is its own group and runs only when enabled (off until an account exists, #554).
  const cdp = config.cdp.enabled
    ? createCdpConsumer({
        hq,
        pool,
        adapter: buildCdpAdapter(config),
        // Per-store consent mode (#576): resolved per event from the store the event names.
        consentModeFor: config.cdp.consentModeFor,
        // The keys behind it, so a consumer built anywhere else gets the same refusal (#586). The boot's own
        // check is above, where it can still stop the process.
        consentModeOverrides: config.cdp.consentModeOverrides,
        // The cache this process already warmed: one query for the organization's stores, not two.
        storeCodes,
        log: (line) => console.info(JSON.stringify(line)),
      })
    : null;

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
  // The support API (#556): an HTTP server, off unless asked for. The agent's own token authenticates every
  // request; there is no service principal anywhere in this route.
  const support = config.support.enabled
    ? createSupportServer({
        hq,
        auth: createAgentAuth({
          client: hq,
          fga: openFgaChecker(),
          devTokens: config.support.devTokens,
        }),
        reader: createSupportReader({
          baseUrl: config.support.adminApiUrl,
          maxOrders: config.support.maxOrders,
        }),
        ...(config.support.chatwootSecret
          ? { chatwoot: createChatwootReceiver({ secret: config.support.chatwootSecret }) }
          : {}),
        log: (line) => console.info(JSON.stringify(line)),
      })
    : null;

  // Starting is all-or-nothing (#590 review). A half-started process keeps the event loop alive, so a
  // failure here has to unwind what already runs — otherwise the boot "fails" and the service stays up.
  const started: { stop(): Promise<void> }[] = [];
  try {
    await consumer.start();
    started.push(consumer);
    if (cdp) {
      await cdp.start();
      started.push(cdp);
    }
    if (crm) {
      await crm.start();
      started.push(crm);
    }
    if (support) {
      await new Promise<void>((r) => support.listen(config.support.port, r));
      console.info(
        JSON.stringify({
          service: 'engagement',
          module: 'support',
          event: 'started',
          port: config.support.port,
          chatwoot: Boolean(config.support.chatwootSecret),
        }),
      );
    }
  } catch (err) {
    // Newest first, and a failure to stop must not mask the failure to start.
    for (const s of [...started].reverse()) await s.stop().catch(() => undefined);
    if (support?.listening) await new Promise<void>((r) => support.close(() => r()));
    await pool.end().catch(() => undefined);
    throw err;
  }

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
    if (support) await new Promise<void>((r) => support.close(() => r()));
    await pool.end();
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

// Only when run directly (`node dist/main.js`), never on import from a test. `pathToFileURL` because a Windows
// path (`C:\...`) is not a URL path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // The CLASS, never the error itself: a thrown error's message or stack can carry a webhook URL, a write
    // key or a row it was handling (#562 review). The class is what a restart policy needs.
    //
    // ONE EXCEPTION, added by the #590 review: a `ConsentModeConfigError`'s message is also printed, because
    // this module builds those messages itself out of env variable names and store codes — no payload, no
    // secret, no personal data — and the operator needs to be told WHICH variable is wrong. Without it the
    // boot failure reads `error_class: "Error"` and the name of the offending key is thrown away.
    const line = JSON.stringify({
      service: 'engagement',
      module: 'ops',
      event: 'crashed',
      error_class: err instanceof Error ? err.name : 'Error',
      ...(err instanceof ConsentModeConfigError ? { message: err.message } : {}),
    });
    // Written synchronously: `process.exit` below can truncate a buffered write to a pipe, and the whole
    // point of this line is that it reaches whoever is reading the logs.
    writeSync(2, `${line}\n`);
    // EXIT, not just an exit code. `process.exitCode` alone does nothing while something is still running
    // (an ops consumer, a server, a timer) — the defect this review found: the service stayed up with a
    // configuration it had already refused.
    process.exit(1);
  });
}

export { main };
