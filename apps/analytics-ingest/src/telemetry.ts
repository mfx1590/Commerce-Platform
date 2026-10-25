// Metrics export over OTLP/HTTP to the collector (infra/README.md "What an app has to do"), only when
// OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise the API's no-op meter is used and nothing leaves the process.
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export interface Telemetry {
  shutdown(): Promise<void>;
}

export function startTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return { shutdown: async () => {} };
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': env.OTEL_SERVICE_NAME ?? 'analytics-ingest',
      'deployment.environment': env.NODE_ENV ?? 'development',
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 15_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  return { shutdown: () => provider.shutdown() };
}
