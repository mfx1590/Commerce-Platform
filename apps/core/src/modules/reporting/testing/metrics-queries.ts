// Test helper (#603): seeded random queries that the validator and the compiler accept. Shared by the unit property
// test and the ClickHouse leak and latency tests; never imported by production code.
import { DIMENSIONS, GRAINS, METRIC_IDS, METRICS, type Dimension } from '../metrics/catalogue';
import { compileMetricQuery } from '../metrics/compile';
import { parseMetricQuery, type MetricQuery } from '../metrics/query';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random query the validator accepts (metrics sharing a dimension set; filters that apply). */
export function randomQuery(random: () => number, stores: readonly string[]): MetricQuery {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  for (;;) {
    const metrics = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(METRIC_IDS))),
    ];
    const shared = DIMENSIONS.filter((d) =>
      metrics.every((m) => METRICS[m].dimensions.includes(d)),
    );
    const dimensions = shared.filter(() => random() < 0.5).slice(0, 2) as Dimension[];
    const body: Record<string, unknown> = {
      metrics,
      dimensions,
      grain: pick(GRAINS),
      from: '2026-10-01',
      to: pick(['2026-10-08', '2026-11-01', '2027-01-01']),
      filters: random() < 0.5 ? { store_ids: stores.filter(() => random() < 0.7) } : {},
      ...(random() < 0.4
        ? { order_by: { metric: pick(metrics), direction: pick(['asc', 'desc']) } }
        : {}),
      limit: 1 + Math.floor(random() * 1000),
    };
    if ((body.filters as { store_ids?: string[] }).store_ids?.length === 0) body.filters = {};
    try {
      const q = parseMetricQuery(body);
      compileMetricQuery(q, stores); // filters that do not apply are refused there: draw again
      return q;
    } catch {
      /* not a valid combination: draw again */
    }
  }
}
