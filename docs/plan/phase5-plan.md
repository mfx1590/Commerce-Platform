# Phase 5 — Data platform and AI: the plan (manager session nine, 2026-10-25)

Source: master plan §5 "Phase 5" (W1 real-time analytics, W2 warehouse & models, W3 BI, W4 AI, W5 product analytics;
Integration 5: "BI numbers = ledger = PSP; performance and access review across every role"). This file adapts it
to what we actually have: one laptop, no cloud accounts, Max 5x, three build windows at a time, data that already
flows through the bus with no PII.

Tracking issue: #612 (label `phase:5`); tasks #600–#611. Decisions below are final unless the owner overrides.

## 1. Decisions (and why)

| # | Decision | Why |
|---|---|---|
| D1 | **ClickHouse is the only analytics store** (self-hosted in the compose stack; ClickHouse Cloud at deploy). It serves live tiles (W1) and history (W2). BigQuery/Snowflake are deferred. | No warehouse account, and it would cost money. At our volume ClickHouse handles years of history. One engine means one ingest path, one set of tests and one less thing to break on a laptop. |
| D2 | **The bus is the source**: `apps/analytics-ingest` reads every topic from the beginning (group `analytics.raw`) into `raw_events` (ReplacingMergeTree on `(topic, event_id)`), using the `@platform/events` consumer + DLQ like accounting. No Postgres→ClickHouse CDC. | CDC would bypass RLS and pull PII columns. Events are tenant-stamped, PII-free (email_hash only) and replayable (#595), so a rebuild is a replay. `order.placed` v1 already carries totals and line items. |
| D3 | **Models are versioned ClickHouse SQL in `data/clickhouse/`**, tested with Vitest on the generated month (the #552 gate data). **No dbt, Dagster or Airbyte in Phase 5.** | TypeScript everywhere is a fixed decision; dbt + Dagster would add a Python platform to run a dozen models. The master plan wants "tests on every model, per store + consolidated": Vitest tests on staging, fact and mart models give that. dbt becomes worth it when a second warehouse exists (recorded as later work). Airbyte sources (ads, carrier invoices) need accounts we don't have. |
| D4 | **One query path, with tenant scope added on the server: a typed metrics API.** The metrics catalogue (metric × dimensions × filters × grain) compiles to parameterised ClickHouse SQL; the server adds `store_id IN (<OpenFGA scope>)` to every query. Read-only ClickHouse user. No app, user or AI ever sends SQL. | ClickHouse has no RLS tied to our tenants. One compiler with a scope predicate we can test for leaks is safer than per-tenant ClickHouse users or a BI tool with its own auth. BI Q&A (D8) reuses the same API. |
| D5 | **BI stays in our admin `(hq)/bi`**: live tiles plus period dashboards from the metrics API. **No embedded Metabase/Superset.** | Open-source Metabase has no row-level sandboxing (that's paid), so embedding it means a second authorization system and an iframe. Our admin already has OpenFGA scope, finance vs store views and a perf budget. Metabase may come back later as an internal HQ-analyst tool. |
| D6 | **Live = poll every 15 s** of a ClickHouse materialised view (per store, per minute). No websockets. | No new infrastructure, and it works through every proxy. Target: event → tile < 10 s p95 on the dev stack, measured. |
| D7 | **Reconciliation is code, built in wave 2, using three identities** (the ledger books revenue at SHIPMENT; the reporting views book at PLACEMENT): **Bookings** — ClickHouse placed orders = `rpt_sales_daily` per store × currency × day. **Recognised revenue** — ClickHouse does **not** recompute revenue (amended 10-25 after session eight's review): the ledger's own posted journal lines (Finance API `listJournalLines`: `store_id`, `source_event_id`, `source_topic`, reference) are pulled into `fct_ledger_line`, and check 2 is (a) **copy integrity**: ClickHouse 4000 + 4010 + 4090 = the Finance API per legal entity × currency × day; (b) **lineage**: every revenue line's `source_event_id` is a `shipment.shipped`/`refund.issued` in `raw_events`, and every shipped event has its lines unless it is parked; (c) **a lifetime invariant** per fully shipped, unrefunded order: Σ revenue = goods net + shipping net from `order.placed`. That invariant holds whatever the release rounding, remainder or VAT split, so no posting rule is copied. **Cash** — ClickHouse captured = `rpt_payments_daily` = ledger PSP-clearing debits; payouts = `listPayouts`. Every identity must show 0 difference, in minor units. | Comparing "BI revenue" straight to "ledger revenue" would never match, because they book at different moments. A second copy of the posting rules (floor-cumulative release, remainders, cancels before late shipments, zero-base VAT, proportional refund VAT; #548, #588, #591) would drift from window 15's copy. One copy of the rules; ClickHouse checks it. |
| D8 | **AI goes through one guarded gateway, `packages/ai`** (window 14, amended 10-25 to take load off window 12; window 14 wrote the `@platform/events` SDK and is idle): one Claude client; a model registry (`claude-sonnet-5-5` for drafting, `claude-haiku-5-5` for cheap classification); prompt templates versioned in git; PII redaction before any call; a per-store monthly token budget and rate limit; an audit row per call (prompt-template id, hash, model, tokens, cost — never the content); a kill switch `AI_ENABLED`; a deterministic fake for tests and CI. AI **drafts**, a human **publishes**. **The key variable is `AI_ANTHROPIC_API_KEY`, never `ANTHROPIC_API_KEY`**: Claude Code reads `ANTHROPIC_API_KEY` from the environment and would bill it instead of the Max plan. The owner pastes it ONCE into the repo-root `.env` (gitignored); the manager copies that one line into the `.env` of the worktree that needs it, without printing it. | One place to enforce redaction, cost and audit. Tests never call the network. No AI output reaches a customer without a human. |
| D9 | **AI features by value ÷ risk:** (1) product copy drafts per locale in the admin product editor; (2) BI Q&A via **tool use over the metrics API** (Claude chooses metric/dimension/filter from the typed catalogue; the server validates and scopes it; no SQL); (3) support reply drafts — **default OFF per store until the owner/lawyer approves sending support context to Anthropic (DPA)**. | Copy is the most hours saved (3 brands × catalogue × locales) with the least risk. Q&A is nearly free once D4 exists and cannot leak across tenants by construction. Support drafts send customer context to a processor, and **BI Q&A sends store aggregates**: both go on the lawyer list together, and both stay OFF per store until the answer. |
| D10 | **Recommendations without a vendor**: "frequently bought together" (co-occurrence with lift and minimum support, per store) + "popular in store" (7/30-day), computed from ClickHouse `fct_order_line` by a job in window 9's search module, stored in Postgres (`product_recommendation`, RLS) and served by the Store API, filtered to published and in-stock products at read time. Recombee and vector search are deferred. | A good baseline at zero cost that's easy to explain, and it works from the first orders. Vector search needs an embeddings provider (another account); Algolia NeuralSearch is paid. |
| D11 | **W5 product analytics (PostHog) is deferred** to the launch wave. | No account, no traffic before launch, and self-hosted PostHog (ClickHouse + Kafka + more) is too heavy for the laptop. The CDP tracking plan (`data/cdp/tracking-plan.json`) already defines the storefront events PostHog will receive. Feature flags go into the same later issue. |
| D12 | **Ports**: ClickHouse HTTP **18123**, native **19000** (outside 8033–8232, the range Windows reserved at boot on 10-25; 9000 is the core). Verify from the host. **Memory cap**: `mem_limit: 1536m` plus `max_server_memory_usage_to_ram_ratio` 0.75 and small mark/merge caches. | Avoid the port fights we've already had. Docker Desktop on this laptop already dies under memory pressure and after standby. |

## 2. Waves (at most three build windows at once; one machine holder)

**Step 0 — manager, before wave 1:** `integration/phase5-clickhouse`: the ClickHouse service in
`infra/docker/docker-compose.yml` (pinned image, healthcheck, volume), the CI service container for the jobs that
need it, `.env.example` rows (`CLICKHOUSE_URL`, `CLICKHOUSE_USER/PASSWORD` dev words, read-only user),
`docs/ownership.md` rows (`packages/ai/**` and `data/clickhouse/**` → 12; `check-ownership.test.sh` run), Memory-main.

**Wave 1 (step 0 and wave 1 approved by the owner on 10-25 to run now; waves 2–3 after the weekly reset, 2026-10-27 17:00 local):**
- 12 — P5.1 ingest, then P5.2 models.
- 16 — #599 (the real bug: group overrides vs the DLQ watch); the analytics ingest will copy that consumer pattern, so the fix lands first.

**Wave 2:**
- 12 — P5.3 reconcile, P5.4 metrics API (CONTRACT CHANGE Admin API), P5.5 admin BI v2.
- 9 — P5.8 recommendations (CONTRACT CHANGE db + Store API; needs P5.2 `fct_order_line`).

**Wave 3:**
- 14 — P5.6 `packages/ai`; then 12 — P5.7 BI Q&A.
- Wave 2 also needs a REQUEST to window 2: a confidential `analytics-ingest` service client with finance read (the ledger pull for D7 check 2), the same pattern as #565.
- 1 + 4 — P5.9 product copy drafts (core endpoint, then the admin editor), after P5.6.
- 3 — P5.10 the recommendation rail (PDP + cart), after P5.8.
- 16 — P5.11 support drafts (built, default OFF), after P5.6.

**Integration 5 (manager)** — the gate below, on the dev stack and in CI.

Contract landings follow the house rule: the manager's commit on `integration/*`, the reader before the writer, one PR.

## 3. Integration 5 gate (measurable)

**Primary proof = generated data in CI** (the #552 pattern): a generated month (refunds, parking, Brand C, captures,
payouts) through the REAL relay with `--topic-prefix` + `--throwaway-db`, a FRESH consumer group per run, then all
checks below. **Secondary proof = the dev stack**, with its coverage gaps stated, not hidden (Integration 4 found no
`payment.captured`, no `refund.issued` and no Brand C in the dev outbox, so the cash check cannot be proven there).

1. **Ingest:** every published outbox row appears in `raw_events` exactly once (count of distinct `(topic, event_id)` = the relay's published count per topic); a full replay changes no count; lag p95 < 10 s.
2. **Money:** D7's three identities show 0 difference per store/legal entity × currency × day, on the dev data AND on the CI generated month (the month includes refunds, parking and Brand C).
3. **Access review:** a matrix test of every role (owner, finance, HQ analyst, store-admin A, store-admin B, support, no token) × every BI, metrics, recommendation and AI route → the expected 200/403/404/401; a leak test (a store-A principal never receives a store-B row through any metric, grouping, Q&A answer or recommendation).
4. **PII:** a ClickHouse sweep finds 0 hits; AI audit rows hold no content; with support drafts OFF, no customer field ever reaches the gateway.
5. **Performance:** metrics API p95 < 300 ms on the CI month; the BI page stays inside the admin perf budget.
6. **AI:** CI is green against the fake; a real-Claude smoke test only once the owner gives a key (launch checklist).

## 4. Deferred, with reasons (each has an issue)

PostHog + feature flags (D11) · vector/semantic search (D10) · dbt, Dagster, BigQuery, Airbyte (D3) · embedded
Metabase (D5) · scheduled e-mailed reports (needs the email provider, #361) · Recombee (D10) · COGS margin in BI
waits for #559 (unit cost on shipment.shipped), then it's one more metric.

## 5. What the owner owes for Phase 5

- An **Anthropic API key** and a **monthly spend cap** you choose (money and keys are yours; until then everything runs on the fake).
- A **legal answer** covering BOTH: support context (customer orders, messages) for P5.11 AND store aggregates for P5.7 BI Q&A, sent to Anthropic as a processor (DPA). Until then both stay OFF per store.
- Confirm **window models** (12 and 9 in particular) before the manager messages them.
- Open a **session for window 9** in the existing `../wt-search` (worktree option OFF) when wave 2 starts.
