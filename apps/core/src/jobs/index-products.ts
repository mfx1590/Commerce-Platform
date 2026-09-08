// Product index job (issue #134). Full reindex or incremental outbox sync of one, several or every active
// store. Runs as a one-shot (cron / CI / runbook) or as a loop (`--loop <ms>`), always through the tenant client
// of the store being indexed. Credentials: ALGOLIA_APP_ID / ALGOLIA_ADMIN_API_KEY (or the per-store
// ALGOLIA_*_<CODE> pair) from the repo-root .env / Vault; `--fake` runs the in-memory client (dry run, local dev
// without an Algolia account).
//
//   pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --all --full
//   pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --store brand-a
//   pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --all --loop 5000
//   pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --store brand-a --full --fake
import { SEED_IDS } from '@platform/db';
import { closePool, initDb, organizationClient, tenantClient } from '../lib/db';
import {
  AlgoliaIndexClient,
  FakeIndexClient,
  algoliaCredentialsFor,
  fullReindex,
  indexNameFor,
  syncUntilCaughtUp,
  type IndexClient,
  type StoreIndexTarget,
} from '../modules/search';

export interface JobArgs {
  stores: string[];
  all: boolean;
  full: boolean;
  fake: boolean;
  loopMs: number | null;
  batchSize: number | undefined;
}

export function parseArgs(argv: string[]): JobArgs {
  const args: JobArgs = {
    stores: [],
    all: false,
    full: false,
    fake: false,
    loopMs: null,
    batchSize: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--store') args.stores.push(next());
    else if (a === '--all') args.all = true;
    else if (a === '--full') args.full = true;
    else if (a === '--fake') args.fake = true;
    else if (a === '--loop') args.loopMs = Math.max(250, Number(next()));
    else if (a === '--batch') args.batchSize = Math.max(1, Number(next()));
    else if (a === '--help' || a === '-h') {
      args.stores = [];
      args.all = false;
      return args;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!args.all && args.stores.length === 0)
    throw new Error('pass --store <code> (repeatable) or --all');
  return args;
}

type Log = (msg: string) => void;

interface StoreRow extends StoreIndexTarget {
  status: string;
}

async function listStores(organizationId: string, codes: string[]): Promise<StoreRow[]> {
  const org = organizationClient({ organizationId, actorId: null });
  const params: unknown[] = [];
  let where = `status = 'active'`;
  if (codes.length > 0) {
    params.push(codes);
    where += ` AND code = ANY($1)`;
  }
  const r = await org.query<StoreRow>(
    `SELECT id, code, default_currency, search_index, status FROM store WHERE ${where} ORDER BY code`,
    params,
  );
  return r.rows;
}

/** One pass over the selected stores. Returns the number of stores that failed. */
export async function runOnce(
  args: JobArgs,
  organizationId: string,
  clients: Map<string, IndexClient>,
  log: Log,
): Promise<number> {
  const stores = await listStores(organizationId, args.stores);
  const missing = args.stores.filter((c) => !stores.some((s) => s.code === c));
  for (const m of missing) log(`search: store ${m} not found or not active — skipped`);
  let failed = missing.length;
  for (const store of stores) {
    let index: IndexClient | undefined;
    if (args.fake) {
      index = clients.get('fake') ?? new FakeIndexClient();
      clients.set('fake', index);
    } else {
      const creds = algoliaCredentialsFor(store.code);
      if (!creds) {
        log(
          `search: ${store.code}: no Algolia credentials (ALGOLIA_APP_ID/ALGOLIA_ADMIN_API_KEY or the _${store.code
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')} pair) — skipped`,
        );
        failed++;
        continue;
      }
      index = clients.get(creds.appId);
      if (!index) {
        index = new AlgoliaIndexClient({ appId: creds.appId, apiKey: creds.apiKey });
        clients.set(creds.appId, index);
      }
      log(`search: ${store.code}: index ${indexNameFor(store)} (${creds.source} credentials)`);
    }
    const client = tenantClient({ organizationId, storeIds: [store.id], actorId: null });
    try {
      if (args.full) {
        const r = await fullReindex(client, store, index, {
          ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
          log,
        });
        log(
          `search: ${store.code}: full reindex ${r.indexed} records, ${r.removed} removed, cursor ${r.cursor}`,
        );
      } else {
        const r = await syncUntilCaughtUp(client, store, index, {
          ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
          log,
        });
        log(
          `search: ${store.code}: sync ${r.processed} events, ${r.upserted} upserted, ${r.deleted} deleted, cursor ${r.cursor}`,
        );
      }
    } catch (err) {
      failed++;
      log(`search: ${store.code}: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed;
}

export async function main(argv = process.argv.slice(2), log: Log = console.info): Promise<number> {
  const args = parseArgs(argv);
  await initDb();
  const organizationId = process.env.CORE_ORGANIZATION_ID ?? SEED_IDS.organization;
  const clients = new Map<string, IndexClient>();
  try {
    if (args.loopMs === null) return await runOnce(args, organizationId, clients, log);
    let stop = false;
    const onSignal = () => {
      stop = true;
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    while (!stop) {
      await runOnce(args, organizationId, clients, log);
      await new Promise((resolve) => setTimeout(resolve, args.loopMs!));
      // a loop only does a full pass once; subsequent passes are incremental
      args.full = false;
    }
    return 0;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main()
    .then((failed) => {
      process.exitCode = failed > 0 ? 1 : 0;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
