// AI copy drafts for a product (#608, P5.9; CONTRACT CHANGE #664; D8 / D9 feature 1). `draftProductCopy` asks the
// guarded AI gateway (`@platform/ai`, purpose `drafting`) for a draft of one product's copy in one locale and RETURNS
// it. Nothing is written to the product: the admin shows the draft beside the current copy, a human edits it and
// saves with the normal `updateProduct`. The only write is the gateway's own `ai_call_audit` row (no content).
//
// What the model sees — and nothing else: the product's own facts (title, subtitle, brand name, category name, tags,
// `attributes`, option names and values), the store's brand voice and audience (`store.settings.content.*`, a
// neutral default when unset) and the locale. No customer, order or cart table is read here, and the gateway's
// denylist refuses a customer field at type level and at runtime.
//
// The gateway's typed errors become the contract's typed results the admin can explain (`toAppError`).
import type { Queryable, ScopedClient } from '@platform/db';
import {
  AiAuditError,
  AiBudgetExceededError,
  AiConfigError,
  AiDisabledError,
  AiLimiterError,
  AiRateLimitedError,
  AiRefusedError,
  AiTransportError,
  createAiGateway,
  createAnthropicTransport,
  createPgAuditSink,
  createRedisLimiter,
  DeniedFieldError,
  TemplateError,
  type AiGateway,
  type AiTransport,
  type UsageLimiter,
} from '@platform/ai';
import { getPool } from '../../lib/db';
import { AppError, notFound, validationError } from '../../lib/errors';

export const COPY_FIELDS = ['title', 'description', 'bullets', 'seo'] as const;
export type CopyField = (typeof COPY_FIELDS)[number];

/**
 * The template the endpoint renders. `product-copy-draft@2` (window 14: one JSON object with exactly the requested
 * keys, and a `fields` variable) replaces @1 when it lands — a change of this constant and of `variablesFor`. @1
 * answers plain text (paragraphs + up to five "- " bullets): `parseDraft` reads both, and with @1 a request for
 * `title` or `seo` is `ai_invalid_draft` (the answer cannot hold them).
 */
export const COPY_TEMPLATE = {
  key: 'product-copy-draft@1',
  id: 'product-copy-draft',
  version: 1,
} as const;

/** When `store.settings.content.brand_voice` / `.audience` are unset (#664 decision 2). */
export const DEFAULT_BRAND_VOICE = 'clear, friendly and factual';
export const DEFAULT_AUDIENCE = 'everyone';

export interface DraftProductCopyInput {
  productId: string;
  locale: string;
  fields: readonly string[];
  /** `staff_user.id` of the person asking (audited by the gateway). */
  actorId: string | null;
}

export interface ProductCopyDraftBody {
  title?: string;
  description?: string;
  bullets?: string[];
  seo?: { title: string; description: string };
}

/** `ProductCopyDraft` (Admin API 0.4.26). */
export interface ProductCopyDraft {
  product_id: string;
  locale: string;
  fields: CopyField[];
  draft: ProductCopyDraftBody;
  brand_voice_source: 'settings' | 'default';
  model: string;
  template: { id: string; version: number };
  created_at: string;
}

/** Builds the gateway for one call. The default is the real one; tests swap in the fake transport. */
export type CopyDraftGatewayFactory = (ctx: {
  organizationId: string;
  storeId: string;
  actorId: string | null;
}) => AiGateway;

// One limiter (Redis) per process, created on first use; the transport is resolved only when a call goes out, so
// `AI_ENABLED` off is `ai_disabled` (the gateway refuses before the transport) even without a key configured.
let redisLimiter: UsageLimiter | null = null;
const lazyTransport: AiTransport = {
  kind: 'anthropic',
  complete: (req) => createAnthropicTransport().complete(req),
} as AiTransport;

const defaultFactory: CopyDraftGatewayFactory = (ctx) =>
  createAiGateway({
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    purpose: 'drafting',
    actorId: ctx.actorId,
    transport: lazyTransport,
    limiter: (redisLimiter ??= createRedisLimiter()),
    audit: createPgAuditSink(getPool()),
  });

let factory: CopyDraftGatewayFactory = defaultFactory;

/** Replaces the gateway factory (tests: the deterministic fake). Returns the previous one. */
export function setCopyDraftGatewayFactory(next: CopyDraftGatewayFactory): CopyDraftGatewayFactory {
  const previous = factory;
  factory = next;
  return previous;
}

interface ProductFacts {
  title: string;
  facts: string[];
  brandVoice: string;
  audience: string;
  voiceSource: 'settings' | 'default';
}

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

/** The product's own facts, one per line, from product tables only. 404 for a product the client cannot see. */
async function productFacts(
  tx: Queryable,
  storeId: string,
  productId: string,
  locale: string,
): Promise<ProductFacts> {
  const p = await tx.query<{
    title: string;
    subtitle: string | null;
    brand_name: string | null;
    tags: string[];
    attributes: Record<string, unknown>;
    category: string | null;
    settings: Record<string, unknown> | null;
  }>(
    `SELECT p.title, p.subtitle, p.brand_name, p.tags, p.attributes, c.name AS category, s.settings
     FROM product p
     JOIN store s ON s.id = p.store_id
     LEFT JOIN product_category c ON c.id = p.category_id
     WHERE p.id = $1 AND p.store_id = $2`,
    [productId, storeId],
  );
  const row = p.rows[0];
  if (!row) throw notFound('product', productId);
  const enabled = await tx.query(`SELECT 1 FROM store_locale WHERE store_id = $1 AND locale = $2`, [
    storeId,
    locale,
  ]);
  if (!enabled.rows[0]) {
    throw validationError('invalid copy draft request', {
      locale: 'a locale enabled for the store',
    });
  }
  const options = await tx.query<{ name: string; values: string[] }>(
    `SELECT name, values FROM product_option WHERE product_id = $1 ORDER BY position, name`,
    [productId],
  );

  const facts: string[] = [];
  if (row.subtitle) facts.push(`subtitle: ${row.subtitle}`);
  if (row.brand_name) facts.push(`brand: ${row.brand_name}`);
  if (row.category) facts.push(`category: ${row.category}`);
  if (row.tags.length) facts.push(`tags: ${row.tags.join(', ')}`);
  for (const [key, value] of Object.entries(row.attributes ?? {})) {
    if (value === null || value === undefined || typeof value === 'object') continue; // scalars only
    facts.push(`${key}: ${String(value)}`);
  }
  for (const o of options.rows) facts.push(`${o.name}: ${o.values.join(', ')}`);

  const content = (row.settings?.content ?? {}) as Record<string, unknown>;
  const voice = text(content.brand_voice, 500);
  return {
    title: row.title,
    facts,
    brandVoice: voice ?? DEFAULT_BRAND_VOICE,
    audience: text(content.audience, 200) ?? DEFAULT_AUDIENCE,
    voiceSource: voice ? 'settings' : 'default',
  };
}

const BULLET = /^\s*(?:[-•*]|\d+[.)])\s+(.+?)\s*$/;

/**
 * The model's answer → the requested fields. Reads @2's JSON object, and @1's plain text (paragraphs → `description`,
 * bullet lines → `bullets`). Anything requested that the answer does not hold → `ai_invalid_draft { missing }`.
 */
export function parseDraft(answer: string, fields: readonly CopyField[]): ProductCopyDraftBody {
  let parsed: Record<string, unknown> | null = null;
  const trimmed = answer.trim();
  const json = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)?.[1] ?? trimmed;
  if (json.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(json);
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    const lines = trimmed.split(/\r?\n/);
    const bullets = lines.map((l) => l.match(BULLET)?.[1]).filter((b): b is string => !!b);
    const prose = lines
      .filter((l) => !BULLET.test(l))
      .join('\n')
      .trim();
    parsed = {
      ...(prose ? { description: prose } : {}),
      ...(bullets.length ? { bullets } : {}),
    };
  }

  const draft: ProductCopyDraftBody = {};
  const missing: string[] = [];
  for (const f of fields) {
    const v = parsed[f];
    if (f === 'title' || f === 'description') {
      const s = text(v, f === 'title' ? 200 : 5000);
      if (s) draft[f] = s;
      else missing.push(f);
    } else if (f === 'bullets') {
      const list = Array.isArray(v)
        ? v
            .map((b) => text(b, 200))
            .filter((b): b is string => !!b)
            .slice(0, 5)
        : [];
      if (list.length) draft.bullets = list;
      else missing.push(f);
    } else {
      const seo = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      const title = text(seo.title, 70);
      const description = text(seo.description, 160);
      if (title && description) draft.seo = { title, description };
      else missing.push(f);
    }
  }
  if (missing.length) {
    throw new AppError('ai_invalid_draft', 'the AI answer did not contain the requested fields', {
      missing,
    });
  }
  return draft;
}

/** The first instant of the next calendar month, UTC — when a store's monthly token budget resets. */
const nextMonthUtc = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

/** The gateway's typed errors → the contract's typed results (#664). Anything else is left alone. */
export function toAppError(err: unknown, now: Date = new Date()): unknown {
  if (err instanceof AiDisabledError) return new AppError('ai_disabled', 'AI is switched off');
  if (err instanceof AiBudgetExceededError) {
    return new AppError('ai_budget_exceeded', "the store's monthly AI budget is used up", {
      used_tokens: err.usedTokens,
      limit_tokens: err.limitTokens,
      resets_at: nextMonthUtc(now),
    });
  }
  if (err instanceof AiRateLimitedError) {
    return new AppError(
      'ai_rate_limited',
      'too many AI requests for this store; try again in a minute',
      { limit_per_minute: err.limitPerMinute },
      undefined,
      { 'Retry-After': '60' },
    );
  }
  if (err instanceof AiRefusedError) {
    return new AppError(
      'ai_refused',
      'the AI declined to write this draft; reword the product facts',
      {
        category: err.category,
      },
    );
  }
  if (err instanceof AiTransportError) {
    return new AppError('ai_unavailable', 'the AI provider could not be reached', {
      error_class: err.errorClass,
    });
  }
  if (err instanceof AiLimiterError || err instanceof AiAuditError) {
    return new AppError('unavailable', 'AI drafting is unavailable right now; nothing was sent');
  }
  if (
    err instanceof AiConfigError ||
    err instanceof TemplateError ||
    err instanceof DeniedFieldError
  ) {
    return new AppError('internal', 'AI drafting is misconfigured');
  }
  return err;
}

/**
 * `POST /admin/stores/{storeId}/products/{productId}/copy-drafts` (`store_staff`, the same as `updateProduct`):
 * the draft, never saved. The product is read on the caller's store-scoped client (another store's product is a
 * 404); the gateway call runs outside any transaction (no database transaction held across a network call).
 */
export async function draftProductCopy(
  client: ScopedClient,
  storeId: string,
  input: DraftProductCopyInput,
): Promise<ProductCopyDraft> {
  const fields = [...new Set(input.fields)];
  const problems: Record<string, string> = {};
  if (
    typeof input.locale !== 'string' ||
    !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.locale)
  ) {
    problems.locale = 'BCP 47 locale';
  }
  if (fields.length === 0 || fields.some((f) => !(COPY_FIELDS as readonly string[]).includes(f))) {
    problems.fields = `one or more of ${COPY_FIELDS.join(', ')}`;
  }
  if (Object.keys(problems).length) throw validationError('invalid copy draft request', problems);

  const facts = await client.transaction((tx) =>
    productFacts(tx, storeId, input.productId, input.locale),
  );
  const ai = factory({
    organizationId: client.context.organizationId,
    storeId,
    actorId: input.actorId,
  });
  let answer: Awaited<ReturnType<AiGateway['complete']>>;
  try {
    answer = await ai.complete(COPY_TEMPLATE.key, {
      brandVoice: facts.brandVoice,
      locale: input.locale,
      audience: facts.audience,
      productTitle: facts.title,
      attributes: facts.facts,
    });
  } catch (err) {
    throw toAppError(err);
  }
  return {
    product_id: input.productId,
    locale: input.locale,
    fields: fields as CopyField[],
    draft: parseDraft(answer.text, fields as CopyField[]),
    brand_voice_source: facts.voiceSource,
    model: answer.servedModel || answer.model,
    template: { id: COPY_TEMPLATE.id, version: COPY_TEMPLATE.version },
    created_at: new Date().toISOString(),
  };
}
