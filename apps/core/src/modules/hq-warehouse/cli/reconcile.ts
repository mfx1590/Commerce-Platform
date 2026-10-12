// Cycle-count reconciliation preview (#436). Lives under the module, NOT src/jobs/ (Medusa's job loader requires
// every file there to export a job config).
//
//   pnpm --filter @platform/core exec tsx src/modules/hq-warehouse/cli/reconcile.ts --warehouse wh-eu --dry-run
//
// Prints, for every open count of the warehouse, what a reconciliation would do — and WRITES NOTHING. It is a
// preview: the real reconciliation (Admin API `reconcileCycleCount`, permission `operations` on organization:hq)
// recomputes under the shelf's lock. Applying from a terminal is deliberately not offered: an approval names a
// person, and a CLI has none.
import { SEED_IDS, type ScopedClient } from '@platform/db';
import { closePool, initDb, organizationClient } from '../../../lib/db';
import { planOpenCounts, type PlannedReconciliation } from '../cycle-counts';

export interface ReconcileArgs {
  warehouse: string | null;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): ReconcileArgs {
  const args: ReconcileArgs = { warehouse: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--warehouse') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--warehouse needs a warehouse code');
      args.warehouse = value;
    } else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

export const USAGE = 'usage: reconcile.ts --warehouse <code> --dry-run';

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

function describe(c: PlannedReconciliation): string {
  const verdict = c.superseded
    ? 'SUPERSEDED (a later count is applied; reconcile would answer 409)'
    : c.action === 'flag'
      ? 'FLAG for approval (above the tolerance)'
      : c.delta === 0
        ? 'APPLY, no movement (the count matches)'
        : `APPLY one movement of ${signed(c.delta)}`;
  return `${c.sku}  counted ${c.countedQuantity} at ${c.countedAt}  on-hand as of the count ${c.onHandAsOfCount}  delta ${signed(c.delta)}  → ${verdict}`;
}

/** Runs the preview against `client` and returns the exit code. `out` receives one line per call. */
export async function runReconcile(
  argv: readonly string[],
  deps: { client: ScopedClient; organizationId: string; out: (line: string) => void },
): Promise<number> {
  let args: ReconcileArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    deps.out(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    deps.out(USAGE);
    return 0;
  }
  if (args.warehouse === null) {
    deps.out(`--warehouse is required\n${USAGE}`);
    return 2;
  }
  if (!args.dryRun) {
    deps.out(
      'only --dry-run is offered here: reconcile through the Admin API (reconcileCycleCount), where an approval names a person',
    );
    return 2;
  }
  const plan = await planOpenCounts(deps.client, {
    organizationId: deps.organizationId,
    warehouseCode: args.warehouse,
  });
  deps.out(
    `dry run: ${plan.counts.length} open count(s) in ${args.warehouse}, tolerance ${plan.tolerance} unit(s); nothing is written`,
  );
  for (const c of plan.counts) deps.out(describe(c));
  return 0;
}

async function main(): Promise<void> {
  await initDb();
  const organizationId = process.env.CORE_ORGANIZATION_ID ?? SEED_IDS.organization;
  try {
    process.exitCode = await runReconcile(process.argv.slice(2), {
      client: organizationClient({ organizationId }),
      organizationId,
      out: (line) => void process.stdout.write(`${line}\n`),
    });
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
