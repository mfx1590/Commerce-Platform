// The reporting views (packages/db migration 0200, db 0.3.8, #478 / CONTRACT CHANGE #485) on a seeded throwaway
// database. Every view is security_invoker: it must return exactly what a direct aggregate over its source tables
// returns for the same session (brand A store scope, and HQ), nothing for no context or another organization, and
// never one sum across two currencies. The direct aggregates are computed here in TypeScript from the source rows,
// not with the views' SQL.
import { createOrganizationClient, createTenantClient, seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORTING_VIEWS } from './index';

const VIEWS = REPORTING_VIEWS;

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

type Client = ReturnType<typeof createOrganizationClient>;
type Row = Record<string, unknown>;

let db: TestDatabase;
let a: Client;
let b: Client;
let hq: Client;
let other: Client;

async function rows(client: { query: Client['query'] }, sql: string, params: unknown[] = []) {
  return (await client.query<Row>(sql, params)).rows;
}

/** Sorts rows by every value so two result sets compare regardless of order. */
function sorted(list: Row[]): Row[] {
  const key = (r: Row) =>
    JSON.stringify(
      Object.keys(r)
        .sort()
        .map((k) => r[k]),
    );
  return [...list].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

/** Groups rows by the named columns and folds each group into one output row. */
function groupBy<T extends Row>(list: T[], keys: string[], fold: (group: T[]) => Row): Row[] {
  const groups = new Map<string, T[]>();
  for (const r of list) {
    const k = JSON.stringify(keys.map((c) => r[c]));
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((g) => ({
    ...Object.fromEntries(keys.map((c) => [c, g[0]![c]])),
    ...fold(g),
  }));
}

const sum = (g: Row[], col: string) =>
  String(g.reduce((s, r) => s + BigInt(String(r[col] ?? 0)), 0n));
const countWhere = (g: Row[], pred: (r: Row) => boolean) => String(g.filter(pred).length);

// ---- direct aggregates over the source tables ----

async function directSales(client: Client): Promise<Row[]> {
  const orders = await rows(
    client,
    `SELECT id, organization_id, store_id, (placed_at AT TIME ZONE 'UTC')::date::text AS day, currency,
            status, payment_status, subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor
       FROM "order"`,
  );
  const refunds = await rows(
    client,
    `SELECT order_id, amount_minor FROM refund WHERE status = 'succeeded'`,
  );
  const refunded = new Map<string, bigint>();
  for (const r of refunds) {
    const id = String(r.order_id);
    refunded.set(id, (refunded.get(id) ?? 0n) + BigInt(String(r.amount_minor)));
  }
  const sales = orders
    .filter(
      (o) => o.status !== 'cancelled' && !['voided', 'failed'].includes(String(o.payment_status)),
    )
    .map((o) => ({ ...o, refunded_minor: String(refunded.get(String(o.id)) ?? 0n) }));
  return groupBy(sales, ['organization_id', 'store_id', 'day', 'currency'], (g) => {
    const total = BigInt(sum(g, 'total_minor'));
    const back = BigInt(sum(g, 'refunded_minor'));
    return {
      orders: String(g.length),
      gross_minor: sum(g, 'subtotal_minor'),
      discount_minor: sum(g, 'discount_minor'),
      shipping_minor: sum(g, 'shipping_minor'),
      tax_minor: sum(g, 'tax_minor'),
      total_minor: String(total),
      refunded_minor: String(back),
      net_minor: String(total - back),
    };
  });
}

async function directPayments(client: Client): Promise<Row[]> {
  const list = await rows(
    client,
    `SELECT organization_id, store_id, (captured_at AT TIME ZONE 'UTC')::date::text AS day, currency, provider,
            amount_minor, fee_minor
       FROM payment WHERE status = 'captured' AND captured_at IS NOT NULL`,
  );
  return groupBy(list, ['organization_id', 'store_id', 'day', 'currency', 'provider'], (g) => ({
    captured_count: String(g.length),
    captured_minor: sum(g, 'amount_minor'),
    fee_minor: sum(g, 'fee_minor'),
    fee_unknown: countWhere(g, (r) => r.fee_minor === null),
  }));
}

async function directRefunds(client: Client): Promise<Row[]> {
  const list = await rows(
    client,
    `SELECT organization_id, store_id, (created_at AT TIME ZONE 'UTC')::date::text AS day, currency, reason,
            amount_minor
       FROM refund WHERE status = 'succeeded'`,
  );
  return groupBy(list, ['organization_id', 'store_id', 'day', 'currency', 'reason'], (g) => ({
    refunds: String(g.length),
    refunded_minor: sum(g, 'amount_minor'),
  }));
}

async function directStock(client: Client): Promise<Row[]> {
  const levels = await rows(
    client,
    `SELECT organization_id, stock_item_id, warehouse_id, on_hand, reserved, incoming, available FROM inventory_level`,
  );
  const items = new Map(
    (await rows(client, `SELECT id, sku FROM stock_item`)).map((r) => [String(r.id), r.sku]),
  );
  const warehouses = new Map(
    (await rows(client, `SELECT id, code FROM warehouse`)).map((r) => [String(r.id), r.code]),
  );
  return levels.map((l) => ({
    organization_id: l.organization_id,
    stock_item_id: l.stock_item_id,
    sku: items.get(String(l.stock_item_id)),
    warehouse_id: l.warehouse_id,
    warehouse_code: warehouses.get(String(l.warehouse_id)),
    on_hand: l.on_hand,
    reserved: l.reserved,
    incoming: l.incoming,
    available: l.available,
  }));
}

async function directCustomers(client: Client): Promise<Row[]> {
  const list = await rows(
    client,
    `SELECT organization_id, store_id, (created_at AT TIME ZONE 'UTC')::date::text AS day, status FROM customer`,
  );
  return groupBy(list, ['organization_id', 'store_id', 'day'], (g) => ({
    new_customers: String(g.length),
    registered: countWhere(g, (r) => r.status === 'registered'),
    guests: countWhere(g, (r) => r.status === 'guest'),
  }));
}

const direct: Record<(typeof VIEWS)[number], (c: Client) => Promise<Row[]>> = {
  rpt_sales_daily: directSales,
  rpt_payments_daily: directPayments,
  rpt_refunds_daily: directRefunds,
  rpt_stock_position: directStock,
  rpt_customers_daily: directCustomers,
};

/** A view read the way the Admin API will read it: every column, `day` as text, no WHERE. */
async function view(client: { query: Client['query'] }, name: string): Promise<Row[]> {
  const list = await rows(client, `SELECT * FROM ${name}`);
  return list.map((r) => ('day' in r ? { ...r, day: dayText(r.day) } : r));
}

function dayText(d: unknown): string {
  if (d instanceof Date) {
    // node-postgres parses `date` as local midnight
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return String(d);
}

// ---- fixtures: two stores, EUR + GBP in brand A, cancelled / voided / failed / awaiting orders, refunds ----

async function fixtures(): Promise<void> {
  const channel = async (store: string) =>
    (
      await rows(
        hq,
        `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
        [store],
      )
    )[0]!.id as string;
  const channels = { [A]: await channel(A), [B]: await channel(B) };
  const address = JSON.stringify({
    line1: 'Fixture street 1',
    city: 'Testville',
    postal_code: '00000',
    country: 'DE',
  });

  let n = 0;
  const order = async (
    store: string,
    currency: string,
    placedAt: string,
    total: number,
    status = 'confirmed',
    paymentStatus = 'captured',
  ): Promise<string> => {
    n += 1;
    const sub = total - 100;
    const res = await rows(
      hq,
      `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, email, currency, locale, status,
                            payment_status, shipping_address, billing_address, subtotal_minor, discount_minor,
                            shipping_minor, tax_minor, total_minor, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'en', $7, $8, $9, $9, $10, 50, 100, 50, $11, $12) RETURNING id`,
      [
        ORG,
        store,
        900_000 + n,
        channels[store],
        `rpt-${n}@example.test`,
        currency,
        status,
        paymentStatus,
        address,
        sub,
        total,
        placedAt,
      ],
    );
    return res[0]!.id as string;
  };
  const payment = async (
    store: string,
    orderId: string,
    currency: string,
    amount: number,
    capturedAt: string,
    fee: number | null,
    status = 'captured',
  ): Promise<string> => {
    n += 1;
    const res = await rows(
      hq,
      `INSERT INTO payment (organization_id, store_id, order_id, provider, amount_minor, currency, status, fee_minor,
                            captured_at, idempotency_key)
       VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        ORG,
        store,
        orderId,
        amount,
        currency,
        status,
        fee,
        status === 'captured' ? capturedAt : null,
        `rpt-pay-${n}`,
      ],
    );
    return res[0]!.id as string;
  };
  const refund = async (
    store: string,
    orderId: string,
    paymentId: string,
    currency: string,
    amount: number,
    createdAt: string,
    status = 'succeeded',
    reason = 'goodwill',
  ): Promise<void> => {
    n += 1;
    await rows(
      hq,
      `INSERT INTO refund (organization_id, store_id, order_id, payment_id, amount_minor, currency, reason, status,
                           idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [ORG, store, orderId, paymentId, amount, currency, reason, status, `rpt-ref-${n}`, createdAt],
    );
  };

  // Brand A, EUR: two orders either side of a UTC midnight, one refunded twice (succeeded + failed) days later.
  const a1 = await order(A, 'EUR', '2026-03-01T23:30:00Z', 10_000);
  const a1p = await payment(A, a1, 'EUR', 10_000, '2026-03-01T23:31:00Z', 290);
  await refund(A, a1, a1p, 'EUR', 2_500, '2026-03-05T10:00:00Z');
  await refund(A, a1, a1p, 'EUR', 1_000, '2026-03-05T11:00:00Z', 'failed');
  const a2 = await order(A, 'EUR', '2026-03-02T00:30:00Z', 4_000);
  await payment(A, a2, 'EUR', 4_000, '2026-03-02T00:31:00Z', null);
  // Brand A, GBP, the same day as a1: must stay its own row.
  const a3 = await order(A, 'GBP', '2026-03-01T12:00:00Z', 7_000);
  const a3p = await payment(A, a3, 'GBP', 7_000, '2026-03-01T12:01:00Z', 210);
  await refund(A, a3, a3p, 'GBP', 7_000, '2026-03-03T09:00:00Z', 'succeeded', 'return');
  // Excluded from sales: cancelled, voided, failed. Kept: awaiting.
  const a4 = await order(A, 'EUR', '2026-03-01T15:00:00Z', 9_900, 'cancelled', 'refunded');
  const a4p = await payment(A, a4, 'EUR', 9_900, '2026-03-01T15:01:00Z', 280);
  await refund(A, a4, a4p, 'EUR', 9_900, '2026-03-01T16:00:00Z', 'succeeded', 'cancellation');
  await order(A, 'EUR', '2026-03-01T16:00:00Z', 5_100, 'cancelled', 'voided');
  const a6 = await order(A, 'EUR', '2026-03-01T17:00:00Z', 3_300, 'pending', 'failed');
  await payment(A, a6, 'EUR', 3_300, '2026-03-01T17:01:00Z', null, 'failed');
  await order(A, 'EUR', '2026-03-01T18:00:00Z', 2_200, 'pending', 'awaiting');
  // Brand B, GBP.
  const b1 = await order(B, 'GBP', '2026-03-01T10:00:00Z', 6_000);
  const b1p = await payment(B, b1, 'GBP', 6_000, '2026-03-01T10:01:00Z', 180);
  await refund(B, b1, b1p, 'GBP', 600, '2026-03-02T10:00:00Z');

  // Customers (counts only ever leave the database).
  for (const [store, status, at] of [
    [A, 'registered', '2026-03-01T08:00:00Z'],
    [A, 'guest', '2026-03-01T09:00:00Z'],
    [A, 'erased', '2026-03-01T10:00:00Z'],
    [B, 'guest', '2026-03-01T11:00:00Z'],
  ] as const) {
    n += 1;
    await rows(
      hq,
      `INSERT INTO customer (organization_id, store_id, email, status, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [ORG, store, `rpt-c${n}@example.test`, status, at],
    );
  }
}

beforeAll(async () => {
  db = await createTestDatabase('reporting');
  try {
    await seed(db.owner);
    // Fail loudly if migration 0200 is not among the migrations createTestDatabase ran.
    const found = await db.owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relkind = 'v' AND relname = ANY($1)`,
      [[...VIEWS]],
    );
    if (found.rowCount !== VIEWS.length) {
      throw new Error(
        `reporting-views.test: migration 0200 views missing — found ${found.rows.map((r) => r.relname).join(', ') || 'none'}`,
      );
    }
  } catch (err) {
    await db.drop();
    throw err;
  }
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  const second = await db.owner.query<{ id: string }>(
    `INSERT INTO organization (slug, name) VALUES ('other-organization', 'Other') RETURNING id`,
  );
  other = createOrganizationClient(db.app, { organizationId: second.rows[0]!.id });
  await fixtures();
}, 240_000);

afterAll(async () => {
  await db?.drop();
});

describe('0200: each view equals a direct aggregate over its source tables', () => {
  for (const name of VIEWS) {
    it(`${name} as brand A (store scope)`, async () => {
      const got = await view(a, name);
      expect(got.length).toBeGreaterThan(0);
      expect(sorted(got)).toEqual(sorted(await direct[name](a)));
    });
    it(`${name} as HQ (organization scope)`, async () => {
      expect(sorted(await view(hq, name))).toEqual(sorted(await direct[name](hq)));
    });
  }
});

describe('0200: row-level security through security_invoker', () => {
  const storeViews = VIEWS.filter((v) => v !== 'rpt_stock_position');

  it('a store client reading a view with no WHERE gets only its own store', async () => {
    for (const name of storeViews) {
      const got = await view(a, name);
      expect(got.length, name).toBeGreaterThan(0);
      expect(new Set(got.map((r) => r.store_id)), name).toEqual(new Set([A]));
      expect(new Set((await view(b, name)).map((r) => r.store_id)), name).toEqual(new Set([B]));
    }
  });

  it('organization scope sees every store', async () => {
    for (const name of storeViews) {
      const stores = new Set((await view(hq, name)).map((r) => r.store_id));
      expect(stores.has(A) && stores.has(B), name).toBe(true);
    }
  });

  it('no session context and another organization see zero rows', async () => {
    for (const name of VIEWS) {
      expect((await db.app.query(`SELECT * FROM ${name}`)).rowCount, name).toBe(0);
      expect(await view(other, name), name).toEqual([]);
    }
  });

  it('the stock view follows the pool: brand A sees only items its variants map, HQ sees every pool row', async () => {
    const mapped = await rows(
      a,
      `SELECT DISTINCT stock_item_id FROM product_variant WHERE stock_item_id IS NOT NULL`,
    );
    const own = new Set(mapped.map((r) => r.stock_item_id));
    const got = await view(a, 'rpt_stock_position');
    expect(got.every((r) => own.has(r.stock_item_id))).toBe(true);
    expect(got.some((r) => r.stock_item_id === SEED_IDS.sharedStock.stockItem)).toBe(true);
    const hqRows = await view(hq, 'rpt_stock_position');
    const [all] = await rows(hq, `SELECT count(*)::int AS n FROM inventory_level`);
    expect(hqRows.length).toBe(all!.n);
    expect(hqRows.length).toBeGreaterThan(got.length);
  });

  it('every view is security_invoker, depends on no SECURITY DEFINER function, and only platform_app may SELECT', async () => {
    for (const name of VIEWS) {
      const rel = await db.owner.query<{ reloptions: string[] | null; def: string }>(
        `SELECT c.reloptions, pg_get_viewdef(c.oid) AS def FROM pg_class c WHERE c.relname = $1 AND c.relkind = 'v'`,
        [name],
      );
      expect(rel.rows[0]?.reloptions, name).toContain('security_invoker=true');
      const definers = await db.owner.query<{ proname: string }>(
        `SELECT DISTINCT p.proname FROM pg_depend d
           JOIN pg_rewrite rw ON rw.oid = d.objid
           JOIN pg_class c ON c.oid = rw.ev_class
           JOIN pg_proc p ON p.oid = d.refobjid
          WHERE c.relname = $1 AND d.refclassid = 'pg_proc'::regclass AND p.prosecdef`,
        [name],
      );
      expect(definers.rows, name).toEqual([]);
      const grants = await db.owner.query<{ grantee: string; privilege_type: string }>(
        `SELECT grantee, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = $1 AND grantee <> (
            SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = $1)`,
        [name],
      );
      expect(grants.rows, name).toEqual([{ grantee: 'platform_app', privilege_type: 'SELECT' }]);
    }
  });
});

describe('0200: money and currency', () => {
  it('EUR and GBP orders of one store on one day are two rows, never one sum', async () => {
    const got = (await view(a, 'rpt_sales_daily')).filter((r) => r.day === '2026-03-01');
    expect(got.map((r) => r.currency).sort()).toEqual(['EUR', 'GBP']);
  });

  it('every money column is bigint beside a currency column', async () => {
    const cols = await db.owner.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [[...VIEWS]],
    );
    const money = cols.rows.filter((c) => c.column_name.endsWith('_minor'));
    expect(money.length).toBeGreaterThan(0);
    for (const c of money) {
      expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('bigint');
      expect(
        cols.rows.some((x) => x.table_name === c.table_name && x.column_name === 'currency'),
        `${c.table_name} has currency`,
      ).toBe(true);
    }
  });

  it('sum(net_minor) reconciles to order totals minus succeeded refunds, per row and overall', async () => {
    for (const client of [a, hq]) {
      const got = await view(client, 'rpt_sales_daily');
      for (const r of got) {
        expect(BigInt(String(r.net_minor))).toBe(
          BigInt(String(r.total_minor)) - BigInt(String(r.refunded_minor)),
        );
      }
      const byCurrency = await rows(
        client,
        `SELECT o.currency,
                (sum(o.total_minor) - coalesce(sum((SELECT sum(r.amount_minor) FROM refund r
                                                     WHERE r.order_id = o.id AND r.status = 'succeeded')), 0))::text AS net
           FROM "order" o
          WHERE o.status <> 'cancelled' AND o.payment_status NOT IN ('voided', 'failed')
          GROUP BY o.currency`,
      );
      const fromView = groupBy(got, ['currency'], (g) => ({ net: sum(g, 'net_minor') }));
      expect(sorted(fromView)).toEqual(sorted(byCurrency));
    }
  });

  it('the worked example: brand A EUR on 2026-03-01 is one order, net of its later refund', async () => {
    const eur = (await view(a, 'rpt_sales_daily')).filter(
      (r) => r.day === '2026-03-01' && r.currency === 'EUR',
    );
    expect(eur).toHaveLength(1);
    const row = eur[0];
    // a1 (10 000, refunded 2 500 on 03-05) + the awaiting order (2 200); cancelled, voided and failed are out.
    expect(row).toMatchObject({
      orders: '2',
      total_minor: '12200',
      refunded_minor: '2500',
      net_minor: '9700',
    });
    const cash = (await view(a, 'rpt_refunds_daily')).filter((r) => r.day === '2026-03-05');
    expect(cash).toEqual([
      expect.objectContaining({ currency: 'EUR', refunds: '1', refunded_minor: '2500' }),
    ]);
  });

  it('the stock view reconciles to inventory_level', async () => {
    const got = await view(hq, 'rpt_stock_position');
    const levels = await rows(
      hq,
      `SELECT sum(on_hand)::text AS on_hand, sum(reserved)::text AS reserved FROM inventory_level`,
    );
    expect(String(got.reduce((s, r) => s + Number(r.on_hand), 0))).toBe(levels[0]!.on_hand ?? '0');
    expect(String(got.reduce((s, r) => s + Number(r.reserved), 0))).toBe(
      levels[0]!.reserved ?? '0',
    );
  });
});

describe('0200: no PII', () => {
  it('no view exposes an email, name, phone, address, provider reference or idempotency key', async () => {
    const cols = await db.owner.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [[...VIEWS]],
    );
    expect(cols.rows.length).toBeGreaterThan(0);
    const deny =
      /email|name|phone|address|provider_.*id|idempotency|keycloak|subject|metadata|consent|note/;
    const hits = cols.rows
      .filter((c) => deny.test(c.column_name))
      .map((c) => `${c.table_name}.${c.column_name}`);
    expect(hits).toEqual([]);
  });
});
