'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { draftProductCopyAction, saveProductCopyAction } from '@/app/actions/copy-drafts';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import {
  COPY_FIELDS,
  COPY_FIELD_LABELS,
  draftToProductPatch,
  editableDraft,
  lineDiff,
  withBullets,
  type CopyField,
  type DraftRefusal,
  type EditableCopy,
  type ProductCopyDraft,
} from '@/lib/copy-drafts';

/** Changed lines marked; the same lines kept plain. */
function Diff({ before, after, label }: { before: string; after: string; label: string }) {
  const lines = lineDiff(before, after);
  if (lines.every((l) => l.kind === 'same')) {
    return <p className="text-muted text-xs">No change.</p>;
  }
  return (
    <ul aria-label={`Changes to ${label}`} className="font-mono text-xs">
      {lines.map((line, index) => (
        <li
          key={index}
          className={
            line.kind === 'added'
              ? 'bg-success/10 text-success'
              : line.kind === 'removed'
                ? 'bg-danger/10 text-danger line-through'
                : 'text-muted'
          }
        >
          <span aria-hidden="true">
            {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
          </span>
          <span className="sr-only">
            {line.kind === 'added' ? 'added: ' : line.kind === 'removed' ? 'removed: ' : ''}
          </span>
          {line.text}
        </li>
      ))}
    </ul>
  );
}

/** Per-locale product copy does not exist yet (the Product has one copy): its issue. */
const PER_LOCALE_ISSUE = 'https://github.com/mfx1590/Commerce-Platform/issues/670';

/** Copies a draft field's text, e.g. a non-default locale's draft to paste elsewhere. */
function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      className="text-accent ml-auto text-xs hover:underline"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function asText(field: CopyField, copy: EditableCopy): string {
  switch (field) {
    case 'title':
      return copy.title;
    case 'description':
      return copy.description;
    case 'bullets':
      return copy.bullets.join('\n');
    case 'seo':
      return `${copy.seo.title}\n${copy.seo.description}`;
  }
}

/**
 * Product editor · "Draft with AI" (#608): ask `draftProductCopy` for one locale and the chosen
 * fields, show the current copy beside the editable draft with the changed lines marked, and save
 * ONLY what the human accepts, with the normal `updateProduct`. Nothing is saved automatically.
 *
 * The product holds ONE copy (title, description, seo): a draft in another locale is shown and can
 * be copied, but saving it would overwrite that one copy, so Save is offered for the store's default
 * locale only. Bullets have no field of their own: they are saved into the description as a list.
 */
export function CopyDraftPanel({
  storeId,
  productId,
  locales,
  defaultLocale,
  canDraft,
  current,
  product,
  settingsHref,
}: {
  storeId: string;
  productId: string;
  locales: readonly string[];
  defaultLocale: string;
  /** store_staff on the store — a convenience; the server decides. */
  canDraft: boolean;
  current: EditableCopy;
  product: { description: string | null; seo: Record<string, unknown> };
  settingsHref: string;
}) {
  const router = useRouter();
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const [locale, setLocale] = useState(defaultLocale);
  const [fields, setFields] = useState<ReadonlySet<CopyField>>(new Set(['description']));
  const [draft, setDraft] = useState<ProductCopyDraft | null>(null);
  const [edited, setEdited] = useState<EditableCopy | null>(null);
  const [accepted, setAccepted] = useState<ReadonlySet<CopyField>>(new Set());
  const [error, setError] = useState<DraftRefusal | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [saveFailure, setSaveFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);

  // ai_rate_limited: the button counts Retry-After down before it works again.
  useEffect(() => {
    if (waitSeconds <= 0) return;
    const timer = setTimeout(() => setWaitSeconds((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [waitSeconds]);

  const toggle = (set: ReadonlySet<CopyField>, field: CopyField, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(field);
    else next.delete(field);
    return next;
  };

  const requestDraft = () => {
    setError(null);
    setRefusal(undefined);
    setSaved(null);
    setSaveFailure(null);
    startDraft(async () => {
      const result = await draftProductCopyAction(storeId, productId, {
        locale,
        fields: COPY_FIELDS.filter((f) => fields.has(f)),
      });
      if (result.status === 'success') {
        setDraft(result.draft);
        setEdited(editableDraft(result.draft.draft, current));
        setAccepted(new Set(result.draft.fields));
        return;
      }
      if (result.status === 'refused') {
        setRefusal(result.refusal);
        return;
      }
      setError(result.error);
      if (result.error.retryAfterSeconds !== undefined) {
        setWaitSeconds(result.error.retryAfterSeconds);
      }
    });
  };

  const canSave = draft !== null && draft.locale === defaultLocale && accepted.size > 0;
  const save = () => {
    if (draft === null || edited === null) return;
    setSaveFailure(null);
    startSave(async () => {
      const result = await saveProductCopyAction(
        storeId,
        productId,
        draftToProductPatch(product, accepted, edited),
      );
      if (result.status === 'success') {
        setSaved(
          `Saved ${[...accepted].map((f) => COPY_FIELD_LABELS[f].toLowerCase()).join(', ')} to the product.`,
        );
        setDraft(null);
        setEdited(null);
        router.refresh();
        return;
      }
      setSaveFailure({ message: result.formError, refusal: result.refusal });
    });
  };

  const buttonLabel = drafting
    ? 'Drafting…'
    : waitSeconds > 0
      ? `Draft with AI (wait ${waitSeconds} s)`
      : 'Draft with AI';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <SelectField
          label="Locale"
          value={locale}
          onChange={(event) => setLocale(event.currentTarget.value)}
          options={locales.map((l) => ({
            value: l,
            label: l === defaultLocale ? `${l} (default)` : l,
          }))}
        />
        <fieldset className="flex flex-wrap gap-3 text-sm">
          <legend className="text-muted mb-1 text-xs">Fields to draft</legend>
          {COPY_FIELDS.map((field) => (
            <label key={field} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={fields.has(field)}
                onChange={(event) => setFields(toggle(fields, field, event.currentTarget.checked))}
              />
              {COPY_FIELD_LABELS[field]}
            </label>
          ))}
        </fieldset>
        <Button
          type="button"
          onClick={requestDraft}
          disabled={!canDraft || drafting || waitSeconds > 0 || fields.size === 0}
          title={canDraft ? undefined : `Drafting needs store_staff on store:${storeId}`}
        >
          {buttonLabel}
        </Button>
      </div>
      {!canDraft && (
        <p className="text-muted text-sm">
          Drafting with AI needs <span className="font-mono">store_staff</span> on{' '}
          <span className="font-mono">store:{storeId}</span>.
        </p>
      )}
      {locale !== defaultLocale && (
        <p className="text-muted text-sm">
          This product holds one copy, in {defaultLocale}. A {locale} draft can be read, edited and
          copied, but not saved over it — per-locale product copy is{' '}
          <a href={PER_LOCALE_ISSUE} className="text-accent hover:underline">
            #670
          </a>
          .
        </p>
      )}

      <ActionRefusal refusal={refusal} message={null} />
      {error !== null && (
        <div
          role="alert"
          aria-label={error.title}
          className="border-warning/30 bg-warning/5 rounded-md border px-3 py-2 text-sm"
        >
          <p className="font-medium">{error.title}</p>
          <p>{error.message}</p>
          <p className="text-muted mt-1 text-xs">The editor below works as before.</p>
        </div>
      )}
      {saved !== null && (
        <p role="status" className="text-success text-sm">
          {saved}
        </p>
      )}

      {draft !== null && edited !== null && (
        <section aria-label="AI draft" className="space-y-4">
          {draft.brand_voice_source === 'default' && (
            <p role="note" className="text-sm">
              Drafted in a neutral voice: this store has no brand voice yet.{' '}
              <Link href={settingsHref} className="text-accent hover:underline">
                Set the brand voice (content.brand_voice) in Store settings
              </Link>
              .
            </p>
          )}
          {draft.fields.map((field) => (
            <div key={field} className="border-line space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold">{COPY_FIELD_LABELS[field]}</h3>
                <label className="ml-auto flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={accepted.has(field)}
                    onChange={(event) =>
                      setAccepted(toggle(accepted, field, event.currentTarget.checked))
                    }
                  />
                  Use this field
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-muted mb-1 text-xs">Current</p>
                  <pre
                    aria-label={`Current ${COPY_FIELD_LABELS[field]}`}
                    className="bg-canvas min-h-10 whitespace-pre-wrap rounded p-2 text-sm"
                  >
                    {field === 'bullets'
                      ? '(no bullets field: they are saved into the description)'
                      : asText(field, current) || '—'}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <p className="text-muted text-xs">Draft — edit before saving</p>
                    <CopyButton
                      label={`Copy draft ${COPY_FIELD_LABELS[field]}`}
                      text={
                        field === 'bullets'
                          ? edited.bullets.map((b) => `- ${b}`).join('\n')
                          : asText(field, edited)
                      }
                    />
                  </div>
                  {field === 'seo' ? (
                    <div className="space-y-2">
                      <input
                        aria-label="Draft SEO title"
                        className="border-line w-full rounded-md border px-2 py-1 text-sm"
                        value={edited.seo.title}
                        maxLength={70}
                        onChange={(event) =>
                          setEdited({
                            ...edited,
                            seo: { ...edited.seo, title: event.currentTarget.value },
                          })
                        }
                      />
                      <textarea
                        aria-label="Draft SEO description"
                        className="border-line w-full rounded-md border px-2 py-1 text-sm"
                        rows={2}
                        value={edited.seo.description}
                        maxLength={160}
                        onChange={(event) =>
                          setEdited({
                            ...edited,
                            seo: { ...edited.seo, description: event.currentTarget.value },
                          })
                        }
                      />
                    </div>
                  ) : (
                    <textarea
                      aria-label={`Draft ${COPY_FIELD_LABELS[field]}`}
                      className="border-line w-full rounded-md border px-2 py-1 text-sm"
                      rows={field === 'title' ? 1 : 6}
                      value={asText(field, edited)}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setEdited(
                          field === 'bullets'
                            ? { ...edited, bullets: value.split('\n') }
                            : { ...edited, [field]: value },
                        );
                      }}
                    />
                  )}
                </div>
              </div>
              <Diff
                label={COPY_FIELD_LABELS[field]}
                before={field === 'bullets' ? (product.description ?? '') : asText(field, current)}
                after={
                  field === 'bullets'
                    ? withBullets(
                        accepted.has('description')
                          ? edited.description
                          : (product.description ?? ''),
                        edited.bullets,
                      )
                    : asText(field, edited)
                }
              />
            </div>
          ))}
          <p className="text-muted text-xs" aria-label="Draft provenance">
            Model {draft.model} · template {draft.template.id} v{draft.template.version} ·{' '}
            {draft.locale} · drafted {draft.created_at.replace('T', ' ').slice(0, 16)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={save} disabled={!canSave || saving}>
              {saving ? 'Saving…' : 'Save to product'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDraft(null);
                setEdited(null);
              }}
            >
              Discard draft
            </Button>
            {draft.locale !== defaultLocale && (
              <span className="text-muted text-sm">
                Saving is for the default locale ({defaultLocale}) only.
              </span>
            )}
          </div>
          <ActionRefusal refusal={saveFailure?.refusal} message={saveFailure?.message ?? null} />
        </section>
      )}
    </div>
  );
}
