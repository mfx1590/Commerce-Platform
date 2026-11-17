/**
 * CSV for the tables (#870 wave 1 item 2): the bulk report and "Export CSV" of a filtered list.
 * Pure — no React, no `next/*`.
 *
 * RFC 4180 quoting (a field with a comma, quote, CR or LF is quoted; quotes doubled), CRLF line
 * ends, and a guard against spreadsheet formula injection: a text cell that starts with `=`, `+`,
 * `-`, `@`, tab or CR is prefixed with `'`, so a product title or an email someone typed cannot
 * run as a formula when a specialist opens the file. Numbers are written as numbers.
 */

import type { BulkRowResult } from './bulk';

/** The most rows one "Export CSV" writes. Stated on the button and in the result. */
export const EXPORT_CAP = 1000;

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** The bulk report as a specialist follows it up: id, name, result, message (every row). */
export function reportCsv(results: readonly BulkRowResult[]): string {
  return toCsv(
    ['id', 'name', 'result', 'message'],
    results.map((row) => [row.id, row.label, row.outcome, row.message]),
  );
}

/** `catalog-2026-11-17T09-30.csv`: what, and when it was taken (UTC). */
export function csvFileName(what: string, now = new Date()): string {
  return `${what}-${now.toISOString().slice(0, 16).replace(':', '-')}.csv`;
}
