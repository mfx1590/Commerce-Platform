'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { eraseCustomerAction } from '@/app/actions/customers';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

const CONFIRMATION = 'ERASE';

/**
 * GDPR erasure. Irreversible, so the confirmation is typed rather than clicked; the control holds
 * only ids (no PII). The contract answers `202` with no body, so success is reported as
 * "scheduled" and the page re-reads to show `status: erased`.
 */
export function EraseControl({ storeId, customerId }: { storeId: string; customerId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [scheduled, setScheduled] = useState(false);

  if (scheduled) {
    return (
      <p role="status" className="text-success text-sm">
        Erasure scheduled. The record shows as erased once the core has processed it.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ActionRefusal refusal={refusal} message={error} />
      {!open ? (
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
          Erase this customer
        </Button>
      ) : (
        <form
          className="space-y-3"
          aria-label="Confirm erasure"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed !== CONFIRMATION) return;
            setError(null);
            setRefusal(undefined);
            startTransition(async () => {
              const result = await eraseCustomerAction(storeId, customerId);
              if (result.status === 'success') {
                setScheduled(true);
                router.refresh();
                return;
              }
              setRefusal(result.refusal);
              setError(
                result.refusal === undefined
                  ? (result.formError ?? 'Could not schedule the erasure.')
                  : null,
              );
            });
          }}
        >
          <p className="text-sm">
            This anonymises the customer&apos;s personal data and cannot be undone. Type{' '}
            <code className="text-xs">{CONFIRMATION}</code> to confirm.
          </p>
          <TextField
            label="Confirmation"
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={isPending || typed !== CONFIRMATION}
            >
              Yes, erase
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setOpen(false);
                setTyped('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
