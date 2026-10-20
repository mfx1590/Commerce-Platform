#!/usr/bin/env node
// Creates (idempotently) every event topic and dead-letter topic on a Redpanda/Kafka broker (issue #530).
//
//   node infra/redpanda/create-topics.mjs [--env local|ci|production] [--dry-run] [--brokers host:port,…]
//   pnpm --filter @platform/events topics:create [-- --env ci]
//
// The topic list comes from packages/events (EVENT_TOPICS); the numbers from topics.policy.json next to this
// file. Needs the events package built (`pnpm --filter @platform/events build`); the pnpm script does that.
// Run twice = no change: the summary line then reads created 0 / altered 0 / partitions raised 0.
// Never deletes a topic. Exit 1 on any broker error; exit 2 on a usage error.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../packages/events/dist/index.js');
if (!existsSync(dist)) {
  console.error(
    `create-topics: ${dist} missing — run \`pnpm --filter @platform/events build\` first`,
  );
  process.exit(2);
}
const { createKafka, ensureTopics, planTopics } = await import(pathToFileURL(dist).href);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? '');
};
if (args.includes('--help') || args.includes('-h')) {
  console.info(
    'usage: create-topics.mjs [--env local|ci|production] [--dry-run] [--brokers host:port,…]',
  );
  process.exit(0);
}
const environment = flag('--env') ?? process.env.REDPANDA_ENV ?? 'local';
const dryRun = args.includes('--dry-run');
const brokers = flag('--brokers')
  ?.split(',')
  .map((b) => b.trim())
  .filter(Boolean);

const policy = JSON.parse(readFileSync(resolve(here, 'topics.policy.json'), 'utf8'));
const plan = planTopics(policy, { environment });

const kafka = createKafka(
  brokers ? { brokers, clientId: 'create-topics' } : { clientId: 'create-topics' },
);
const admin = kafka.admin();
try {
  await admin.connect();
  const result = await ensureTopics(admin, plan, { dryRun });
  console.info(
    JSON.stringify({
      script: 'create-topics',
      environment,
      dry_run: dryRun,
      topics_planned: plan.length,
      created: result.created.length,
      altered: result.altered.length,
      partitions_raised: result.partitionsRaised.length,
      unchanged: result.unchanged.length,
      warnings: result.warnings.length,
    }),
  );
  for (const t of result.created) console.info(`  created ${t}`);
  for (const a of result.altered) console.info(`  altered ${a.topic} ${JSON.stringify(a.changes)}`);
  for (const p of result.partitionsRaised)
    console.info(`  partitions ${p.topic} ${p.from} -> ${p.to}`);
  for (const w of result.warnings) console.warn(`  warning ${w}`);
} catch (err) {
  console.error(`create-topics: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await admin.disconnect();
}
