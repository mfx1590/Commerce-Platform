/**
 * Consent per channel, read defensively from the contract's free-form `Customer.consent` object.
 *
 * The spec types it as `{ additionalProperties: true }` and its example shows
 * `channel → { granted, at, source }`. Anything else a backend puts there must still render — as
 * a row with what could be read and the raw value alongside — never throw, never hide a channel.
 * Pure, so the shapes are unit-tested without a screen.
 */

export interface ConsentRow {
  channel: string;
  /** `null` when the entry did not say. */
  granted: boolean | null;
  at: string | null;
  source: string | null;
  /** Set when the entry was not the documented shape, so the screen can show it verbatim. */
  raw: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function consentRows(consent: unknown): ConsentRow[] {
  if (!isRecord(consent)) return [];
  return Object.entries(consent)
    .map(([channel, entry]): ConsentRow => {
      if (typeof entry === 'boolean') {
        return { channel, granted: entry, at: null, source: null, raw: null };
      }
      if (isRecord(entry)) {
        const granted = typeof entry['granted'] === 'boolean' ? entry['granted'] : null;
        const at = typeof entry['at'] === 'string' ? entry['at'] : null;
        const source = typeof entry['source'] === 'string' ? entry['source'] : null;
        const documented = granted !== null;
        return {
          channel,
          granted,
          at,
          source,
          raw: documented ? null : JSON.stringify(entry),
        };
      }
      return { channel, granted: null, at: null, source: null, raw: JSON.stringify(entry) };
    })
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

/** "2 of 3 channels" for the list; "—" when nothing is recorded. */
export function consentSummary(consent: unknown): string {
  const rows = consentRows(consent);
  if (rows.length === 0) return '—';
  const granted = rows.filter((row) => row.granted === true).length;
  return `${granted} of ${rows.length} channel${rows.length === 1 ? '' : 's'}`;
}

/** `marketing_email` → "marketing email". */
export function channelLabel(channel: string): string {
  return channel.replaceAll('_', ' ');
}
