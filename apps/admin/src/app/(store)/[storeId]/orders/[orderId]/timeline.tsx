import { Badge } from '@/components/ui/badge';
import type { AdminComponents } from '@/lib/api/admin-client';
import { formatMoney } from '@/lib/forms/money';
import { orderTimeline } from '@/lib/orders/timeline';
import { statusLabel, toneFor } from '../orders-table.config';

type Order = AdminComponents['Order'];

function formatAt(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      date,
    );
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Payments, refunds, shipments and returns as one story, oldest first (`src/lib/orders/timeline.ts`). */
export function Timeline({ order, locale }: { order: Order; locale: string }) {
  const entries = orderTimeline(order, (amountMinor, currency) =>
    formatMoney(amountMinor, currency, locale),
  );
  return (
    <ol className="space-y-3" aria-label="Order timeline">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-baseline gap-3 text-sm">
          <span className="text-muted w-40 shrink-0 font-mono text-xs">
            {entry.at === null ? '—' : formatAt(entry.at, locale)}
          </span>
          <span className="font-medium">{entry.title}</span>
          {entry.status !== undefined && (
            <Badge tone={toneFor(entry.status)}>{statusLabel(entry.status)}</Badge>
          )}
          {entry.detail !== undefined && <span className="text-muted">{entry.detail}</span>}
        </li>
      ))}
    </ol>
  );
}
