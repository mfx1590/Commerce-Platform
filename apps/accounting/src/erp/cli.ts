// `pnpm --filter @platform/accounting erp:sync -- --legal-entity <uuid> [--company <id>] [--mock]`
// Maps the legal entity to its Odoo company when --company is given, maps the chart, posts every unposted entry.
// Credentials from ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY; `--mock` runs against the in-memory Odoo (development
// only; nothing leaves the process). Exit 0 when everything posted, 2 when a move was refused or skipped.
import {
  connectionStringFromEnv,
  createOrganizationClient,
  createPool,
  loadDotenv,
} from '@platform/db';
import { resolveConfig } from '../config.js';
import { consoleLogger, errorClassOf } from '../log.js';
import { createMockOdoo, MOCK_ODOO_CREDENTIALS } from './mock.js';
import { OdooJsonRpcClient, odooCredentialsFromEnv } from './odoo-jsonrpc.js';
import { mapLegalEntityToCompany, syncLegalEntity } from './sync.js';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadDotenv();
  const argv = process.argv.slice(2);
  const config = resolveConfig(process.env, argv);
  const legalEntityId = arg(argv, '--legal-entity');
  const company = arg(argv, '--company');
  const mock = argv.includes('--mock');
  if (!legalEntityId) {
    console.error('usage: erp:sync --legal-entity <uuid> [--company <id>] [--mock]');
    process.exit(1);
  }
  const erp = mock
    ? new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, { fetch: createMockOdoo().fetch })
    : new OdooJsonRpcClient(odooCredentialsFromEnv());
  const pool = createPool(connectionStringFromEnv('app'), 2);
  try {
    const client = createOrganizationClient(pool, {
      organizationId: config.organizationId,
      actorId: null,
    });
    if (company) await mapLegalEntityToCompany(client, legalEntityId, Number(company));
    const result = await syncLegalEntity({ client, erp, log: consoleLogger }, legalEntityId);
    process.exitCode = result.refused.length + result.skipped.length > 0 ? 2 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      service: 'accounting',
      event: 'erp_sync_failed',
      error_class: errorClassOf(err),
    }),
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
