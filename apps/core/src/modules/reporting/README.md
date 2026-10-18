# reporting (window 12)

Reporting v1 in the core: the Admin API report operations over the reporting views (#479, next). Views, grain,
filters and the security model: `data/reporting/README.md`.

| File                      | What                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                | Public API: `REPORTING_VIEWS`, `ReportingView`.                                                                                                                                                                                                                                                                                                                                                                           |
| `reporting-views.test.ts` | #478: on a seeded throwaway database migrated through 0200 (fails loudly if a view is missing); each view equals a direct aggregate over its source tables as brand A and as HQ; store / HQ / no-context / other-organization visibility through `security_invoker`; no SECURITY DEFINER dependency, SELECT-only grant; bigint money beside currency, EUR and GBP never one row; net reconciliation; PII column denylist. |

Rules: every read goes through `tenantClient` / `organizationClient` (`src/lib/db.ts`); no PII in any response;
money stays per currency. Route mounting is a REQUEST to window 1 (`src/http/module-routers.ts`).

Test: `pnpm --filter @platform/core test -- src/modules/reporting`.
