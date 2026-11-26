'use client';

import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { BulkAction } from '@/components/table/bulk-action';
import { DataTable } from '@/components/table/data-table';
import { useTermSearch } from '@/components/table/use-term-search';
import { searchOrdersAction } from '@/app/actions/search-lists';
import { bulkCancelOrdersAction } from '@/app/actions/bulk-orders';
import { BulkCapture } from './bulk-capture';
import { exportOrdersCsvAction } from '@/app/actions/export-lists';
import { ExportCsvButton } from '@/components/table/export-csv';
import type { FilterNames } from '@/lib/table/bulk';
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
 *
 * #946: the "Order number or email" search is POST-backed (`searchOrdersAction`): the term never enters
 * the URL. Bulk Cancel and the CSV export get the EFFECTIVE filters, the term included, in their POST
 * bodies, so "all matching" and the exported file mean what the table shows, not the unsearched list.
 */
export function OrdersTable({
  storeId,
  locale,
  rows,
  total,
  query,
  emptyState,
  error,
  canCancel = false,
  canCapture = false,
}: {
  storeId: string;
  /** Offer bulk Cancel (store_admin). A convenience: the server decides, per row. */
  canCancel?: boolean;
  /** Offer bulk Capture (store_admin): ticked orders only, at most 100. The server decides. */
  canCapture?: boolean;
  /** The store's `default_locale`, for money and dates. */
  locale: string;
  /** `OrderRow` projections — the columns shown, without the `customer_id` the table never renders. */
  rows: readonly OrderRow[];
  total: number;
  query: TableQuery;
  emptyState?: ReactNode;
  error?: { status: number; error: AdminError } | undefined;
}) {
  const search = useTermSearch<OrderRow>({
    query,
    run: (term, request) => searchOrdersAction(storeId, term, request),
  });
  const shown = search.query;
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

  const day = (value: string) => value.slice(0, 10);
  const filterNames: FilterNames = {
    q: { label: 'Search' },
    status: { label: 'Status', value: statusLabel },
    payment_status: { label: 'Payment', value: statusLabel },
    fulfillment_status: { label: 'Fulfilment', value: statusLabel },
    placed_from: { label: 'Placed from', value: day },
    placed_to: { label: 'Placed to', value: day },
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportCsvButton
          what="orders"
          run={() =>
            exportOrdersCsvAction(
              storeId,
              { ...shown.filters },
              { sort: shown.sort, order: shown.order },
            )
          }
        />
      </div>
      <DataTable<OrderRow>
        columns={columns}
        rows={search.rows ?? rows}
        total={search.total ?? total}
        query={shown}
        defaults={ORDERS_TABLE_DEFAULTS}
        getRowId={(order) => order.id}
        caption="Orders"
        sortableColumns={ORDERS_SORTABLE_COLUMNS}
        searchKey="q"
        searchPlaceholder="Order number or email"
        termSearch={search.control}
        emptyState={emptyState}
        error={search.control.term === null ? error : search.error}
        {...(canCancel || canCapture
          ? {
              bulkActions: (selection, { clear }) => (
                <>
                  {canCapture && (
                    <BulkCapture
                      storeId={storeId}
                      locale={locale}
                      selection={selection}
                      onClose={clear}
                    />
                  )}
                  {canCancel && (
                    <BulkAction
                      label="Cancel…"
                      noun={{ one: 'order', many: 'orders' }}
                      selection={selection}
                      filters={shown.filters}
                      filterNames={filterNames}
                      run={(sent, reason) => bulkCancelOrdersAction(storeId, sent, reason)}
                      onClose={clear}
                      destructive
                      reason={{
                        label: 'Reason (sent with every order)',
                        placeholder: 'e.g. out of stock',
                      }}
                      question={(_, words) =>
                        `Cancel ${words}? An authorised payment is voided. A payment already CAPTURED is NOT refunded by cancelling: those orders are marked "refund needed" in the results — download them as your refund list. Orders already cancelled are left as they are; the API refuses orders it can no longer cancel.`
                      }
                    />
                  )}
                </>
              ),
            }
          : {})}
      />
    </div>
  );
}
