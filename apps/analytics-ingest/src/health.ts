// `GET /health` (#641 item 2): the container contract's one probe path (apps/analytics-ingest/Dockerfile; the chart
// points startup, readiness and liveness at it). 200 only while the consumer is joined AND making progress, 503
// otherwise, so the orchestrator restarts a stuck consumer instead of trusting a live process. The body carries the
// verdict's inputs (no PII: the group id and ages only).
import type { IngestHealth } from './ingest.js';

export interface HealthAnswer {
  status: 200 | 503 | 404;
  body: string;
}

export function healthAnswer(
  url: string | undefined,
  groupId: string,
  health: IngestHealth,
): HealthAnswer {
  if (url !== '/health') return { status: 404, body: '{}' };
  return {
    status: health.ready ? 200 : 503,
    body: JSON.stringify({ ok: health.ready, group_id: groupId, ...health }),
  };
}
