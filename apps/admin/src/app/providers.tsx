'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';

/**
 * TanStack Query is here for the interactive parts of later screens (data-table refetches in
 * issue #26, optimistic form submits in #27). Data still enters the tree from server components;
 * client components call server actions and route handlers, never the Admin API directly, so no
 * access token ever reaches the browser.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // 401/403 are answers, not outages: retrying them just delays the panel.
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
