'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { bulkRulesAction, publishRulesAction } from '@/app/actions/merchandising';
import { ActionRefusal } from '@/components/states/action-refusal';
import { BulkAction } from '@/components/table/bulk-action';
import { downloadCsv } from '@/components/table/export-csv';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  filterRules,
  publishPreview,
  RULE_STATE_LABEL,
  RULES_CSV_HEADER,
  ruleCsvRow,
  ruleState,
  scopeLabel,
  sortRules,
  unpublishedChange,
  type MerchandisingRule,
  type PublishReport,
  type RuleState,
} from '@/lib/catalog/merchandising';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import type { FilterNames } from '@/lib/table/bulk';
import { csvFileName, toCsv } from '@/lib/table/csv';
import {
  EMPTY_SELECTION,
  isPageFullySelected,
  isRowSelected,
  togglePage,
  toggleRow,
  type Selection,
} from '@/lib/table/selection';
import { RuleEditor } from './rule-editor';

/** A product a rule names: its title and status, or `missing` (deleted / not in this store). */
export interface ProductRef {
  title: string | null;
  status: string;
}

const STATE_TONE: Record<RuleState, 'success' | 'neutral' | 'warning'> = {
  live: 'success',
  disabled: 'neutral',
  scheduled: 'neutral',
  ended: 'warning',
};

const control = 'border-line bg-surface h-9 rounded-md border px-2 text-sm';

function day(value: string | null): string {
  return value === null ? '—' : value.slice(0, 16).replace('T', ' ');
}

/** The rule's products a shopper would not see as intended: deleted, archived or draft. */
export function productTrouble(
  rule: MerchandisingRule,
  products: Readonly<Record<string, ProductRef>>,
): string | null {
  const ids = [...rule.pins, ...rule.boosts.map((b) => b.product_id), ...rule.buries];
  const missing = ids.filter((id) => products[id]?.status === 'missing').length;
  const hidden = ids.filter((id) => {
    const status = products[id]?.status;
    return status === 'archived' || status === 'draft';
  }).length;
  const parts = [
    missing > 0
      ? `${missing} product${missing === 1 ? ' no longer exists' : 's no longer exist'}`
      : null,
    hidden > 0 ? `${hidden} not published (draft or archived)` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join('; ');
}

export function RulesScreen({
  storeId,
  rules,
  categories,
  categoriesError,
  products,
  unreadNames,
  filters,
  canAdmin,
  now: nowIso,
}: {
  storeId: string;
  rules: readonly MerchandisingRule[];
  categories: readonly { id: string; name: string }[];
  categoriesError: string | null;
  products: Readonly<Record<string, ProductRef>>;
  /** Products whose names were not read (over the page's cap). */
  unreadNames: number;
  filters: Readonly<Record<string, string>>;
  /** store_admin: create, edit, bulk, publish. A convenience; the server decides. */
  canAdmin: boolean;
  /** The server's time when the page was read, so the states match what it read. */
  now: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const now = new Date(nowIso);
  const categoryNames = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const productNames = Object.fromEntries(
    Object.entries(products).map(([id, ref]) => [
      id,
      ref.title ?? `(deleted product ${id.slice(0, 8)})`,
    ]),
  );
  const shown = sortRules(filterRules(rules, filters, now), categoryNames);
  const shownIds = shown.map((rule) => rule.id);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [editing, setEditing] = useState<MerchandisingRule | 'new' | null>(null);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(filters);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSelection(EMPTY_SELECTION);
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`);
  };

  const filterNames: FilterNames = {
    scope: { label: 'Scope' },
    state: { label: 'State' },
    category_id: { label: 'Category', value: (id) => categoryNames[id] ?? id },
    q: { label: 'Query contains' },
  };
  const filtered = Object.keys(filters).length > 0;

  if (editing !== null) {
    return (
      <RuleEditor
        storeId={storeId}
        rule={editing === 'new' ? null : editing}
        categories={categories}
        productNames={productNames}
        onDone={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Scope</span>
          <select
            value={filters['scope'] ?? ''}
            onChange={(e) => setFilter('scope', e.currentTarget.value)}
            className={control}
          >
            <option value="">Any scope</option>
            <option value="category">Category</option>
            <option value="query">Search query</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">State</span>
          <select
            value={filters['state'] ?? ''}
            onChange={(e) => setFilter('state', e.currentTarget.value)}
            className={control}
          >
            <option value="">Any state</option>
            {(Object.keys(RULE_STATE_LABEL) as RuleState[]).map((state) => (
              <option key={state} value={state}>
                {RULE_STATE_LABEL[state]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Category</span>
          <select
            value={filters['category_id'] ?? ''}
            onChange={(e) => setFilter('category_id', e.currentTarget.value)}
            className={control}
          >
            <option value="">Any category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Query contains</span>
          <input
            defaultValue={filters['q'] ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('q', e.currentTarget.value.trim());
            }}
            onBlur={(e) => {
              if (e.currentTarget.value.trim() !== (filters['q'] ?? ''))
                setFilter('q', e.currentTarget.value.trim());
            }}
            className={control}
          />
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={shown.length === 0}
            onClick={() =>
              downloadCsv(
                csvFileName('merchandising-rules'),
                toCsv(
                  RULES_CSV_HEADER,
                  shown.map((rule) =>
                    ruleCsvRow(rule, { categories: categoryNames, products: productNames }, now),
                  ),
                ),
              )
            }
          >
            Export CSV ({shown.length})
          </Button>
          {canAdmin && (
            <Button size="sm" onClick={() => setEditing('new')}>
              New rule
            </Button>
          )}
        </div>
      </div>

      <p className="text-muted text-xs">
        {shown.length} of {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
        {filtered ? ' match the filters' : ''}. The Admin API returns every rule at once (no
        filters, no paging): the filters apply to that full list. A preview of the ranked search
        result for a rule is not available (no operation).
      </p>
      {categoriesError !== null && (
        <p role="alert" className="text-warning text-sm">
          Category names could not be read ({categoriesError}): category rules show their id.
        </p>
      )}
      {unreadNames > 0 && (
        <p role="note" className="text-warning text-sm">
          {unreadNames} products in these rules were not looked up (the page reads at most 300):
          they show their id.
        </p>
      )}

      {canAdmin && (
        <PublishPanel storeId={storeId} rules={rules} now={now} categoryNames={categoryNames} />
      )}

      {canAdmin && selection.mode === 'rows' && selection.ids.size > 0 && (
        <div role="region" aria-label="Bulk actions" className="flex flex-wrap gap-2">
          {(
            [
              ['Enable', 'enable', false],
              ['Disable', 'disable', false],
              ['Delete…', 'delete', true],
            ] as const
          ).map(([label, kind, destructive]) => (
            <BulkAction
              key={kind}
              label={label}
              noun={{ one: 'rule', many: 'rules' }}
              selection={selection}
              filters={filters}
              filterNames={filterNames}
              run={(sent) => bulkRulesAction(storeId, sent, kind)}
              onClose={() => setSelection(EMPTY_SELECTION)}
              destructive={destructive}
              question={(_, words) =>
                kind === 'delete'
                  ? `Delete ${words}? They leave the index on the next publish; this cannot be undone.`
                  : `${label} ${words}? Shoppers see the change after the next publish.`
              }
            />
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-muted text-sm">
          {rules.length === 0
            ? 'No rules yet. A rule pins, boosts or buries products for one category or one search query.'
            : 'No rule matches these filters.'}
        </p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Merchandising rules</caption>
          <thead className="text-muted text-left text-xs">
            <tr>
              {canAdmin && (
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select every rule shown"
                    checked={isPageFullySelected(selection, shownIds)}
                    onChange={() => setSelection(togglePage(selection, shownIds))}
                  />
                </th>
              )}
              <th>Scope</th>
              <th>State</th>
              <th>Pins / boosts / buries</th>
              <th>Window</th>
              <th>Published</th>
              {canAdmin && <th className="sr-only">Edit</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((rule) => {
              const label = scopeLabel(rule.scope, categoryNames);
              const state = ruleState(rule, now);
              const change = unpublishedChange(rule);
              const trouble = productTrouble(rule, products);
              return (
                <tr key={rule.id} className="border-line border-t align-top">
                  {canAdmin && (
                    <td className="py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${label}`}
                        checked={isRowSelected(selection, rule.id)}
                        onChange={() => setSelection(toggleRow(selection, rule.id))}
                      />
                    </td>
                  )}
                  <td className="py-2">
                    <div className="font-medium">{label}</div>
                    {trouble !== null && <div className="text-warning text-xs">{trouble}</div>}
                  </td>
                  <td className="py-2">
                    <Badge tone={STATE_TONE[state]}>{RULE_STATE_LABEL[state]}</Badge>
                  </td>
                  <td className="py-2">
                    {rule.pins.length} / {rule.boosts.length} / {rule.buries.length}
                  </td>
                  <td className="text-muted py-2 text-xs">
                    {rule.starts_at === null && rule.ends_at === null
                      ? 'Always'
                      : `${day(rule.starts_at)} → ${day(rule.ends_at)} UTC`}
                  </td>
                  <td className="py-2 text-xs">
                    <div className="text-muted">{day(rule.published_at)}</div>
                    {change === 'never' && <Badge tone="warning">never published</Badge>}
                    {change === 'changed' && <Badge tone="warning">changed since</Badge>}
                  </td>
                  {canAdmin && (
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Edit ${label}`}
                        onClick={() => setEditing(rule)}
                      >
                        Edit
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PublishPanel({
  storeId,
  rules,
  now,
  categoryNames,
}: {
  storeId: string;
  rules: readonly MerchandisingRule[];
  now: Date;
  categoryNames: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [report, setReport] = useState<PublishReport | null>(null);
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);
  const preview = publishPreview(rules, now);
  const pendingChanges = rules.filter((rule) => unpublishedChange(rule) !== null).length;
  const labels = Object.fromEntries(
    rules.map((rule) => [rule.id, scopeLabel(rule.scope, categoryNames)]),
  );

  return (
    <div className="border-line space-y-2 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm">
          A publish now puts <strong>{preview.live}</strong> live{' '}
          {preview.live === 1 ? 'rule' : 'rules'} in the search index and skips {preview.skipped}{' '}
          (disabled, not started or ended); it replaces what the index has.
          {pendingChanges > 0 &&
            ` ${pendingChanges} ${pendingChanges === 1 ? 'rule has' : 'rules have'} changes shoppers do not see yet.`}
        </p>
        {!asking && (
          <Button size="sm" disabled={pending} onClick={() => setAsking(true)}>
            Publish to search…
          </Button>
        )}
      </div>
      {asking && (
        <div
          role="alertdialog"
          aria-label="Publish to search?"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span>
            Replace the index&apos;s rules with these {preview.live}? Deleted rules leave the index.
          </span>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              if (pending) return;
              setFailure(null);
              setReport(null);
              startTransition(async () => {
                let result: Awaited<ReturnType<typeof publishRulesAction>>;
                try {
                  result = await publishRulesAction(storeId);
                } catch {
                  setFailure({
                    message:
                      'The publish did not come back: the index may or may not have the rules. Reload and check the publish times before running it again.',
                  });
                  setAsking(false);
                  return;
                }
                setAsking(false);
                if (result.status !== 'success') {
                  setFailure({ message: result.formError, refusal: result.refusal });
                  return;
                }
                setReport(result.data);
                router.refresh();
              });
            }}
          >
            {pending ? 'Publishing…' : 'Yes, publish'}
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      )}
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      {report !== null && (
        <div role="region" aria-label="Publish result" className="space-y-1 text-sm">
          <p role="status" className="font-medium">
            Published to {report.index}: {report.published} in the index, {report.skipped} skipped.
          </p>
          {report.mismatch !== null && (
            <p role="alert" className="text-warning">
              {report.mismatch}
            </p>
          )}
          <ul className="space-y-1 text-xs">
            {report.rows.map((row) => (
              <li key={row.id} className="flex gap-2">
                <span
                  className={
                    row.outcome === 'published'
                      ? 'text-success w-28 shrink-0 font-medium'
                      : row.outcome === 'skipped'
                        ? 'text-muted w-28 shrink-0 font-medium'
                        : 'text-warning w-28 shrink-0 font-medium'
                  }
                >
                  {row.outcome === 'published'
                    ? 'Published'
                    : row.outcome === 'skipped'
                      ? 'Skipped'
                      : 'Not confirmed'}
                </span>
                <span className="w-56 shrink-0 truncate">{labels[row.id] ?? row.id}</span>
                <span className="text-muted">{row.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
