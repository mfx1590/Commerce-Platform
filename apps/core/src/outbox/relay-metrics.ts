// The relay's lag as an OpenTelemetry gauge (#733), for window 5's relay-lag SLO (infra/observability/SLO.md).
// `outbox_relay.lag_oldest` with unit `s` lands in Prometheus as `outbox_relay_lag_oldest_seconds{service_name=
// "outbox-relay"}`: the collector appends the unit suffix and turns the resource's service.name into the label
// (infra/observability/otel-collector.yaml, resource_to_telemetry_conversion), exactly as the core's
// `http.server.request.duration` becomes `http_server_request_duration_seconds`. No attributes of its own: one relay
// process serves one organization, and the SLO rule takes max() over replicas.
//
// The value is computed when the meter collects, not when a pass ends: the age of the oldest unpublished row the
// last completed pass saw, so it keeps growing while that row stays unpublished. And a loop that has not completed a
// pass for longer than max(3 × interval, 10 s) reports at least the time since its last completed pass: a relay that
// hangs after a pass that saw an empty backlog would otherwise report 0 while rows pile up, and a living process
// never lets the series go absent.
import type { Meter } from '@opentelemetry/api';
import type { RelayPassResult } from './relay';

export const LAG_GAUGE_NAME = 'outbox_relay.lag_oldest';

/** The floor's threshold: a pass is overdue after three intervals, and never before the SLO's own 10 s. */
export const stalledAfterMs = (intervalMs: number): number => Math.max(3 * intervalMs, 10_000);

export interface RelayLagState {
  /** Feed every COMPLETED pass (the relay's pass line). A pass that throws is not one. */
  observePass(line: Pick<RelayPassResult, 'lag_oldest_seconds'>, at?: Date): void;
  /** The gauge value at `now`, in seconds. */
  valueAt(now: Date): number;
}

export function createRelayLagState(opts: {
  intervalMs: number;
  /** Counts as the last completed pass until the first one completes. */
  startedAt?: Date;
}): RelayLagState {
  const stallMs = stalledAfterMs(opts.intervalMs);
  let lastPassAt = (opts.startedAt ?? new Date()).getTime();
  let oldestAt: number | null = null;
  return {
    observePass(line, at = new Date()) {
      lastPassAt = at.getTime();
      oldestAt =
        line.lag_oldest_seconds === null ? null : lastPassAt - line.lag_oldest_seconds * 1000;
    },
    valueAt(now) {
      const t = now.getTime();
      const backlog = oldestAt === null ? 0 : Math.max(0, t - oldestAt) / 1000;
      const sincePass = t - lastPassAt;
      return Math.max(backlog, sincePass > stallMs ? sincePass / 1000 : 0);
    },
  };
}

/** Registers the gauge on `meter`. A no-op meter (telemetry off) never calls the callback. */
export function registerRelayLagGauge(
  meter: Meter,
  state: RelayLagState,
  now: () => Date = () => new Date(),
): void {
  meter
    .createObservableGauge(LAG_GAUGE_NAME, {
      description:
        'Age of the oldest unpublished outbox row the relay knows of (at least the time since its last completed pass once that is overdue)',
      unit: 's',
    })
    .addCallback((result) => result.observe(state.valueAt(now())));
}
