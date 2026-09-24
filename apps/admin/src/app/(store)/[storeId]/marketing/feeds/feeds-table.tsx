'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DataTable } from '@/components/table/data-table';
import { Badge } from '@/components/ui/badge';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import type { TableQuery } from '@/lib/table/query-state';
import { CHANNEL_LABEL, FEEDS_TABLE_DEFAULTS, FEED_STATUS_TONE } from './feeds-table.config';

type ProductFeed = AdminComponents['ProductFeed'];

export function FeedsTable({
  storeId,
  rows,
  total,
  query,
  emptyAction,
  error,
}: {
  storeId: string;
  rows: readonly ProductFeed[];
  total: number;
  query: TableQuery;
  emptyAction?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const columns: ColumnDef<ProductFeed, unknown>[] = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      cell: ({ row }) => (
        <Link
          href={`/${storeId}/marketing/feeds/${row.original.id}`}
          className="text-accent hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: 'channel',
      header: 'Channel',
      accessorKey: 'channel',
      cell: ({ row }) => (
        <span className="text-xs">
          {CHANNEL_LABEL[row.original.channel] ?? row.original.channel}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      cell: ({ row }) => (
        <Badge tone={FEED_STATUS_TONE[row.original.status] ?? 'neutral'}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: 'item_count',
      header: 'Items',
      accessorKey: 'item_count',
      cell: ({ row }) => <span className="font-mono tabular-nums">{row.original.item_count}</span>,
    },
    {
      id: 'errors',
      header: 'Problems',
      // The count, not the messages: a feed with 120 items and 120 GTIN advisories is healthy, and the detail
      // page is where the reasons belong.
      cell: ({ row }) =>
        row.original.errors.length === 0 ? (
          <span className="text-muted text-xs">none</span>
        ) : (
          <span className="text-warning font-mono text-xs tabular-nums">
            {row.original.errors.length}
          </span>
        ),
    },
    {
      id: 'last_published_at',
      header: 'Published',
      accessorKey: 'last_published_at',
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.last_published_at === null
            ? 'never'
            : row.original.last_published_at.slice(0, 10)}
        </span>
      ),
    },
  ];

  return (
    <DataTable<ProductFeed>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      defaults={FEEDS_TABLE_DEFAULTS}
      getRowId={(row) => row.id}
      caption="Product feeds"
      {...(emptyAction === undefined ? {} : { emptyAction })}
      {...(error === undefined ? {} : { error })}
    />
  );
}
