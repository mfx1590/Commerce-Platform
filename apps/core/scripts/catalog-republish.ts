// `pnpm --filter @platform/core catalog:republish [--store <code>]… [--force] [--dry-run] [--batch <n>]` (#634):
// announces every PUBLISHED product that never went through the bus as `product.published` (its current state)
// through the outbox; the relay delivers it. Idempotent: a second run writes nothing. A deliberate command — never
// run automatically. On a shared database it is a shared-data write: the manager runs it, with a backup first.
import path from 'node:path';
import { SEED_IDS } from '@platform/db';
import { closePool, initDb, organizationClient } from '../src/lib/db';
import { republishCatalogue } from '../src/modules/catalog';

function args(argv: string[]) {
  const stores: string[] = [];
  let force = false;
  let dryRun = false;
  let batch: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') stores.push(String(argv[++i] ?? ''));
    else if (a === '--force') force = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--batch') batch = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (batch !== undefined && (!Number.isInteger(batch) || batch < 1)) {
    throw new Error('--batch must be a positive integer');
  }
  return { stores, force, dryRun, batch };
}

async function main(): Promise<void> {
  const opts = args(process.argv.slice(2));
  await initDb({ startDir: path.resolve(__dirname, '..') });
  const organizationId = process.env.CORE_ORGANIZATION_ID ?? SEED_IDS.organization;
  const client = organizationClient({ organizationId });
  let storeIds: string[] | undefined;
  if (opts.stores.length) {
    const r = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM store WHERE code = ANY($1)`,
      [opts.stores],
    );
    const unknown = opts.stores.filter((c) => !r.rows.some((s) => s.code === c));
    if (unknown.length) throw new Error(`unknown store code(s): ${unknown.join(', ')}`);
    storeIds = r.rows.map((s) => s.id);
  }
  const result = await republishCatalogue(client, {
    storeIds,
    force: opts.force,
    dryRun: opts.dryRun,
    batch: opts.batch,
  });
  for (const s of result.stores) {
    console.info(
      `catalog:republish ${result.dry_run ? '(dry run) ' : ''}store ${s.store_id}: ${s.published} announced, ${s.skipped} already on the bus`,
    );
  }
  await closePool();
}

main().catch(async (err) => {
  console.error('catalog:republish failed:', err instanceof Error ? err.message : err);
  await closePool().catch(() => {});
  process.exit(1);
});
