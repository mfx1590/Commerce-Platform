// The live PII sweep (Integration 5 gate 4, #612): every table and view of a ClickHouse database is read for values
// shaped like personal data. "No PII in ClickHouse" (#600) is proven on the bytes, not on the column names
// (models.test.ts checks those).
//
//   * WHAT is swept is enumerated from system.tables (every table and view of the current database; materialised
//     views hold no rows of their own, and `_migrations*` are the runner's), so a new table or model cannot be
//     missed. Every column whose type carries a String (Nullable, LowCardinality, Array, Map …) is read through
//     toString; numbers, dates and UUIDs cannot hold these shapes.
//   * The shapes: an e-mail; a phone (international `+…`, or a domestic `0…` number with separators); an IBAN (a
//     registered country, then the mod-97 check); a card number (13-19 digits from an issuer range, then Luhn); and a
//     name or address KEY with a non-empty value in JSON text (`"first_name":"…"`), which only free-text columns such
//     as raw_events.payload can hold. sha256 hex (email_hash), uuids and timestamps match none of them.
//   * Without FINAL: an old, not yet merged copy of a row is bytes on disk too.
// The result carries COUNTS only, never a value: what it finds must not reach a log. Read-only (SELECTs).
import type { ChClient } from './clickhouse.js';

export type PiiKind = 'email' | 'phone' | 'iban' | 'card' | 'personal_key';

export interface PiiFinding {
  table: string;
  column: string;
  kind: PiiKind;
  /** e-mail, phone, personal_key: rows that match; iban, card: distinct values that pass their check digit. */
  count: number;
}

export interface PiiSweepResult {
  database: string;
  /** Every table and view read, with the string columns read in it. */
  scanned: { table: string; engine: string; columns: string[] }[];
  findings: PiiFinding[];
}

/** re2 patterns (ClickHouse `match` / `extractAll`). The candidates of iban and card are checked in JS. */
export const PII_PATTERNS = {
  email: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}',
  // `+` then 8-15 digits with optional separators; or a domestic number: 0, an area code, a separator, the rest
  phone:
    '(^|[^0-9A-Za-z+])\\+[1-9]([ ().-]?[0-9]){7,14}($|[^0-9A-Za-z])|(^|[^0-9A-Za-z.:-])0[1-9][0-9]{1,4}[ /-][0-9]{3,4}[ -]?[0-9]{2,4}($|[^0-9A-Za-z])',
  // whole tokens only (never a fragment of a uuid or of a longer digit run); the capture is the candidate
  card: '(?:^|[^0-9A-Za-z-])([2-6](?:[ -]?[0-9]){12,18})(?:$|[^0-9A-Za-z-])',
  iban: '(?:^|[^0-9A-Za-z])([A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30})(?:$|[^0-9A-Za-z])',
  personal_key:
    '"(e?mail|email_address|phone|phone_number|mobile|first_name|last_name|full_name|customer_name|billing_name|shipping_name|given_name|family_name|address|address_1|address_2|address_line_1|address_line_2|street|postcode|postal_code|zip|city|ip|ip_address|birth_date|dob)"\\s*:\\s*"[^"]',
} as const;

/** Countries that issue IBANs (the SWIFT registry); anything else is not an IBAN however its digits add up. */
const IBAN_COUNTRIES = new Set(
  'AD AE AL AT AZ BA BE BG BH BI BR BY CH CR CY CZ DE DJ DK DO EE EG ES FI FK FO FR GB GE GI GL GR GT HR HU IE IL IQ IS IT JO KW KZ LB LC LI LT LU LV LY MC MD ME MK MN MR MT MU NI NL NO OM PK PL PS PT QA RO RS RU SA SC SD SE SI SK SM SO ST SV TL TN TR UA VA VG XK YE'.split(
    ' ',
  ),
);

/** The Luhn check over the digits of `s` (separators ignored). */
export function luhnValid(s: string): boolean {
  const digits = s.replace(/[ -]/g, '');
  if (!/^[0-9]{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** ISO 13616: a registered country and the mod-97 check (= 1). */
export function ibanValid(s: string): boolean {
  const iban = s.replace(/ /g, '');
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) || !IBAN_COUNTRIES.has(iban.slice(0, 2)))
    return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rest === 1;
}

const quote = (identifier: string) =>
  `\`${identifier.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;

export interface SweepOptions {
  /** Distinct iban / card candidates checked per column (default 10 000). */
  candidateLimit?: number;
}

export async function sweepPii(ch: ChClient, opts: SweepOptions = {}): Promise<PiiSweepResult> {
  const limit = opts.candidateLimit ?? 10_000;
  const rows = async <T>(query: string, params: Record<string, unknown> = {}) =>
    (await ch.query({ query, format: 'JSONEachRow', query_params: params })).json<T>();
  const [{ database }] = (await rows<{ database: string }>(
    'SELECT currentDatabase() AS database',
  )) as [{ database: string }];
  const tables = await rows<{ name: string; engine: string }>(
    `SELECT name, engine FROM system.tables
     WHERE database = currentDatabase() AND engine != 'MaterializedView' AND NOT startsWith(name, '_')
     ORDER BY name`,
  );
  const columns = await rows<{ table: string; name: string }>(
    `SELECT table, name FROM system.columns
     WHERE database = currentDatabase() AND position(type, 'String') > 0
     ORDER BY table, position`,
  );
  const byTable = new Map<string, string[]>();
  for (const c of columns) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c.name]);

  const scanned: PiiSweepResult['scanned'] = [];
  const findings: PiiFinding[] = [];
  for (const t of tables) {
    const cols = byTable.get(t.name) ?? [];
    scanned.push({ table: t.name, engine: t.engine, columns: cols });
    if (cols.length === 0) continue;
    const select = cols.flatMap((c, i) => {
      const s = `ifNull(toString(${quote(c)}), '')`;
      return [
        `countIf(match(${s}, {email:String})) AS c${i}_email`,
        `countIf(match(${s}, {phone:String})) AS c${i}_phone`,
        `countIf(match(${s}, {personal_key:String})) AS c${i}_personal_key`,
        `groupUniqArrayArray(${limit})(extractAll(${s}, {card:String})) AS c${i}_card`,
        `groupUniqArrayArray(${limit})(extractAll(${s}, {iban:String})) AS c${i}_iban`,
      ];
    });
    const [r] = await rows<Record<string, string | string[]>>(
      `SELECT ${select.join(', ')} FROM ${quote(t.name)}`,
      PII_PATTERNS,
    );
    cols.forEach((column, i) => {
      const add = (kind: PiiKind, count: number) => {
        if (count > 0) findings.push({ table: t.name, column, kind, count });
      };
      add('email', Number(r?.[`c${i}_email`] ?? 0));
      add('phone', Number(r?.[`c${i}_phone`] ?? 0));
      add('personal_key', Number(r?.[`c${i}_personal_key`] ?? 0));
      add('card', ((r?.[`c${i}_card`] ?? []) as string[]).filter(luhnValid).length);
      add('iban', ((r?.[`c${i}_iban`] ?? []) as string[]).filter(ibanValid).length);
    });
  }
  return { database, scanned, findings };
}
