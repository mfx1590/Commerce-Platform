# (hq)/bi — BI section (window 12)

Issue #480 (reporting v1, 12.3): HQ sales, finance and stock from the Admin API report operations (Admin API 0.4.19,
#479). Issue #604 (BI v2): the metrics dashboard over the metrics API (`listMetrics` / `queryMetrics`, Admin API
0.4.25, #603), here and in the store view `src/app/(store)/[storeId]/bi/`. Window 12 owns this folder, that one, and
`apps/admin/test/bi/**`, `apps/admin/test-contract/bi/**` and `apps/admin/e2e/bi/**`; the rail, the shell,
`src/lib/**` and the section catalogue stay window 4's.

## The metrics dashboard (#604)

- **Where:** first on HQ `/bi` (every store the principal may see) and alone on `/<storeId>/bi` (that store). The
  store view has no rail entry yet (REQUEST to window 4); the store layout refuses a store outside the principal's
  list, and the API scopes every statement on top: a store outside the scope is a 403, never empty rows.
- **Live tiles:** today (UTC) per store × currency from `live_orders` / `live_placed_minor` (the per-minute ingest
  table, labelled live, never bookings). A client component polls `<base>/live` (a route handler; the token stays
  on the server) every 15 s while the tab is visible; a failed poll keeps the last figures and says so, and no event
  for two minutes marks the tiles stale.
- **Per currency tab** (`Metrics currency`, `?currency=` shared with the v1 tabs): bookings, refunds and refund rate
  KPIs; bookings per day and **refunds per day** per store; for finance principals only, bookings vs recognised (the
  ledger) vs cash (captured) — an analyst never asks for a finance metric (that would be a 403); top products by
  units. A truncated answer says so.
- **CSV download:** `<base>/export?from=&to=` streams `queryMetrics` as `text/csv` (RFC 4180, the server's
  formula-injection guard, `X-Truncated` passed on) as `bi-<scope>-<from>-to-<to>.csv`; an API error stays the
  API's JSON error with its status.
- **503 `unavailable`** (the analytics store down): a state panel, nothing partial; the v1 reports still render.

## What the page shows

- **Who:** the section requires `analyst` on organization:hq (`src/lib/nav/sections.ts`); owner implies it. Everyone
  else, including store admins, support and a finance-only user, gets the guard's 403 panel and the page makes no
  API call.
- **Window:** `?from=YYYY-MM-DD&to=YYYY-MM-DD` (UTC days, `to` exclusive, ≤ 366 days); default the last 30 days.
- **Currency is a tab** (`?currency=EUR`), one per currency in the report, most orders first. Every KPI, chart and
  table holds that currency only: amounts are never added across currencies or drawn on a shared axis.
- **Sales:** KPI cards (orders, total, refunded, net), net revenue per day and orders per day (one line per store),
  and a per-store table. Net is cohort-attributed (refunds counted on the order's day).
- **Finance** (only when `/admin/me` gives `finance`): captured, PSP fees labelled **unreconciled**, payments whose
  fee is not known yet, refunds by reason. For anyone else the card is not rendered and `getHqFinanceReport` is
  never requested. Because BI itself is analyst-gated (manager decision 2026-10-18), the finance cards show for the
  **owner only** (finance + analyst); a finance-only principal gets BI's 403 and uses window 4's Finance section.
- **Stock:** a store tab (`?stock=<storeId>`, default the first store by code) with the first 20 pool rows of
  `getStoreStockReport`. HQ analysts read it through `store.viewer ⊇ analyst from organization`.

## Files

| File                                | What                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page.tsx`                          | The route: the section guard around `BiReport`.                                                                                                                                              |
| `_api.ts`                           | `getHqSalesReport`, `getHqFinanceReport`, `getStoreStockReport`, `listMetrics`, `queryMetrics` over window 4's `adminCall`; `queryMetricsCsv` reads text (server-only).                      |
| `_components/metrics-dashboard.tsx` | The #604 dashboard (server), shared by HQ and the store view.                                                                                                                                |
| `_components/live-tiles.tsx`        | The live tiles (client): the 15 s poll, freshness, stale.                                                                                                                                    |
| `_lib/metrics.ts`                   | Pure: the query bodies on the generated types, `forStore`, and the shaping (tabs, money views, series, tiles, freshness).                                                                    |
| `_lib/handlers.ts`                  | The bodies of the `live/` and `export/` route handlers (HQ and store view).                                                                                                                  |
| `_components/bi-report.tsx`         | The page body: tabs, KPIs, charts, tables, state panels.                                                                                                                                     |
| `_components/series-chart.tsx`      | A local server-rendered SVG line chart (one currency, one measure, one y-axis from zero, legend + end labels, per-day tooltips). Promoted to a shared primitive only via a window 4 REQUEST. |
| `_lib/report.ts`                    | Pure helpers: window, tabs, fixed store colours, daily series, links.                                                                                                                        |

Series colours are the dataviz reference categorical slots for a dark surface, validated against the admin's
`--color-surface` (#131a22): lightness band, chroma, CVD and normal-vision separation, ≥ 3:1 contrast. A colour
follows the store (fixed order by code), never its rank; a ninth store gets no new hue (table only).

## Tests

- `pnpm --filter @platform/admin test -- test/bi`: helpers; the page per principal (real guard, mocked wrappers):
  nav fixtures, 403 without requests, finance cards, currency tabs, stock tab, no customer field.
- `pnpm --filter @platform/admin test:contract -- test-contract/bi`: the wrappers against Prism on admin-api.yaml.
- Playwright on the kept core (`e2e/bi/`): only after the manager's go (one window measures at a time). The live-tiles
  journey writes one guest order and needs, besides `pnpm --filter @platform/core dev`, the relay
  (`pnpm --filter @platform/core outbox:relay`) and the ingest (`pnpm --filter @platform/analytics-ingest dev`, with
  `ANALYTICS_ERASURE_KEY`); then `E2E_API=core CORE_URL=http://localhost:9000 pnpm --filter @platform/admin e2e bi`.
