'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  bulkCaptureAction,
  previewBulkCaptureAction,
  type CapturePreview,
} from '@/app/actions/bulk-capture';
import { ActionRefusal } from '@/components/states/action-refusal';
import { BulkReportPanel, OutcomeUnknownPanel } from '@/components/table/bulk-action';
import { Button } from '@/components/ui/button';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { BULK_CAPTURE_CAP, describeTotals } from '@/lib/orders/bulk-capture';
import type { BulkReport } from '@/lib/table/bulk';
import type { Selection } from '@/lib/table/selection';

const NOUN = { one: 'order', many: 'orders' };

/**
 * "Capture…" in the orders bulk bar (#870 wave 1 item 2, the money PR). Ticked orders only, at
 * most 100 — never "all matching". First a preview (reads only): what each order would capture
 * and the totals per currency. Then the capturable count, typed, and the capture of exactly the
 * amounts shown; a row whose amount changed meanwhile is not captured. Every row is reported; a
 * run that never comes back is "outcome unknown" and is not retried.
 */
export function BulkCapture({
  storeId,
  locale,
  selection,
  onClose,
}: {
  storeId: string;
  locale: string;
  selection: Selection;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<CapturePreview | null>(null);
  const [typed, setTyped] = useState('');
  const [report, setReport] = useState<BulkReport | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);

  if (selection.mode === 'all-matching') {
    return (
      <span className="text-muted text-xs">
        Capture works on ticked orders only (at most {BULK_CAPTURE_CAP}), not on all matching.
      </span>
    );
  }
  const ids = [...selection.ids];
  if (ids.length > BULK_CAPTURE_CAP) {
    return (
      <span className="text-muted text-xs">
        Capture takes at most {BULK_CAPTURE_CAP} ticked orders ({ids.length} are ticked).
      </span>
    );
  }

  const close = () => {
    setPreview(null);
    setReport(null);
    setUnknown(false);
    setTyped('');
    onClose();
  };

  if (unknown) return <OutcomeUnknownPanel label="Capture…" noun={NOUN} onClose={close} />;
  if (report !== null) {
    return <BulkReportPanel label="Capture…" noun={NOUN} report={report} onClose={close} />;
  }

  if (preview === null) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          disabled={pending || ids.length === 0}
          onClick={() => {
            if (pending) return;
            setFailure(null);
            startTransition(async () => {
              try {
                const result = await previewBulkCaptureAction(storeId, ids, locale);
                if (result.status === 'success') {
                  setTyped('');
                  setPreview(result.data);
                  return;
                }
                setFailure({ message: result.formError, refusal: result.refusal });
              } catch {
                // A preview only reads: nothing changed, it can simply be asked again.
                setFailure({ message: 'The preview did not come back. Nothing was captured.' });
              }
            });
          }}
        >
          {pending ? 'Previewing…' : 'Capture…'}
        </Button>
        <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      </div>
    );
  }

  const count = preview.capturable;
  const notCaptured = preview.rows.length - count;
  const unconfirmed = typed.trim() !== String(count);
  const question = `Capture ${count} ${count === 1 ? NOUN.one : NOUN.many}?`;

  return (
    <div
      role="alertdialog"
      aria-label={question}
      className="border-warning/30 bg-warning/5 w-full space-y-2 rounded-md border px-3 py-2 text-sm"
    >
      <p className="font-medium">{question}</p>
      {count > 0 ? (
        <p aria-label="Total to capture">
          Total to capture: <strong>{describeTotals(preview.totals, locale)}</strong> — exactly{' '}
          {count} ticked {count === 1 ? NOUN.one : NOUN.many}, each at most its authorisation.
        </p>
      ) : (
        <p>None of the ticked orders can be captured.</p>
      )}
      {notCaptured > 0 && (
        <p className="text-muted">
          {notCaptured} {notCaptured === 1 ? 'order is' : 'orders are'} not captured (the reason is
          below).
        </p>
      )}
      <ul
        className="max-h-48 space-y-1 overflow-y-auto text-xs"
        aria-label="What each order captures"
      >
        {preview.rows.map((row) => (
          <li key={row.id} className="flex gap-2">
            <span className="w-20 shrink-0 font-medium">{row.label}</span>
            <span className={row.capturable ? '' : 'text-muted'}>{row.message}</span>
          </li>
        ))}
      </ul>
      {count > 0 && (
        <label className="flex flex-col gap-1">
          <span>
            Money moves and there is no undo here. Type <strong>{count}</strong> to confirm.
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
        {count > 0 && (
          <Button
            size="sm"
            disabled={pending || unconfirmed}
            onClick={() => {
              if (pending) return;
              const confirmed = preview.rows
                .filter((row) => row.capturable)
                .map((row) => ({
                  id: row.id,
                  amountMinor: row.amountMinor!,
                  currency: row.currency!,
                }));
              startTransition(async () => {
                try {
                  const result = await bulkCaptureAction(storeId, confirmed, locale);
                  if (result.status === 'success') {
                    setReport(result.data);
                    router.refresh();
                    return;
                  }
                  setFailure({ message: result.formError, refusal: result.refusal });
                } catch {
                  // Some captures may have gone through: never retried, the person checks first.
                  setUnknown(true);
                  router.refresh();
                }
              });
            }}
          >
            {pending ? 'Capturing…' : `Yes, capture ${describeTotals(preview.totals, locale)}`}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setPreview(null);
            setTyped('');
          }}
        >
          Cancel
        </Button>
      </div>
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </div>
  );
}
