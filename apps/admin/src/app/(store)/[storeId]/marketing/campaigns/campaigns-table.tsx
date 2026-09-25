'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DataTable } from '@/components/table/data-table';
import { Badge } from '@/components/ui/badge';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import { formatMoney } from '@/lib/forms/money';
import type { TableQuery } from '@/lib/table/query-state';
import {
  CAMPAIGNS_SORTABLE_COLUMNS,
  CAMPAIGNS_TABLE_DEFAULTS,
  CAMPAIGN_STATUS_TONE,
} from './campaigns-table.config';

type Campaign = AdminComponents['Campaign'];

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

export function CampaignsTable({
  storeId,
  rows,
  total,
  query,
  emptyAction,
  error,
}: {
  storeId: string;
  rows: readonly Campaign[];
  total: number;
  query: TableQuery;
  emptyAction?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const columns: ColumnDef<Campaign, unknown>[] = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      cell: ({ row }) => (
        <Link
          href={`/${storeId}/marketing/campaigns/${row.original.id}`}
          className="text-accent hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      accessorKey: 'type',
      cell: ({ row }) => <span className="text-xs">{row.original.type.replace('_', ' ')}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      cell: ({ row }) => (
        <Badge tone={CAMPAIGN_STATUS_TONE[row.original.status] ?? 'neutral'}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: 'utm_campaign',
      header: 'utm_campaign',
      accessorKey: 'utm_campaign',
      // This is the string the attribution report matches on, so it earns a column: a campaign with none
      // will never be credited with an order, and that is invisible anywhere else.
      cell: ({ row }) =>
        row.original.utm_campaign === null || row.original.utm_campaign === undefined ? (
          <span className="text-muted text-xs">not linked</span>
        ) : (
          <span className="font-mono text-xs">{row.original.utm_campaign}</span>
        ),
    },
    {
      id: 'budget',
      header: 'Budget',
      cell: ({ row }) => {
        const budget = row.original.budget;
        return (
          <span className="font-mono text-xs tabular-nums">
            {budget === null || budget === undefined
              ? '—'
              : formatMoney(budget.amount_minor, budget.currency)}
          </span>
        );
      },
    },
    {
      id: 'starts_at',
      header: 'Starts',
      accessorKey: 'starts_at',
      cell: ({ row }) => (
        <span className="font-mono text-xs">{formatDate(row.original.starts_at)}</span>
      ),
    },
  ];

  return (
    <DataTable<Campaign>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      defaults={CAMPAIGNS_TABLE_DEFAULTS}
      getRowId={(row) => row.id}
      caption="Campaigns"
      sortableColumns={CAMPAIGNS_SORTABLE_COLUMNS}
      {...(emptyAction === undefined ? {} : { emptyAction })}
      {...(error === undefined ? {} : { error })}
    />
  );
}
