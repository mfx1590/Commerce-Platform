/** `2026-09-01` → "1 September 2026" in `en-GB`, "1. September 2026" in `de-DE`; garbage is echoed. */
export function formatReviewDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}
