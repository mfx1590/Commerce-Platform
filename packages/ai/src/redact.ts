// Redaction before anything leaves the process (D8, #605): every rendered string is passed through `redact()`.
// It masks e-mail addresses, payment-like numbers (card numbers that pass the Luhn check, IBANs that pass mod-97),
// phone numbers, address shapes (a street name with a number, NL/UK postcodes, a US "City, ST 12345" line) and the
// tracking numbers of the common carriers (UPS 1Z…, DHL 10 digits or JJD…, PostNL 3S…, #671). It does NOT mask names, an
// e-mail address spelled out in words, other carriers' tracking numbers, or an address in a shape it does not know.
// Canonical uuids are left as they are (#680): they are ids, and their digit groups would otherwise read as phones.
// This is defence in depth: the hard guard is the denylist of customer fields (denylist.ts), which keeps those
// fields out of a prompt altogether. The patterns lean towards masking; a masked GTIN in product copy costs a little
// quality, a leaked card number costs much more.

export type RedactionKind = 'email' | 'card' | 'iban' | 'phone' | 'address' | 'tracking';

export interface RedactionResult {
  text: string;
  counts: Record<RedactionKind, number>;
  total: number;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// a canonical uuid (8-4-4-4-12 hex) is an id, never PII, but its digit groups look like phone, card and tracking runs
// ("00000000-0000-4000-8000-000000000031" became "[phone]-[phone]", #680). The capture group makes split() keep them.
const UUID_SPLIT = /(\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/i;
// 13–19 digits, optionally grouped by single spaces or hyphens
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
// UPS 1Z + 16; DHL Express exactly 10 digits (a bare run of 10 — 12/13-digit GTINs and order numbers stay), DHL
// parcel JJD + digits; PostNL 3S + a 4-letter customer code + digits
const TRACKING = /\b(?:1Z[0-9A-Z]{16}|JJD\d{10,20}|3S[A-Z]{4}\d{6,11}|\d{10})\b/gi;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
// a phone-shaped run. Two shapes: an international one that starts with + or 00 and runs on through digits and
// separators ("+31612345678", "+1 (415) 555-2671") — its own branch, because a `\b` after the country code cannot
// sit between two digits, which once cut "+31612345678" down to a prefix-less run the check below rejected — and a
// national one (optional "(", optional trunk 0). Kept only when it has at least 9 digits AND looks like a phone
// (starts with +, 00 or 0, or uses separators), so a bare 13-digit order number or GTIN is left alone.
const PHONE = /(?:\+|\b00)\d(?:[\s.()-]{0,2}\d){7,16}\b|\(?\b0?\d{1,4}\)?(?:[\s.-]?\d){6,12}\b/g;
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
    tracking: 0,
  };
  const mask = (
    text: string,
    re: RegExp,
    kind: RedactionKind,
    keep?: (m: string) => boolean,
  ): string =>
    text.replace(re, (m) => {
      if (keep && !keep(m)) return m;
      counts[kind] += 1;
      return `[${kind}]`;
    });
  // e-mail first, over the whole text, so a uuid used as an address's local part does not shield the address
  const rest = (s: string) => {
    s = mask(s, IBAN_CANDIDATE, 'iban', ibanValid);
    s = mask(s, CARD_CANDIDATE, 'card', (m) => luhn(m.replace(/\D/g, '')));
    s = mask(s, STREET_AFTER, 'address');
    s = mask(s, STREET_BEFORE, 'address');
    s = mask(s, NL_POSTCODE, 'address');
    s = mask(s, UK_POSTCODE, 'address');
    s = mask(s, US_CITY_ZIP, 'address');
    // before the phone check, which keeps a bare 10-digit run (not phone-shaped)
    s = mask(s, TRACKING, 'tracking');
    return mask(s, PHONE, 'phone', looksLikePhone);
  };
  // every other pass runs on the text between uuids (even indexes of the split) and leaves the uuids as they are
  const text = mask(input, EMAIL, 'email')
    .split(UUID_SPLIT)
    .map((part, i) => (i % 2 === 1 ? part : rest(part)))
    .join('');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text, counts, total };
}

// one JSON string token. Only for a text that JSON.parse accepted: outside strings valid JSON has no quotes, so this
// finds every string (keys included) and nothing else.
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

/**
 * `redact()` for a tool result that is valid JSON (#680 review): each string, value or key, is decoded, redacted and
 * re-encoded; everything else (numbers, booleans, null, the layout) stays byte for byte. A 10-digit figure stays a
 * number instead of becoming `[tracking]`, a big integer keeps its digits, and the result stays valid JSON. A string
 * with nothing to mask keeps its original encoding.
 */
export function redactJsonStrings(json: string): RedactionResult {
  const counts: Record<RedactionKind, number> = {
    email: 0,
    card: 0,
    iban: 0,
    phone: 0,
    address: 0,
    tracking: 0,
  };
  const text = json.replace(JSON_STRING, (token) => {
    const r = redact(JSON.parse(token) as string);
    if (r.total === 0) return token;
    for (const k of Object.keys(counts) as RedactionKind[]) counts[k] += r.counts[k];
    return JSON.stringify(r.text);
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text, counts, total };
}
