'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/form/fields';
import { archiveProductAction, publishProductAction } from '@/app/actions/catalog';
import type { AdminComponents } from '@/lib/api/admin-client';

type Product = AdminComponents['Product'];

const TONE: Record<string, 'success' | 'neutral' | 'warning'> = {
  published: 'success',
  draft: 'neutral',
  archived: 'warning',
};

function formatDate(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Publish and archive.
 *
 * Both render what the server returned rather than what was hoped for: publishing shows the
 * `status` and `published_at` from the response, and archiving re-reads (the contract answers
 * `204`, so there is no product to show). Archive is behind a confirmation because `DELETE` is the
 * verb even though the contract archives rather than hard-deletes.
 */
export function PublishControls({ storeId, product }: { storeId: string; product: Product }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState({
    status: product.status,
    publishedAt: product.published_at,
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const run = (work: () => Promise<{ ok: boolean; message: string | null }>) => {
    setError(null);
    startTransition(async () => {
      const outcome = await work();
      if (!outcome.ok) setError(outcome.message);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={TONE[state.status] ?? 'neutral'}>{state.status}</Badge>
        <span className="text-muted">
          Published: <span className="font-mono text-xs">{formatDate(state.publishedAt)}</span>
        </span>
      </div>

      <FormError message={error} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={isPending || state.status === 'published' || state.status === 'archived'}
          onClick={() =>
            run(async () => {
              const result = await publishProductAction(storeId, product.id);
              if (result.status === 'success') {
                setState({
                  status: result.data.status,
                  publishedAt: result.data.published_at,
                });
                router.refresh();
                return { ok: true, message: null };
              }
              return { ok: false, message: result.formError ?? 'Could not publish this product.' };
            })
          }
        >
          {state.status === 'published' ? 'Published' : 'Publish'}
        </Button>

        {confirmingArchive ? (
          <>
            <span className="text-sm">Archive this product?</span>
            <Button
              variant="danger"
              size="sm"
              disabled={isPending}
              onClick={() =>
                run(async () => {
                  const result = await archiveProductAction(storeId, product.id);
                  setConfirmingArchive(false);
                  if (result.status === 'success') {
                    // 204: nothing came back, so re-read rather than guessing the new state.
                    setState({ status: 'archived', publishedAt: state.publishedAt });
                    router.refresh();
                    return { ok: true, message: null };
                  }
                  return {
                    ok: false,
                    message: result.formError ?? 'Could not archive this product.',
                  };
                })
              }
            >
              Yes, archive
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmingArchive(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            disabled={isPending || state.status === 'archived'}
            onClick={() => setConfirmingArchive(true)}
          >
            {state.status === 'archived' ? 'Archived' : 'Archive'}
          </Button>
        )}
      </div>
    </div>
  );
}
