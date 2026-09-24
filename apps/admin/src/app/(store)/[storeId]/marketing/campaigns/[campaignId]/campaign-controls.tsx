'use client';

import { useState } from 'react';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

/**
 * Launch / end for one campaign.
 *
 * The actions arrive **already bound** (`action.bind(null, storeId, campaignId)`) from the server component:
 * an arrow wrapper does not cross the server/client boundary (Memory-main global gotchas), so the binding
 * happens on the server side and this component receives a zero-argument callable.
 *
 * A refusal renders `ActionRefusal` in place rather than throwing: the server decides, and being told which
 * relation you need is more useful than a disabled button with no explanation.
 */
export function CampaignControls({
  status,
  canLaunch,
  canEnd,
  launch,
  end,
}: {
  status: string;
  canLaunch: boolean;
  canEnd: boolean;
  launch: () => Promise<{ status: 'success' | 'error'; refusal?: ActionRefusalInfo }>;
  end: () => Promise<{ status: 'success' | 'error'; refusal?: ActionRefusalInfo }>;
}) {
  const [refusal, setRefusal] = useState<ActionRefusalInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function run(
    action: () => Promise<{ status: 'success' | 'error'; refusal?: ActionRefusalInfo }>,
  ) {
    setRefusal(null);
    setProblem(null);
    const result = await action();
    if (result.status === 'error') {
      if (result.refusal) setRefusal(result.refusal);
      // A 409 is not a refusal about who you are: the campaign moved on while the page was open.
      else setProblem('That is no longer possible — reload to see the campaign as it stands.');
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <form action={() => run(launch)}>
          <Button size="sm" type="submit" disabled={!canLaunch}>
            Launch
          </Button>
        </form>
        <form action={() => run(end)}>
          <Button size="sm" variant="secondary" type="submit" disabled={!canEnd}>
            End
          </Button>
        </form>
        <span className="text-muted text-xs">
          {canLaunch || canEnd ? null : `A campaign in status ${status} has no next step.`}
        </span>
      </div>
      <ActionRefusal refusal={refusal ?? undefined} message={problem} />
    </div>
  );
}
