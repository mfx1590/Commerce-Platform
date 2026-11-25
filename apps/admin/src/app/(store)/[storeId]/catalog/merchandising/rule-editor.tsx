'use client';

import { useState, useTransition } from 'react';
import {
  createRuleAction,
  searchProductsForRuleAction,
  updateRuleAction,
} from '@/app/actions/merchandising';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import {
  BOOSTS_MAX,
  BURIES_MAX,
  PINS_MAX,
  isoToLocalInput,
  ruleProblems,
  scheduleValue,
  scopeLabel,
  type MerchandisingRule,
  type RuleDraft,
} from '@/lib/catalog/merchandising';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

const control = 'border-line bg-surface h-9 rounded-md border px-2 text-sm';

function draftOf(rule: MerchandisingRule | null): RuleDraft {
  return rule === null
    ? {
        scope: { type: 'category', category_id: '', query: '' },
        pins: [],
        boosts: [],
        buries: [],
        enabled: true,
        starts_at: null,
        ends_at: null,
      }
    : {
        scope: {
          type: rule.scope.type,
          category_id: rule.scope.category_id ?? '',
          query: rule.scope.query ?? '',
        },
        pins: [...rule.pins],
        boosts: rule.boosts.map((b) => ({ ...b })),
        buries: [...rule.buries],
        enabled: rule.enabled,
        starts_at: rule.starts_at,
        ends_at: rule.ends_at,
      };
}

type ListKey = 'pins' | 'boosts' | 'buries';

/**
 * Create or edit one rule. Products are chosen by name (never typed ids). The scope is fixed once
 * the rule exists (the API does not change it). Saving checks here first, then the server checks
 * the permission and the same rules again.
 */
export function RuleEditor({
  storeId,
  rule,
  categories,
  productNames,
  onDone,
}: {
  storeId: string;
  rule: MerchandisingRule | null;
  categories: readonly { id: string; name: string }[];
  productNames: Readonly<Record<string, string>>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(rule));
  const [names, setNames] = useState<Record<string, string>>({ ...productNames });
  const [pending, startTransition] = useTransition();
  const [server, setServer] = useState<{
    fields: Record<string, string>;
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);
  // The schedule as typed (the person's own time) and as it was opened (#963 review). The
  // instants sent are made HERE, in the browser, where the typed time's zone is known: an
  // untouched field sends the API's own value, byte for byte.
  const [opened] = useState(() => ({
    starts: isoToLocalInput(rule?.starts_at ?? null),
    ends: isoToLocalInput(rule?.ends_at ?? null),
  }));
  const [times, setTimes] = useState(opened);
  const startsSent = scheduleValue(rule?.starts_at ?? null, opened.starts, times.starts);
  const endsSent = scheduleValue(rule?.ends_at ?? null, opened.ends, times.ends);
  const sent: RuleDraft = { ...draft, starts_at: startsSent ?? null, ends_at: endsSent ?? null };
  const local = ruleProblems(sent);
  if (startsSent === undefined) local['starts_at'] = 'Not a date and time.';
  if (endsSent === undefined) local['ends_at'] = 'Not a date and time.';
  if (rule !== null) delete local['scope'];
  const problem = (field: string) => server?.fields[field] ?? local[field] ?? null;
  const categoryNames = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const name = (id: string) => names[id] ?? id;

  const used = new Set([...draft.pins, ...draft.boosts.map((b) => b.product_id), ...draft.buries]);
  const add = (list: ListKey, product: { id: string; title: string }) => {
    setNames((current) => ({ ...current, [product.id]: product.title }));
    setDraft((current) =>
      list === 'boosts'
        ? { ...current, boosts: [...current.boosts, { product_id: product.id, weight: 50 }] }
        : { ...current, [list]: [...current[list], product.id] },
    );
  };
  const remove = (list: ListKey, index: number) =>
    setDraft((current) =>
      list === 'boosts'
        ? { ...current, boosts: current.boosts.filter((_, i) => i !== index) }
        : { ...current, [list]: current[list].filter((_, i) => i !== index) },
    );
  const movePin = (index: number, by: -1 | 1) =>
    setDraft((current) => {
      const pins = [...current.pins];
      const [moved] = pins.splice(index, 1);
      pins.splice(index + by, 0, moved!);
      return { ...current, pins };
    });

  const save = () => {
    if (pending || Object.keys(local).length > 0) return;
    setServer(null);
    startTransition(async () => {
      const result =
        rule === null
          ? await createRuleAction(storeId, sent)
          : await updateRuleAction(storeId, rule.id, sent);
      if (result.status === 'success') {
        onDone();
        return;
      }
      setServer({
        fields: { ...result.fieldErrors },
        message: result.formError,
        refusal: result.refusal,
      });
    });
  };

  return (
    <form
      aria-label={rule === null ? 'New rule' : `Edit ${scopeLabel(rule.scope, categoryNames)}`}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h2 className="text-base font-semibold">
        {rule === null ? 'New rule' : `Edit: ${scopeLabel(rule.scope, categoryNames)}`}
      </h2>

      <fieldset className="space-y-2" disabled={rule !== null}>
        <legend className="text-sm font-medium">
          Scope{rule !== null ? ' (fixed once the rule exists)' : ''}
        </legend>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="scope"
              checked={draft.scope.type === 'category'}
              onChange={() => setDraft({ ...draft, scope: { ...draft.scope, type: 'category' } })}
            />
            A category
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="scope"
              checked={draft.scope.type === 'query'}
              onChange={() => setDraft({ ...draft, scope: { ...draft.scope, type: 'query' } })}
            />
            A search query
          </label>
          {draft.scope.type === 'category' ? (
            <label className="flex items-center gap-2">
              <span className="text-muted">Category</span>
              <select
                value={draft.scope.category_id}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    scope: { ...draft.scope, category_id: e.currentTarget.value },
                  })
                }
                className={control}
              >
                <option value="">Choose…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex items-center gap-2">
              <span className="text-muted">Search query (the whole query, any case)</span>
              <input
                value={draft.scope.query}
                onChange={(e) =>
                  setDraft({ ...draft, scope: { ...draft.scope, query: e.currentTarget.value } })
                }
                className={control}
              />
            </label>
          )}
        </div>
        {problem('scope') !== null && (
          <p role="alert" className="text-danger text-xs">
            {problem('scope')}
          </p>
        )}
      </fieldset>

      <ProductList
        title={`Pinned, in this order (${draft.pins.length}/${PINS_MAX})`}
        hint="Shown first, in this order."
        problem={problem('pins')}
      >
        {draft.pins.map((id, index) => (
          <li key={id} className="flex items-center gap-2">
            <span className="w-6 text-right">{index + 1}.</span>
            <span className="flex-1 truncate">{name(id)}</span>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              aria-label={`Move ${name(id)} up`}
              disabled={index === 0}
              onClick={() => movePin(index, -1)}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              aria-label={`Move ${name(id)} down`}
              disabled={index === draft.pins.length - 1}
              onClick={() => movePin(index, 1)}
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              aria-label={`Remove ${name(id)} from pinned`}
              onClick={() => remove('pins', index)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ProductList>
      <ProductPicker
        storeId={storeId}
        list="pinned"
        used={used}
        full={draft.pins.length >= PINS_MAX}
        onPick={(p) => add('pins', p)}
      />

      <ProductList
        title={`Boosted (${draft.boosts.length}/${BOOSTS_MAX})`}
        hint="Weight 1–100: higher ranks higher among the results."
        problem={problem('boosts')}
      >
        {draft.boosts.map((boost, index) => (
          <li key={boost.product_id} className="flex items-center gap-2">
            <span className="flex-1 truncate">{name(boost.product_id)}</span>
            <label className="flex items-center gap-1 text-xs">
              <span className="text-muted">Weight</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                aria-label={`Weight of ${name(boost.product_id)}`}
                value={Number.isNaN(boost.weight) ? '' : boost.weight}
                onChange={(e) => {
                  const weight = e.currentTarget.valueAsNumber;
                  setDraft((current) => ({
                    ...current,
                    boosts: current.boosts.map((b, i) => (i === index ? { ...b, weight } : b)),
                  }));
                }}
                className={`${control} w-20`}
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              aria-label={`Remove ${name(boost.product_id)} from boosted`}
              onClick={() => remove('boosts', index)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ProductList>
      <ProductPicker
        storeId={storeId}
        list="boosted"
        used={used}
        full={draft.boosts.length >= BOOSTS_MAX}
        onPick={(p) => add('boosts', p)}
      />

      <ProductList
        title={`Buried (${draft.buries.length}/${BURIES_MAX})`}
        hint="Shown last."
        problem={problem('buries')}
      >
        {draft.buries.map((id, index) => (
          <li key={id} className="flex items-center gap-2">
            <span className="flex-1 truncate">{name(id)}</span>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              aria-label={`Remove ${name(id)} from buried`}
              onClick={() => remove('buries', index)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ProductList>
      <ProductPicker
        storeId={storeId}
        list="buried"
        used={used}
        full={draft.buries.length >= BURIES_MAX}
        onPick={(p) => add('buries', p)}
      />

      <fieldset className="flex flex-wrap items-end gap-4 text-sm">
        <legend className="mb-1 text-sm font-medium">When</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })}
          />
          Enabled
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">
            Starts (your local time, {Intl.DateTimeFormat().resolvedOptions().timeZone}; empty =
            now)
          </span>
          <input
            type="datetime-local"
            aria-label="Starts"
            value={times.starts}
            onChange={(e) => {
              const starts = e.currentTarget.value;
              setTimes((current) => ({ ...current, starts }));
            }}
            className={control}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Ends (empty = no end)</span>
          <input
            type="datetime-local"
            aria-label="Ends"
            value={times.ends}
            onChange={(e) => {
              const ends = e.currentTarget.value;
              setTimes((current) => ({ ...current, ends }));
            }}
            className={control}
          />
        </label>
      </fieldset>
      {(problem('starts_at') ?? problem('ends_at')) !== null && (
        <p role="alert" className="text-danger text-xs">
          {problem('starts_at') ?? problem('ends_at')}
        </p>
      )}
      {local['form'] !== undefined && (
        <p role="alert" className="text-danger text-sm">
          {local['form']}
        </p>
      )}

      <p className="text-muted text-xs">
        Saving does not change search yet: shoppers see the rule after the next “Publish to search”.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || Object.keys(local).length > 0}>
          {pending ? 'Saving…' : rule === null ? 'Create rule' : 'Save rule'}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ActionRefusal refusal={server?.refusal} message={server?.message ?? null} />
    </form>
  );
}

function ProductList({
  title,
  hint,
  problem,
  children,
}: {
  title: string;
  hint: string;
  problem: string | null;
  children: React.ReactNode[];
}) {
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-muted text-xs">{hint}</p>
      {children.length === 0 ? (
        <p className="text-muted text-xs">None.</p>
      ) : (
        <ul className="space-y-1 text-sm">{children}</ul>
      )}
      {problem !== null && (
        <p role="alert" className="text-danger text-xs">
          {problem}
        </p>
      )}
    </section>
  );
}

/** Search products by title or handle and add one; products already in a list are not offered. */
function ProductPicker({
  storeId,
  list,
  used,
  full,
  onPick,
}: {
  storeId: string;
  list: string;
  used: ReadonlySet<string>;
  full: boolean;
  onPick: (product: { id: string; title: string }) => void;
}) {
  const [q, setQ] = useState('');
  const [pending, startTransition] = useTransition();
  const [found, setFound] = useState<{ id: string; title: string; status: string }[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const search = () => {
    if (pending || q.trim() === '') return;
    setFailure(null);
    startTransition(async () => {
      const result = await searchProductsForRuleAction(storeId, q);
      if (result.status === 'success') setFound(result.data);
      else setFailure(result.formError ?? 'The search failed.');
    });
  };
  if (full) return <p className="text-muted text-xs">The {list} list is full.</p>;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          aria-label={`Find a product to add to ${list}`}
          placeholder="Product title or handle"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              search();
            }
          }}
          className={control}
        />
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={search}>
          {pending ? 'Searching…' : 'Find'}
        </Button>
      </div>
      {failure !== null && (
        <p role="alert" className="text-danger text-xs">
          {failure}
        </p>
      )}
      {found !== null &&
        (found.length === 0 ? (
          <p className="text-muted text-xs">No product matches “{q}”.</p>
        ) : (
          <ul aria-label={`Products to add to ${list}`} className="space-y-1 text-sm">
            {found.map((product) => (
              <li key={product.id} className="flex items-center gap-2">
                <span className="flex-1 truncate">
                  {product.title}
                  {product.status !== 'published' && (
                    <span className="text-warning text-xs">
                      {' '}
                      ({product.status}: not shown to shoppers)
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={used.has(product.id)}
                  aria-label={`Add ${product.title} to ${list}`}
                  onClick={() => onPick({ id: product.id, title: product.title })}
                >
                  {used.has(product.id) ? 'Already in a list' : 'Add'}
                </Button>
              </li>
            ))}
          </ul>
        ))}
      {found !== null && found.length === 20 && (
        <p className="text-muted text-xs">The first 20 matches: type more of the name to narrow.</p>
      )}
    </div>
  );
}
