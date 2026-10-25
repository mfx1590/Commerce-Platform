// OpenTelemetry instruments of the ingest. Recorded through @opentelemetry/api: without a MeterProvider (tests,
// no OTEL_EXPORTER_OTLP_ENDPOINT) the API hands out no-op instruments, so nothing here needs a collector.
//   analytics_ingest.consumer_lag        gauge, messages behind the partition's high watermark (topic, partition)
//   analytics_ingest.ingest_delay        histogram, ms from the relay's publish (Kafka timestamp) to the CH ack
//   analytics_ingest.rows_inserted       counter (topic)
//   analytics_ingest.dead_lettered       counter (event_topic, error_class)
//   analytics_ingest.insert_duration     histogram, ms per acknowledged insert
import { metrics, type Meter } from '@opentelemetry/api';

export interface IngestMetrics {
  lag(topic: string, partition: number, messages: number): void;
  delay(ms: number): void;
  inserted(topic: string, n: number): void;
  deadLettered(eventTopic: string, errorClass: string): void;
  insertDuration(ms: number): void;
}

export function createIngestMetrics(
  meter: Meter = metrics.getMeter('@platform/analytics-ingest'),
): IngestMetrics {
  const lagByPartition = new Map<string, { topic: string; partition: number; value: number }>();
  meter
    .createObservableGauge('analytics_ingest.consumer_lag', {
      description: 'Messages between the last committed batch and the partition high watermark',
      unit: '{message}',
    })
    .addCallback((result) => {
      for (const l of lagByPartition.values())
        result.observe(l.value, { topic: l.topic, partition: l.partition });
    });
  const delay = meter.createHistogram('analytics_ingest.ingest_delay', {
    description: 'Relay publish → ClickHouse acknowledged insert',
    unit: 'ms',
  });
  const rows = meter.createCounter('analytics_ingest.rows_inserted', { unit: '{row}' });
  const dead = meter.createCounter('analytics_ingest.dead_lettered', { unit: '{message}' });
  const insert = meter.createHistogram('analytics_ingest.insert_duration', { unit: 'ms' });
  return {
    lag(topic, partition, value) {
      lagByPartition.set(`${topic}:${partition}`, { topic, partition, value });
    },
    delay: (ms) => delay.record(Math.max(0, ms)),
    inserted: (topic, n) => rows.add(n, { topic }),
    deadLettered: (event_topic, error_class) => dead.add(1, { event_topic, error_class }),
    insertDuration: (ms) => insert.record(ms),
  };
}
