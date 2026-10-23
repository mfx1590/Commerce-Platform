import type { Alert } from '../types.js';

/**
 * Where an alert goes. One method, so a provider that nobody can run yet (Slack, PagerDuty, Opsgenie) is one
 * file and a config value — the seam apps/notifications proved for e-mail.
 */
export interface AlertTransport {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

/**
 * A transport refused the alert. The message carries the transport name, the HTTP status and the provider's
 * error name — never the response body (which can echo the webhook URL) and never the alert's fields.
 */
export class TransportError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'TransportError';
    this.retryable = opts.retryable ?? false;
  }
}
