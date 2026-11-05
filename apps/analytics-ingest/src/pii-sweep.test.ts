// The PII sweep's shapes and its enumeration, offline. The patterns are re2 for ClickHouse and run unchanged as JS
// regular expressions here (no lookaround). The live sweep runs in the Integration 5 gate (apps/core
// reconcile-gate.test.ts) over every table and view of a migrated, populated database.
import { describe, expect, it } from 'vitest';
import type { ChClient } from './clickhouse.js';
import { ibanValid, luhnValid, PII_PATTERNS, sweepPii } from './pii-sweep.js';

const re = (k: keyof typeof PII_PATTERNS) => new RegExp(PII_PATTERNS[k]);
const first = (k: 'card' | 'iban', s: string) => re(k).exec(s)?.[1];

// fixtures assembled at run time: no literal in this file is shaped like a card or an IBAN
const card = ['4111', '1111', '1111', '1111'].join('');
const iban = ['GB', '82', 'WEST', '1234', '5698', '7654', '32'].join('');

describe('PII shapes', () => {
  it('finds an e-mail, a phone, a personal-data key with a value, a card and an IBAN', () => {
    expect(re('email').test('{"note":"someone@shop.example"}')).toBe(true);
    expect(re('phone').test('{"note":"call +44 20 7946 0000"}')).toBe(true);
    expect(re('phone').test('{"note":"tel 030 1234 5678"}')).toBe(true);
    expect(re('personal_key').test('{"first_name": "Ada"}')).toBe(true);
    expect(re('personal_key').test('{"lines":[{"street":"Main"}]}')).toBe(true);
    expect(first('card', `{"pan":"${card}"}`)).toBe(card);
    expect(luhnValid(first('card', `{"pan":"${card.replace(/(\d{4})(?=\d)/g, '$1 ')}"}`)!)).toBe(
      true,
    );
    expect(first('iban', `{"account":"${iban}"}`)).toBe(iban);
    expect(ibanValid(iban)).toBe(true);
  });

  it('passes what the platform does store: sha256, uuids, timestamps, money, an empty personal key', () => {
    const benign = [
      `{"email_hash":"${'ab12'.repeat(16)}"}`,
      '{"order_id":"12345678-1234-4123-8123-123456789012"}',
      '{"customer_id":"00000000-0000-4000-8000-0000000c0001"}',
      '{"occurred_at":"2026-10-25T09:30:00.123Z","placed_at":"2026-10-25 09:30:00.123"}',
      '{"total_minor":1234567890123,"display_id":100042,"ms":1761384600000}',
      '{"rate":"0.05","date":"2026-01-05","window":"05/2026"}',
      '{"customer_id":null,"email_hash":null,"address":""}',
      '{"sku":"SKU-0001","currency":"EUR","provider":"stripe"}',
    ];
    for (const s of benign) {
      for (const k of ['email', 'phone', 'personal_key'] as const)
        expect(re(k).test(s), `${k}: ${s}`).toBe(false);
      const c = first('card', s);
      expect(c === undefined || !luhnValid(c), `card: ${s}`).toBe(true);
      const i = first('iban', s);
      expect(i === undefined || !ibanValid(i), `iban: ${s}`).toBe(true);
    }
  });

  it('the check digits: Luhn and mod-97 refuse a one-digit change, an unknown country, a wrong length', () => {
    expect(luhnValid(card.slice(0, -1) + '2')).toBe(false);
    expect(luhnValid('4111')).toBe(false);
    expect(ibanValid(iban.slice(0, -1) + '3')).toBe(false);
    expect(ibanValid(`ZZ${iban.slice(2)}`)).toBe(false);
  });
});

describe('sweepPii', () => {
  function fakeCh(
    tables: { name: string; engine: string }[],
    columns: { table: string; name: string }[],
  ) {
    const queries: { query: string; params: Record<string, unknown> }[] = [];
    const ch = {
      query: async (p: { query: string; query_params?: Record<string, unknown> }) => {
        queries.push({ query: p.query, params: p.query_params ?? {} });
        const out = p.query.includes('currentDatabase() AS database')
          ? [{ database: 'analytics_x' }]
          : p.query.includes('FROM system.tables')
            ? tables
            : p.query.includes('FROM system.columns')
              ? columns
              : p.query.includes('`raw_events`')
                ? [
                    {
                      c0_email: '1',
                      c0_phone: '0',
                      c0_personal_key: '0',
                      c0_card: [card, card.slice(0, -1) + '2'],
                      c0_iban: [],
                    },
                  ]
                : [
                    {
                      c0_email: '0',
                      c0_phone: '0',
                      c0_personal_key: '0',
                      c0_card: [],
                      c0_iban: [],
                    },
                  ];
        return { json: async () => out };
      },
    } as unknown as ChClient;
    return { ch, queries };
  }

  it('reads every table and view system.tables lists, every string column, and reports counts only', async () => {
    const { ch, queries } = fakeCh(
      [
        { name: 'raw_events', engine: 'ReplacingMergeTree' },
        { name: 'stg_x', engine: 'View' },
        { name: 'no_strings', engine: 'MergeTree' },
      ],
      [
        { table: 'raw_events', name: 'payload' },
        { table: 'stg_x', name: 'currency' },
      ],
    );
    const r = await sweepPii(ch);
    expect(r.database).toBe('analytics_x');
    expect(r.scanned).toEqual([
      { table: 'raw_events', engine: 'ReplacingMergeTree', columns: ['payload'] },
      { table: 'stg_x', engine: 'View', columns: ['currency'] },
      { table: 'no_strings', engine: 'MergeTree', columns: [] },
    ]);
    // the e-mail by rows; the card candidates through Luhn (one passes, one does not); never the values
    expect(r.findings).toEqual([
      { table: 'raw_events', column: 'payload', kind: 'email', count: 1 },
      { table: 'raw_events', column: 'payload', kind: 'card', count: 1 },
    ]);
    expect(JSON.stringify(r)).not.toContain(card);
    // materialised views and the runner's _migrations* are left out by the enumeration query itself
    const list = queries.find((q) => q.query.includes('FROM system.tables'))!.query;
    expect(list).toMatch(/engine != 'MaterializedView'/);
    expect(list).toMatch(/NOT startsWith\(name, '_'\)/);
    // a table with no string column is listed but not queried; identifiers are quoted, patterns are parameters
    expect(
      queries.filter((q) => /FROM `/.test(q.query)).map((q) => q.query.match(/FROM (`\w+`)/)![1]),
    ).toEqual(['`raw_events`', '`stg_x`']);
    expect(queries.at(-1)!.params).toEqual(PII_PATTERNS);
  });
});
