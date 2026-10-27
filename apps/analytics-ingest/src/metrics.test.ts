import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { createIngestMetrics } from './metrics.js';

describe('ingest metrics (OpenTelemetry)', () => {
  it('exports consumer lag per partition, ingest delay, rows and dead letters', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const m = createIngestMetrics(provider.getMeter('test'));
    m.lag('order.placed', 0, 12);
    m.lag('order.placed', 0, 3); // the latest value wins
    m.lag('refund.issued', 1, 0);
    m.delay(850);
    m.inserted('order.placed', 4);
    m.deadLettered('order.placed', 'UnknownEventError');
    await reader.forceFlush();
    const all = exporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const byName = new Map(all.map((x) => [x.descriptor.name, x]));
    const lag = byName.get('analytics_ingest.consumer_lag')!;
    expect(
      lag.dataPoints.map((d) => [d.attributes.topic, d.attributes.partition, d.value]),
    ).toEqual([
      ['order.placed', 0, 3],
      ['refund.issued', 1, 0],
    ]);
    expect(byName.get('analytics_ingest.ingest_delay')!.dataPoints[0]!.value).toMatchObject({
      count: 1,
      sum: 850,
    });
    expect(byName.get('analytics_ingest.rows_inserted')!.dataPoints[0]!.value).toBe(4);
    expect(byName.get('analytics_ingest.dead_lettered')!.dataPoints[0]!.attributes).toEqual({
      event_topic: 'order.placed',
      error_class: 'UnknownEventError',
    });
    await provider.shutdown();
  });
});
