# Changelog — @platform/ai

## 0.1.0 — unreleased (#605, Phase 5 D8)

- `createAiGateway({ organizationId, storeId, purpose, … })` over the official `@anthropic-ai/sdk` 1.3.0 (exact pin).
- Model registry: drafting = `claude-sonnet-5-5`, classification = `claude-haiku-5-5`; env-overridable to priced models only.
- Versioned templates with ids (`product-copy-draft@1`, `product-category-suggest@1`), validated and typed by `scripts/generate.mjs`.
- Guards: customer-field denylist at the type level and at runtime; redaction of e-mail, phone, address/postcode, card (Luhn) and IBAN (mod-97).
- Server-side refusal fallbacks off for both purposes in Phase 5 (the transport supports them; the served model is audited).
- Per-store monthly token budget (default 200,000) and per-minute rate limit (default 10), in memory and in Redis (atomic Lua reserve/settle).
- `AI_ENABLED=1` kill switch (off by default); the key variable is `AI_ANTHROPIC_API_KEY` only.
- One audit record per call (ids, template, input hash, models, tokens, cost, latency, outcome; never content), behind `AuditSink`: `createPgAuditSink` writes `ai_call_audit` (packages/db 0205) through the tenant client in store scope; an in-memory sink for tests. A call refused before rendering hashes as `NO_INPUT_SHA256`; an ill-shaped template key is audited as `unknown`, so every record fits the table's CHECKs.
- Deterministic fake transport; no test touches the network. `scripts/live-smoke.mjs` for the single manual live call.
