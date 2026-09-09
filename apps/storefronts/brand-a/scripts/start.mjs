#!/usr/bin/env node
/**
 * `next start`, with this app's documented port as the default.
 *
 * REQUEST #68 asks that the app honour `$PORT` so the container image and its HEALTHCHECK agree —
 * a hard-coded `--port` wins over `$PORT` and the pod never becomes ready. But bare `next start`
 * falls back to 3000, which collides with the admin app locally, so the default here is 3101:
 * brand A's port (the starter keeps 3100, so both can run side by side).
 *
 * A wrapper rather than `next start --port ${PORT:-3101}` because that shell syntax does not expand
 * on Windows, where this repo is developed.
 */
import { spawnSync } from 'node:child_process';

process.env.PORT ??= '3101';

const result = spawnSync('next', ['start'], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
