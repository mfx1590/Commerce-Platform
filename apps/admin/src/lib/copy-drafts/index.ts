/**
 * AI product copy drafts (#608, CONTRACT CHANGE #664, Admin API 0.4.26). Pure — the permission
 * row, the fields, and what every refusal of `draftProductCopy` says. No React, no `next/*`.
 *
 * A draft is NEVER written to the product: the editor shows it beside the current copy, the human
 * edits it and saves with the normal `updateProduct`.
 */

import type { AdminComponents, AdminError } from '../api/admin-client';
import type { Principal } from '../nav/navigation';
import { holds, type PermissionRule } from '../permissions/rules';

export type ProductCopyDraft = AdminComponents['ProductCopyDraft'];

/** `draftProductCopy`'s `x-permission` (pinned against the yaml in a unit test). */
export const COPY_DRAFT_PERMISSIONS = {
  draftProductCopy: { relation: 'store_staff', object: 'store' },
  // The save is the normal `updateProduct`; its row guards the copy panel's own save action.
  updateProduct: { relation: 'store_staff', object: 'store' },
} as const satisfies Record<string, PermissionRule>;

export function mayDraftCopy(principal: Principal, storeId: string): boolean {
  return holds(principal, COPY_DRAFT_PERMISSIONS.draftProductCopy, storeId);
}

export const COPY_FIELDS = ['title', 'description', 'bullets', 'seo'] as const;
export type CopyField = (typeof COPY_FIELDS)[number];

export const COPY_FIELD_LABELS: Record<CopyField, string> = {
  title: 'Title',
  description: 'Description',
  bullets: 'Bullets',
  seo: 'SEO title and description',
};

/** One refusal as the editor shows it: a heading, the explanation, and whether retrying makes sense. */
export interface DraftRefusal {
  code: string;
  title: string;
  message: string;
  /** Seconds before the button works again (`ai_rate_limited`'s Retry-After). */
  retryAfterSeconds?: number;
  /** "Try again" is offered. */
  retry: boolean;
}

function details(error: AdminError): Record<string, unknown> {
  return (error.details as Record<string, unknown> | undefined) ?? {};
}

function formatWhen(iso: unknown): string | null {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return null;
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Every refusal from the contract, in words; the editor keeps working whatever comes back. 401/403
 * are the screen's refusal panel (handled by the caller), everything else is this.
 */
export function describeDraftError(failure: {
  status: number;
  error: AdminError;
  retryAfterSeconds?: number;
}): DraftRefusal {
  const { status, error } = failure;
  const d = details(error);
  switch (error.code) {
    case 'ai_disabled':
      return {
        code: error.code,
        title: 'AI drafting is switched off',
        message:
          'AI is turned off for this platform, so no draft can be made. Edit the copy by hand as usual.',
        retry: false,
      };
    case 'ai_budget_exceeded': {
      const used = typeof d['used_tokens'] === 'number' ? d['used_tokens'] : null;
      const limit = typeof d['limit_tokens'] === 'number' ? d['limit_tokens'] : null;
      const resets = formatWhen(d['resets_at']);
      return {
        code: error.code,
        title: 'This store’s monthly AI budget is used up',
        message:
          'No more drafts this month' +
          (used !== null && limit !== null
            ? ` (${used.toLocaleString('en')} of ${limit.toLocaleString('en')} tokens used)`
            : '') +
          (resets !== null ? `; it resets on ${resets}.` : '.'),
        retry: false,
      };
    }
    case 'ai_rate_limited': {
      const seconds = failure.retryAfterSeconds;
      return {
        code: error.code,
        title: 'Too many drafts in a short time',
        message:
          seconds !== undefined
            ? `Wait ${seconds} s and try again.`
            : 'Wait a moment and try again.',
        ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
        retry: true,
      };
    }
    case 'ai_refused': {
      const category = typeof d['category'] === 'string' ? ` (${d['category']})` : '';
      return {
        code: error.code,
        title: 'The model declined to write this draft',
        message: `It refused the request${category}. Reword the product's facts (title, attributes, tags) and try again.`,
        retry: true,
      };
    }
    case 'ai_unavailable':
      return {
        code: error.code,
        title: 'The AI provider did not answer',
        message: 'Nothing was drafted. Try again in a moment.',
        retry: true,
      };
    case 'ai_invalid_draft':
      return {
        code: error.code,
        title: 'The draft came back incomplete',
        message: 'The model’s answer did not have the requested fields. Try again.',
        retry: true,
      };
    case 'unavailable':
      return {
        code: error.code,
        title: 'Drafting is unavailable right now',
        message: 'Nothing was sent to the AI. Try again shortly.',
        retry: true,
      };
    default:
      break;
  }
  if (status === 404) {
    return {
      code: error.code,
      title: 'Product not found',
      message: 'This product no longer exists in this store.',
      retry: false,
    };
  }
  if (status === 400) {
    return {
      code: error.code,
      title: 'The request was not accepted',
      message: `${error.message} — check the locale is one of the store's enabled locales and pick at least one field.`,
      retry: false,
    };
  }
  return {
    code: error.code,
    title: 'Drafting failed',
    message: `${error.message}. Try again.`,
    retry: true,
  };
}

// ---------------------------------------------------------------------------- the save

type Product = AdminComponents['Product'];

/** The copy as the editor compares it: the product holds one title, description and seo. */
export interface EditableCopy {
  title: string;
  description: string;
  bullets: string[];
  seo: { title: string; description: string };
}

function seoString(seo: Record<string, unknown> | undefined, key: string): string {
  const value = seo?.[key];
  return typeof value === 'string' ? value : '';
}

/** The product's current copy (no bullets field exists on a product: they live in the description). */
export function currentCopy(product: Pick<Product, 'title' | 'description' | 'seo'>): EditableCopy {
  const seo = product.seo as Record<string, unknown> | undefined;
  return {
    title: product.title,
    description: product.description ?? '',
    bullets: [],
    seo: { title: seoString(seo, 'title'), description: seoString(seo, 'description') },
  };
}

/** The draft as editable text, starting from the current copy for the fields not drafted. */
export function editableDraft(
  draft: ProductCopyDraft['draft'],
  current: EditableCopy,
): EditableCopy {
  return {
    title: draft.title ?? current.title,
    description: draft.description ?? current.description,
    bullets: draft.bullets ?? [],
    seo: draft.seo ?? current.seo,
  };
}

/**
 * The description without a trailing "- " list (the bullets a previous save put there), so a
 * re-drafted list REPLACES it instead of appending a second one.
 */
export function stripTrailingList(description: string): string {
  const lines = description.trimEnd().split('\n');
  let end = lines.length;
  while (end > 0 && /^- /.test(lines[end - 1] ?? '')) end--;
  if (end === lines.length) return description.trimEnd();
  return lines.slice(0, end).join('\n').trimEnd();
}

/** Bullets joined into the description as a "- " list — exactly what is saved and shown. An
 * existing trailing list is replaced, never doubled. */
export function withBullets(description: string, bullets: readonly string[]): string {
  const items = bullets.map((b) => b.trim()).filter((b) => b !== '');
  if (items.length === 0) return description;
  const list = items.map((b) => `- ${b}`).join('\n');
  const base = stripTrailingList(description);
  return base.trim() === '' ? list : `${base}\n\n${list}`;
}

/** The PARTIAL `updateProduct` body for the accepted fields only. */
export interface CopyPatch {
  title?: string;
  description?: string;
  seo?: Record<string, unknown>;
}

export function draftToProductPatch(
  product: Pick<Product, 'description' | 'seo'>,
  accepted: ReadonlySet<CopyField>,
  edited: EditableCopy,
): CopyPatch {
  const patch: CopyPatch = {};
  if (accepted.has('title')) patch.title = edited.title.trim();
  if (accepted.has('description') || accepted.has('bullets')) {
    const base = accepted.has('description') ? edited.description : (product.description ?? '');
    patch.description = accepted.has('bullets') ? withBullets(base, edited.bullets) : base;
  }
  if (accepted.has('seo')) {
    patch.seo = {
      ...((product.seo as Record<string, unknown> | undefined) ?? {}),
      title: edited.seo.title.trim(),
      description: edited.seo.description.trim(),
    };
  }
  return patch;
}

// ---------------------------------------------------------------------------- the diff

export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** A line diff (LCS) of the current copy against the draft, for the side-by-side view. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++]! });
  while (j < m) out.push({ kind: 'added', text: b[j++]! });
  return out;
}
