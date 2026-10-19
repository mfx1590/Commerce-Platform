# (hq)/bi — BI section (window 12)

Issue #480 (reporting v1, 12.3). HQ sales, finance and stock from the Admin API report operations (Admin API 0.4.19,
#479). Window 12 owns this folder plus `apps/admin/test/bi/**`, `apps/admin/test-contract/bi/**` and
`apps/admin/e2e/bi/**`; the rail, the shell, `src/lib/**` and the section catalogue stay window 4's.

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

| File                           | What                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page.tsx`                     | The route: the section guard around `BiReport`.                                                                                                                                              |
| `_api.ts`                      | `getHqSalesReport`, `getHqFinanceReport`, `getStoreStockReport` over window 4's `adminCall` (server-only).                                                                                   |
| `_components/bi-report.tsx`    | The page body: tabs, KPIs, charts, tables, state panels.                                                                                                                                     |
| `_components/series-chart.tsx` | A local server-rendered SVG line chart (one currency, one measure, one y-axis from zero, legend + end labels, per-day tooltips). Promoted to a shared primitive only via a window 4 REQUEST. |
| `_lib/report.ts`               | Pure helpers: window, tabs, fixed store colours, daily series, links.                                                                                                                        |

Series colours are the dataviz reference categorical slots for a dark surface, validated against the admin's
`--color-surface` (#131a22): lightness band, chroma, CVD and normal-vision separation, ≥ 3:1 contrast. A colour
follows the store (fixed order by code), never its rank; a ninth store gets no new hue (table only).

## Tests

- `pnpm --filter @platform/admin test -- test/bi`: helpers; the page per principal (real guard, mocked wrappers):
  nav fixtures, 403 without requests, finance cards, currency tabs, stock tab, no customer field.
- `pnpm --filter @platform/admin test:contract -- test-contract/bi`: the wrappers against Prism on admin-api.yaml.
- Playwright on the kept core (`e2e/bi/`): only after the manager's go (one window measures at a time).
