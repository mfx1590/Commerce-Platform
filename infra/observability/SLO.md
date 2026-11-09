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

| SLO                      | Good event                                                                   | Target | Error budget (28 d)                         | Where the target comes from                                             | Metric                                             |
| ------------------------ | ---------------------------------------------------------------------------- | ------ | ------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `store-api-availability` | a Store API request (`/store…`) not answered with a 5xx                      | 99.9%  | 0.1% of requests (≈ 40 min of total outage) | owner: errors < 0.1% (load report)                                      | **live**: core (#729)                              |
| `store-api-latency`      | a `GET /store`, product-list or product-detail request under **500 ms**      | 95%    | 5% of those requests                        | owner: p95 < 500 ms (load report; measured 7–76 ms)                     | **live**: core (#729)                              |
| `admin-api-availability` | an Admin API request (`/admin…`) not answered with a 5xx                     | 99.9%  | 0.1% of requests                            | the same errors < 0.1% target, applied to the Admin API                 | **live**: core (#729)                              |
| `admin-metrics-latency`  | an `/admin/metrics` or `/admin/metrics/query` request under **300 ms**       | 95%    | 5% of those requests                        | Integration 5: metrics p95 < 300 ms (#612; measured 40–44 ms)           | **live**: core (#729)                              |
| `checkout-availability`  | a `POST /store/carts/{cartId}/complete` not answered with a 5xx              | 99.9%  | 0.1% of placements                          | owner: errors < 0.1%; the load runs placed 900 orders with none failing | **live**: core (#729)                              |
| `checkout-latency`       | a `complete` under **2 s**                                                   | 95%    | 5% of placements                            | see below                                                               | **live**: core (#729)                              |
| `analytics-ingest-lag`   | an event in ClickHouse within **10 s** of the relay publishing it            | 95%    | 5% of events                                | Integration 5: lag p95 < 10 s (#612; measured 0.45–0.6 s)               | **live**: `analytics_ingest.ingest_delay`          |
| `outbox-relay-lag`       | a minute in which the oldest unpublished outbox row is younger than **10 s** | 99%    | 1% of minutes (≈ 6.7 h)                     | derived, see below                                                      | **live**: `outbox_relay_lag_oldest_seconds` (#733) |

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
in 99% of minutes.

**Metric:** the relay CLI exports `outbox_relay_lag_oldest_seconds{service_name="outbox-relay"}` (#733). Its value is
the age of the oldest unpublished row its last completed pass saw, and it keeps growing between passes. Once no pass
has completed for max(3 × interval, 10 s), it is at least the time since the last completed pass. A relay that is
down exports nothing, so the series goes absent and the rule evaluates to nothing. An `absent()` alert covers that
case (below).

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

| Alert                               | Fires when the error ratio is above                                                               | Spends                  | `for` |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- | ----- |
| `SLOBurn_<slo>_page`                | 14.4 × budget over **1h and 5m**, or 6 × budget over **6h and 30m**                               | 2% / 5% of the budget   | 2m    |
| `SLOBurn_<slo>_ticket`              | 3 × budget over **1d and 2h**, or 1 × budget over **3d and 6h**                                   | 10% / 10% of the budget | 15m   |
| `SLOAbsent_outbox_relay_lag` (page) | `absent(outbox_relay_lag_oldest_seconds{service_name="outbox-relay"})`: the relay exports nothing | ≈ 2.5% when it pages    | 5m    |

**Why a down relay needs its own alert, and why 5 minutes.** A relay that is down burns its budget fastest of all:
every minute is bad, a 100× burn. But it exports nothing, so the error ratio is empty and neither burn alert can
fire. `SLOAbsent_outbox_relay_lag` pages instead.

- **When it pages:** the collector's Prometheus exporter keeps a series for its `metric_expiration` (default 5 min)
  after the last export, so the series goes absent about 5 min after the relay dies. `for: 5m` then pages at about
  10 min. That is about 2.5% of the 28-day budget (403 min), in line with the fast-burn page (2%).
- **Why not sooner:** a restart or a deploy re-exports within one 15 s export interval, so a shorter `for` would not
  catch the outage much earlier, and a longer one would let a dead relay spend ten times the page's share.
- **In dev:** the alert also fires whenever no relay with telemetry is running (the relay's OTLP export is off
  without an endpoint). Expect it on a dev stack that does not run the relay.

The long window says the burn is real; the short one stops the alert soon after the burn does. Labels: `severity`
(`page` | `ticket`) and `slo`. No Alertmanager receiver is configured yet: the alerts show in Prometheus' Alerts page
and in Grafana; routing them is part of the production setup.

`rules/slo.test.yml` proves every alert both ways: for each SLO, a burning budget fires the page and the ticket
alert, and a healthy service fires neither, with its 1h error ratio at 0. The tests were themselves checked by
mutation: expecting no page on a burning budget, or a page on a healthy one, makes `promtool test rules` fail.
The relay's down alert has its own case: the gauge exports for 10 minutes and then stops. The alert must be silent
at 12m and firing at 30m, and silent in both of the relay's other cases, where the gauge is present. Pointing the
rule at the wrong series, or lengthening its `for` to 30m, makes that case fail.
