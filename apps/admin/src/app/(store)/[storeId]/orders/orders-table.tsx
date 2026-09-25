'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/table/data-table';
import type { AdminError } from '@/lib/api/admin-client';
import { formatMoney } from '@/lib/forms/money';
import type { OrderRow } from '@/lib/orders/projection';
import type { TableQuery } from '@/lib/table/query-state';
import {
  ORDERS_SORTABLE_COLUMNS,
  ORDERS_TABLE_DEFAULTS,
  statusLabel,
  toneFor,
} from './orders-table.config';

function formatPlaced(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      date,
    );
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * The orders list. Money arrives as `{ amount_minor, currency }` and is rendered with the store's
 * locale — never a float in between. Each of the three statuses is a pill with its name.
 */
export function OrdersTable({
  storeId,
  locale,
  rows,
  total,
  query,
  emptyState,
  error,
}: {
  storeId: string;
  /** The store's `default_locale`, for money and dates. */
  locale: string;
  /** `OrderRow` projections — the columns shown, without the `customer_id` the table never renders. */
  rows: readonly OrderRow[];
  total: number;
  query: TableQuery;
  emptyState?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const columns: ColumnDef<OrderRow, unknown>[] = [
    {
      id: 'display_id',
      header: 'Order',
      accessorKey: 'display_id',
      cell: ({ row }) => (
        <Link
          href={`/${storeId}/orders/${row.original.id}`}
          className="text-accent font-mono hover:underline"
        >
          #{row.original.display_id}
        </Link>
      ),
    },
    {
      id: 'email',
      header: 'Customer',
      accessorKey: 'email',
      cell: ({ row }) => <span className="text-sm">{row.original.email}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      cell: ({ row }) => (
        <Badge tone={toneFor(row.original.status)}>{statusLabel(row.original.status)}</Badge>
      ),
    },
    {
      id: 'payment_status',
      header: 'Payment',
      cell: ({ row }) => (
        <Badge tone={toneFor(row.original.payment_status)}>
          {statusLabel(row.original.payment_status)}
        </Badge>
      ),
    },
    {
      id: 'fulfillment_status',
      header: 'Fulfilment',
      cell: ({ row }) => (
        <Badge tone={toneFor(row.original.fulfillment_status)}>
          {statusLabel(row.original.fulfillment_status)}
        </Badge>
      ),
    },
    {
      id: 'total',
      header: 'Total',
      cell: ({ row }) => (
        <span className="block text-right font-mono">
          {formatMoney(row.original.total.amount_minor, row.original.total.currency, locale)}
        </span>
      ),
    },
    {
      id: 'placed_at',
      header: 'Placed',
      accessorKey: 'placed_at',
      cell: ({ row }) => (
        <span className="text-muted">{formatPlaced(row.original.placed_at, locale)}</span>
      ),
    },
  ];

  return (
    <DataTable<OrderRow>
      columns={columns}
      rows={rows}
      total={total}
      query={query}
      defaults={ORDERS_TABLE_DEFAULTS}
      getRowId={(order) => order.id}
      caption="Orders"
      sortableColumns={ORDERS_SORTABLE_COLUMNS}
      searchKey="q"
      searchPlaceholder="Order number or email"
      emptyState={emptyState}
      error={error}
    />
  );
}
