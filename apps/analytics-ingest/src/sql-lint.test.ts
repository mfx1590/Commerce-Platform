// The alias-shadow lint (sql-lint.ts): it catches the three shapes that bit Phase 5, allows the shapes that are meant,
// and the repository's ClickHouse SQL (data/clickhouse/** and the SQL in TypeScript template literals of this package
// and of the core's reporting module) is clean.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSqlFiles, splitStatements } from './migrations.js';
import { aliasShadows, sqlInTypeScript } from './sql-lint.js';

describe('aliasShadows: the three Phase 5 bugs are caught', () => {
  it('erasure re-read: an aliased event_id used in its own WHERE (#623, the DELETE of real orders)', () => {
    expect(
      aliasShadows(
        'SELECT topic, toString(event_id) AS event_id, payload FROM raw_events FINAL WHERE event_id IN {ids:Array(UUID)}',
      ),
    ).toEqual([
      "event_id: the alias of an expression shadows the column in this SELECT's WHERE/ON",
    ]);
  });

  it("mart_cash_daily: an aggregate's alias used inside another select item (#602)", () => {
    expect(
      aliasShadows(
        'SELECT coalesce(sum(fee_minor), 0) AS fee_minor, countIf(isNull(fee_minor)) AS fee_unknown FROM fct_payment GROUP BY store_id',
      ),
    ).toEqual([
      'fee_minor: the alias of an expression shadows the column inside another select item',
    ]);
  });

  it('reconcile bookings: toString(day) AS day used in the WHERE (#602)', () => {
    expect(
      aliasShadows(
        "SELECT toString(store_id) AS store_id, toString(day) AS day, currency FROM mart_bookings_daily WHERE day >= toDate('2026-10-01') AND store_id = toUUID('x')",
      ).sort(),
    ).toEqual([
      "day: the alias of an expression shadows the column in this SELECT's WHERE/ON",
      "store_id: the alias of an expression shadows the column in this SELECT's WHERE/ON",
    ]);
  });
});

describe('aliasShadows: what is meant stays allowed', () => {
  it('a plain (qualified) reference aliased to its own name, GROUP BY / ORDER BY by alias, out_* names', () => {
    expect(
      aliasShadows(
        `SELECT o.store_id AS store_id, toDate(o.placed_at, 'UTC') AS day, sum(o.total_minor) AS total_minor,
                sum(o.total_minor) - 1 AS net, toString(currency) AS out_currency
         FROM fct_order AS o WHERE o.order_status != 'cancelled' AND currency = 'EUR'
         GROUP BY store_id, day ORDER BY day`,
      ),
    ).toEqual([]);
  });

  it('each SELECT level is its own scope; string literals and comments never count', () => {
    expect(
      aliasShadows(
        "SELECT x AS y FROM (SELECT toString(a) AS a2 FROM t WHERE a = 1) WHERE note = 'toString(b) AS b WHERE b' -- b AS b",
      ),
    ).toEqual([]);
  });
});

describe('the repository is clean', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory()
        ? walk(p)
        : p.endsWith('.ts') && !p.endsWith('.test.ts')
          ? [p]
          : [];
    });

  // The ONE frozen exception: migration 0002 is applied (the runner refuses an edit) and its mv_orders_minute and
  // backfill select `assumeNotNull(store_id) AS store_id … WHERE … AND store_id IS NOT NULL`, which reads the alias
  // (a no-op filter). Harmless: order.placed is always store-scoped (packages/events), so the filter never had a row
  // to drop. Anything new must be clean; models are fixed in place (100_staging moved its filters into a subquery).
  const FROZEN = new Set([
    "0002_orders_minute.sql: store_id: the alias of an expression shadows the column in this SELECT's WHERE/ON",
  ]);

  it('every statement of data/clickhouse (migrations and models), except the one frozen migration', () => {
    const problems = readSqlFiles().flatMap((f) =>
      splitStatements(f.sql).flatMap((s) => aliasShadows(s).map((p) => `${f.name}: ${p}`)),
    );
    expect(problems.filter((p) => !FROZEN.has(p))).toEqual([]);
    expect(problems.filter((p) => FROZEN.has(p))).toHaveLength(2); // the MV and its backfill, nothing else
  });

  it('every SQL template literal in apps/analytics-ingest/src and apps/core/src/modules/reporting', () => {
    const files = [
      ...walk(join(root, 'apps/analytics-ingest/src')),
      ...walk(join(root, 'apps/core/src/modules/reporting')),
    ];
    expect(files.length).toBeGreaterThan(10);
    const problems = files.flatMap((f) =>
      sqlInTypeScript(readFileSync(f, 'utf8')).flatMap((sql) =>
        aliasShadows(sql).map((p) => `${f}: ${p}`),
      ),
    );
    expect(problems).toEqual([]);
  });
});
