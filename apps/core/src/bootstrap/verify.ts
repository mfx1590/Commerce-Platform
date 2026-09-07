// Bootstrap verifier (issue #8, re-scoped by the owner on 2026-09-05): an idempotent, fail-fast check that the
// database this core is pointed at is ready to serve the contract — our migrations + seed present, every store
// resolvable through the tenant layer, Medusa's own schema migrated. It never writes anything. Medusa-side
// mirrors of our stores/keys are deferred to the Phase 2 cart task (see Memory-1-core Decisions).
import { SEED_IDS } from '@platform/db';
import { coreOrganizationId, resolveStoreContext } from '../http/tenant';
import { organizationClient } from '../lib/db';

export type Severity = 'error' | 'warn';

export interface Finding {
  severity: Severity;
  check: string;
  message: string;
  /** What to run to fix it. */
  fix?: string;
}

export interface VerifyResult {
  ok: boolean;
  organizationId: string;
  findings: Finding[];
  /** Stores that passed (id, code, default currency, key prefix). */
  stores: Array<{ id: string; code: string; default_currency: string; key_prefix: string }>;
}

const REQUIRED_TABLES = [
  'organization',
  'legal_entity',
  'store',
  'sales_channel',
  'store_api_key',
  'price_list',
  'product',
  'audit_log',
  'outbox',
];

interface StoreRow {
  id: string;
  code: string;
  status: string;
  default_currency: string;
  channels: string;
  keys: string;
  key_prefix: string | null;
  default_lists: string;
}

/**
 * Runs every check against the pool opened by `initDb()` as `platform_app` (RLS on) under CORE_ORGANIZATION_ID.
 * Seeded fixtures (SEED_IDS) are verified only when the organization IS the seeded one.
 */
export async function verifyBootstrap(): Promise<VerifyResult> {
  const organizationId = coreOrganizationId();
  const findings: Finding[] = [];
  const err = (check: string, message: string, fix?: string) =>
    findings.push(
      fix ? { severity: 'error', check, message, fix } : { severity: 'error', check, message },
    );
  const warn = (check: string, message: string, fix?: string) =>
    findings.push(
      fix ? { severity: 'warn', check, message, fix } : { severity: 'warn', check, message },
    );
  const hq = organizationClient({ organizationId });
  const passed: VerifyResult['stores'] = [];

  // 1. our schema (packages/db migrations)
  const tables = await hq.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [REQUIRED_TABLES],
  );
  const present = new Set(tables.rows.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length) {
    err(
      'schema',
      `missing tables in public: ${missing.join(', ')}`,
      'pnpm db:migrate (repo root) or pnpm dev',
    );
    return { ok: false, organizationId, findings, stores: [] };
  }

  // 2. organization
  const org = await hq.query<{ slug: string }>('SELECT slug FROM organization WHERE id = $1', [
    organizationId,
  ]);
  if (!org.rows[0]) {
    err(
      'organization',
      `organization ${organizationId} (CORE_ORGANIZATION_ID) not found — no seed, or the wrong organization id`,
      'pnpm db:seed (repo root) or set CORE_ORGANIZATION_ID',
    );
    return { ok: false, organizationId, findings, stores: [] };
  }

  // 3. every non-archived store: active sales channel, non-revoked publishable key, default price list for its currency
  const stores = await hq.query<StoreRow>(
    `SELECT s.id, s.code, s.status, s.default_currency,
            (SELECT count(*)::text FROM sales_channel c WHERE c.store_id = s.id AND c.is_active) AS channels,
            (SELECT count(*)::text FROM store_api_key k WHERE k.store_id = s.id AND k.type = 'publishable' AND k.revoked_at IS NULL) AS keys,
            (SELECT k.key_prefix FROM store_api_key k WHERE k.store_id = s.id AND k.type = 'publishable' AND k.revoked_at IS NULL ORDER BY k.created_at LIMIT 1) AS key_prefix,
            (SELECT count(*)::text FROM price_list pl WHERE pl.store_id = s.id AND pl.type = 'default' AND pl.status = 'active' AND pl.currency = s.default_currency) AS default_lists
     FROM store s WHERE s.status <> 'archived' ORDER BY s.code`,
  );
  if (stores.rows.length === 0) {
    err(
      'stores',
      `organization ${org.rows[0].slug} has no store`,
      'pnpm db:seed (dev) or create one via POST /admin/stores',
    );
  }
  for (const s of stores.rows) {
    let storeOk = true;
    if (Number(s.channels) === 0) {
      storeOk = false;
      err(
        'sales_channel',
        `store ${s.code} has no active sales channel`,
        `POST /admin/stores/${s.id}/sales-channels`,
      );
    }
    if (Number(s.keys) === 0) {
      storeOk = false;
      err(
        'store_api_key',
        `store ${s.code} has no non-revoked publishable key — storefronts cannot resolve it`,
        `POST /admin/stores/${s.id}/api-keys`,
      );
    }
    if (Number(s.default_lists) === 0) {
      storeOk = false;
      warn(
        'price_list',
        `store ${s.code} has no active default price list for ${s.default_currency} — Store API lists no products`,
      );
    }
    if (storeOk) {
      passed.push({
        id: s.id,
        code: s.code,
        default_currency: s.default_currency,
        key_prefix: s.key_prefix ?? '',
      });
    }
  }

  // 4. seeded keys resolve through the tenant layer (dev/CI: the seeded HQ only)
  if (organizationId === SEED_IDS.organization) {
    const expected: Array<[string, string, string]> = [
      [SEED_IDS.publishableKeys.brandA, SEED_IDS.stores.brandA, 'EUR'],
      [SEED_IDS.publishableKeys.brandB, SEED_IDS.stores.brandB, 'GBP'],
      [SEED_IDS.publishableKeys.brandC, SEED_IDS.stores.brandC, 'USD'],
    ];
    for (const [key, storeId, currency] of expected) {
      try {
        const ctx = await resolveStoreContext(key, 'bootstrap');
        if (ctx.storeId !== storeId) {
          err(
            'seed_keys',
            `seeded key ${key.slice(0, 8)}… resolves to store ${ctx.storeId}, expected ${storeId}`,
          );
        } else if (ctx.defaultCurrency !== currency) {
          err(
            'seed_keys',
            `seeded store ${ctx.storeCode} has default currency ${ctx.defaultCurrency}, expected ${currency}`,
          );
        }
      } catch (e) {
        err(
          'seed_keys',
          `seeded key ${key.slice(0, 8)}… does not resolve: ${(e as Error).message}`,
          'pnpm db:seed (repo root) — the seed is idempotent',
        );
      }
    }
  }

  // 5. Medusa's own schema
  const schema = process.env.MEDUSA_DB_SCHEMA ?? 'medusa';
  const medusa = await hq.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1`,
    [schema],
  );
  if (Number(medusa.rows[0]?.n ?? 0) === 0) {
    err(
      'medusa_schema',
      `Medusa schema "${schema}" is empty or missing — Medusa cannot boot`,
      'pnpm --filter @platform/core db:medusa:migrate',
    );
  } else {
    const links = await hq
      .query<{ n: string }>(`SELECT count(*)::text AS n FROM ${schema}.link_module_migrations`)
      .catch(() => ({ rows: [{ n: '0' }] }));
    if (Number(links.rows[0]?.n ?? 0) === 0) {
      err(
        'medusa_links',
        `Medusa link tables were not synced (${schema}.link_module_migrations is empty)`,
        'pnpm --filter @platform/core db:medusa:migrate',
      );
    }
  }

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    organizationId,
    findings,
    stores: passed,
  };
}

/** Human-readable report (one line per finding, then the stores that are ready). */
export function formatReport(r: VerifyResult): string {
  const lines: string[] = [];
  for (const f of r.findings) {
    lines.push(
      `${f.severity === 'error' ? 'ERROR' : 'warn '} [${f.check}] ${f.message}${f.fix ? `\n        fix: ${f.fix}` : ''}`,
    );
  }
  for (const s of r.stores) {
    lines.push(`ok    store ${s.code} (${s.default_currency}) key ${s.key_prefix}…`);
  }
  lines.push(r.ok ? `bootstrap: ready (organization ${r.organizationId})` : 'bootstrap: NOT ready');
  return lines.join('\n');
}
