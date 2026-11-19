'use client';

import { useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import {
  attributeRows,
  attributesFrom,
  canonicalProblem,
  duplicateKeys,
  mergeSeo,
  parseTags,
  SEO_LENGTHS,
  type AttributeRow,
  type SeoKey,
} from '@/lib/catalog/attributes';
import type { ProductCreateValues } from '@/lib/forms/schemas';

const input = 'border-line bg-surface h-9 w-full rounded-md border px-3 text-sm';

/**
 * Tags, SEO and attributes of a product (#870 item 5). They write into the product form's values
 * (`tags`, `seo`, `attributes`) and are saved with it. SEO edits the three keys the storefront's
 * product page reads (title, description, canonical) and keeps any other key already there;
 * attributes edit text and numbers, and keep (read-only) values of any other kind.
 */
export function ProductDetailsFields({ form }: { form: UseFormReturn<ProductCreateValues> }) {
  const initial = form.getValues();
  const [tagsText, setTagsText] = useState((initial.tags ?? []).join(', '));
  const seoStart = (initial.seo ?? {}) as Record<string, unknown>;
  const [seo, setSeo] = useState<Record<SeoKey, string>>({
    title: typeof seoStart['title'] === 'string' ? seoStart['title'] : '',
    description: typeof seoStart['description'] === 'string' ? seoStart['description'] : '',
    canonical: typeof seoStart['canonical'] === 'string' ? seoStart['canonical'] : '',
  });
  const start = attributeRows(initial.attributes as Record<string, unknown> | undefined);
  const [rows, setRows] = useState<AttributeRow[]>(start.rows);
  const kept = start.kept;

  const writeSeo = (next: Record<SeoKey, string>) => {
    setSeo(next);
    form.setValue('seo', mergeSeo(seoStart, next), { shouldDirty: true });
  };
  const writeRows = (next: AttributeRow[]) => {
    setRows(next);
    form.setValue('attributes', attributesFrom(next, kept), { shouldDirty: true });
  };
  const tags = parseTags(tagsText);
  const duplicates = duplicateKeys(rows);
  const canonical = canonicalProblem(seo.canonical);

  return (
    <div className="space-y-6">
      <section className="max-w-3xl space-y-2">
        <h2 className="text-base font-semibold">Tags</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span>Tags, separated by commas</span>
          <input
            value={tagsText}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setTagsText(text);
              form.setValue('tags', parseTags(text), { shouldDirty: true });
            }}
            className={input}
          />
        </label>
        {tags.length > 0 && (
          <ul aria-label="Tags" className="flex flex-wrap gap-1 text-xs">
            {tags.map((tag) => (
              <li key={tag} className="border-line bg-canvas rounded-full border px-2 py-0.5">
                {tag}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="max-w-3xl space-y-3" aria-label="Search engines">
        <h2 className="text-base font-semibold">Search engines (SEO)</h2>
        <p className="text-muted text-xs">
          Empty fields fall back to the product title and description on the storefront.
        </p>
        {/* Labels by id, counters described-by: the field's name stays "SEO title", not the count. */}
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="seo-title">SEO title</label>
          <input
            id="seo-title"
            aria-describedby="seo-title-count"
            value={seo.title}
            onChange={(e) => writeSeo({ ...seo, title: e.currentTarget.value })}
            className={input}
          />
          <span
            id="seo-title-count"
            className={
              seo.title.length > SEO_LENGTHS.title ? 'text-warning text-xs' : 'text-muted text-xs'
            }
          >
            {seo.title.length} / {SEO_LENGTHS.title} characters
            {seo.title.length > SEO_LENGTHS.title ? ' — search engines usually cut the rest.' : ''}
          </span>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="seo-description">SEO description</label>
          <textarea
            id="seo-description"
            aria-describedby="seo-description-count"
            rows={3}
            value={seo.description}
            onChange={(e) => writeSeo({ ...seo, description: e.currentTarget.value })}
            className="border-line bg-surface rounded-md border px-3 py-2 text-sm"
          />
          <span
            id="seo-description-count"
            className={
              seo.description.length > SEO_LENGTHS.description
                ? 'text-warning text-xs'
                : 'text-muted text-xs'
            }
          >
            {seo.description.length} / {SEO_LENGTHS.description} characters
            {seo.description.length > SEO_LENGTHS.description
              ? ' — search engines usually cut the rest.'
              : ''}
          </span>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="seo-canonical">Canonical URL (optional)</label>
          <input
            id="seo-canonical"
            value={seo.canonical}
            placeholder="/products/linen-tea-towel or https://…"
            onChange={(e) => writeSeo({ ...seo, canonical: e.currentTarget.value })}
            className={input}
          />
          {canonical !== null && (
            <span role="alert" className="text-danger text-xs">
              {canonical}
            </span>
          )}
        </div>
      </section>

      <section className="max-w-3xl space-y-2" aria-label="Attributes">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">Attributes</h2>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => writeRows([...rows, { key: '', value: '' }])}
          >
            Add attribute
          </Button>
        </div>
        <p className="text-muted text-xs">
          Facts such as material or care, shown and searchable on the storefront.
        </p>
        {rows.length === 0 && Object.keys(kept).length === 0 && (
          <p className="text-muted text-sm">No attributes yet.</p>
        )}
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li key={index} className="flex items-center gap-2">
              <input
                aria-label={`Attribute ${index + 1} name`}
                value={row.key}
                placeholder="material"
                onChange={(e) => {
                  const key = e.currentTarget.value;
                  writeRows(rows.map((r, i) => (i === index ? { ...r, key } : r)));
                }}
                className={`${input} w-48`}
              />
              <input
                aria-label={`Attribute ${index + 1} value`}
                value={row.value}
                placeholder="linen"
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  writeRows(rows.map((r, i) => (i === index ? { ...r, value } : r)));
                }}
                className={input}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label={`Remove attribute ${row.key || index + 1}`}
                onClick={() => writeRows(rows.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        {duplicates.length > 0 && (
          <p role="alert" className="text-warning text-xs">
            The same name appears twice ({duplicates.join(', ')}): only the last value is kept.
          </p>
        )}
        {Object.keys(kept).length > 0 && (
          <p className="text-muted text-xs">
            Kept as they are (not text, so not editable here): {Object.keys(kept).join(', ')}.
          </p>
        )}
      </section>
    </div>
  );
}
