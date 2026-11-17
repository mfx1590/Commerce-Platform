'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';
import { csvFileName, EXPORT_CAP } from '@/lib/table/csv';

/**
 * Saves `csv` as a file in the browser. A UTF-8 byte-order mark first, so a spreadsheet opens
 * accents and non-Latin text (product titles in ja-JP) correctly.
 */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

interface Exported {
  csv: string;
  exported: number;
  total: number;
  truncated: boolean;
}

/**
 * "Export CSV" of a table's current filtered and sorted list (#870 wave 1 item 2). The cap is on
 * the button; afterwards it says how many rows the file holds, and when the filter matched more,
 * that the file has the first ones in this order.
 */
export function ExportCsvButton({
  what,
  run,
}: {
  /** The file name's stem: `orders`, `catalog`. */
  what: string;
  run: () => Promise<ActionResult<Exported>>;
}) {
  const [pending, startTransition] = useTransition();
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          if (pending) return;
          setSaid(null);
          setFailure(null);
          startTransition(async () => {
            let result: Awaited<ReturnType<typeof run>>;
            try {
              result = await run();
            } catch {
              setFailure({
                message: 'The export did not come back. Try again; nothing was changed.',
              });
              return;
            }
            if (result.status !== 'success') {
              setFailure({ message: result.formError, refusal: result.refusal });
              return;
            }
            const { csv, exported, total, truncated } = result.data;
            downloadCsv(csvFileName(what), csv);
            setSaid(
              truncated
                ? `Exported the first ${exported} of ${total} rows in this order (the cap is ${EXPORT_CAP.toLocaleString('en')}). Narrow the filter for the rest.`
                : `Exported ${exported} ${exported === 1 ? 'row' : 'rows'}.`,
            );
          });
        }}
      >
        {pending ? 'Exporting…' : `Export CSV (up to ${EXPORT_CAP.toLocaleString('en')} rows)`}
      </Button>
      {said !== null && (
        <p role="status" className="text-muted text-xs">
          {said}
        </p>
      )}
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </div>
  );
}
