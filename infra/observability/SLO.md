# Service level objectives (#730, plan D3)

The SLOs for the Store API, the Admin API, checkout completion, the analytics ingest and the outbox relay. Every
target is taken from a measurement or a stated owner target, never invented: the 2026-10-06 load report
(`infra/load/reports/2026-10-06.md`) and the Integration 5 numbers on #612. `docs/slo.md` points here.

**The rules are code.** `infra/observability/rules/slo.mjs` defines every SLI once and generates
`rules/slo.rules.yml` (loaded by `prometheus.yml`) and `rules/slo.test.yml` (the `promtool test rules` cases). The
`observability config` job fails if the YAML is not what the generator writes, if `promtool check rules` rejects it,
or if a unit test fails. To change an SLO, edit `slo.mjs`, run `node infra/observability/rules/slo.mjs`, and commit
all three files.

## The SLOs

Every SLO is measured over a **rolling 28 days**. The error budget is `1 − target` of the events in that window.

| SLO                      | Good event                                                                   | Target | Error budget (28 d)                         | Where the target comes from                                             | Metric                                    |
| ------------------------ | ---------------------------------------------------------------------------- | ------ | ------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `store-api-availability` | a Store API request (`/store…`) not answered with a 5xx                      | 99.9%  | 0.1% of requests (≈ 40 min of total outage) | owner: errors < 0.1% (load report)                                      | core, pending #729                        |
| `store-api-latency`      | a `GET /store`, product-list or product-detail request under **500 ms**      | 95%    | 5% of those requests                        | owner: p95 < 500 ms (load report; measured 7–76 ms)                     | core, pending #729                        |
| `admin-api-availability` | an Admin API request (`/admin…`) not answered with a 5xx                     | 99.9%  | 0.1% of requests                            | the same errors < 0.1% target, applied to the Admin API                 | core, pending #729                        |
| `admin-metrics-latency`  | an `/admin/metrics` or `/admin/metrics/query` request under **300 ms**       | 95%    | 5% of those requests                        | Integration 5: metrics p95 < 300 ms (#612; measured 40–44 ms)           | core, pending #729                        |
| `checkout-availability`  | a `POST /store/carts/{cartId}/complete` not answered with a 5xx              | 99.9%  | 0.1% of placements                          | owner: errors < 0.1%; the load runs placed 900 orders with none failing | core, pending #729                        |
| `checkout-latency`       | a `complete` under **2 s**                                                   | 95%    | 5% of placements                            | see below                                                               | core, pending #729                        |
| `analytics-ingest-lag`   | an event in ClickHouse within **10 s** of the relay publishing it            | 95%    | 5% of events                                | Integration 5: lag p95 < 10 s (#612; measured 0.45–0.6 s)               | **live**: `analytics_ingest.ingest_delay` |
| `outbox-relay-lag`       | a minute in which the oldest unpublished outbox row is younger than **10 s** | 99%    | 1% of minutes (≈ 6.7 h)                     | derived, see below                                                      | **metric pending** (window 14)            |

Only the Admin metrics API has a measured latency number, so it is the only Admin latency SLO; none is invented for
the rest of the Admin API.

### Why checkout latency is 2 s, not 500 ms

The load runs measured `complete` at p95 44–111 ms, but against the **manual** payment provider: no network call.
In production `complete` calls the payment provider (a Stripe authorisation) inside the request, which no load run
measures. So the browse bound (500 ms) does not apply. The target is **95% under 2 s** (manager, 2026-11-06), to be
revisited against the first production month.

### Why the relay lag target is derived

No target exists for the relay on its own. #612's 10 s budget is end to end — outbox row → relay → Kafka →
ClickHouse — so the relay, which is inside it, must stay well under it: the oldest unpublished row younger than 10 s
in 99% of minutes. **Metric pending:** the relay computes `lag_oldest_seconds` (`apps/core/src/outbox/relay.ts`)
but does not export it. The rule is written against the planned gauge
`outbox_relay_lag_oldest_seconds{service_name="outbox-relay"}`, and **#733** (`REQUEST: export the relay's lag_oldest_seconds
as an OTel gauge`) asks window 14 for it. Until it exists the rule evaluates to nothing and cannot alert.

## How each SLI is measured

The core's series are window 1's OpenTelemetry metrics (#729), exported through the compose collector:
`http_server_request_duration_seconds` (histogram) with exactly `service_name="core"`, `http_route` (the contract
template, else `unmatched`), `http_request_method`, `http_status_class` (`2xx`…`5xx`) and `store_id`.

- **Availability** = 1 − (5xx requests ÷ all requests), from the histogram's `_count`, filtered by `http_route`.
  OTel creates the 5xx series on the first 5xx, so a core that has never failed has none. `or vector(0)` makes that a
  ratio of 0, not "no data", and a promtool case with no 5xx series at all checks it.
- **Latency** = the share of requests under the threshold, from `_bucket{le="<threshold>"} ÷ _count`. **A
  threshold must be a bucket boundary**: #729's histogram needs `0.3`, `0.5` and `2` among its boundaries (asked of
  window 1 through the manager; all three are present on the compose stack, 2026-11-06). **Prometheus 3 normalises
  `le` at scrape**: an integer boundary is stored as `"2.0"`, not `"2"`, and `le="2"` selects nothing. So the rules
  match both spellings (`le=~"2(\\.0)?"`, `le=~"10000(\\.0)?"`). The promtool tests use the stored literals, so a
  regression to an exact `"2"` fails them.
- **Ingest lag** = the share of events under 10 000 ms in `analytics_ingest_ingest_delay_milliseconds` (the SDK's
  default millisecond buckets include 10000).
- **Relay lag** = the share of one-minute samples in which the gauge is below 10.

The recording rules are `slo:error_ratio:<window>{slo="<name>"}` for 5m, 30m, 1h, 2h, 6h, 1d and 3d.

## Alerts: multi-window burn rate

Each SLO has two alerts (Google SRE workbook, "Alerting on SLOs"). A burn rate of 1 spends exactly the budget over
28 days.

| Alert                  | Fires when the error ratio is above                                 | Spends                  | `for` |
| ---------------------- | ------------------------------------------------------------------- | ----------------------- | ----- |
| `SLOBurn_<slo>_page`   | 14.4 × budget over **1h and 5m**, or 6 × budget over **6h and 30m** | 2% / 5% of the budget   | 2m    |
| `SLOBurn_<slo>_ticket` | 3 × budget over **1d and 2h**, or 1 × budget over **3d and 6h**     | 10% / 10% of the budget | 15m   |

The long window says the burn is real; the short one stops the alert soon after the burn does. Labels: `severity`
(`page` | `ticket`) and `slo`. No Alertmanager receiver is configured yet: the alerts show in Prometheus' Alerts page
and in Grafana; routing them is part of the production setup.

`rules/slo.test.yml` proves every alert both ways: for each SLO, a burning budget fires the page and the ticket
alert, and a healthy service fires neither, with its 1h error ratio at 0. The tests were themselves checked by
mutation: expecting no page on a burning budget, or a page on a healthy one, makes `promtool test rules` fail.
