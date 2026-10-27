// The recommendations rebuild (task P5.8, #607). Two ways to run the same function, exactly like
// src/jobs/abandoned-carts.ts:
//
//  1. As a Medusa scheduled job — this file exports Medusa's job contract (`default` handler + `config` with a
//     cron `schedule`), because Medusa's job loader scans `src/jobs` and REFUSES TO BOOT the core if any file
//     here lacks a `config` (#202 / #203). Env:
//       CORE_RECOMMENDATIONS_CRON            cron expression, default "30 3 * * *" (nightly, after the day's data)
//       CORE_RECOMMENDATIONS_LOOKBACK_DAYS   basket window, default 90
//       CORE_RECOMMENDATIONS_MIN_SUPPORT     baskets a pair needs, default 3
//       CORE_RECOMMENDATIONS_MIN_LIFT        lift a pair needs, default 1.2
//       CORE_RECOMMENDATIONS_MAX_PAIRS       stored per anchor, default 24
//       CORE_RECOMMENDATIONS_MAX_POPULAR     stored per store per window, default 24
//       CLICKHOUSE_URL / CLICKHOUSE_DATABASE / CLICKHOUSE_READONLY_USER / CLICKHOUSE_READONLY_PASSWORD
//     The env rows belong to window 1's `.env.example` (REQUEST filed with #607); the defaults above work
//     without any of them except the ClickHouse set, and with no ClickHouse the job logs why and exits 0.
//
//  2. As a one-shot CLI (runbooks, a single store, CI):
//       pnpm --filter @platform/core exec tsx src/jobs/index-recommendations.ts [--store brand-a] [--dry-run]
//
// The heavy lifting lives in the search module (`rebuildStoreRecommendations`), so it is testable without
// booting Medusa; this file is wiring, the store loop and the log lines only.
import {
  ClickHouseBasketSource,
  ClickHouseClient,
  clickhouseCredentialsFrom,
  POPULAR_WINDOWS,
  rebuildStoreRecommendations,
  recommendPairs,
  recommendPopular,
  thresholdsFromEnv,
  type BasketSource,
  type PopularWindow,
  type RebuildResult,
} from '../modules/search';
import { closePool, initDb, organizationClient, tenantClient } from '../lib/db';
import { coreOrganizationId } from '../http/tenant';

export const DEFAULT_CRON = '30 3 * * *';

interface StoreRow {
  id: string;
  code: string;
}

/** Every store of the organization (the `store` table is itself under RLS, so this needs organization scope). */
async function listStores(organizationId: string, code?: string): Promise<StoreRow[]> {
  const client = organizationClient({ organizationId });
  const params: unknown[] = [];
  let where = '';
  if (code) {
    params.push(code);
    where = ` WHERE code = $1`;
  }
  const r = await client.query<StoreRow>(
    `SELECT id, code FROM store${where} ORDER BY code`,
    params,
  );
  return r.rows;
}

export interface RunOptions {
  organizationId?: string | undefined;
  /** One store code instead of every store. */
  storeCode?: string | undefined;
  /** Compute and report, write nothing. */
  dryRun?: boolean | undefined;
  /** Injected in tests and until #601 lands; default = the real ClickHouse source. */
  source?: BasketSource | undefined;
  now?: Date | undefined;
}

export interface RunSummary {
  source: string;
  results: RebuildResult[];
  /** Set when the job did nothing because ClickHouse is not configured. */
  skipped?: string;
}

/**
 * One pass: every store (or one), each rewritten in its own transaction through its own tenant client, so one
 * store's bad data can never roll back another's rows and no pass ever holds organization scope while writing.
 */
export async function runIndexRecommendations(opts: RunOptions = {}): Promise<RunSummary> {
  const organizationId = opts.organizationId ?? coreOrganizationId();
  const thresholds = thresholdsFromEnv();

  let source = opts.source;
  if (!source) {
    const creds = clickhouseCredentialsFrom();
    if (!creds) {
      return {
        source: 'none',
        results: [],
        skipped:
          'ClickHouse is not configured (CLICKHOUSE_URL / CLICKHOUSE_READONLY_USER / CLICKHOUSE_READONLY_PASSWORD) — nothing rebuilt',
      };
    }
    source = new ClickHouseBasketSource(new ClickHouseClient(creds));
  }

  const stores = await listStores(organizationId, opts.storeCode);
  const results: RebuildResult[] = [];
  for (const store of stores) {
    const client = tenantClient({ organizationId, storeIds: [store.id] });
    if (opts.dryRun) {
      // Same computation, no transaction: what a real run WOULD write, so the number is comparable with the
      // `pairs` a real run reports. `counts.pairs.size` would be the raw candidate count before the lift floor
      // (and counts one row per unordered pair, not the two directions that get stored).
      const counts = await source.counts(store.id, thresholds);
      const popular: Record<PopularWindow, number> = { 7: 0, 30: 0 };
      for (const window of POPULAR_WINDOWS) {
        const units = await source.units(store.id, window);
        popular[window] = recommendPopular(units, thresholds.maxPopularPerStore).length;
      }
      results.push({
        storeId: store.id,
        pairs: recommendPairs(counts, thresholds).length,
        popular,
      });
      continue;
    }
    results.push(
      await rebuildStoreRecommendations(
        client,
        store.id,
        source,
        thresholds,
        opts.now ?? new Date(),
      ),
    );
  }
  return { source: source.kind, results };
}

// ---- Medusa scheduled job contract ----
export const config = {
  name: 'index-recommendations',
  schedule: process.env.CORE_RECOMMENDATIONS_CRON?.trim() || DEFAULT_CRON,
};

export default async function indexRecommendationsJob(): Promise<void> {
  const summary = await runIndexRecommendations();
  if (summary.skipped) {
    console.info(`[core] index-recommendations: ${summary.skipped}`);
    return;
  }
  const pairs = summary.results.reduce((n, r) => n + r.pairs, 0);
  const popular = summary.results.reduce((n, r) => n + r.popular[7] + r.popular[30], 0);
  console.info(
    `[core] index-recommendations: ${summary.results.length} store(s), ${pairs} pair row(s), ${popular} popular row(s) from ${summary.source}`,
  );
}

// ---- CLI ----
function parseArgs(argv: string[]): { storeCode?: string; dryRun: boolean } {
  let storeCode: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') {
      const v = argv[++i];
      if (!v) throw new Error('--store needs a store code');
      storeCode = v;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return { ...(storeCode ? { storeCode } : {}), dryRun };
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    await initDb({ startDir: __dirname });
    try {
      const summary = await runIndexRecommendations(args);
      if (summary.skipped) {
        console.info(`index-recommendations: ${summary.skipped}`);
        return;
      }
      for (const r of summary.results) {
        console.info(
          `index-recommendations: store ${r.storeId} — ${r.pairs} pair row(s), popular 7d ${r.popular[7]}, 30d ${r.popular[30]}`,
        );
      }
    } finally {
      await closePool();
    }
  })().catch((err) => {
    console.error('index-recommendations failed', err);
    process.exit(1);
  });
}
