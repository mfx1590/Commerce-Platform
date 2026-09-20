'use client';

import { useState, useTransition } from 'react';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

/**
 * Publish one feed. The action arrives already bound from the server component (global gotcha: `.bind`, not an
 * arrow wrapper, for anything crossing the boundary).
 *
 * A 409 here means the channel has no writer yet — the message says so rather than showing a generic failure,
 * because "TikTok is not supported" and "publishing broke" are different problems for the person reading.
 */
export function PublishControl({
  renderable,
  publish,
}: {
  renderable: boolean;
  publish: () => Promise<{ status: 'success' | 'error'; refusal?: ActionRefusalInfo }>;
}) {
  const [refusal, setRefusal] = useState<ActionRefusalInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!renderable || isPending}
          onClick={() =>
            startTransition(async () => {
              setRefusal(null);
              setMessage(null);
              const result = await publish();
              if (result.status === 'error') {
                if (result.refusal) setRefusal(result.refusal);
                else
                  setMessage(
                    'This feed could not be published. Its channel may have no writer yet.',
                  );
              } else {
                setMessage('Published. The file is regenerated only when its contents changed.');
              }
            })
          }
        >
          {isPending ? 'Publishing…' : 'Publish now'}
        </Button>
        {renderable ? null : (
          <span className="text-muted text-xs">
            This channel has no writer yet, so publishing would be refused.
          </span>
        )}
      </div>
      <ActionRefusal refusal={refusal ?? undefined} message={message} />
    </div>
  );
}
