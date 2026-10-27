# Platform launch checklist

Platform-wide items that must be true before real customers and real money touch the system. Per-brand items
live in each brand's `apps/storefronts/<brand>/LAUNCH.md` (window 10). Owner: the manager. Each line names its
issue; tick it only with a link to the evidence.

## Owner decisions and accounts (the owner's to provide)

- [ ] Stripe live/test keys and payouts (#361); the 2a gate (#356, #358, #360) on real test keys.
- [ ] A real Odoo instance (accounting target) and its API key.
- [ ] Slack, RudderStack, Twenty, Chatwoot accounts; Chatwoot's webhook signature header confirmed.
- [ ] Lawyer review: the CDP tracking default (owner decision 2026-10-23: track by default; per-region strict via
      `ENGAGEMENT_CDP_CONSENT_MODE_<STORE>`), the erase decision (orders retained), the existing lawyer list, and
      the Anthropic processor question for BI Q&A (#606) and support drafts (#610).
- [ ] Brand names; brands B/C invoice OK.
- [ ] Anthropic API key with a monthly spend cap (in place for dev since 2026-10-27; the gift credit expires
      2026-11-10).

## Data protection

- [ ] **ClickHouse honours customer.erased (#623, PR #631).** No real customer data may reach ClickHouse before it
      lands. `ANALYTICS_ERASURE_KEY` set from the secrets manager; rotation procedure in apps/analytics-ingest README.
- [ ] **Bus retention vs erasure (#629):** bounded retention for topics carrying pseudonymous ids; outbox pruning,
      if ever added, exempts `customer.erased`.
- [ ] Migration backfills that assume BYPASSRLS (#497) fixed before any cloud database.

## Access

- [ ] **Service accounts (#565, #622, #632):** the per-client operation allowlist (#632) merged BEFORE any
      production secret exists; then provision the `crm-sync` / `analytics-sync` staff_user rows + OpenFGA
      tuples in production with window 2's `provision:service-accounts` (see infra/keycloak/README, production
      section); secrets from the secrets manager only.
- [ ] Read-only customer relation (#625) decided (until then, service accounts rely on #632's allowlist).

## Accounting

- [ ] **Re-run `erp:sync` on a clean Odoo after #627 (PR #630):** every move synced before it is dated a day early
      (all 147 Integration 4 dev moves were). Never reuse the dev Odoo's books.
- [ ] Service images run with `TZ=UTC` (accounting pins it since #630; check every service image).

## Data platform

- [ ] Integration 5 gate green (#612): the money identities at 0 in CI (the #602 gate) and on the dev stack with
      the coverage gaps stated; the access matrix; the PII sweep; metrics p95 < 300 ms.
- [ ] ClickHouse in production: the read-only user, system tables behind a grant, a memory cap sized for the host.
