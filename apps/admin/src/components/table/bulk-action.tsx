'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';
import { downloadCsv } from '@/components/table/export-csv';
import {
  describeFilters,
  describeReport,
  sortForReport,
  toBulkSelection,
  type BulkReport,
  type BulkSelection,
  type FilterNames,
  type RowOutcome,
} from '@/lib/table/bulk';
import { csvFileName, reportCsv } from '@/lib/table/csv';
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
  filterNames,
}: {
  /** How the table names its filters, for "every one matching Status: draft · Category: Kitchen". */
  filterNames?: FilterNames;
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
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);
  const [report, setReport] = useState<BulkReport | null>(null);
  const [unknown, setUnknown] = useState(false);

  const count = selectionCount(selection);
  const words = `${count} ${count === 1 ? noun.one : noun.many}`;

  if (unknown) {
    return (
      <OutcomeUnknownPanel
        label={label}
        noun={noun}
        onClose={() => {
          setUnknown(false);
          onClose();
        }}
      />
    );
  }

  if (report !== null) {
    return (
      <BulkReportPanel
        label={label}
        noun={noun}
        report={report}
        onClose={() => {
          setReport(null);
          onClose();
        }}
      />
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
          setTyped('');
          setAsking(true);
        }}
      >
        {label}
      </Button>
    );
  }

  const missingReason = reason !== undefined && text.trim() === '';
  // No undo (archive has no unarchive; a cancelled order stays cancelled): the count, typed.
  const unconfirmed = destructive && typed.trim() !== String(count);
  const scope = describeFilters(filters, filterNames);
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
      <p className="text-sm" aria-label="What this acts on">
        {selection.mode === 'rows' ? (
          <>
            Exactly <strong>{words}</strong>: the ones ticked.
          </>
        ) : (
          <>
            Exactly <strong>{words}</strong>: every one matching{' '}
            {scope === '' ? <strong>no filter (the whole list)</strong> : <strong>{scope}</strong>}
            {selection.excluded.size > 0 && `, except the ${selection.excluded.size} unticked`}. If
            that list has changed by the time it runs, nothing is done and you are told.
          </>
        )}
      </p>
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
      {destructive && (
        <label className="flex flex-col gap-1 text-sm">
          <span>
            There is no undo. Type <strong>{count}</strong> to confirm.
          </span>
          <input
            value={typed}
            inputMode="numeric"
            aria-label={`Type ${count} to confirm`}
            onChange={(event) => setTyped(event.currentTarget.value)}
            className="border-line bg-surface h-9 w-28 rounded-md border px-3"
          />
        </label>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || missingReason || unconfirmed}
          onClick={() => {
            if (pending) return;
            startTransition(async () => {
              let result: Awaited<ReturnType<typeof run>>;
              try {
                result = await run(toBulkSelection(selection, filters), text.trim());
              } catch {
                // The request failed in flight (network, a crashed action): some rows may have been
                // done. Never retried (no idempotency key) — the person checks first (#904 review).
                setAsking(false);
                setUnknown(true);
                router.refresh();
                return;
              }
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

/**
 * A bulk run that never came back (network, a crashed action): some rows may have been done.
 * Nothing is retried — no Admin API mutation takes an idempotency key; the person checks first.
 */
export function OutcomeUnknownPanel({
  label,
  noun,
  onClose,
}: {
  label: string;
  noun: { one: string; many: string };
  onClose: () => void;
}) {
  return (
    <div
      role="alert"
      className="border-warning/30 bg-warning/5 w-full space-y-2 rounded-md border px-3 py-2"
    >
      <p className="font-medium">
        {label.replace(/…$/, '')}: outcome unknown — the request did not come back.
      </p>
      <p className="text-sm">
        Some {noun.many} may have been changed. Reload the list and check them before running it
        again; nothing is retried automatically.
      </p>
      <Button size="sm" variant="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

/** Every row's result, what needs attention first, downloadable as CSV for the follow-up. */
export function BulkReportPanel({
  label,
  noun,
  report,
  onClose,
}: {
  label: string;
  noun: { one: string; many: string };
  report: BulkReport;
  onClose: () => void;
}) {
  const name = label.replace(/…$/, '');
  const rows = sortForReport(report.results);
  return (
    <div
      role="region"
      aria-label={`${name} results`}
      className="border-line bg-surface w-full space-y-2 rounded-md border px-3 py-2"
    >
      <p className="font-medium" role="status">
        {name}: {describeReport(report.counts)}
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
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            downloadCsv(
              csvFileName(`${noun.many}-${name.toLowerCase()}-results`),
              reportCsv(report.results),
            )
          }
        >
          Download results (CSV)
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
