import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Alert } from '../types.js';
import type { AlertTransport } from './types.js';

/**
 * The local sink: one JSON object per line in `<dir>/ops-alerts.jsonl`, appended. JSON LINES rather than a file
 * per alert (apps/notifications' choice for e-mail) because alerts are read as a stream — `tail -f` while
 * placing a failing order, or `jq` over the file in a test.
 *
 * The directory is git-ignored (`.engagement/`, the manager adds the row on main). Refused in production by
 * `resolveConfig`: a dropped ops alert in production is an incident nobody hears about.
 */
export class DevSinkAlertTransport implements AlertTransport {
  readonly name = 'dev';
  readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, 'ops-alerts.jsonl');
  }

  async send(alert: Alert): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(alert)}\n`, 'utf8');
  }
}
