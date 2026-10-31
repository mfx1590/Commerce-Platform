# @platform/ai

## Purpose

The guarded Claude gateway (Phase 5, D8, #605). Every model call in the platform goes through `createAiGateway`:
a versioned template, a denylist of customer fields (type-level and runtime), redaction of e-mail, phone, address,
card and IBAN shapes, a per-store monthly token budget and per-minute rate limit, the `AI_ENABLED` kill switch, and
one audit row per call that never holds content. AI drafts; a human publishes.

## Owner

Window 14 (events) since Phase 5 (#605). Templates and the denylist are part of the contract: a new template is a new
file, a changed prompt is a new version (`v<N+1>.json`), never an edit of a published one.

## Rules

- The key variable is `AI_ANTHROPIC_API_KEY`, NEVER `ANTHROPIC_API_KEY` (Claude Code reads that name and would bill it
  instead of the Max plan). The transport reads only that variable and passes it explicitly, so the SDK reads no
  ambient credentials. Never print, log or test with a real key; test keys are plain words.
- No test touches the network: tests use `createFakeTransport`, or the real transport with an injected `fetch`.
- `AI_ENABLED` must be exactly `1` to call out; anything else (and the default) refuses with `AiDisabledError`.
- The audit stores ids, the template id/version, a SHA-256 of the redacted input, the models, tokens, cost, latency,
  outcome and an error class. Never prompt text, variables, output, or error messages.
- The audit goes through `createPgAuditSink` (tenant client, store scope; packages/db 0205 `ai_call_audit`, append-only). `test/pg-audit.test.ts` migrates a throwaway database (DATABASE_URL, default 127.0.0.1:5433).
- No unaudited output: if the audit write fails the draft is withheld (`AiAuditError`).
- No `temperature` (removed from the API); effort comes from the template; thinking stays adaptive.

## Run / test

- `pnpm --filter @platform/ai generate` — validates `templates/<id>/v<N>.json` and writes `src/generated/templates.ts` (committed)
- `pnpm --filter @platform/ai test | typecheck | build` — typecheck includes `test/denylist.typecheck.ts` (`@ts-expect-error` cases)
- The Redis block of `test/limiter.test.ts` runs against `REDIS_URL` (default `redis://127.0.0.1:6381`) and skips with a printed reason when Redis is down; keys use a random prefix and are deleted afterwards.
- `pnpm --filter @platform/ai live-smoke -- --live-ok` — ONE billed drafting call; by hand, with the manager's OK only. Prints model, tokens, latency and cost; never content.

## Public API

See README.md.
