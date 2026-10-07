// Locale-aware formatting from minor units, and HTML escaping. No library: `Intl` on Node 20 (full ICU) does
// exactly what a template needs, and an email with a wrongly formatted total is a customer-service ticket.

/**
 * `123456` + `EUR` + `de-DE` → `1.234,56 €`; `en-GB` → `€1,234.56`. The number of minor digits comes from
 * Intl's own knowledge of the currency (JPY has none), so `amountMinor` is never divided by a guessed 100.
 */
export function formatMinor(amountMinor: number, currency: string, locale: string): string {
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(amountMinor / 10 ** digits);
}

export function formatDate(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(new Date(iso));
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Every value that reaches HTML goes through here — product titles and addresses are customer-typed data. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Template literal tag: interpolations are escaped, the literal parts are trusted markup. Named `tpl`, not `html`, so prettier does not reformat the markup as embedded HTML (that formatting is not idempotent across nested tags). */
export function tpl(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      out += v instanceof RawHtml ? v.value : escapeHtml(v == null ? '' : String(v));
    }
  });
  return out;
}

export class RawHtml {
  constructor(readonly value: string) {}
}

/** Marks a string as already-rendered markup (the output of another `tpl` call). */
export function raw(value: string): RawHtml {
  return new RawHtml(value);
}
