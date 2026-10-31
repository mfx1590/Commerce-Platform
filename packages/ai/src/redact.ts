// Redaction before anything leaves the process (D8, #605): every rendered string is passed through `redact()`.
// It masks e-mail addresses, payment-like numbers (card numbers that pass the Luhn check, IBANs that pass mod-97),
// phone numbers, and address shapes (a street name with a number, NL/UK postcodes, a US "City, ST 12345" line).
// This is defence in depth: the hard guard is the denylist of customer fields (denylist.ts), which keeps those
// fields out of a prompt altogether. The patterns lean towards masking; a masked GTIN in product copy costs a little
// quality, a leaked card number costs much more.

export type RedactionKind = 'email' | 'card' | 'iban' | 'phone' | 'address';

export interface RedactionResult {
  text: string;
  counts: Record<RedactionKind, number>;
  total: number;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 13–19 digits, optionally grouped by single spaces or hyphens
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
// a phone-shaped run: an optional international prefix, then digits with optional separators. Kept only when it has
// at least 9 digits AND looks like a phone (starts with +, 00 or 0, or uses separators), so a bare 13-digit order
// number or GTIN is left alone.
const PHONE = /(?:(?:\+|\b00)\d{1,3}[\s.-]?)?\(?\b0?\d{1,4}\)?(?:[\s.-]?\d){6,12}\b/g;
const looksLikePhone = (m: string) =>
  m.replace(/\D/g, '').length >= 9 && (/^\s*(?:\+|00|0|\()/.test(m) || /\d[\s.()-]+\d/.test(m));

// Street suffixes in both cases, without the `i` flag (which would let the capitalised-word part swallow a whole
// sentence): "Damstraat", "Baker Street", "Main St.", "Hauptstraße"…
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const eitherCase = (w: string) => `[${w[0]}${w[0]!.toUpperCase()}]${escapeRe(w.slice(1))}`;
const STREET_SUFFIX = `(?:${[
  'straat',
  'laan',
  'weg',
  'plein',
  'gracht',
  'kade',
  'dijk',
  'singel',
  'steeg',
  'hof',
  'street',
  'st.',
  'st',
  'road',
  'rd.',
  'rd',
  'avenue',
  'ave.',
  'ave',
  'lane',
  'ln.',
  'drive',
  'dr.',
  'boulevard',
  'blvd.',
  'way',
  'court',
  'ct.',
  'place',
  'pl.',
  'straße',
  'strasse',
  'str.',
  'gasse',
  'platz',
  'allee',
]
  .map(eitherCase)
  .join('|')})`;
const WORDS = `[A-Z][\\p{L}'-]*(?:\\s[A-Z][\\p{L}'-]*)*`;
// "Damstraat 12", "Baker Street 221B", "Hauptstraße 5a" — and "221B Baker Street", "12 rue de la Paix"
const STREET_AFTER = new RegExp(`\\b${WORDS}\\s?${STREET_SUFFIX}\\s+\\d{1,5}[a-zA-Z]?\\b`, 'gu');
const STREET_BEFORE = new RegExp(
  `\\b\\d{1,5}[a-zA-Z]?\\s+(?:(?:rue|avenue|boulevard|place|chemin|via|calle)\\s+[\\p{L}' -]{2,40}|${WORDS}\\s${STREET_SUFFIX})(?![\\p{L}])`,
  'gu',
);
// NL "1234 AB" followed by a capitalised place name; UK full postcode; US "City, ST 12345(-6789)"
const NL_POSTCODE = /\b[1-9]\d{3}\s?(?!SA|SD|SS)[A-Z]{2}\s+[A-Z][\p{L}'-]+/gu;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b/g;
const US_CITY_ZIP = /\b[A-Z][\p{L}.'-]+(?:\s[A-Z][\p{L}.'-]+)*,\s[A-Z]{2}\s\d{5}(?:-\d{4})?\b/gu;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const c of chunk) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

export function redact(input: string): RedactionResult {
  const counts: Record<RedactionKind, number> = {
    email: 0,
    card: 0,
    iban: 0,
    phone: 0,
    address: 0,
  };
  let text = input;
  const mask = (re: RegExp, kind: RedactionKind, keep?: (m: string) => boolean) => {
    text = text.replace(re, (m) => {
      if (keep && !keep(m)) return m;
      counts[kind] += 1;
      return `[${kind}]`;
    });
  };
  mask(EMAIL, 'email');
  mask(IBAN_CANDIDATE, 'iban', ibanValid);
  mask(CARD_CANDIDATE, 'card', (m) => luhn(m.replace(/\D/g, '')));
  mask(STREET_AFTER, 'address');
  mask(STREET_BEFORE, 'address');
  mask(NL_POSTCODE, 'address');
  mask(UK_POSTCODE, 'address');
  mask(US_CITY_ZIP, 'address');
  mask(PHONE, 'phone', looksLikePhone);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text, counts, total };
}
