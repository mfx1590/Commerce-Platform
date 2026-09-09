'use client';

import { useRouter } from 'next/navigation';
import { useFieldArray, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { useContractForm } from '@/components/form/use-contract-form';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';
import { productCreateSchema, type ProductCreateValues } from '@/lib/forms/schemas';
import { variantMatrix, variantTitle, suggestSku } from '@/lib/forms/variant-matrix';

type Product = AdminComponents['Product'];
type Category = AdminComponents['Category'];

/** Values arrive as a comma-separated list because that is how people type them. */
function splitValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

export function ProductForm({
  action,
  defaultValues,
  categories,
  submitLabel,
  redirectBase,
}: {
  action: (values: ProductCreateValues) => Promise<ActionResult<Product>>;
  defaultValues: ProductCreateValues;
  categories: readonly Category[];
  submitLabel: string;
  /** Path prefix; the new product id is appended. See the note in `store-form.tsx`. */
  redirectBase?: string;
}) {
  const router = useRouter();
  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    ProductCreateValues,
    Product
  >({
    schema: productCreateSchema,
    action,
    defaultValues,
    onSuccess: (product) => {
      if (redirectBase !== undefined) router.push(`${redirectBase}/${product.id}`);
      else router.refresh();
    },
  });

  const options = useFieldArray({ control: form.control, name: 'options' });
  const media = useFieldArray({ control: form.control, name: 'media' });
  // Watching, not reading form state, so the matrix preview updates as the operator types.
  const watchedOptions = useWatch({ control: form.control, name: 'options' }) ?? [];
  const handle = useWatch({ control: form.control, name: 'handle' }) ?? '';

  const drafts = watchedOptions.map((option) => ({
    name: option?.name ?? '',
    values: option?.values ?? [],
  }));
  const matrix = variantMatrix(drafts);
  const errors = form.formState.errors;

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <ActionRefusal refusal={refusal} message={formError} />

      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        <TextField
          label="Title"
          required
          error={errorMessage(errors.title)}
          {...form.register('title')}
        />
        <TextField
          label="Handle"
          required
          hint="Lower-case and hyphenated; it is the storefront URL."
          error={errorMessage(errors.handle)}
          {...form.register('handle')}
        />
        <TextField
          label="Subtitle"
          error={errorMessage(errors.subtitle)}
          {...form.register('subtitle')}
        />
        <TextField
          label="Brand"
          error={errorMessage(errors.brand_name)}
          {...form.register('brand_name')}
        />
        <SelectField
          label="Category"
          error={errorMessage(errors.category_id)}
          options={[
            { value: '', label: '— none —' },
            ...categories.map((category) => ({ value: category.id, label: category.name })),
          ]}
          // "No category" is an empty option value, but the contract's `category_id` is a uuid or
          // null — an empty string is neither, so it must become null on the way in. Without this
          // the form silently refused to submit: the schema rejected `''`, and because this field
          // had no error slot the message had nowhere to appear. Every field here now shows its
          // own error for the same reason.
          {...form.register('category_id', {
            setValueAs: (value: string) => (value === '' ? null : value),
          })}
        />
        <TextField
          label="Description"
          error={errorMessage(errors.description)}
          {...form.register('description')}
        />
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">Options</h2>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => options.append({ name: '', values: [] })}
          >
            Add option
          </Button>
        </div>

        {options.fields.length === 0 ? (
          <p className="text-muted text-sm">
            A product with no options has a single variant. Add options like Size or Colour to build
            a matrix.
          </p>
        ) : (
          <ul className="space-y-3">
            {options.fields.map((field, index) => (
              <li key={field.id} className="flex flex-wrap items-end gap-3">
                <div className="w-40">
                  <TextField
                    label="Name"
                    placeholder="Size"
                    error={errorMessage(errors.options?.[index]?.name)}
                    {...form.register(`options.${index}.name`)}
                  />
                </div>
                <div className="min-w-64 flex-1">
                  <TextField
                    label="Values"
                    placeholder="S, M, L"
                    hint="Comma separated."
                    error={errorMessage(errors.options?.[index]?.values?.root)}
                    defaultValue={(defaultValues.options?.[index]?.values ?? []).join(', ')}
                    onChange={(event) =>
                      form.setValue(
                        `options.${index}.values`,
                        splitValues(event.currentTarget.value),
                        { shouldValidate: form.formState.isSubmitted },
                      )
                    }
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => options.remove(index)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">Media</h2>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            // `position` is omitted on purpose: the server renumbers from the array order, so a
            // number set here would only be a second source of truth that could disagree.
            onClick={() => media.append({ url: '', alt: null })}
          >
            Add image
          </Button>
        </div>

        {media.fields.length === 0 ? (
          <p className="text-muted text-sm">
            No images. The first one becomes the product thumbnail.
          </p>
        ) : (
          <ul className="space-y-3">
            {media.fields.map((field, index) => (
              <li key={field.id} className="flex flex-wrap items-end gap-3">
                <div className="min-w-72 flex-1">
                  <TextField
                    label={index === 0 ? 'Image URL (thumbnail)' : 'Image URL'}
                    placeholder="https://cdn.example.com/front.jpg"
                    error={errorMessage(errors.media?.[index]?.url)}
                    {...form.register(`media.${index}.url`)}
                  />
                </div>
                <div className="min-w-48 flex-1">
                  <TextField
                    label="Alt text"
                    hint="Describe the image for screen readers and search."
                    error={errorMessage(errors.media?.[index]?.alt)}
                    {...form.register(`media.${index}.alt`)}
                  />
                </div>
                <div className="flex items-center gap-1">
                  {/*
                    Order is the whole point of this list: the first image is the thumbnail and the
                    rest is gallery order, so being able to say "this one first" without deleting
                    and retyping a URL is the difference between a usable editor and a chore.
                    `position` is renumbered from the array order server-side, so moving a row here
                    is the only thing that has to happen.
                  */}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label={`Move image ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => media.move(index, index - 1)}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label={`Move image ${index + 1} down`}
                    disabled={index === media.fields.length - 1}
                    onClick={() => media.move(index, index + 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label={`Remove image ${index + 1}`}
                    onClick={() => media.remove(index)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-live="polite">
        <h2 className="text-base font-semibold">
          Variants{matrix.length > 0 && <span className="text-muted"> · {matrix.length}</span>}
        </h2>
        {matrix.length === 0 ? (
          <p className="text-muted text-sm">
            {drafts.length === 0
              ? 'No options, so this product will have a single default variant.'
              : 'Give every option at least one value to see the variants they produce.'}
          </p>
        ) : (
          <div className="border-line bg-surface overflow-x-auto rounded-lg border">
            <table className="w-full text-sm" aria-label="Variants this product will have">
              <thead className="border-line bg-canvas border-b">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Variant
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Suggested SKU
                  </th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {matrix.map((combination) => {
                  const title = variantTitle(combination, drafts);
                  return (
                    <tr key={title}>
                      <td className="px-3 py-2">{title}</td>
                      <td className="text-muted px-3 py-2 font-mono text-xs">
                        {suggestSku(handle, combination)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-muted text-xs">
          Variants are created from this matrix after the product is saved; SKUs and prices are
          editable on the product page.
        </p>
      </section>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
