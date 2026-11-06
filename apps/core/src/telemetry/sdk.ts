// The OpenTelemetry SDK of the core (#729): traces and metrics over OTLP/HTTP to the compose collector
// (infra/observability), configured by the standard OTEL_* environment only. Nothing is registered unless an OTLP
// endpoint is set and OTEL_SDK_DISABLED is not `true`; the API then hands out no-op tracers and meters, so tests and
// a plain `pnpm dev` export nothing. A collector that is absent never stops the boot or a request: the exporters
// run in the background (batch span processor, periodic metric reader) and the first failure is ONE warning.
import { context, diag, DiagLogLevel, metrics, trace, type DiagLogger } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';

export interface Telemetry {
  /** Whether anything was registered (an endpoint was configured and the SDK is not disabled). */
  readonly enabled: boolean;
  /** Flushes and stops both providers and unregisters the globals. */
  shutdown(): Promise<void>;
}

/** Test seam (code only): in-memory exporters instead of OTLP; enables the SDK whatever the environment says. */
export interface TelemetryOverrides {
  spanProcessor?: SpanProcessor;
  spanExporter?: SpanExporter;
  metricReader?: MetricReader;
}

let active = false;
let warned = false;

/** True while `startTelemetry` has registered providers: the instrumentation skips all work otherwise. */
export function telemetryActive(): boolean {
  return active;
}

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[core] telemetry: ${message}; further telemetry errors are not logged`);
}

// The SDK reports export failures through diag.error (its global error handler); every one after the first is dropped.
const onceLogger: DiagLogger = {
  error: (message) => warnOnce(`export failed (${String(message).slice(0, 200)})`),
  warn: () => {},
  info: () => {},
  debug: () => {},
  verbose: () => {},
};

/** OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG. The core never takes a parent from a caller, so parentbased_* = base. */
export function samplerFromEnv(env: NodeJS.ProcessEnv): Sampler {
  const name = (env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on').trim().toLowerCase();
  switch (name) {
    case 'always_on':
    case 'parentbased_always_on':
      return new AlwaysOnSampler();
    case 'always_off':
    case 'parentbased_always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
    case 'parentbased_traceidratio': {
      const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? '1');
      return new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? ratio : 1);
    }
    default:
      console.warn(
        `[core] telemetry: OTEL_TRACES_SAMPLER=${name} is not supported; sampling every trace`,
      );
      return new AlwaysOnSampler();
  }
}

function tracesEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const specific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) return specific;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${base.replace(/\/+$/, '')}/v1/traces` : undefined;
}

function configured(env: NodeJS.ProcessEnv): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false;
  return Boolean(
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim(),
  );
}

/** One request at boot so an absent collector is reported at once rather than at the first export. Never awaited. */
async function probeCollector(url: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2_000),
    });
  } catch (err) {
    warnOnce(`the collector at ${url} is unreachable (${(err as Error).name})`);
  }
}

/**
 * Registers the tracer and meter providers when an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT or the
 * per-signal variables; OTEL_SDK_DISABLED=true wins; OTEL_TRACES_EXPORTER / OTEL_METRICS_EXPORTER=none drop one
 * signal). Resource: OTEL_SERVICE_NAME (default `core`), `deployment.environment` and OTEL_RESOURCE_ATTRIBUTES.
 * Called once by `createServer()`, before the middleware is mounted.
 */
export function startTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  overrides: TelemetryOverrides = {},
): Telemetry {
  const forced = Boolean(
    overrides.spanProcessor || overrides.spanExporter || overrides.metricReader,
  );
  if (active || (!forced && !configured(env))) return { enabled: false, shutdown: async () => {} };

  diag.setLogger(onceLogger, DiagLogLevel.ERROR);
  const resource = resourceFromAttributes({
    'service.name': env.OTEL_SERVICE_NAME?.trim() || 'core',
    'deployment.environment': env.NODE_ENV ?? 'development',
  }).merge(detectResources({ detectors: [envDetector] }));

  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);

  let tracerProvider: TracerProvider | undefined;
  const spanProcessor =
    overrides.spanProcessor ??
    (overrides.spanExporter
      ? new BatchSpanProcessor({ exporter: overrides.spanExporter })
      : forced || env.OTEL_TRACES_EXPORTER?.trim() === 'none'
        ? undefined
        : new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }));
  if (spanProcessor) {
    tracerProvider = new TracerProvider({
      resource,
      sampler: samplerFromEnv(env),
      spanProcessors: [spanProcessor],
    });
    trace.setGlobalTracerProvider(tracerProvider);
  }

  let meterProvider: MeterProvider | undefined;
  const reader =
    overrides.metricReader ??
    (forced || env.OTEL_METRICS_EXPORTER?.trim() === 'none'
      ? undefined
      : new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 15_000),
        }));
  if (reader) {
    meterProvider = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
  }

  active = true;
  const url = tracesEndpoint(env);
  if (!forced && url && tracerProvider) void probeCollector(url);
  console.info(
    `[core] telemetry: exporting${tracerProvider ? ' traces' : ''}${meterProvider ? ' metrics' : ''} over OTLP`,
  );

  return {
    enabled: true,
    async shutdown() {
      await Promise.allSettled([tracerProvider?.shutdown(), meterProvider?.shutdown()]);
      trace.disable();
      metrics.disable();
      context.disable();
      diag.disable();
      active = false;
      warned = false;
    },
  };
}
