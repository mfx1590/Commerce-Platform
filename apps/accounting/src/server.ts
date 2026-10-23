// The process's HTTP surface for now: `GET /health` (the image contract, infra/docker/entrypoint.sh). The Finance read
// API (#551) mounts next to it later.
import http from 'node:http';

export function createHealthServer(status: () => Record<string, unknown>): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
      const body = JSON.stringify({ status: 'ok', ...status() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', message: 'not found' }));
  });
}
