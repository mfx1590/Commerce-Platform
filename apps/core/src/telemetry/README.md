# src/telemetry — OpenTelemetry of the core (#729)

Traces and RED metrics over OTLP/HTTP to the compose collector (`infra/observability`), which forwards traces to
Tempo and metrics to Prometheus. Manual instrumentation on the API (`@opentelemetry/api` 1.9.1, SDK 2.12.0,
OTLP exporters 0.223.0 — the versions apps/analytics-ingest pins); no auto-instrumentation, no patched modules.

## Configuration: the standard `OTEL_*` environment only

| Variable                                                    | Effect                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `_TRACES_` / `_METRICS_`) | unset = **off**: nothing registered, the API's no-op tracer and meter            |
| `OTEL_SDK_DISABLED=true`                                    | off, whatever else is set (vitest.config.ts sets it for every test)              |
| `OTEL_TRACES_EXPORTER=none` / `OTEL_METRICS_EXPORTER=none`  | drops one signal                                                                 |
| `OTEL_SERVICE_NAME`                                         | default `core`; `OTEL_RESOURCE_ATTRIBUTES` is merged in                          |
| `OTEL_TRACES_SAMPLER` / `_ARG`                              | `always_on` (default), `always_off`, `traceidratio` (+ the `parentbased_` names) |
| `OTEL_METRIC_EXPORT_INTERVAL`                               | ms, default 15000                                                                |

Locally: `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` with the observability profile up. An absent
collector is **one** `console.warn` (a probe at boot, then the SDK's first export error; every later one is dropped):
the boot never fails and no request waits on an export (batch span processor, periodic metric reader).

## What is recorded

`telemetryMiddleware` is mounted first in `mountCoreMiddleware`, right after the request id (only when
`startTelemetry()` registered providers). `/health` is skipped. Every series has exactly four attributes:

| Attribute             | Value                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.route`          | the contract template (`store-api.yaml` + `admin-api.yaml` paths, `routes.ts`), else `unmatched`                                                                                                                                 |
| `http.request.method` | `GET` `POST` `PUT` `PATCH` `DELETE`, else `other`                                                                                                                                                                                |
| `http.status_class`   | `1xx` … `5xx`                                                                                                                                                                                                                    |
| `store_id`            | Store API: the store of the publishable key. Admin: the `{storeId}` path parameter when it is a store of the registry (`known-stores.ts`, refreshed lazily every 60 s), so a made-up uuid cannot mint a series. `none` otherwise |

- `http.server.request.duration` — histogram, seconds; buckets EXACTLY 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.3, 0.5, 0.75, 1, 2, 2.5, 5, 7.5, 10 (the semantic-conventions defaults plus 0.3 and 2: the SLO thresholds 0.3 s, 0.5 s and 2 s must be bucket boundaries; pinned by a test).
- `core.http.requests` — counter. `core.http.errors` — counter, **5xx only**; a 4xx (429 included) is visible
  through `http.status_class` and is not an error, for metrics and for the span status alike.
- Prometheus names (collector): `http_server_request_duration_seconds_{bucket,sum,count}`,
  `core_http_requests_total`, `core_http_errors_total`, labels `http_route`, `http_request_method`,
  `http_status_class`, `store_id` (+ `service_name` and the other resource attributes).

Spans: the SERVER span `<METHOD> <template>` (the four attributes, `http.response.status_code`, `http.request.id`;
ERROR on a 5xx) — Tempo's span-metrics turn it into the `traces_spanmetrics_*` series of the platform-overview
dashboard (`store_id` is one of its dimensions). Children: `db.transaction` around every transaction of the scoped
clients (`traceScopedClient`, applied in `src/lib/db.ts`; scope, no SQL, a failure carries its SQLSTATE as
`error.type`, never the message) and `outbox.write` (`src/outbox/with-events.ts`).

Never recorded: raw paths, query strings, ids other than the store, tokens, emails, SQL text or parameters, error
messages. **An inbound `traceparent` is never honoured**: the Store API is public, so a caller must not choose the
trace id that lands in our outbox; every trace is rooted at the core.

## The outbox envelope's `trace`

`currentTraceFields()` returns `{ trace_id, request_id }` of the active request (the SERVER span's trace id and
the request id from `requestIdOf`: a client `X-Request-Id` only in the safe shape, a generated uuid otherwise, #740), or `undefined` outside a request or with telemetry off. `withEvents` fills an envelope's
`trace` with it when the caller set none, and never overwrites one the caller set.

## Tests

`telemetry.test.ts` (no database): route templates (every contract path matches itself), the known-store set,
the sampler, off by default, the single warning for an absent collector, the metric series and their exact label
sets, the rooted span, the request context through a body parser (also with a body that arrives after the headers),
and the database span. `test/outbox-trace.test.ts`: the trace id reaches the outbox row.
