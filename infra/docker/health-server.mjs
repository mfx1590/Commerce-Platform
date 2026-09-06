// Fallback process for an app image whose package has no `start` script yet (Phase 0/1 scaffolds).
// It answers GET /health so the image HEALTHCHECK is real today; once window 1/3/4 ship a `start`
// script (Medusa / Next.js), infra/docker/entrypoint.sh runs that instead and this file is unused.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3000);
const app = process.env.APP_NAME ?? 'unknown';

createServer((req, res) => {
  const healthy = req.url === '/health' || req.url === '/health/';
  res.writeHead(healthy ? 200 : 404, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      healthy
        ? { status: 'ok', app, mode: 'scaffold', uptime: Math.round(process.uptime()) }
        : { status: 'not_found' },
    ),
  );
}).listen(port, '0.0.0.0', () =>
  console.info(`[${app}] scaffold health server listening on :${port}`),
);

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
