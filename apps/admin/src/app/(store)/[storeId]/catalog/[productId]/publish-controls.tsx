'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import { archiveProductAction, publishProductAction } from '@/app/actions/catalog';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';

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

type Confirming = 'publish' | 'archive' | null;

/**
 * Publish and archive.
 *
 * Both render what the server returned rather than what was hoped for: publishing shows the
 * `status` and `published_at` from the response, and archiving re-reads (the contract answers
 * `204`, so there is no product to show).
 *
 * **Both are behind a confirmation.** Archive always was, because `DELETE` is the verb. Publishing
 * earns one for a different reason: it emits `product.published` on the bus, so it is the moment a
 * product becomes visible to shoppers and downstream consumers act on it. That is not something to
 * do by mis-clicking a button that sits next to Archive.
 *
 * A refusal (401/403) renders the state panel rather than a line of red text — being told "you need
 * `store_staff` on this store" is a different thing from being told a field is wrong.
 */
export function PublishControls({ storeId, product }: { storeId: string; product: Product }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState({
    status: product.status,
    publishedAt: product.published_at,
  });
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [confirming, setConfirming] = useState<Confirming>(null);

  /** Runs one mutation, then renders whatever came back — never an assumed outcome. */
  const run = <T,>(
    work: () => Promise<ActionResult<T>>,
    apply: (data: T) => void,
    fallback: string,
  ) => {
    setError(null);
    setRefusal(undefined);
    startTransition(async () => {
      const result = await work();
      setConfirming(null);
      if (result.status === 'success') {
        apply(result.data);
        router.refresh();
        return;
      }
      setRefusal(result.refusal);
      setError(result.refusal === undefined ? (result.formError ?? fallback) : null);
    });
  };

  const publish = () =>
    run(
      () => publishProductAction(storeId, product.id),
      (data: Product) => setState({ status: data.status, publishedAt: data.published_at }),
      'Could not publish this product.',
    );

  const archive = () =>
    run(
      () => archiveProductAction(storeId, product.id),
      // 204: nothing came back, so `router.refresh()` re-reads rather than this guessing.
      () => setState((current) => ({ ...current, status: 'archived' })),
      'Could not archive this product.',
    );

  const published = state.status === 'published';
  const archived = state.status === 'archived';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={TONE[state.status] ?? 'neutral'}>{state.status}</Badge>
        <span className="text-muted">
          Published: <span className="font-mono text-xs">{formatDate(state.publishedAt)}</span>
        </span>
      </div>

      <ActionRefusal refusal={refusal} message={error} />

      <div className="flex flex-wrap items-center gap-2">
        {confirming === 'publish' ? (
          <>
            <span className="text-sm">
              Publish this product? It becomes visible to shoppers and emits{' '}
              <code className="text-xs">product.published</code>.
            </span>
            <Button size="sm" disabled={isPending} onClick={publish}>
              Yes, publish
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </>
        ) : confirming === 'archive' ? (
          <>
            <span className="text-sm">Archive this product?</span>
            <Button variant="danger" size="sm" disabled={isPending} onClick={archive}>
              Yes, archive
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={isPending || published || archived}
              onClick={() => setConfirming('publish')}
            >
              {published ? 'Published' : 'Publish'}
            </Button>
            <Button
              variant="secondary"
              disabled={isPending || archived}
              onClick={() => setConfirming('archive')}
            >
              {archived ? 'Archived' : 'Archive'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
