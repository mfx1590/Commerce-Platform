'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { revokeApiKeyAction, setPrimaryDomainAction } from '@/app/actions/stores';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';

interface Failure {
  message: string | null;
  refusal?: ActionRefusalInfo | undefined;
}

/** Runs one row action and keeps its failure next to the row; success revalidates the list. */
function useRowAction() {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<ActionResult<unknown>>, onSuccess?: () => void) => {
    setFailure(null);
    startTransition(async () => {
      const result = await action();
      if (result.status === 'success') {
        onSuccess?.();
        return;
      }
      setFailure({ message: result.formError, refusal: result.refusal });
    });
  };
  return { failure, pending, run };
}

function RowFailure({ failure }: { failure: Failure | null }) {
  if (failure === null) return null;
  return (
    <div className="basis-full">
      <ActionRefusal refusal={failure.refusal} message={failure.message} />
    </div>
  );
}

/**
 * `updateDomain { is_primary: true }` (owner on hq). One click: moving the primary is reversible
 * by the same button on the old domain, and the core clears the flag there in the same change.
 */
export function MakePrimaryButton({
  storeId,
  domainId,
  hostname,
}: {
  storeId: string;
  domainId: string;
  hostname: string;
}) {
  const { failure, pending, run } = useRowAction();
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        aria-label={`Make ${hostname} primary`}
        onClick={() => run(() => setPrimaryDomainAction(storeId, domainId))}
      >
        {pending ? 'Moving…' : 'Make primary'}
      </Button>
      <RowFailure failure={failure} />
    </>
  );
}

/**
 * `revokeApiKey` (store_admin). Revoking cannot be undone — the key stops working everywhere it is
 * deployed — so the button only opens the question; the confirmation sends. The store's last live
 * publishable key gets no button at all: the core refuses it (409 `last_live_key`), and the list
 * says why instead (`ApiKeyList`).
 */
export function RevokeKeyButton({
  storeId,
  keyId,
  name,
}: {
  storeId: string;
  keyId: string;
  name: string;
}) {
  const [asking, setAsking] = useState(false);
  const { failure, pending, run } = useRowAction();

  if (!asking) {
    return (
      <>
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Revoke ${name}`}
          onClick={() => setAsking(true)}
        >
          Revoke
        </Button>
        <RowFailure failure={failure} />
      </>
    );
  }
  return (
    <div
      role="alertdialog"
      aria-label={`Confirm revoking ${name}`}
      className="border-warning/30 bg-warning/5 basis-full space-y-2 rounded-md border px-3 py-2"
    >
      <p className="text-sm">
        Revoke <span className="font-medium">{name}</span>? Anything using this key stops working at
        once. This cannot be undone.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => revokeApiKeyAction(storeId, keyId),
              () => setAsking(false),
            )
          }
        >
          {pending ? 'Revoking…' : 'Revoke key'}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
      <RowFailure failure={failure} />
    </div>
  );
}
