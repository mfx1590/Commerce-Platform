# Memory 16 — CRM, CDP, ops alerts & support
Window: 16 · Key: `engagement` · Branch prefix: `engagement/` · Model: Sonnet
Last updated: 2026-10-23 (manager, kickoff) · Contracts: contracts-v0.4.26, events-v1 = 2abe310 · Last commit: (none) · Status: not started — worktree ../wt-engagement, branch engagement/phase4

## Identity (does not change)
Owned paths (write):
- `apps/engagement/**` (new service, created by you in #553)
- `apps/support/**` (reserved; support lives in apps/engagement/src/support this phase)
- `data/cdp/**`
Reads:
- everything; especially packages/events (events-v1 consumer SDK), apps/notifications (window 17's transactional email — the model for transports and exactly-once, NOT yours), auth-sdk, docs/adr/0003-outbox-events.md item 5 (no PII in events)
Never touches:
- apps/notifications (window 17), core, accounting, packages/* (CONTRACT CHANGE / REQUEST issues instead)

## Mission — Phase 4 (Events, accounting, CRM)
Bus consumers for engagement, each an adapter + dev sink/mock (no external accounts exist): ops alerts to Slack, a CDP tracking plan + RudderStack mapper, CRM sync (Twenty), a support-context API for agents (Chatwoot-shaped). Consent-gated, erase-aware, no PII from events.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 4 (issues, in order)
- [ ] #553 16.1 apps/engagement service + ops alerts (group `engagement.ops`) — the window-wide decisions are on this issue
- [ ] #554 16.2 CDP tracking plan + RudderStack mapper (group `engagement.cdp`)
- [ ] #555 16.3 CRM sync, Twenty adapter (group `engagement.crm`; REQUEST a crm-sync service client)
- [ ] #556 16.4 Support context API + Chatwoot webhook stub

## Decisions made (with reasons)
- 2026-10-23 (manager, kickoff — full text on #553): apps/notifications stays with window 17 (it built transactional email there since #360); your row is apps/engagement, apps/support, data/cdp. One new service apps/engagement; the manager lands its Dockerfile manifest lines as an integration commit on your 16.1 head. Shared `consumer_processed` (db 0202) via the SDK's pg store. SMS/WhatsApp (Twilio), Novu, Klaviyo flows DEFERRED until accounts exist; returns portal + refund limits by role are a later wave (core/auth/storefront/admin), not yours.

## Blocked / waiting
- External accounts (Slack webhook, RudderStack, Twenty/HubSpot, Chatwoot): mocks until the owner provides them; live use on the launch checklist.

## Gotchas learned
- (from Memory-main, read its Global gotchas) loopback 127.0.0.1 for DB and broker; rebuild workspace packages after every merge of main (stale dist); a new workspace package breaks `app images` until every Dockerfile COPYs its manifest.

## How to run & test this package
- (fill in after first setup: exact commands)
