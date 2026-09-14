// Entry point (`pnpm --filter @platform/feeds start`, and the container's `start` script).
import { createFeedServer, resolveConfig } from './server.js';

const config = resolveConfig();
const server = createFeedServer(config);

server.listen(config.port, () => {
  const scope = config.storeCodes?.length
    ? config.storeCodes.join(', ')
    : 'every store code on disk';
  console.info(`[feeds] listening on :${config.port} — serving ${scope} from ${config.dir}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
