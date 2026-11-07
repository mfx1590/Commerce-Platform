// The relay lag gauge (#733): its exported name and unit (window 5's SLO rule reads
// outbox_relay_lag_oldest_seconds{service_name="outbox-relay"}), no attributes, a value that grows between passes, and
// the stalled-loop floor. A local MeterProvider with an in-memory exporter: nothing global, no collector.
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRelayLagState,
  LAG_GAUGE_NAME,
  registerRelayLagGauge,
  stalledAfterMs,
} from './relay-metrics';

const T0 = new Date('2026-11-06T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('createRelayLagState', () => {
  it('reports the age of the oldest unpublished row the last pass saw, growing until a pass sees it gone', () => {
    const s = createRelayLagState({ intervalMs: 1_000, startedAt: T0 });
    s.observePass({ lag_oldest_seconds: 4 }, T0); // the oldest row was 4 s old at the pass
    expect(s.valueAt(T0)).toBe(4);
    expect(s.valueAt(at(2_500))).toBe(6.5); // between passes it keeps ageing, never freezes at the pass's number
    s.observePass({ lag_oldest_seconds: null }, at(3_000)); // published
    expect(s.valueAt(at(3_000))).toBe(0);
  });

  it('is 0 before the first pass and with an empty backlog, until a pass is overdue', () => {
    const s = createRelayLagState({ intervalMs: 1_000, startedAt: T0 });
    expect(s.valueAt(at(9_000))).toBe(0);
    s.observePass({ lag_oldest_seconds: null }, at(1_000));
    expect(s.valueAt(at(10_900))).toBe(0); // 9.9 s since the pass: not overdue (threshold 10 s)
  });

  it('stalled-loop floor: no completed pass for longer than max(3 × interval, 10 s) reports the time since the last one', () => {
    expect(stalledAfterMs(1_000)).toBe(10_000);
    expect(stalledAfterMs(5_000)).toBe(15_000);

    // a relay that hangs after a pass that saw an empty backlog must not report 0 while rows pile up
    const s = createRelayLagState({ intervalMs: 1_000, startedAt: T0 });
    s.observePass({ lag_oldest_seconds: null }, T0);
    expect(s.valueAt(at(12_000))).toBe(12);
    // the floor never lowers a real backlog
    s.observePass({ lag_oldest_seconds: 30 }, at(12_000));
    expect(s.valueAt(at(25_000))).toBe(43);
    // a first pass that never completes counts from the start
    const stuck = createRelayLagState({ intervalMs: 5_000, startedAt: T0 });
    expect(stuck.valueAt(at(14_000))).toBe(0);
    expect(stuck.valueAt(at(16_000))).toBe(16);
  });
});

describe('registerRelayLagGauge', () => {
  let provider: MeterProvider | undefined;
  afterEach(async () => {
    await provider?.shutdown();
    provider = undefined;
  });

  it('exports outbox_relay.lag_oldest in seconds with no attributes (Prometheus: outbox_relay_lag_oldest_seconds)', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    provider = new MeterProvider({ readers: [reader] });
    const state = createRelayLagState({ intervalMs: 1_000, startedAt: T0 });
    state.observePass({ lag_oldest_seconds: 7 }, T0);
    registerRelayLagGauge(provider.getMeter('outbox-relay'), state, () => at(500));

    await reader.forceFlush();
    const metrics = exporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    const gauge = metrics.find((m) => m.descriptor.name === LAG_GAUGE_NAME)!;
    expect(LAG_GAUGE_NAME).toBe('outbox_relay.lag_oldest'); // + unit s → the collector's `_seconds` suffix
    expect(gauge.descriptor.unit).toBe('s');
    expect(gauge.dataPoints).toHaveLength(1);
    expect(gauge.dataPoints[0]!.value).toBe(7.5);
    expect(gauge.dataPoints[0]!.attributes).toEqual({}); // no per-store, per-row or per-org label
  });
});
