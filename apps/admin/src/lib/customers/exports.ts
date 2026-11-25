/**
 * Reading a GDPR export request out loud (#870 wave 1 item 4, PR C).
 *
 * `listCustomerExports` answers ids, a status, timestamps, a size, a reason and who asked. None of
 * that is the bundle, and none of it is personal data about the customer — which is exactly why
 * the trail can be shown while the bundle is not.
 *
 * Pure: no `next/*`, no I/O, no React.
 */

import type { AdminComponents } from '../api/admin-client';

type Summary = AdminComponents['CustomerExportSummary'];

/** A row of `listCustomerExports`: the summary plus who asked and how often it was downloaded. */
export type ExportRequest = Summary & {
  requested_by: string;
  requested_by_type: 'staff' | 'customer';
  download_count: number;
};

export type ExportTone = 'neutral' | 'success' | 'warning' | 'danger';

export function exportTone(status: Summary['status']): ExportTone {
  if (status === 'ready') return 'success';
  if (status === 'expired') return 'warning';
  return 'neutral';
}

/**
 * What the status means, in a sentence, including the two reasons a bundle never arrived.
 *
 * `reason` is only ever one of the contract's two enum values, so it is mapped rather than printed:
 * a raw `too_large` in a table reads like a bug, and an unknown value must not become one either.
 */
export function describeExport(entry: ExportRequest): string {
  if (entry.status === 'pending') return 'Being built by the core.';
  if (entry.status === 'ready') {
    return entry.expires_at === null
      ? 'Ready to hand over.'
      : `Ready to hand over until ${day(entry.expires_at)}.`;
  }
  if (entry.reason === 'customer_gone') {
    return 'Never built: the customer was erased before the bundle was.';
  }
  if (entry.reason === 'too_large') {
    return 'Never built: too large. The core can only bundle so much in one request.';
  }
  return 'Expired. A bundle is kept for a limited time and then purged.';
}

/** `1.4 MB`, or an em dash when there is no bundle to measure (pending, or purged). */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Who asked, as a person where that is knowable.
 *
 * A **customer** request is labelled as one and never named: it came from the storefront's own
 * self-service, and this screen already shows whose page it is. A **staff** id is resolved against
 * the staff list when the reader may read it — `listUsers` is `owner` on `organization:hq`, so a
 * store admin looking at their own store's exports cannot have the name and gets a short id
 * instead. The trail stays readable either way; it never invents a name.
 */
export function requesterLabel(
  entry: ExportRequest,
  staffName: (id: string) => string | undefined,
): string {
  if (entry.requested_by_type === 'customer') return 'The customer (self-service)';
  return staffName(entry.requested_by) ?? `Staff (${entry.requested_by.slice(0, 8)})`;
}

/** "downloaded twice", and silence at zero — a count of nothing is noise in a table. */
export function describeDownloads(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) return 'downloaded once';
  if (count === 2) return 'downloaded twice';
  return `downloaded ${count} times`;
}

const day = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
};
