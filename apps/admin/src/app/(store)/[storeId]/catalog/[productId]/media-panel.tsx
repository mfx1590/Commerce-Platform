'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionRefusal } from '@/components/states/action-refusal';
import {
  deleteProductMediaAction,
  moveProductMediaAction,
  updateProductMediaAction,
  uploadProductMediaAction,
} from '@/app/actions/media';
import type { AdminComponents } from '@/lib/api/admin-client';
import { ALT_MAX, altProblem, missingAlt } from '@/lib/catalog/media';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

type ProductMedia = AdminComponents['ProductMedia'];

interface Failure {
  message: string | null;
  refusal?: ActionRefusalInfo | undefined;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif';
const input = 'border-line bg-surface h-9 rounded-md border px-2 text-sm';

/**
 * The product's images (#870 wave 1 item 5, PR B): upload one at a time (the server checks the
 * type from the file's content, the size, and alt text), edit alt text, tie an image to a variant,
 * reorder (the first is the product's thumbnail), delete with a confirmation. The thumbnails come
 * from Cloudinary's delivery host, the one image origin the admin's CSP allows besides itself.
 */
export function MediaPanel({
  storeId,
  productId,
  media,
  variants,
  canEdit,
  error,
}: {
  storeId: string;
  productId: string;
  media: readonly ProductMedia[];
  variants: readonly { id: string; title: string }[];
  /** store_staff: upload, edit, reorder, delete. Others read. A convenience; the server decides. */
  canEdit: boolean;
  /** The media list could not be read. */
  error?: string | null;
}) {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  const lacking = missingAlt(sorted);

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-danger text-sm">
          The images could not be read: {error}
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-muted text-sm">
          No images yet. The first one becomes the product thumbnail.
        </p>
      ) : (
        <>
          {lacking > 0 && (
            <p role="note" className="text-warning text-sm">
              {lacking} {lacking === 1 ? 'image has' : 'images have'} no alt text: describe{' '}
              {lacking === 1 ? 'it' : 'them'} before publishing — it is read to people who cannot
              see the image.
            </p>
          )}
          <ul aria-label="Product images" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((item, index) => (
              <MediaItem
                key={item.id}
                storeId={storeId}
                productId={productId}
                item={item}
                index={index}
                count={sorted.length}
                variants={variants}
                canEdit={canEdit}
              />
            ))}
          </ul>
        </>
      )}
      {canEdit && <UploadForm storeId={storeId} productId={productId} variants={variants} />}
    </div>
  );
}

function MediaItem({
  storeId,
  productId,
  item,
  index,
  count,
  variants,
  canEdit,
}: {
  storeId: string;
  productId: string;
  item: ProductMedia;
  index: number;
  count: number;
  variants: readonly { id: string; title: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [alt, setAlt] = useState(item.alt ?? '');
  const [variantId, setVariantId] = useState(item.variant_id ?? '');
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const label = (item.alt ?? '').trim() || `image ${index + 1}`;
  const altMessage = alt === (item.alt ?? '') ? null : altProblem(alt);
  const dirty = alt.trim() !== (item.alt ?? '').trim() || variantId !== (item.variant_id ?? '');

  const run = (
    work: () => Promise<{ status: string; formError?: string | null; refusal?: ActionRefusalInfo }>,
  ) => {
    if (pending) return;
    setFailure(null);
    startTransition(async () => {
      const result = await work();
      if (result.status === 'success') {
        setAsking(false);
        router.refresh();
        return;
      }
      setFailure({ message: result.formError ?? null, refusal: result.refusal });
    });
  };

  return (
    <li
      aria-label={`Image ${index + 1}: ${label}`}
      className="border-line space-y-2 rounded-lg border p-3"
    >
      {/* A plain <img>: Cloudinary already serves the sized rendition (variants.thumb). */}
      <img
        src={item.variants.thumb}
        alt={(item.alt ?? '').trim()}
        width={200}
        height={200}
        className="bg-canvas aspect-square w-full rounded-md object-cover"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {index === 0 && <Badge tone="accent">thumbnail</Badge>}
        {(item.alt ?? '').trim() === '' ? <Badge tone="warning">no alt text</Badge> : null}
        {item.variant_id && (
          <Badge>{variants.find((v) => v.id === item.variant_id)?.title ?? 'a variant'}</Badge>
        )}
      </div>
      {canEdit ? (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span>Alt text</span>
            <input
              value={alt}
              maxLength={ALT_MAX}
              onChange={(e) => setAlt(e.currentTarget.value)}
              className={input}
            />
          </label>
          {altMessage !== null && (
            <p role="alert" className="text-danger text-xs">
              {altMessage}
            </p>
          )}
          <label className="flex flex-col gap-1 text-xs">
            <span>Shown for</span>
            <select
              value={variantId}
              onChange={(e) => setVariantId(e.currentTarget.value)}
              className={input}
            >
              <option value="">The whole product</option>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.title}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending || !dirty || altMessage !== null}
              onClick={() =>
                run(() =>
                  updateProductMediaAction(storeId, productId, item.id, {
                    ...(alt.trim() !== (item.alt ?? '').trim() ? { alt } : {}),
                    ...(variantId !== (item.variant_id ?? '')
                      ? { variant_id: variantId === '' ? null : variantId }
                      : {}),
                  }),
                )
              }
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Move ${label} earlier`}
              disabled={pending || index === 0}
              onClick={() =>
                run(() => moveProductMediaAction(storeId, productId, item.id, index - 1))
              }
            >
              ←
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Move ${label} later`}
              disabled={pending || index === count - 1}
              onClick={() =>
                run(() => moveProductMediaAction(storeId, productId, item.id, index + 1))
              }
            >
              →
            </Button>
            {!asking ? (
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Delete ${label}`}
                onClick={() => setAsking(true)}
              >
                Delete…
              </Button>
            ) : null}
          </div>
          {asking && (
            <div
              role="alertdialog"
              aria-label={`Delete ${label}?`}
              className="border-warning/30 bg-warning/5 space-y-2 rounded-md border p-2 text-xs"
            >
              <p>Delete this image from the product? It cannot be undone here.</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => deleteProductMediaAction(storeId, productId, item.id))}
                >
                  {pending ? 'Deleting…' : 'Yes, delete'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setAsking(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
        </>
      ) : (
        <p className="text-muted text-xs">{(item.alt ?? '').trim() || 'No alt text.'}</p>
      )}
    </li>
  );
}

function UploadForm({
  storeId,
  productId,
  variants,
}: {
  storeId: string;
  productId: string;
  variants: readonly { id: string; title: string }[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [alt, setAlt] = useState('');
  const [failure, setFailure] = useState<(Failure & { fields?: Record<string, string> }) | null>(
    null,
  );
  const [done, setDone] = useState<string | null>(null);
  const altMessage = alt === '' ? null : altProblem(alt);

  return (
    <form
      ref={formRef}
      aria-label="Upload an image"
      className="border-line space-y-2 rounded-lg border border-dashed p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const data = new FormData(event.currentTarget);
        setFailure(null);
        setDone(null);
        const problem = altProblem(alt);
        if (problem !== null) {
          setFailure({ message: null, fields: { alt: problem } });
          return;
        }
        startTransition(async () => {
          const result = await uploadProductMediaAction(storeId, productId, data);
          if (result.status === 'success') {
            setDone('Uploaded and added to the product.');
            setAlt('');
            formRef.current?.reset();
            router.refresh();
            return;
          }
          setFailure({
            message: result.formError,
            refusal: result.refusal,
            fields: { ...result.fieldErrors },
          });
        });
      }}
    >
      <p className="text-sm font-medium">Upload an image</p>
      <p className="text-muted text-xs">
        One file at a time, up to 10 MB: JPEG, PNG, WebP, AVIF or GIF. The type is checked from the
        file itself.
      </p>
      <label className="flex flex-col gap-1 text-xs">
        <span>Image file</span>
        <input type="file" name="file" accept={ACCEPT} required className="text-sm" />
      </label>
      {failure?.fields?.['file'] && (
        <p role="alert" className="text-danger text-xs">
          {failure.fields['file']}
        </p>
      )}
      <label className="flex flex-col gap-1 text-xs">
        <span>Alt text (required)</span>
        <input
          name="alt"
          value={alt}
          maxLength={ALT_MAX}
          onChange={(e) => setAlt(e.currentTarget.value)}
          className={input}
        />
      </label>
      {(altMessage ?? failure?.fields?.['alt']) && (
        <p role="alert" className="text-danger text-xs">
          {altMessage ?? failure?.fields?.['alt']}
        </p>
      )}
      <label className="flex flex-col gap-1 text-xs">
        <span>Shown for</span>
        <select name="variant_id" defaultValue="" className={input}>
          <option value="">The whole product</option>
          {variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.title}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" type="submit" disabled={pending}>
        {pending ? 'Uploading…' : 'Upload'}
      </Button>
      {done !== null && (
        <p role="status" className="text-success text-xs">
          {done}
        </p>
      )}
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </form>
  );
}
