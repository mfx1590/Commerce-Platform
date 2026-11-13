'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';
import {
  describeReport,
  sortForReport,
  toBulkSelection,
  type BulkReport,
  type BulkSelection,
  type RowOutcome,
} from '@/lib/table/bulk';
import { selectionCount, type Selection } from '@/lib/table/selection';
import { cn } from '@/lib/utils';

const OUTCOME_LABEL: Record<RowOutcome, string> = {
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
  unknown: 'Outcome unknown',
  refused: 'Refused',
};

const OUTCOME_TONE: Record<RowOutcome, string> = {
  done: 'text-success',
  skipped: 'text-muted',
  failed: 'text-danger',
  unknown: 'text-warning',
  refused: 'text-danger',
};

/**
 * One bulk action in a table's bulk bar (#870 wave 1 item 2). Asks first, naming how many rows and
 * (optionally) a reason; then runs the server action and shows what happened to EVERY row, the
 * ones that need attention first. The selection is sent as ids or as "all matching these filters";
 * the server resolves it and checks the permission per row. The report stays until it is closed,
 * which also clears the selection.
 */
export function BulkAction({
  label,
  noun,
  selection,
  filters,
  run,
  onClose,
  question,
  reason,
  destructive = false,
}: {
  /** The button: "Publish", "Archive…". */
  label: string;
  /** What a row is: { one: 'product', many: 'products' }. */
  noun: { one: string; many: string };
  selection: Selection;
  filters: Readonly<Record<string, string>>;
  run: (selection: BulkSelection, reason: string) => Promise<ActionResult<BulkReport>>;
  /** Clears the table's selection. */
  onClose: () => void;
  /** The confirmation's question, given the count: "Publish 12 products?". */
  question: (count: number, words: string) => string;
  /** A free-text reason sent with every row (required when given). */
  reason?: { label: string; placeholder?: string };
  destructive?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);
  const [report, setReport] = useState<BulkReport | null>(null);

  const count = selectionCount(selection);
  const words = `${count} ${count === 1 ? noun.one : noun.many}`;

  if (report !== null) {
    const rows = sortForReport(report.results);
    return (
      <div
        role="region"
        aria-label={`${label.replace(/…$/, '')} results`}
        className="border-line bg-surface w-full space-y-2 rounded-md border px-3 py-2"
      >
        <p className="font-medium" role="status">
          {label.replace(/…$/, '')}: {describeReport(report.counts)}
        </p>
        <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
          {rows.map((row) => (
            <li key={row.id} className="flex gap-2">
              <span className={cn('w-28 shrink-0 font-medium', OUTCOME_TONE[row.outcome])}>
                {OUTCOME_LABEL[row.outcome]}
              </span>
              <span className="w-48 shrink-0 truncate" title={row.id}>
                {row.label}
              </span>
              <span className="text-muted">{row.message}</span>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setReport(null);
            onClose();
          }}
        >
          Close
        </Button>
      </div>
    );
  }

  if (!asking) {
    return (
      <Button
        size="sm"
        variant={destructive ? 'secondary' : 'primary'}
        disabled={count === 0}
        onClick={() => {
          setFailure(null);
          setAsking(true);
        }}
      >
        {label}
      </Button>
    );
  }

  const missingReason = reason !== undefined && text.trim() === '';
  return (
    <div
      role="alertdialog"
      aria-label={question(count, words)}
      className={cn(
        'w-full space-y-2 rounded-md border px-3 py-2',
        destructive ? 'border-warning/30 bg-warning/5' : 'border-line bg-surface',
      )}
    >
      <p>{question(count, words)}</p>
      <p className="text-muted text-xs">
        Each {noun.one} is done on its own; the result of every one is shown afterwards. Nothing is
        retried automatically.
      </p>
      {reason !== undefined && (
        <label className="flex flex-col gap-1 text-sm">
          <span>{reason.label}</span>
          <input
            value={text}
            placeholder={reason.placeholder}
            onChange={(event) => setText(event.currentTarget.value)}
            className="border-line bg-surface h-9 rounded-md border px-3"
          />
        </label>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || missingReason}
          onClick={() => {
            if (pending) return;
            startTransition(async () => {
              const result = await run(toBulkSelection(selection, filters), text.trim());
              if (result.status === 'success') {
                setAsking(false);
                setText('');
                setReport(result.data);
                router.refresh();
                return;
              }
              setFailure({ message: result.formError, refusal: result.refusal });
            });
          }}
        >
          {pending ? 'Working…' : `Yes, ${label.replace(/…$/, '').toLowerCase()} ${words}`}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </div>
  );
}
