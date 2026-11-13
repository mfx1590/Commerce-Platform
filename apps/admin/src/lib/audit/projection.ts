/**
 * An audit entry as the screens render it: already redacted, with the actor named.
 *
 * `AuditRow` is what crosses into a `'use client'` table (src/lib/client-safe.ts: a client
 * component never takes a contract record). It has **no `before`/`after`** by construction — the
 * raw bodies are reduced to `FieldChange[]` on the server and the blobs are left behind, so
 * nothing unreviewed can reach the browser's Flight payload or a CSV file.
 *
 * Pure: no `next/*`, no I/O.
 */

import type { AdminComponents } from '../api/admin-client';
import { fieldChanges, entityLabel, summarise, type FieldChange } from './redaction';

type AuditEntry = AdminComponents['AuditEntry'];
type StaffUser = AdminComponents['StaffUser'];

export type ActorKind = 'staff' | 'service' | 'system' | 'customer' | 'unknown';

export interface ActorLabel {
  name: string;
  kind: ActorKind;
}

export interface AuditRow {
  id: string;
  created_at: string;
  store_id: string | null;
  store_label: string | null;
  actor: ActorLabel;
  action: string;
  action_label: string;
  entity_type: string;
  entity_label: string;
  entity_id: string;
  summary: string;
  changes: readonly FieldChange[];
  request_id: string | null;
}

/** What the row renderer needs to put a name on an id. */
export interface AuditLookups {
  staff?: ReadonlyMap<string, StaffUser>;
  stores?: ReadonlyMap<string, string>;
  isServiceAccount?: (userId: string) => boolean;
}

const shortId = (id: string) => id.slice(0, 8);

/**
 * Who did it, as a person rather than a uuid.
 *
 * A **customer** actor is never named: an audit row is read by staff, and the customer's name is
 * personal data this screen has no reason to show. A staff id that resolves to nobody (deleted
 * user, another organization's row) is labelled "unknown staff" with a short id — never a bare
 * uuid pretending to be a name, and never silently blank.
 */
export function actorLabel(entry: AuditEntry, lookups: AuditLookups = {}): ActorLabel {
  if (entry.actor_type === 'system') return { name: 'System', kind: 'system' };
  if (entry.actor_type === 'customer') return { name: 'Customer', kind: 'customer' };
  const id = entry.actor_id;
  if (id === null) return { name: 'Unknown', kind: 'unknown' };
  const user = lookups.staff?.get(id);
  const service = lookups.isServiceAccount?.(id) === true;
  if (user === undefined) return { name: `Unknown staff (${shortId(id)})`, kind: 'unknown' };
  return { name: user.display_name, kind: service ? 'service' : 'staff' };
}

/** One entry, reduced to what a screen may render. */
export function toAuditRow(entry: AuditEntry, lookups: AuditLookups = {}): AuditRow {
  return {
    id: entry.id,
    created_at: entry.created_at,
    store_id: entry.store_id,
    store_label:
      entry.store_id === null ? null : (lookups.stores?.get(entry.store_id) ?? entry.store_id),
    actor: actorLabel(entry, lookups),
    action: entry.action,
    action_label: summarise(entry),
    entity_type: entry.entity_type,
    entity_label: entityLabel(entry.entity_type),
    entity_id: entry.entity_id,
    summary: summarise(entry),
    changes: fieldChanges(entry),
    request_id: entry.request_id,
  };
}

export function toAuditRows(
  entries: readonly AuditEntry[],
  lookups: AuditLookups = {},
): AuditRow[] {
  return entries.map((entry) => toAuditRow(entry, lookups));
}

// ---------------------------------------------------------------------------- CSV

/** The visible columns, in the order the table shows them. */
export const CSV_COLUMNS = [
  'time',
  'store',
  'actor',
  'actor_type',
  'action',
  'entity_type',
  'entity_id',
  'summary',
  'changed_fields',
  'request_id',
] as const;

/**
 * RFC 4180 quoting, plus the spreadsheet guard: a cell beginning `=`, `+`, `-` or `@` is prefixed
 * with an apostrophe so Excel and Sheets treat it as text rather than a formula. An audit log is
 * attacker-influenced input (a product title is whatever someone typed), and a CSV export is the
 * classic way that becomes a formula in someone else's spreadsheet.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * The visible columns as CSV — the redacted summary and the changed field NAMES, never a
 * `before`/`after` body. An export is the easiest way for an unreviewed blob to end up in a
 * spreadsheet, so the rows it writes are the same `AuditRow`s the table renders.
 */
export function auditCsv(rows: readonly AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.created_at,
        row.store_label ?? 'organization',
        row.actor.name,
        row.actor.kind,
        row.action,
        row.entity_type,
        row.entity_id,
        row.summary,
        row.changes.map((change) => change.field).join(' '),
        row.request_id ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
