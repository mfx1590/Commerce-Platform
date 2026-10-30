// The ClickHouse read side of the recommendations job (task P5.8, #607), over `fct_order_line` (window 12's #601).
//
// No SDK, same rule as the Algolia and Cloudinary clients: ClickHouse's HTTP interface over fetch. Credentials come
// from the environment only and are never logged or embedded in an error (`redact`), like the Algolia key.
//
// Three things make this a READ-ONLY path by construction:
//   * the user is `CLICKHOUSE_READONLY_USER` (data/clickhouse/access/20_analytics_ro.sql: `readonly 1`, a
//     SELECT-only grant on `analytics.*`, 10 s execution cap, 100 000 result rows);
//   * every query here is a SELECT with bound parameters (`{name:Type}` + `param_name=`), never string
//     interpolation, so no caller value can become SQL;
//   * the aggregation happens in ClickHouse. Only the counts cross the wire — pair counts, per-product basket
//     counts and the basket total — which is both the cheap way and the only way that fits the 100 000-row cap on
//     a real catalogue.
//
// The `fct_order_line` columns are the interface fixed on #601 (comment 6400313723): line items carry only
// `variant_id`, and ClickHouse resolves `product_id` itself through `dim_variant`, so this job needs NO Postgres
// join for the mapping. Two filters are the manager's and are applied in every query below:
//   * `product_id IS NOT NULL` — the variant was never published, so there is nothing to recommend;
//   * `order_status != 'cancelled'` — a cancelled order is not evidence of anything.
import {
  countsFromBaskets,
  emptyCounts,
  pairKey,
  type BasketCounts,
  type PopularWindow,
  type Thresholds,
} from './recommendations-types';

export interface ClickHouseCredentials {
  url: string;
  database: string;
  user: string;
  password: string;
}

/**
 * `CLICKHOUSE_URL` / `CLICKHOUSE_DATABASE` + the READ-ONLY pair (`CLICKHOUSE_READONLY_USER` /
 * `CLICKHOUSE_READONLY_PASSWORD`, .env.example rows 134-139). Null when the set is incomplete: the job then says
 * so and exits without touching anything, and the ClickHouse-backed tests skip with a printed reason.
 */
export function clickhouseCredentialsFrom(
  env: NodeJS.ProcessEnv = process.env,
): ClickHouseCredentials | null {
  const url = env.CLICKHOUSE_URL;
  const user = env.CLICKHOUSE_READONLY_USER;
  const password = env.CLICKHOUSE_READONLY_PASSWORD;
  const database = env.CLICKHOUSE_DATABASE ?? 'analytics';
  if (!url || !user || !password) return null;
  return { url, database, user, password };
}

export class ClickHouseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`clickhouse ${status}: ${message}`);
    this.name = 'ClickHouseError';
  }
}

export interface ClickHouseClientOptions extends ClickHouseCredentials {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

/** A minimal SELECT-only ClickHouse HTTP client. */
export class ClickHouseClient {
  private readonly url: string;
  private readonly database: string;
  private readonly user: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts: ClickHouseClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.database = opts.database;
    this.user = opts.user;
    this.password = opts.password;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 2;
  }

  /** Credentials must never reach a log or an error message. */
  private redact(s: string): string {
    let out = s.split(this.password).join('***');
    if (this.user) out = out.split(this.user).join('***');
    return out;
  }

  private async backoff(attempt: number): Promise<void> {
    await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
  }

  /**
   * Runs one SELECT and returns its rows. `params` are bound through ClickHouse's own `param_<name>` mechanism,
   * so `{storeId:UUID}` in the SQL is a parameter and never text we concatenated.
   */
  async query<T>(sql: string, params: Record<string, string | number> = {}): Promise<T[]> {
    // `analytics_ro` is `readonly = 1`, which refuses ANY per-query setting ("Cannot modify … in readonly
    // mode") — the same rule apps/analytics-ingest's read-only client documents. `default_format` IS a setting,
    // so the format goes in the statement instead; only `database` and the `param_*` bindings are sent.
    const search = new URLSearchParams({ database: this.database });
    for (const [k, v] of Object.entries(params)) search.set(`param_${k}`, String(v));
    const auth = Buffer.from(`${this.user}:${this.password}`).toString('base64');

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.url}/?${search.toString()}`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/plain' },
          body: `${sql}\nFORMAT JSONEachRow`,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt >= this.retries) {
          throw new ClickHouseError(
            0,
            this.redact(err instanceof Error ? err.message : String(err)),
          );
        }
        await this.backoff(attempt);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 500 && attempt < this.retries) {
          await this.backoff(attempt);
          continue;
        }
        throw new ClickHouseError(res.status, this.redact(text.slice(0, 300)));
      }
      return text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as T);
    }
  }
}

/** Where the job's baskets come from: ClickHouse in production, a fixture until #601 is on main. */
export interface BasketSource {
  /** A name for the job's log line (`clickhouse` / `fixture`). */
  readonly kind: string;
  /** Basket counts for one store over the lookback window. */
  counts(storeId: string, t: Thresholds): Promise<BasketCounts>;
  /** Units sold per product in one store over `window` days. */
  units(storeId: string, window: PopularWindow): Promise<Map<string, number>>;
}

// ClickHouse resolves aliases EVERYWHERE in a statement, so an alias may never repeat a name that is already a
// source column, a table alias or a CTE in the same query (Memory-main global gotcha, three bugs in Phase 5 —
// "aggregate inside aggregate" in #601, wrong WHERE results in #602, a data-loss path in #623). Every name below
// is therefore distinct from every other: the CTE is `basket_lines`, its two self-join sides are `left_line` /
// `right_line`, and the outputs are `total_baskets` / `product_baskets` / `pa` / `pb` / `pair_baskets` /
// `sold_units`. clickhouse.test.ts asserts this statically, because none of this SQL has ever executed (the
// ClickHouse-backed test is skipped until #601 is on main).
/** The table this job reads. Only a test ever substitutes it — see `basketStatements`. */
export const ORDER_LINES_RELATION = 'fct_order_line';

/**
 * The four statements, over `relation`. Production always uses `fct_order_line`; the live test passes a literal
 * row set instead, so the self-join's semantics can be proven on the REAL ClickHouse without writing anything
 * to the shared database (`analytics_ro` could not anyway). `relation` is never caller input — it is this
 * module's own constant or a literal the test builds.
 */
export function basketStatements(relation: string = ORDER_LINES_RELATION): {
  totals: string;
  singles: string;
  pairs: string;
  units: string;
} {
  const cte = `
  WITH basket_lines AS (
    SELECT DISTINCT order_id, product_id
    FROM ${relation}
    WHERE store_id = {storeId:UUID}
      AND product_id IS NOT NULL
      AND order_status != 'cancelled'
      AND placed_at >= now() - INTERVAL {lookbackDays:UInt16} DAY
  )`;
  return {
    totals: `${cte} SELECT uniqExact(order_id) AS total_baskets FROM basket_lines`,
    singles: `${cte}
       SELECT product_id, uniqExact(order_id) AS product_baskets
       FROM basket_lines
       GROUP BY product_id`,
    // The self-join is the co-occurrence. `left_line.product_id < right_line.product_id` keeps each unordered
    // pair once (half the work, and it is the same key `pairKey` builds); both directions are written by
    // `recommendPairs`. The support floor is pushed down here so the thin pairs never cross the wire.
    pairs: `${cte}
       SELECT left_line.product_id AS pa, right_line.product_id AS pb, count() AS pair_baskets
       FROM basket_lines AS left_line
       INNER JOIN basket_lines AS right_line ON left_line.order_id = right_line.order_id
       WHERE left_line.product_id < right_line.product_id
       GROUP BY pa, pb
       HAVING pair_baskets >= {minSupport:UInt32}`,
    units: `SELECT product_id, sum(quantity) AS sold_units
       FROM ${relation}
       WHERE store_id = {storeId:UUID}
         AND product_id IS NOT NULL
         AND order_status != 'cancelled'
         AND placed_at >= now() - INTERVAL {days:UInt16} DAY
       GROUP BY product_id
       ORDER BY sold_units DESC`,
  };
}

/** The real source: four aggregates per store, computed in ClickHouse. */
export class ClickHouseBasketSource implements BasketSource {
  readonly kind = 'clickhouse';

  /**
   * `relation` defaults to `fct_order_line` and is only ever overridden by the live test, which substitutes a
   * literal row set to prove the self-join on the real engine without writing to the shared database.
   */
  constructor(
    private readonly client: ClickHouseClient,
    private readonly relation: string = ORDER_LINES_RELATION,
  ) {}

  async counts(storeId: string, t: Thresholds): Promise<BasketCounts> {
    const params = { storeId, lookbackDays: t.lookbackDays };
    const sql = basketStatements(this.relation);

    const totals = await this.client.query<{ total_baskets: string }>(sql.totals, params);
    const basketCount = Number(totals[0]?.total_baskets ?? 0);
    if (basketCount === 0) return emptyCounts();

    const singleRows = await this.client.query<{ product_id: string; product_baskets: string }>(
      sql.singles,
      params,
    );

    const pairRows = await this.client.query<{ pa: string; pb: string; pair_baskets: string }>(
      sql.pairs,
      { ...params, minSupport: t.minSupportBaskets },
    );

    const counts: BasketCounts = { basketCount, singles: new Map(), pairs: new Map() };
    for (const r of singleRows) counts.singles.set(r.product_id, Number(r.product_baskets));
    for (const r of pairRows) counts.pairs.set(pairKey(r.pa, r.pb), Number(r.pair_baskets));
    return counts;
  }

  async units(storeId: string, window: PopularWindow): Promise<Map<string, number>> {
    const rows = await this.client.query<{ product_id: string; sold_units: string }>(
      basketStatements(this.relation).units,
      { storeId, days: window },
    );
    return new Map(rows.map((r) => [r.product_id, Number(r.sold_units)]));
  }
}

/** One order of the fixture: the shape #601 publishes, reduced to what this job reads. */
export interface FixtureLine {
  store_id: string;
  order_id: string;
  product_id: string | null;
  quantity: number;
  placed_at: string;
  order_status: 'placed' | 'cancelled';
}

/**
 * The stand-in source until #601 (PR #619) is on main, and the one the unit tests use: the same two filters and
 * the same windowing as the SQL above, applied in memory to `fct_order_line`-shaped rows. Keeping both sources
 * behind one interface is what makes the skipped ClickHouse test the only untested seam.
 */
export class FixtureBasketSource implements BasketSource {
  readonly kind = 'fixture';

  constructor(
    private readonly lines: readonly FixtureLine[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  private usable(storeId: string, days: number): FixtureLine[] {
    const cutoff = this.now().getTime() - days * 86_400_000;
    return this.lines.filter(
      (l) =>
        l.store_id === storeId &&
        l.product_id !== null &&
        l.order_status !== 'cancelled' &&
        Date.parse(l.placed_at) >= cutoff,
    );
  }

  counts(storeId: string, t: Thresholds): Promise<BasketCounts> {
    const byOrder = new Map<string, string[]>();
    for (const l of this.usable(storeId, t.lookbackDays)) {
      const list = byOrder.get(l.order_id) ?? [];
      list.push(l.product_id as string);
      byOrder.set(l.order_id, list);
    }
    return Promise.resolve(countsFromBaskets([...byOrder.values()]));
  }

  units(storeId: string, window: PopularWindow): Promise<Map<string, number>> {
    const units = new Map<string, number>();
    for (const l of this.usable(storeId, window)) {
      const id = l.product_id as string;
      units.set(id, (units.get(id) ?? 0) + l.quantity);
    }
    return Promise.resolve(units);
  }
}
