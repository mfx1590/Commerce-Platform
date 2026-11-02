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
src/pg-audit.ts            createPgAuditSink: ai_call_audit (packages/db 0205, 0206) in store or organization scope
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
  purpose: 'drafting', // or 'classification', 'analysis'
  actorId,
  transport: createAnthropicTransport(), // reads AI_ANTHROPIC_API_KEY only
  limiter: createRedisLimiter(), // REDIS_URL
  audit: createPgAuditSink(appPool), // ai_call_audit, store (or organization) scope, append-only
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

### Store or organization scope (#669)

`storeId` is a store's id, or `null` for an organization-scope call (an HQ question over several stores). **A caller
may build a `storeId: null` gateway only after its own organization-level permission check**: the gateway does not
check permissions, and its rows are written through the organization client. A null
store uses the organization's OWN monthly budget (`AI_ORG_MONTHLY_TOKEN_BUDGET`, default: the store budget) and its own
minute (the same `AI_RATE_LIMIT_PER_MINUTE` number, keyed by organization); it never charges a store, and a store call
never charges the organization. Its audit rows have `store_id` NULL and are written in organization scope. The
limiter takes a `LimitScope` (`{ kind: 'store' | 'organization', id }`); store keys in Redis are unchanged
(`ai:budget:<storeId>:<yyyymm>`), organization keys are `ai:budget:org:<organizationId>:<yyyymm>`.

### Tool use: `runTools` (#669, for #606)

```ts
const run = await ai.runTools(
  'bi-qa-answer@3',
  { question, locale, today, window, stores, currencyNote },
  {
    tools: [{ name: 'query_metrics', description, inputSchema }], // inputSchema: a JSON Schema with type 'object'
    handle: async (call) => ({ content: JSON.stringify(await runMetricQuery(call.input)) }), // the caller validates input
    maxToolCalls: 5, // default 5, at most 8
    maxTokensTotal: 20_000, // optional ceiling on input + output across the steps of this run
  },
);
// run.text, run.toolCalls, run.steps, run.stopReason, run.usage, run.costMicroUsd, run.conversationId, run.auditIds
```

`locale` (bi-qa-answer@2 and @3) is validated by the caller, not here: pass `Intl.getCanonicalLocales(admin.locale)[0]`
and fall back to `en` when that throws or is empty. The gateway escapes it like every value, so it cannot leave its
`<locale>` tag, but it does not check that it is a real BCP 47 tag.

- Order: the run's own options are checked (step 0's row on a refusal); steps 1–3 below (template, denylist, render
  and redact) run once; then for EVERY model step: the run's `maxTokensTotal` ceiling (`scope: 'run'`), the kill switch,
  the scope's budget and minute, the call and settle, then that step's tool calls, then its audit row. A step's
  reservation counts the system and user text, the turns so far and the tool definitions, plus `maxTokens`. A run of
  N steps uses N calls of the minute.
- While the answer has tool calls, each is run in order: a name the caller did not offer gets an `is_error` result
  ("unknown tool") and `handle` is never called for it; every result is parsed as JSON (plain text has no keys),
  checked against the denylist (`DeniedFieldError`, nothing sent) and redacted before it goes back to the model.
  A JSON result has only its strings redacted (values and keys, `\u` escapes decoded first) plus Luhn-valid
  13–19 digit integers (`"[card]"`); other numbers, booleans, null and the layout stay byte for byte, so
  `"bookings_minor":1234567890` stays a number and the result stays valid JSON (#680; see "Redaction" below).
  A plain-text result is redacted as a whole, as before.
  The tool INPUT is the model's: it is not redacted, but it is part of the next step's hash.
- Calls to an unknown tool count toward `maxToolCalls` like any other. A step whose calls would take the run past
  `maxToolCalls` is not run: `AiToolLoopError` (`details.max_tool_calls`),
  outcome `tool_loop_cap`, no partial answer. A step cut off at `max_tokens` ends the run with that stop reason and
  runs none of its tools. A refusal is `AiRefusedError`; a throwing `handle` ends the run (audited `error`, the class
  only) and its error is rethrown.
- The assistant turn goes back to the model exactly as the transport returned it (thinking blocks and their
  signatures included); the gateway never reads, logs or audits it.
- ONE audit row per model step, written after that step's tools were handled, with `conversation_id` (the run's),
  `step` (0-based) and `tool_names` (the names that step asked for; a name not offered is recorded as `unknown`).
  A run refused before its first call writes one row with `step = 0`. `input_sha256` hashes what that step sent: the
  system and user text, then the turns as text, tool calls (name, input) and the redacted results (never the
  transport's own blocks). `redactions` on a step's row is cumulative for the run: the rendered prompt's masked spans
  plus those in every tool result sent so far. `complete()` rows have `conversation_id` and `step` NULL.
- Tests script the model with `createFakeTransport({ script: [{ toolUse: [{ name, input }] }, { text }] })`; a step can be
  a function of the request, or an Error. The fake records every request (system, user, turns, tools).

## Templates

A published template is never edited: a changed prompt is a new `v<N+1>.json`, and callers move to it by key.

| Key                          | Purpose        | maxTokens     | Variables                                                                                                                                                                                                                                                                                                       | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `product-copy-draft@1`       | drafting       | 1200          | `brandVoice`, `locale`, `audience`, `productTitle`, `attributes`                                                                                                                                                                                                                                                | plain text: two short paragraphs, then up to five bullets                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `product-copy-draft@2`       | drafting       | 2000          | as v1, plus `fields` (comma-separated: `title`, `description`, `bullets`, `seo`)                                                                                                                                                                                                                                | ONE strict-JSON object with every requested key and no others: `title` ≤ 200, `description` ≤ 5000 (paragraph breaks as `\n\n` in the string), `bullets` ≤ 5 × ≤ 200 (may be `[]`), `seo: { title ≤ 70, description ≤ 160 }` — the `ProductCopyDraft` shape of `draftProductCopy` (#608)                                                                                                                                                                                                               |
| `product-category-suggest@1` | classification | 64            | `productTitle`, `attributes`, `categories`                                                                                                                                                                                                                                                                      | one category handle from the list, or `none`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `bi-qa-answer@1`             | analysis       | 1200 per step | `question` (untrusted), `today`, `window`, `stores`, `currencyNote`                                                                                                                                                                                                                                             | for `runTools` with `query_metrics` (#606): only from tool results, every figure cited by its result's `ref` (`[q1]`; never by call order), per currency (never summed across), at most 5 calls; off-topic or an unlisted store is said without calling the tool                                                                                                                                                                                                                                       |
| `bi-qa-answer@2`             | analysis       | 1200 per step | as v1, plus `locale` (the admin's, e.g. `en-GB`; the caller validates it)                                                                                                                                                                                                                                       | as v1, plus (window 12's 30-question run): answers in the language of the question, `locale` only when that cannot be told; computes no figure unless no query returns it, then ONE difference or sum of exactly two figures (same currency, or two counts) or ONE ratio rounded half-up to 2 decimals, labelled `(derived: a [q1] − b [q2])`; top/most/least ask for the identifying dimension at grain `total` with `order_by` and a `limit`, one currency per query for money, item labels as given |
| `bi-qa-answer@3`             | analysis       | 1200 per step | as v2                                                                                                                                                                                                                                                                                                           | as v2, plus (window 12's second run): EVERY number not copied from a result, a count difference or "N more" included, is in the derived form (`12 more orders (derived: 95 [q1] − 83 [q2])`) or left out; a percentage change only when a result has it; stores named by code, never by id                                                                                                                                                                                                             |
| `support-reply-draft@1`      | drafting       | 700           | `question` (untrusted), `storeCode`, `brandVoice`, `locale`, `orderRef`, `orderStatus`, `paymentStatus`, `fulfillmentStatus`, `placedAt`, `shippedAt`, `deliveredAt`, `carrier`, `total`, `refundStatus`, `refunded`, `returnStatus`, `returnRequestedAt` (empty = unknown; money pre-formatted, e.g. `€49.76`) | plain text, 2–5 short sentences for a support agent to edit: no subject, no signature, no greeting with a name (#610, REQUEST #667)                                                                                                                                                                                                                                                                                                                                                                    |

Every drafting template uses only the given facts. In `product-copy-draft@2` each value sits in its own tag
(`<locale>`, `<brand_voice>`, `<audience>`, `<product_title>`, `<facts>`), the requested keys stay outside the tags,
and the system prompt says tag contents are data only: brand voice and audience set tone and reader, never claims.
A value cannot fake a tag boundary: the renderer escapes `&`, `<` and `>` in every value (step 3 below).
A missing fact drops the claim, never a requested key. The gateway returns the model's text as it is: the caller
parses the JSON and checks the keys and limits itself (the core answers `ai_invalid_draft` otherwise; check
`stopReason === 'max_tokens'` first, a cut-off answer is not valid JSON); the gateway never trusts or repairs an
answer. There is no structured-output (JSON schema) option in the transport yet.

`support-reply-draft@1` works the same way: `<locale>`, `<brand_voice>`, `<store>`, `<order>` (the order, refund and
return facts, one labelled line each; amounts already formatted) and `<question>`. The customer's question is answered,
never obeyed; the draft names only facts from `<order>`, says what is not known instead of guessing, and commits the
company to nothing the facts do not already show. The caller passes a projection without names, e-mail, address,
phone, tracking number or uuid; the denylist and redaction are the second guard (see "Redaction" below for what is
masked in the free-text question and what is not). Money arrives formatted as the customer sees it (`€49.76`, `¥2,495`; the caller formats it with `Intl`), and the
model copies it exactly and never recomputes it; the redaction placeholders are explained to the model, which never
repeats or asks for them.

## Order of a call

1. The template exists and matches the gateway's purpose (`TemplateError`).
2. No denylisted field at any depth (`DeniedFieldError`).
3. Render, escaping `&`, `<` and `>` in every variable value as `&amp;`, `&lt;`, `&gt;` (the template text is not
   escaped), so no value can open or close a tag such as `<facts>`; redact the system and user text; hash the
   escaped, redacted input (SHA-256), which is exactly what is sent.
4. Kill switch: `AI_ENABLED` must be exactly `1` (`AiDisabledError`).
5. Reserve the input estimate plus `maxTokens` against the month and minute of the store, or of the organization for
   `storeId: null` (`AiBudgetExceededError` with `details: { scope, used_tokens, limit_tokens, resets_at }`,
   `AiRateLimitedError` with `scope`). In a tool-use run the run's `maxTokensTotal` is checked first (`scope: 'run'`).
6. Call the model. Server-side refusal fallbacks are off in Phase 5: a refusal is `AiRefusedError` for the human to reword.
7. Settle the reservation to the real usage (a failed call refunds it all).
8. Price by the model that answered; write the audit row; a refusal throws `AiRefusedError` with its category.

Every outcome, including each refusal before the call, writes exactly one audit row. A call refused before
rendering (unknown template, denied field) has no input, so its `input_sha256` is `NO_INPUT_SHA256` = SHA-256 of the
empty string (the column is NOT NULL, 64 hex); an ill-shaped template key is audited as `unknown`. A failed audit write withholds
the draft (`AiAuditError`).

## Redaction: exactly what is masked

`redact()` runs over every rendered string (and, in a tool-use run, every tool result) before it is sent. It replaces a
match with a placeholder and counts it; the counts go into the audit row, the text never does. It is the second guard:
the first is the denylist, which keeps customer fields out of the variables altogether.

| Placeholder  | Masked                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `[email]`    | an e-mail address (`name@domain.tld`)                                                                                                  |
| `[card]`     | 13–19 digits, grouped by spaces or hyphens or not, that pass the Luhn check                                                            |
| `[iban]`     | an IBAN that passes mod-97, grouped or not                                                                                             |
| `[address]`  | a street with a number (NL, DE, UK, US, FR shapes), an NL postcode followed by a place, a full UK postcode, a US `City, ST 12345` line |
| `[tracking]` | UPS `1Z` + 16; DHL Express exactly 10 digits, DHL parcel `JJD` + digits; PostNL `3S` + four letters + digits                           |
| `[phone]`    | at least 9 digits shaped like a phone: starting with `+`, `00`, `0` or `(`, or with separators                                         |

**Not masked:** names; an e-mail address spelled out in words ("anna at example dot org"); other carriers' tracking
numbers (GLS, DPD, …); an address in a shape not listed; free-text identity details. A caller must not put these in a
variable; for free text it cannot control (a customer's question) they may reach the model, which is a recorded
residual. The patterns lean towards masking: a bare 10-digit number (an ISBN-10, a US phone number without a
separator) becomes `[tracking]`, and a 12/13-digit code that starts with `0` is taken for a phone number.
GTIN-13s, UPC-12s that do not start with `0`, 13-digit order numbers and short numbers stay.

**Left as they are:** RFC 4122 uuids (`8-4-4-4-12` hex, any case, version 1–8 and variant 8/9/a/b, plus the nil
uuid; #680), bounded by any character that is not a letter or digit, so `ord_<uuid>` counts too. They are ids, not
personal data, and their digit groups would otherwise read as phone, card or tracking numbers
(`00000000-0000-4000-8000-000000000031` once became `[phone]-[phone]`). E-mail is masked first, over the whole
text, so a uuid used as the local part of an address does not shield it; every other pattern runs on the text between
uuids, so a phone or card number right next to a uuid is still masked. Residual: a phone number written with a uuid
in its middle is no longer masked.

**JSON tool results** (`runTools`): only strings (values and keys) go through the patterns above. A number is left
as written, with one exception: an integer of 13–19 digits that passes the Luhn check becomes the string `"[card]"`.
So a 10-digit tracking number held as a JSON NUMBER is NOT masked (manager decision on #681: numeric BI figures
such as `"bookings_minor":1234567890` are worth more, and tracking numbers are strings in practice); the same
number inside a string, or in a plain-text result, is masked as `[tracking]`.

## Models and prices

| Purpose        | Default             | Override env              | Fallbacks |
| -------------- | ------------------- | ------------------------- | --------- |
| drafting       | `claude-sonnet-5-5` | `AI_MODEL_DRAFTING`       | off       |
| classification | `claude-haiku-5-5`  | `AI_MODEL_CLASSIFICATION` | off       |
| analysis       | `claude-sonnet-5-5` | `AI_MODEL_ANALYSIS`       | off       |

An override must be a priced model (`PRICES`), else `AiConfigError`. Cost is integer micro-USD, rounded up.

## Environment

| Variable                      | Default                   | Meaning                                                         |
| ----------------------------- | ------------------------- | --------------------------------------------------------------- |
| `AI_ENABLED`                  | off                       | exactly `1` to allow calls                                      |
| `AI_ANTHROPIC_API_KEY`        | —                         | the key; never `ANTHROPIC_API_KEY`                              |
| `AI_MONTHLY_TOKEN_BUDGET`     | `200000`                  | tokens per store per calendar month (UTC)                       |
| `AI_ORG_MONTHLY_TOKEN_BUDGET` | `AI_MONTHLY_TOKEN_BUDGET` | tokens per organization per month, for `storeId: null` calls    |
| `AI_RATE_LIMIT_PER_MINUTE`    | `10`                      | calls (model steps) per store, and per organization, per minute |
| `REDIS_URL`                   | `redis://127.0.0.1:6381`  | the Redis limiter                                               |

## Public API

- `createAiGateway(opts)` → `{ storeId, purpose, model, complete(templateKey, variables), runTools(templateKey, variables, opts) }`; `estimateInputTokens`, `nextUtcMonth`, `DEFAULT_MAX_TOOL_CALLS`, `MAX_TOOL_CALLS_CAP`; types `AiToolRun`, `AiToolRunOptions`, `AiToolResult`
- Models: `PURPOSES`, `DEFAULT_MODELS`, `PRICES`, `FALLBACKS`, `modelFor`, `costMicroUsd`, `isPurpose`
- Templates: `TEMPLATES`, `getTemplate`, `renderTemplate`; types `TemplateKey`, `TemplateVariables<K>`
- Guards: `DENIED_FIELDS`, `findDeniedFields`, type `NoDeniedFields`; `redact`
- Limits: `createMemoryLimiter`, `createRedisLimiter`, `limitsFromEnv`, `orgLimitsFromEnv`, `scopeKey`, `DEFAULT_LIMITS`; types `Limits`, `LimitScope`, `UsageLimiter`
- Audit: `OUTCOMES`, `createPgAuditSink(appPool)`, `createMemoryAuditSink`, `NO_INPUT_SHA256` (the hash of a call refused before rendering); types `AuditRecord`, `AuditSink`
- Transport: `createAnthropicTransport`, `createFakeTransport`, `FALLBACK_BETA`, `ANTHROPIC_API_URL` (the fixed host; `ANTHROPIC_BASE_URL` is never read); types `AiTransport`, `AiRequest`, `AiResponse`, `AiTool`, `AiToolCall`, `AiToolResultBlock`, `AiTurn`, `AiAssistantContent`, `JsonSchemaObject`, `FakeStep`, `FakeScriptStep`, `FakeTransportOptions`
- Errors: `AiError`, `AiConfigError`, `AiDisabledError`, `AiBudgetExceededError` (type `BudgetScope`), `AiRateLimitedError`, `AiToolLoopError`,
  `DeniedFieldError`, `TemplateError`, `AiRefusedError`, `AiTransportError`, `AiAuditError`, `AiLimiterError` (the limiter could not reserve; audited as `error`, nothing sent)
