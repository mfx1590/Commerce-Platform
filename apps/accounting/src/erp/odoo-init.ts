// `pnpm --filter @platform/accounting odoo:init` — makes the dev-stack Odoo (Community 17, compose profile `erp`,
// http://127.0.0.1:8069) ready for the live sync: the database (ODOO_DB, default accounting_dev) with the `account`
// module, one company per seeded legal entity in its currency, our 12 accounts and 7 journals per company, and the
// mapping (legal_entity.odoo_company_id, ledger_account.erp_account_id) through the same steps the sync uses. Every
// step searches before it creates: a second run changes nothing. Credentials: ODOO_URL, ODOO_DB, ODOO_USER,
// ODOO_API_KEY (the admin password locally), ODOO_MASTER_PASSWORD (Odoo's admin_passwd, `admin` by default locally) —
// env only, never in git, never in a log line. Slow on the first run (database creation + module install: minutes).
import {
  connectionStringFromEnv,
  createOrganizationClient,
  createPool,
  loadDotenv,
  type ScopedClient,
} from '@platform/db';
import { DEFAULT_CHART, type AccountType } from '../chart.js';
import { resolveConfig } from '../config.js';
import { ensureChart } from '../ledger.js';
import { consoleLogger, errorClassOf, type Logger } from '../log.js';
import { OdooJsonRpcClient, odooCredentialsFromEnv } from './odoo-jsonrpc.js';
import {
  DEFAULT_JOURNAL_CODES,
  isSyncableLegalEntity,
  mapChart,
  mapLegalEntityToCompany,
} from './sync.js';
import { ErpError } from './types.js';

/** Odoo 17 `account.account.account_type` for our account types. */
const ODOO_ACCOUNT_TYPE: Record<AccountType, string> = {
  asset: 'asset_current',
  liability: 'liability_current',
  equity: 'equity',
  revenue: 'income',
  expense: 'expense',
};

const JOURNAL_NAMES: Record<string, string> = {
  SAL: 'Sales',
  PSP: 'PSP fees',
  REF: 'Refunds',
  SHP: 'Shipping',
  BNK: 'Bank',
  COGS: 'Cost of goods sold',
  TAX: 'Tax',
};

/**
 * True when the Odoo URL points at this machine (localhost, 127.0.0.0/8, ::1, *.localhost). odoo:init creates
 * companies, accounts and journals and activates currencies: pointed at a real Odoo by the ODOO_URL the live sync also
 * uses, that would write into someone else's books, so any other host is refused unless --allow-remote is passed (#591).
 */
export function isLocalOdooUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

export interface OdooInitResult {
  database_created: boolean;
  module_installed: boolean;
  companies: {
    legal_entity_id: string;
    code: string;
    currency: string;
    company_id: number;
    created: boolean;
  }[];
  /** Legal entities left alone: a same-named company already exists in another currency (never rewritten). */
  companies_skipped: {
    legal_entity_id: string;
    code: string;
    company_id: number;
    reason: 'currency_mismatch';
    currency: string;
    company_currency: string;
  }[];
  accounts_created: number;
  journals_created: number;
  chart: { legal_entity_id: string; mapped: number; already: number; missing: string[] }[];
}

export interface OdooInitDeps {
  client: ScopedClient;
  odoo: OdooJsonRpcClient;
  masterPassword: string;
  /** Target a non-loopback Odoo on purpose (`--allow-remote`); default: refused before any call. */
  allowRemote?: boolean;
  log?: Logger;
}

export async function odooInit(deps: OdooInitDeps): Promise<OdooInitResult> {
  const { odoo, client } = deps;
  const log = deps.log ?? consoleLogger;
  const result: OdooInitResult = {
    database_created: false,
    module_installed: false,
    companies: [],
    companies_skipped: [],
    accounts_created: 0,
    journals_created: 0,
    chart: [],
  };

  // 0. local only, before any call
  const { url, db: dbName } = (odoo as unknown as { creds: { url: string; db: string } }).creds;
  if (!deps.allowRemote && !isLocalOdooUrl(url))
    throw new ErpError(
      'OdooInitRemoteRefused',
      'odoo:init prepares the local dev-stack Odoo only: ODOO_URL is not a loopback host (pass --allow-remote to target it on purpose)',
    );

  // 1. the database
  const databases = await odoo.listDatabases();
  if (!databases.includes(dbName)) {
    log.info({ event: 'odoo_init', step: 'create_database' });
    await odoo.createDatabase(deps.masterPassword);
    result.database_created = true;
  }

  // 2. the account module
  const mod = (await odoo.executeKw(
    'ir.module.module',
    'search_read',
    [[['name', '=', 'account']]],
    {
      fields: ['id', 'state'],
    },
  )) as { id: number; state: string }[];
  if (!mod[0])
    throw new ErpError('OdooModuleMissing', 'the account module is not available on this Odoo');
  if (mod[0].state !== 'installed') {
    log.info({ event: 'odoo_init', step: 'install_account_module' });
    await odoo.executeKw(
      'ir.module.module',
      'button_immediate_install',
      [[mod[0].id]],
      {},
      { retry: false },
    );
    result.module_installed = true;
  }

  // 3. one company per seeded legal entity, in its currency
  const entities = await client.query<{ id: string; code: string; name: string; currency: string }>(
    'SELECT id, code, name, currency FROM legal_entity ORDER BY code',
  );
  const skipped = entities.rows
    .filter((le) => !isSyncableLegalEntity(le.code))
    .map((le) => le.code);
  entities.rows = entities.rows.filter((le) => isSyncableLegalEntity(le.code));
  if (skipped.length)
    log.info({ event: 'odoo_init', step: 'skip_e2e_legal_entities', count: skipped.length });
  const companies = await odoo.listCompanies();
  for (const le of entities.rows) {
    let company = companies.find((c) => c.name === le.name);
    // an existing company is never rewritten (it may not be ours): a currency mismatch skips the legal entity
    if (company && company.currency !== le.currency) {
      result.companies_skipped.push({
        legal_entity_id: le.id,
        code: le.code,
        company_id: company.id,
        reason: 'currency_mismatch',
        currency: le.currency,
        company_currency: company.currency,
      });
      log.warn({
        event: 'odoo_init',
        step: 'company_currency_mismatch',
        legal_entity_id: le.id,
        company_id: company.id,
        currency: le.currency,
        company_currency: company.currency,
      });
      continue;
    }
    const currencies = (await odoo.executeKw(
      'res.currency',
      'search_read',
      [
        [
          ['name', '=', le.currency],
          ['active', 'in', [true, false]],
        ],
      ],
      { fields: ['id', 'active'] },
    )) as { id: number; active: boolean }[];
    const currency = currencies[0];
    if (!currency)
      throw new ErpError('OdooCurrencyMissing', `currency ${le.currency} unknown to Odoo`);
    if (!currency.active)
      await odoo.executeKw(
        'res.currency',
        'write',
        [[currency.id], { active: true }],
        {},
        { retry: false },
      );
    let created = false;
    if (!company) {
      const id = (await odoo.executeKw(
        'res.company',
        'create',
        [{ name: le.name, currency_id: currency.id }],
        {},
        { retry: false },
      )) as number;
      company = { id, name: le.name, currency: le.currency };
      companies.push(company);
      created = true;
    }
    result.companies.push({
      legal_entity_id: le.id,
      code: le.code,
      currency: le.currency,
      company_id: company.id,
      created,
    });

    // 4. our accounts and journals in that company
    const existingAccounts = await odoo.listAccounts(company.id);
    for (const a of DEFAULT_CHART) {
      if (existingAccounts.some((x) => x.code === a.code)) continue;
      await odoo.executeKw(
        'account.account',
        'create',
        [
          {
            code: a.code,
            name: a.name,
            account_type: ODOO_ACCOUNT_TYPE[a.type],
            company_id: company.id,
            reconcile: false,
          },
        ],
        {},
        { retry: false },
      );
      result.accounts_created += 1;
    }
    const existingJournals = await odoo.listJournals(company.id);
    for (const code of Object.values(DEFAULT_JOURNAL_CODES)) {
      if (existingJournals.some((j) => j.code === code)) continue;
      await odoo.executeKw(
        'account.journal',
        'create',
        [{ name: JOURNAL_NAMES[code] ?? code, code, type: 'general', company_id: company.id }],
        {},
        { retry: false },
      );
      result.journals_created += 1;
    }

    // 5. the mapping, through the sync's own steps
    await mapLegalEntityToCompany(client, le.id, company.id);
    await client.transaction((tx) => ensureChart(tx, client.context.organizationId, le.id));
    const chart = await mapChart({ client, erp: odoo, log }, le.id);
    result.chart.push({ legal_entity_id: le.id, ...chart });
  }

  log.info({
    event: 'odoo_init_done',
    database_created: result.database_created,
    module_installed: result.module_installed,
    companies: result.companies.length,
    accounts_created: result.accounts_created,
    journals_created: result.journals_created,
    chart_missing: result.chart.reduce((a, c) => a + c.missing.length, 0),
  });
  return result;
}

async function main(): Promise<void> {
  loadDotenv();
  const env = process.env;
  const config = resolveConfig(env, process.argv.slice(2));
  const creds = odooCredentialsFromEnv({
    ...env,
    ODOO_URL: env.ODOO_URL ?? 'http://127.0.0.1:8069',
    ODOO_DB: env.ODOO_DB ?? 'accounting_dev',
    ODOO_USER: env.ODOO_USER ?? 'admin',
  });
  const masterPassword = env.ODOO_MASTER_PASSWORD ?? 'admin';
  const odoo = new OdooJsonRpcClient(creds, { timeoutMs: 600_000 });
  const pool = createPool(connectionStringFromEnv('app'), 2);
  try {
    const client = createOrganizationClient(pool, {
      organizationId: config.organizationId,
      actorId: null,
    });
    await odooInit({
      client,
      odoo,
      masterPassword,
      allowRemote: process.argv.includes('--allow-remote'),
      log: consoleLogger,
    });
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /odoo-init\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        service: 'accounting',
        event: 'odoo_init_failed',
        error_class: errorClassOf(err),
      }),
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
