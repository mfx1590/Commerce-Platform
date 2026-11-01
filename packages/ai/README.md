# @platform/ai

The guarded Claude gateway (Phase 5, D8, #605). Owner: window 14. Rules for working here: [CLAUDE.md](./CLAUDE.md).

## Layout

```
templates/<id>/v<N>.json   versioned prompt templates (purpose, effort, maxTokens, declared variables, system, user)
scripts/generate.mjs       validates the templates -> src/generated/templates.ts (committed)
scripts/live-smoke.mjs     the one manual live call (--live-ok; never in CI)
src/models.ts              model registry, prices, cost
src/denylist.ts            denied customer fields (type-level NoDeniedFields + runtime findDeniedFields)
src/redact.ts              e-mail, IBAN (mod-97), card (Luhn), address/postcode, phone
src/limiter.ts             per-store monthly token budget + per-minute rate limit (memory, Redis)
src/audit.ts               AuditRecord, AuditSink, in-memory sink
src/pg-audit.ts            createPgAuditSink: ai_call_audit (packages/db 0205) through the tenant client
src/transport.ts           Anthropic SDK transport, deterministic fake
src/gateway.ts             createAiGateway
```

## Using it

```ts
import {
  createAiGateway,
  createAnthropicTransport,
  createPgAuditSink,
  createRedisLimiter,
} from '@platform/ai';

const ai = createAiGateway({
  organizationId,
  storeId,
  purpose: 'drafting', // or 'classification'
  actorId,
  transport: createAnthropicTransport(), // reads AI_ANTHROPIC_API_KEY only
  limiter: createRedisLimiter(), // REDIS_URL
  audit: createPgAuditSink(appPool), // ai_call_audit, store scope, append-only
});

const draft = await ai.complete('product-copy-draft@1', {
  brandVoice: 'warm and brief',
  locale: 'nl-NL',
  audience: 'everyone',
  productTitle: 'Linen tea towel',
  attributes: ['100% linen', '50 x 70 cm'],
});
// draft.text is a DRAFT: a human edits and publishes it.
```

The variables are typed per template; passing a denylisted field (`email`, `phone`, `postalCode`, …) is a compile
error and, if it gets through `as` casts, a `DeniedFieldError` at runtime.

## Templates

A published template is never edited: a changed prompt is a new `v<N+1>.json`, and callers move to it by key.

| Key                          | Purpose        | maxTokens | Variables                                                                        | Answer                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------- | --------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product-copy-draft@1`       | drafting       | 1200      | `brandVoice`, `locale`, `audience`, `productTitle`, `attributes`                 | plain text: two short paragraphs, then up to five bullets                                                                                                                                                                                                                                |
| `product-copy-draft@2`       | drafting       | 2000      | as v1, plus `fields` (comma-separated: `title`, `description`, `bullets`, `seo`) | ONE strict-JSON object with every requested key and no others: `title` ≤ 200, `description` ≤ 5000 (paragraph breaks as `\n\n` in the string), `bullets` ≤ 5 × ≤ 200 (may be `[]`), `seo: { title ≤ 70, description ≤ 160 }` — the `ProductCopyDraft` shape of `draftProductCopy` (#608) |
| `product-category-suggest@1` | classification | 64        | `productTitle`, `attributes`, `categories`                                       | one category handle from the list, or `none`                                                                                                                                                                                                                                             |

Every drafting template uses only the given facts. In `product-copy-draft@2` each value sits in its own tag
(`<locale>`, `<brand_voice>`, `<audience>`, `<product_title>`, `<facts>`), the requested keys stay outside the tags,
and the system prompt says tag contents are data only: brand voice and audience set tone and reader, never claims.
A value cannot fake a tag boundary: the renderer escapes `&`, `<` and `>` in every value (step 3 below).
A missing fact drops the claim, never a requested key. The gateway returns the model's text as it is: the caller
parses the JSON and checks the keys and limits itself (the core answers `ai_invalid_draft` otherwise; check
`stopReason === 'max_tokens'` first, a cut-off answer is not valid JSON); the gateway never trusts or repairs an
answer. There is no structured-output (JSON schema) option in the transport yet.

## Order of a call

1. The template exists and matches the gateway's purpose (`TemplateError`).
2. No denylisted field at any depth (`DeniedFieldError`).
3. Render, escaping `&`, `<` and `>` in every variable value as `&amp;`, `&lt;`, `&gt;` (the template text is not
   escaped), so no value can open or close a tag such as `<facts>`; redact the system and user text; hash the
   escaped, redacted input (SHA-256), which is exactly what is sent.
4. Kill switch: `AI_ENABLED` must be exactly `1` (`AiDisabledError`).
5. Reserve the input estimate plus `maxTokens` against the store's month and minute (`AiBudgetExceededError`, `AiRateLimitedError`).
6. Call the model. Server-side refusal fallbacks are off in Phase 5: a refusal is `AiRefusedError` for the human to reword.
7. Settle the reservation to the real usage (a failed call refunds it all).
8. Price by the model that answered; write the audit row; a refusal throws `AiRefusedError` with its category.

Every outcome, including each refusal before the call, writes exactly one audit row. A call refused before
rendering (unknown template, denied field) has no input, so its `input_sha256` is `NO_INPUT_SHA256` = SHA-256 of the
empty string (the column is NOT NULL, 64 hex); an ill-shaped template key is audited as `unknown`. A failed audit write withholds
the draft (`AiAuditError`).

## Models and prices

| Purpose        | Default             | Override env              | Fallbacks |
| -------------- | ------------------- | ------------------------- | --------- |
| drafting       | `claude-sonnet-5-5` | `AI_MODEL_DRAFTING`       | off       |
| classification | `claude-haiku-5-5`  | `AI_MODEL_CLASSIFICATION` | off       |

An override must be a priced model (`PRICES`), else `AiConfigError`. Cost is integer micro-USD, rounded up.

## Environment

| Variable                   | Default                  | Meaning                                   |
| -------------------------- | ------------------------ | ----------------------------------------- |
| `AI_ENABLED`               | off                      | exactly `1` to allow calls                |
| `AI_ANTHROPIC_API_KEY`     | —                        | the key; never `ANTHROPIC_API_KEY`        |
| `AI_MONTHLY_TOKEN_BUDGET`  | `200000`                 | tokens per store per calendar month (UTC) |
| `AI_RATE_LIMIT_PER_MINUTE` | `10`                     | calls per store per minute                |
| `REDIS_URL`                | `redis://127.0.0.1:6381` | the Redis limiter                         |

## Public API

- `createAiGateway(opts)` → `{ storeId, purpose, model, complete(templateKey, variables) }`; `estimateInputTokens`
- Models: `PURPOSES`, `DEFAULT_MODELS`, `PRICES`, `FALLBACKS`, `modelFor`, `costMicroUsd`, `isPurpose`
- Templates: `TEMPLATES`, `getTemplate`, `renderTemplate`; types `TemplateKey`, `TemplateVariables<K>`
- Guards: `DENIED_FIELDS`, `findDeniedFields`, type `NoDeniedFields`; `redact`
- Limits: `createMemoryLimiter`, `createRedisLimiter`, `limitsFromEnv`, `DEFAULT_LIMITS`; types `Limits`, `UsageLimiter`
- Audit: `OUTCOMES`, `createPgAuditSink(appPool)`, `createMemoryAuditSink`, `NO_INPUT_SHA256` (the hash of a call refused before rendering); types `AuditRecord`, `AuditSink`
- Transport: `createAnthropicTransport`, `createFakeTransport`, `FALLBACK_BETA`, `ANTHROPIC_API_URL` (the fixed host; `ANTHROPIC_BASE_URL` is never read); types `AiTransport`, `AiRequest`, `AiResponse`
- Errors: `AiError`, `AiConfigError`, `AiDisabledError`, `AiBudgetExceededError`, `AiRateLimitedError`,
  `DeniedFieldError`, `TemplateError`, `AiRefusedError`, `AiTransportError`, `AiAuditError`, `AiLimiterError` (the limiter could not reserve; audited as `error`, nothing sent)
