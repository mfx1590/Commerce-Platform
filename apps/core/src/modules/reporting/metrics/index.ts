// The metrics API (#603, D4) inside the reporting module: catalogue, validator, compiler, executor and routes.
export { catalogueFor, DIMENSIONS, GRAINS, LIMITS, METRIC_IDS, METRICS } from './catalogue';
export type { Dimension, Grain, MetricDefinition, MetricId, SourceId } from './catalogue';
export { parseMetricQuery } from './query';
export type { MetricQuery } from './query';
export { additiveMetrics, compileMetricQuery } from './compile';
export type { CompiledSource, Compiled } from './compile';
export { executeMetricQuery, scopedEverywhere } from './execute';
export type { MetricResult, MetricRow, MetricsReader } from './execute';
export { METRICS_PATH, METRICS_QUERY_PATH, metricsAdminRouter, metricsScope } from './routes';
export type { MetricsRouterOptions } from './routes';
