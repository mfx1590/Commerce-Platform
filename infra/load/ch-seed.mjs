#!/usr/bin/env node
/**
 * Seeds ClickHouse for the admin-metrics leg of the scheduled k6 SLO regression (#785; .github/workflows/load.yml).
 *
 *   node infra/load/ch-seed.mjs <out.json> [months]
 *
 * The generated month (@platform/test-utils' generateMonth: real envelopes, the seed's organization and three stores,
 * no PII), about 210 orders per month asked for, written into analytics.raw_events through the analytics ingest's own
 * public path (envelopeToMessage → classify → createRawEventsSink), as its models test does. The models (views) and
 * the materialized view then answer the metrics API from it. Writes <out.json>: { events, perStore, firstDay, lastDay }
 * for the k6 date range and the summary ("small data: a lower bound").
 *
 * ClickHouse comes from the CLICKHOUSE_* env the ingest's loadConfig reads (the job's, never a committed password).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INGEST = join(ROOT, 'apps/analytics-ingest');

/** A workspace package as the analytics ingest resolves it (its node_modules), through its `import` export. */
async function load(name) {
  const dir = name === '@platform/analytics-ingest' ? INGEST : join(INGEST, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.default ?? pkg.main;
  return import(pathToFileURL(join(dir, entry)).href);
}

export async function seed(months = 1, { dryRun = false } = {}) {
  const { generateMonth } = await load('@platform/test-utils');
  const { createValidator, envelopeToMessage } = await load('@platform/events');
  const { classify, createChClient, createRawEventsSink, loadConfig } = await load(
    '@platform/analytics-ingest',
  );

  const month = generateMonth({
    orders: 210 * months,
    legalEntities: 3,
    deterministicIds: true,
    seed: 785,
  });
  const validator = createValidator();
  const now = new Date();
  const rows = month.events.map((e, i) => {
    const m = envelopeToMessage(e, 'core-outbox-relay/load');
    const c = classify(
      {
        key: m.key,
        value: m.value,
        headers: m.headers,
        offset: String(i),
        timestamp: String(now.getTime()),
      },
      { topic: e.topic, partition: 0 },
      { groupId: 'analytics.raw', validator, now },
    );
    if (c.kind !== 'row')
      throw new Error(`generated ${e.topic} was dead-lettered: ${c.letter.error_class}`);
    return c.row;
  });

  const config = loadConfig(process.env, []);
  const ch = dryRun ? null : createChClient(config.clickhouse);
  if (ch)
    try {
      const sink = createRawEventsSink(ch);
      for (let i = 0; i < rows.length; i += 1000) await sink.insert(rows.slice(i, i + 1000));
    } finally {
      await ch.close();
    }

  const perStore = {};
  for (const e of month.events)
    if (e.store_id) perStore[e.store_id] = (perStore[e.store_id] ?? 0) + 1;
  const days = month.events.map((e) => e.occurred_at.slice(0, 10)).sort();
  return { events: rows.length, months, perStore, firstDay: days[0], lastDay: days.at(-1) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, months] = process.argv.slice(2);
  if (!out) {
    console.error('usage: node infra/load/ch-seed.mjs <out.json> [months]');
    process.exit(2);
  }
  const n = Number(months ?? 1);
  if (!(Number.isInteger(n) && n >= 1 && n <= 12)) {
    console.error(`months must be an integer from 1 to 12, got "${months}"`);
    process.exit(2);
  }
  const result = await seed(n);
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.info(
    `ch-seed: ${result.events} events in raw_events (${n} month(s), ${result.firstDay} … ${result.lastDay}); per store: ${JSON.stringify(result.perStore)}`,
  );
}
