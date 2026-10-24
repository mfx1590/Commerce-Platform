// The process's HTTP surface: `GET /health` (the image contract, infra/docker/entrypoint.sh) and, when given, the
// Finance read API handler (#551, src/api) for everything under /accounting/.
import http from 'node:http';

export type ExtraHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<boolean>;

export function createHealthServer(
  status: () => Record<string, unknown>,
  extra?: ExtraHandler,
): http.Server {
  return http.createServer((req, res) => {
    if (extra && req.url?.startsWith('/accounting/')) {
      void extra(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'not_found', message: 'not found', details: {} }));
        }
      });
      return;
    }
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
