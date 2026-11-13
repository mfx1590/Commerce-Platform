import Link from 'next/link';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ACTIVITY_PAGE_SIZE, type ActivityData } from '@/lib/audit/load';
import type { AuditRow } from '@/lib/audit/projection';
import { entityLabel } from '@/lib/audit/redaction';

/** `?activity=` on the page that hosts the panel; nothing else about that page changes. */
export function activityPage(raw: string | string[] | undefined): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value >= 1 ? value : 1;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

const ACTOR_TONE = {
  service: 'warning',
  system: 'neutral',
  customer: 'neutral',
  unknown: 'danger',
  staff: 'accent',
} as const;

function ChangeList({ row }: { row: AuditRow }) {
  if (row.changes.length === 0) return null;
  return (
    <ul className="text-muted mt-1 space-y-0.5 text-xs">
      {row.changes.map((change) => (
        <li key={change.field}>
          <span className="font-mono">{change.field}</span>{' '}
          {change.kind === 'shown' ? (
            <>
              <span className="line-through">{change.before ?? 'none'}</span>
              {' → '}
              <span className="font-medium">{change.after ?? 'none'}</span>
            </>
          ) : (
            <span>changed — value not shown</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Rows of an audit page, as a table. Shared by the entity panel and the HQ audit view so both read
 * the same — and so neither can start rendering a `before`/`after` body: an `AuditRow` has none.
 */
export function ActivityRows({
  rows,
  caption,
  showStore = false,
}: {
  rows: readonly AuditRow[];
  caption: string;
  showStore?: boolean;
}) {
  return (
    <table className="w-full text-sm" aria-label={caption}>
      <thead className="text-muted text-left text-xs">
        <tr>
          <th className="py-1">When</th>
          {showStore && <th>Store</th>}
          <th>Who</th>
          <th>What changed</th>
        </tr>
      </thead>
      <tbody className="divide-line divide-y align-top">
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="text-muted py-2 pr-3 text-xs whitespace-nowrap">
              {formatTime(row.created_at)}
            </td>
            {showStore && <td className="pr-3 text-xs">{row.store_label ?? 'organization'}</td>}
            <td className="pr-3">
              <span>{row.actor.name}</span>
              {row.actor.kind !== 'staff' && (
                <Badge className="ml-2" tone={ACTOR_TONE[row.actor.kind]}>
                  {row.actor.kind === 'service' ? 'service account' : row.actor.kind}
                </Badge>
              )}
            </td>
            <td className="py-2">
              <span className="font-medium">{row.summary}</span>
              <span className="text-muted ml-2 font-mono text-xs">{row.action}</span>
              <ChangeList row={row} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * "Activity" on an entity's detail page (#870 wave 1 item 3): who changed this thing, when, and
 * what.
 *
 * Synchronous on purpose — the page awaits `loadActivity` with its own data and hands the result
 * down. A page with an async child component cannot be rendered by the screen tests, and the data
 * belongs to the page in any case.
 *
 * Values appear only for an allow-listed `(entity_type, field)` pair (`src/lib/audit/redaction.ts`);
 * every other field is named with its value withheld, so the reader always learns WHAT changed.
 */
export function ActivityPanel({
  activity,
  entityType,
  basePath,
  note,
}: {
  activity: ActivityData;
  entityType: string;
  /** The hosting page's own path; paging links add `?activity=`. */
  basePath: string;
  /** An extra sentence under the heading, where this entity's history has a known gap. */
  note?: string;
}) {
  const label = entityLabel(entityType);
  const { page, total, rows, error } = activity;

  return (
    <Card>
      <CardHeader
        title="Activity"
        description={
          note === undefined
            ? `Who changed this ${label}, newest first.`
            : `Who changed this ${label}, newest first. ${note}`
        }
      />
      <CardBody>
        {error !== undefined ? (
          <RequestErrorPanel status={error.status} error={error.error} />
        ) : rows.length === 0 ? (
          <p className="text-muted text-sm">
            No recorded changes yet. Every admin change to this {label} is recorded here from the
            moment it happens.
          </p>
        ) : (
          <div className="space-y-3">
            <ActivityRows rows={rows} caption={`Activity on this ${label}`} />
            <div className="text-muted flex items-center gap-3 text-xs">
              <span>
                {total} change{total === 1 ? '' : 's'} recorded
              </span>
              {page > 1 && (
                <Link
                  className="text-accent hover:underline"
                  href={`${basePath}?activity=${page - 1}`}
                >
                  ← Newer
                </Link>
              )}
              {page * ACTIVITY_PAGE_SIZE < total && (
                <Link
                  className="text-accent hover:underline"
                  href={`${basePath}?activity=${page + 1}`}
                >
                  Older →
                </Link>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
