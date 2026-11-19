'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * "Copy link to this view" (#869 saved views, first step): every filter, the period, the
 * comparison and the currency are in the URL, so the link IS the view — shareable and bookmarkable.
 * Real saved views (named, per user) come later.
 */
export function CopyLink() {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            setSaid('Link copied: it opens this exact view.');
          } catch {
            setSaid('Could not copy: copy the address bar instead; it holds this exact view.');
          }
        }}
      >
        Copy link to this view
      </Button>
      {said !== null && (
        <span role="status" className="text-muted text-xs">
          {said}
        </span>
      )}
    </span>
  );
}
