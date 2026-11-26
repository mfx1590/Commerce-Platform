'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { requestCustomerExportAction } from '@/app/actions/customers';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

/**
 * Requesting a GDPR export. The control holds only ids — no PII — like the erase control beside it.
 *
 * **It asks once before scheduling, and it is not a typed confirmation.** Erasure types a word
 * because it destroys data irreversibly; an export creates a copy of everything held about one
 * person, which is a serious thing to do by accident but an undoable one (the bundle expires and is
 * purged). One deliberate step, with the consequence named, is the proportionate guard — a typed
 * word for both would make the typing meaningless.
 *
 * The contract answers `202` with no body, so success is reported as "scheduled" and the page
 * re-reads to show the new row in the trail.
 */
export function ExportControl({ storeId, customerId }: { storeId: string; customerId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [scheduled, setScheduled] = useState(false);

  if (scheduled) {
    return (
      <p role="status" className="text-success text-sm">
        Export scheduled. It appears in the trail below, and the core says when the bundle is ready.
      </p>
    );
  }

  const request = () => {
    setError(null);
    setRefusal(undefined);
    startTransition(async () => {
      const result = await requestCustomerExportAction(storeId, customerId);
      if (result.status === 'success') {
        setScheduled(true);
        router.refresh();
        return;
      }
      if (result.refusal !== undefined) setRefusal(result.refusal);
      else setError(result.formError ?? 'The export could not be scheduled.');
    });
  };

  return (
    <div className="space-y-3">
      <ActionRefusal refusal={refusal} message={error} />
      {!open ? (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Request a data export
        </Button>
      ) : (
        <div className="space-y-3" role="group" aria-label="Confirm the export request">
          <p className="text-sm">
            This builds a bundle of everything this store holds about this customer — profile,
            addresses, consent and orders. It is kept for a limited time and then purged, and every
            download of it is recorded.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={isPending} onClick={request}>
              Yes, request the export
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
