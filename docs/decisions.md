# Decisions (filled 2026-09-04; change here first, then mirror into docs/memory/Memory-main.md)

| # | Decision | Value |
|---|---|---|
| 1 | Language / core | TypeScript / Medusa 2 (fixed) |
| 2 | Markets and currencies for brands A, B, C | A: EU / EUR (locale en-GB, de-DE) · B: UK / GBP (en-GB) · C: US / USD (en-US) |
| 3 | Warehouses: own or 3PL | Own. Two HQ warehouses: `wh-eu` (Rotterdam) and `wh-us` (New Jersey) |
| 4 | Accounting target (Odoo / ERPNext / NetSuite / Xero / QuickBooks) | Odoo (multi-company, one company per legal entity) |
| 5 | Hosting: managed-first (recommended solo) or self-host-first | managed-first (Vercel, Neon, Upstash, Redpanda Cloud) for Phases 0–3 |
| 6 | Cloud | AWS |
| 7 | Legal entities per brand | One legal entity per brand (3 seeded); a store belongs to exactly one legal entity |
| 8 | CMS | Sanity (one workspace/dataset per brand) |
| 9 | Search | Algolia (managed), one index per brand |
| 10 | Global PSP | Stripe (Stripe Connect for per-brand settlement); local PSP: none in Phases 0–2 |

Consequences already applied in Phase 0: seed data uses EUR/GBP/USD; `legal_entity` table exists from day one;
`store.content_space_id` holds the Sanity dataset name; ledger event mapping in docs/adr/0003 targets Odoo journals.
