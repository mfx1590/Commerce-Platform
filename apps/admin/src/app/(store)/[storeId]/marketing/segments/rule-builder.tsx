'use client';

import { useState, useTransition } from 'react';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import {
  CONSENT_CHANNELS,
  SEGMENT_FIELDS,
  predicateFor,
  predicateProblem,
  specFor,
  toRules,
  type DraftGroup,
  type SegmentRules,
} from './_rules';

/**
 * The segment rule builder.
 *
 * The grammar is an **AND of ORs**: every group has to match, and a group matches when any one of its rows
 * does. The UI says exactly that in words, because a builder that renders boolean structure without naming it
 * is how people ship a segment that means the opposite of what they intended.
 *
 * `toRules` (a plain module, tested separately) is the only thing that turns rows into contract JSON, so the
 * shape the screen sends is the shape the tests assert.
 */
export function RuleBuilder({
  initial,
  canEdit,
  preview,
  save,
}: {
  initial: DraftGroup[];
  canEdit: boolean;
  /** Bound on the server: `(rules) => previewSegmentAction(storeId, segmentId, rules)`. */
  preview: (rules: SegmentRules) => Promise<{
    status: 'success' | 'error';
    data?: { count: number };
    refusal?: ActionRefusalInfo;
  }>;
  /** Bound on the server; omitted when the principal may not write. */
  save?: (
    rules: SegmentRules,
  ) => Promise<{ status: 'success' | 'error'; refusal?: ActionRefusalInfo }>;
}) {
  const [groups, setGroups] = useState<DraftGroup[]>(initial);
  const [count, setCount] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const rules = toRules(groups);
  const complete = rules !== null;

  function update(next: DraftGroup[]): void {
    setGroups(next);
    // The count belongs to the rules that produced it; keeping it on screen while the rules change would
    // show a number for a segment that no longer exists.
    setCount(null);
    setMessage(null);
  }

  function runPreview(): void {
    if (rules === null) return;
    setRefusal(null);
    setMessage(null);
    startTransition(async () => {
      const result = await preview(rules);
      if (result.status === 'success' && result.data) setCount(result.data.count);
      else if (result.refusal) setRefusal(result.refusal);
      else setMessage('The count could not be taken just now.');
    });
  }

  function runSave(): void {
    if (rules === null || save === undefined) return;
    setRefusal(null);
    setMessage(null);
    startTransition(async () => {
      const result = await save(rules);
      if (result.status === 'error') {
        if (result.refusal) setRefusal(result.refusal);
        else setMessage('The rules were refused. Check the fields above.');
      } else {
        setMessage('Saved.');
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-muted text-sm">
        A customer is in this segment when <strong>every</strong> group below matches. Within a
        group, <strong>any</strong> one row is enough. No groups at all means every customer of the
        store.
      </p>

      {groups.map((group, groupIndex) => (
        <fieldset key={groupIndex} className="border-line rounded border p-3">
          <legend className="text-muted px-1 text-xs uppercase">
            {groupIndex === 0 ? 'Group' : 'and group'} {groupIndex + 1}
          </legend>

          <div className="space-y-2">
            {group.any.map((row, rowIndex) => {
              const spec = specFor(row.field);
              const problem = predicateProblem(row);
              return (
                <div key={rowIndex} className="flex flex-wrap items-start gap-2">
                  {rowIndex > 0 ? <span className="text-muted py-2 text-xs">or</span> : null}

                  <select
                    aria-label="Field"
                    className="border-line bg-surface rounded border px-2 py-1 text-sm"
                    value={row.field}
                    disabled={!canEdit}
                    onChange={(event) => {
                      const next = structuredClone(groups);
                      next[groupIndex]!.any[rowIndex] = predicateFor(event.target.value);
                      update(next);
                    }}
                  >
                    {SEGMENT_FIELDS.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.label}
                      </option>
                    ))}
                  </select>

                  <select
                    aria-label="Comparison"
                    className="border-line bg-surface rounded border px-2 py-1 text-sm"
                    value={row.op}
                    disabled={!canEdit}
                    onChange={(event) => {
                      const next = structuredClone(groups);
                      next[groupIndex]!.any[rowIndex]!.op = event.target.value;
                      update(next);
                    }}
                  >
                    {(spec?.ops ?? []).map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </select>

                  {spec?.value === 'consent' ? (
                    <select
                      aria-label="Value"
                      className="border-line bg-surface rounded border px-2 py-1 text-sm"
                      value={row.value}
                      disabled={!canEdit}
                      onChange={(event) => {
                        const next = structuredClone(groups);
                        next[groupIndex]!.any[rowIndex]!.value = event.target.value;
                        update(next);
                      }}
                    >
                      <option value="">Pick a channel</option>
                      {CONSENT_CHANNELS.map((channel) => (
                        <option key={channel} value={channel}>
                          {channel}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label="Value"
                      type={spec?.value === 'timestamp' ? 'date' : 'text'}
                      inputMode={
                        spec?.value === 'integer' || spec?.value === 'money' ? 'numeric' : undefined
                      }
                      className="border-line bg-surface rounded border px-2 py-1 text-sm"
                      value={row.value}
                      disabled={!canEdit}
                      onChange={(event) => {
                        const next = structuredClone(groups);
                        next[groupIndex]!.any[rowIndex]!.value = event.target.value;
                        update(next);
                      }}
                    />
                  )}

                  {canEdit ? (
                    <button
                      type="button"
                      className="text-muted hover:text-ink px-1 py-1 text-xs"
                      onClick={() => {
                        const next = structuredClone(groups);
                        next[groupIndex]!.any.splice(rowIndex, 1);
                        if (next[groupIndex]!.any.length === 0) next.splice(groupIndex, 1);
                        update(next);
                      }}
                    >
                      Remove
                    </button>
                  ) : null}

                  {problem === null ? (
                    <span className="text-muted py-1 text-xs">{spec?.hint}</span>
                  ) : (
                    <span className="text-critical py-1 text-xs">{problem}</span>
                  )}
                </div>
              );
            })}

            {canEdit ? (
              <button
                type="button"
                className="text-accent text-xs hover:underline"
                onClick={() => {
                  const next = structuredClone(groups);
                  next[groupIndex]!.any.push(predicateFor('orders_count'));
                  update(next);
                }}
              >
                + or…
              </button>
            ) : null}
          </div>
        </fieldset>
      ))}

      {canEdit ? (
        <button
          type="button"
          className="text-accent text-sm hover:underline"
          onClick={() => update([...groups, { any: [predicateFor('orders_count')] }])}
        >
          + and group
        </button>
      ) : null}

      <div className="border-line flex flex-wrap items-center gap-3 border-t pt-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={runPreview}
          disabled={!complete || isPending}
        >
          {isPending ? 'Counting…' : 'Count customers'}
        </Button>
        {save === undefined ? null : (
          <Button size="sm" onClick={runSave} disabled={!complete || isPending}>
            Save rules
          </Button>
        )}
        {count === null ? (
          <span className="text-muted text-sm">
            {complete
              ? 'The count is taken live and writes nothing.'
              : 'Finish every row to take a count.'}
          </span>
        ) : (
          <span className="text-sm">
            <strong className="font-mono tabular-nums">{count}</strong>{' '}
            {count === 1 ? 'customer matches' : 'customers match'} right now.
          </span>
        )}
      </div>

      <ActionRefusal refusal={refusal ?? undefined} message={message} />
    </div>
  );
}
