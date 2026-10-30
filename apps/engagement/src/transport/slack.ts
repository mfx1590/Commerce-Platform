import type { Alert } from '../types.js';
import { TransportError, type AlertTransport } from './types.js';

/** The slice of `fetch` this transport uses, so a test injects one instead of opening a socket. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SlackTransportOptions {
  /** The incoming-webhook URL. Environment only (`SLACK_OPS_WEBHOOK_URL`); never a default, never logged. */
  webhookUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Slack incoming webhook. The URL IS the credential — it is read from the environment, kept in this object,
 * and never put in a log line, an error message or an alert field. A refusal becomes
 * `TransportError("slack: HTTP <status> <name>")`: the status and Slack's short error word (`invalid_payload`,
 * `channel_not_found`), never the body, because a Slack error body can echo the payload back.
 *
 * Not yet exercised against a real workspace: no Slack account exists (#553). Live use is on the launch
 * checklist; the dev sink is what runs today.
 */
export class SlackAlertTransport implements AlertTransport {
  readonly name = 'slack';
  readonly #webhookUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(opts: SlackTransportOptions) {
    if (!opts.webhookUrl?.trim()) {
      throw new Error('slack transport: SLACK_OPS_WEBHOOK_URL is required');
    }
    this.#webhookUrl = opts.webhookUrl.trim();
    this.#fetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async send(alert: Alert): Promise<void> {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(this.#webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(slackPayload(alert)),
      });
    } catch (err) {
      // A transport error must not carry the URL: a fetch failure's message can contain it.
      const name = err instanceof Error ? err.name : 'Error';
      throw new TransportError(`slack: request failed ${name}`, { retryable: true });
    }
    if (!res.ok) {
      const word = await errorWord(res);
      throw new TransportError(`slack: HTTP ${res.status}${word ? ` ${word}` : ''}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
  }

  /** The timeout is informational for now: the injected fetch in tests has no signal. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }
}

/** Slack's refusals are a single short word (`invalid_payload`); anything longer is dropped, body and all. */
async function errorWord(res: { text(): Promise<string> }): Promise<string> {
  try {
    const body = (await res.text()).trim();
    return /^[a-z_]{1,40}$/.test(body) ? body : '';
  } catch {
    return '';
  }
}

/** Slack mrkdwn: only these three characters are special. */
export function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A value that is about to be wrapped in a `code span`, made unable to leave it (#657).
 *
 * A backtick closes the span, so the rest of the value becomes Slack markup — bold, a link, a mention. A
 * newline ends the bullet, so a multi-line value invents bullets of its own. Both are replaced rather than
 * dropped so the value stays legible and obviously altered: a reader sees `card_declined ' + "'" + ' and knows the
 * quote was not in the data.
 */
export function escapeCodeSpan(value: string): string {
  return escapeMrkdwn(value)
    .replace(/`/g, "'")
    .replace(/\r\n|[\r\n]/g, ' ⏎ ');
}

/** The webhook body. `text` is the notification fallback; the section block is what a human reads. */
export function slackPayload(alert: Alert): {
  text: string;
  blocks: { type: string; text: { type: string; text: string } }[];
} {
  const icon = alert.severity === 'critical' ? ':rotating_light:' : ':warning:';
  const head = `${icon} *${escapeMrkdwn(alert.title)}*`;
  const lines = Object.entries(alert.fields).map(
    ([k, v]) => `• ${escapeMrkdwn(k)}: \`${escapeCodeSpan(String(v))}\``,
  );
  if (alert.suppressed > 0) {
    lines.push(`• _${alert.suppressed} more of this rule suppressed by the rate limit_`);
  }
  const text = `${head}\n${lines.join('\n')}`;
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}
