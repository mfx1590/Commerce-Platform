// Transport selection: `NOTIFICATIONS_TRANSPORT=dev|resend`. Production refuses the dev sink (config.ts), and
// the Resend adapter refuses to exist without its key — a worker cannot silently write emails to disk on a
// server, and cannot silently send nothing.
import type { Transport } from '../types.js';
import { DevSinkTransport } from './dev-sink.js';
import { RESEND_KEY_ENV, ResendTransport } from './resend.js';

export type TransportName = 'dev' | 'resend';

export function isTransportName(value: string): value is TransportName {
  return value === 'dev' || value === 'resend';
}

export function createTransport(
  choice: { transport: TransportName; dir: string },
  env: NodeJS.ProcessEnv = process.env,
): Transport {
  switch (choice.transport) {
    case 'dev':
      return new DevSinkTransport(choice.dir);
    case 'resend':
      return new ResendTransport({ apiKey: env[RESEND_KEY_ENV] ?? '' });
  }
}

export { DevSinkTransport, ResendTransport, RESEND_KEY_ENV };
export type { FetchLike, FetchInit, FetchResponse, ResendTransportOptions } from './resend.js';
