# Changelog — @platform/ai

## 0.1.0 — unreleased (#605, Phase 5 D8)

- `createAiGateway({ organizationId, storeId, purpose, … })` over the official `@anthropic-ai/sdk` 1.3.0 (exact pin).
- Model registry: drafting = `claude-sonnet-5-5` (server-side fallbacks on), classification = `claude-haiku-5-5`; env-overridable to priced models only.
- Versioned templates with ids (`product-copy-draft@1`, `product-category-suggest@1`), validated and typed by `scripts/generate.mjs`.
- Guards: customer-field denylist at the type level and at runtime; redaction of e-mail, phone, address/postcode, card (Luhn) and IBAN (mod-97).
- Per-store monthly token budget and per-minute rate limit, in memory and in Redis (atomic Lua reserve/settle).
- `AI_ENABLED=1` kill switch (off by default); the key variable is `AI_ANTHROPIC_API_KEY` only.
- One audit record per call (ids, template, input hash, models, tokens, cost, latency, outcome; never content), behind `AuditSink` with an in-memory sink until the `ai_call_audit` migration lands.
- Deterministic fake transport; no test touches the network. `scripts/live-smoke.mjs` for the single manual live call.
