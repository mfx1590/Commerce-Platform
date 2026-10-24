// `pnpm --filter @platform/accounting reconcile -- --fixtures <dir> --legal-entity <uuid> [--payout <po_…>]`
// Imports and reconciles payout reports from a fixture directory against the ledger (the Stripe source arrives with
// the launch checklist). Exit 0 when every payout reconciled, 2 when any is discrepant (the differences are on
// stderr as JSON lines).
import {
  connectionStringFromEnv,
  createOrganizationClient,
  createPool,
  loadDotenv,
} from '@platform/db';
import { resolveConfig } from '../config.js';
import { consoleLogger, errorClassOf } from '../log.js';
import { reconcileAll, reconcilePayout } from './reconcile.js';
import { createFixtureSource, loadFixtureDir } from './source-fixture.js';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadDotenv();
  const argv = process.argv.slice(2);
  const config = resolveConfig(process.env, argv);
  const dir = arg(argv, '--fixtures');
  const legalEntityId = arg(argv, '--legal-entity');
  const payoutId = arg(argv, '--payout');
  if (!dir || !legalEntityId) {
    console.error('usage: reconcile --fixtures <dir> --legal-entity <uuid> [--payout <id>]');
    process.exit(1);
  }
  const pool = createPool(connectionStringFromEnv('app'), 2);
  try {
    const client = createOrganizationClient(pool, {
      organizationId: config.organizationId,
      actorId: null,
    });
    const deps = {
      client,
      source: createFixtureSource(await loadFixtureDir(dir)),
      log: consoleLogger,
    };
    const results = payoutId
      ? [await reconcilePayout(deps, legalEntityId, payoutId)]
      : await reconcileAll(deps, legalEntityId);
    const discrepant = results.filter((r) => r.status === 'discrepant').length;
    console.info(
      JSON.stringify({
        service: 'accounting',
        event: 'reconcile_done',
        legal_entity_id: legalEntityId,
        payouts: results.length,
        reconciled: results.length - discrepant,
        discrepant,
        posted: results.filter((r) => r.posted).length,
      }),
    );
    process.exitCode = discrepant > 0 ? 2 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      service: 'accounting',
      event: 'reconcile_failed',
      error_class: errorClassOf(err),
    }),
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
