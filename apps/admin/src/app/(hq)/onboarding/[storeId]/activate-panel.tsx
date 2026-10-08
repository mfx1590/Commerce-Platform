'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { activateStoreAction } from '@/app/actions/stores';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { MISSING_LABELS } from '@/lib/onboarding';

/**
 * The readiness panel's Activate (`activateStore`, owner on hq). What is missing is exactly what
 * the core says in the 409's `details.missing` — the panel lists that, no guess of its own; an
 * empty list is an activation.
 */
export function ActivatePanel({ storeId, status }: { storeId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [missing, setMissing] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);

  if (status === 'active') {
    return (
      <p role="status" className="text-success text-sm">
        Active — the store is live.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {missing !== null && missing.length > 0 && (
        <div
          role="alert"
          className="border-warning/30 bg-warning/5 rounded-md border px-3 py-2 text-sm"
        >
          <p className="font-medium">Not ready to activate. Missing:</p>
          <ul className="list-disc pl-5" aria-label="Missing prerequisites">
            {missing.map((item) => (
              <li key={item}>{MISSING_LABELS[item] ?? item}</li>
            ))}
          </ul>
        </div>
      )}
      <ActionRefusal
        refusal={failure?.refusal}
        message={missing === null ? (failure?.message ?? null) : null}
      />
      <Button
        disabled={pending}
        onClick={() => {
          setFailure(null);
          startTransition(async () => {
            const result = await activateStoreAction(storeId);
            if (result.status === 'success') {
              setMissing(null);
              router.refresh();
              return;
            }
            setMissing(result.missing ?? null);
            setFailure({ message: result.formError, refusal: result.refusal });
          });
        }}
      >
        {pending ? 'Activating…' : 'Activate'}
      </Button>
    </div>
  );
}
