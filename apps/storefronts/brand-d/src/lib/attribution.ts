/**
 * Marketing attribution: which campaign brought the customer, and which one was in play when they
 * bought. Captured first-party into a cookie and sent to our own Store API as
 * `cart.metadata.attribution` — nothing is sent anywhere else, and no third-party pixel is involved.
 *
 * Two touches are kept. **First** is never overwritten: it is what actually acquired the customer,
 * and overwriting it on a later visit would credit the last campaign for work the first one did.
 * **Last** is replaced whenever a new campaign appears, because that is what closed the sale.
 *
 * No PII. UTM parameters, a referral code, the referrer's **origin** (a full referrer URL can carry
 * a query string with someone's email in it) and the landing path — nothing else.
 */

export const ATTRIBUTION_COOKIE = 'sf_attribution';
export const ATTRIBUTION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** The parameters that count as a marketing touch, in the order they are stored. */
export const UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

export interface AttributionTouch {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  /** Referral code from `?ref=`. */
  ref: string | null;
  /** Origin only — never the full referring URL. */
  referrer: string | null;
  landing_path: string;
  /** ISO-8601. */
  at: string;
}

export interface Attribution {
  first: AttributionTouch;
  last: AttributionTouch;
  /** When `last` was recorded. */
  captured_at: string;
}

/** Values longer than this are truncated: a cookie is not a log, and 4 KB is the whole budget. */
const MAX_VALUE_LENGTH = 200;

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_VALUE_LENGTH);
}

/**
 * The referrer reduced to its origin. A full referrer URL can carry a query string containing
 * personal data, and the origin is all that attribution needs. Same-site referrers are dropped —
 * internal navigation is not a marketing touch.
 */
export function referrerOrigin(
  referrer: string | null | undefined,
  siteOrigin: string,
): string | null {
  const value = clean(referrer);
  if (value === null) return null;
  try {
    const origin = new URL(value).origin;
    return origin === siteOrigin ? null : origin;
  } catch {
    return null;
  }
}

/**
 * A touch, or `null` when the visit carries no marketing signal at all — no UTM parameters, no
 * referral code and no external referrer. That is the "no cookie is written" case: an ordinary
 * direct visit should not create one.
 */
export function readTouch(
  searchParams: URLSearchParams,
  options: { referrer?: string | null; path: string; siteOrigin: string; now?: Date },
): AttributionTouch | null {
  const utm = Object.fromEntries(
    UTM_PARAMS.map((name) => [name, clean(searchParams.get(name))]),
  ) as Pick<AttributionTouch, (typeof UTM_PARAMS)[number]>;

  const ref = clean(searchParams.get('ref'));
  const referrer = referrerOrigin(options.referrer, options.siteOrigin);

  const hasSignal =
    Object.values(utm).some((value) => value !== null) || ref !== null || referrer !== null;
  if (!hasSignal) return null;

  return {
    ...utm,
    ref,
    referrer,
    landing_path: options.path,
    at: (options.now ?? new Date()).toISOString(),
  };
}

/** Tolerant: a corrupted or truncated cookie means "no attribution yet", never a crash. */
export function parseAttribution(raw: string | undefined): Attribution | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<Attribution>;
    if (!isTouch(candidate.first) || !isTouch(candidate.last)) return null;
    return {
      first: candidate.first,
      last: candidate.last,
      captured_at:
        typeof candidate.captured_at === 'string' ? candidate.captured_at : candidate.last.at,
    };
  } catch {
    return null;
  }
}

function isTouch(value: unknown): value is AttributionTouch {
  if (typeof value !== 'object' || value === null) return false;
  const touch = value as Partial<AttributionTouch>;
  return typeof touch.landing_path === 'string' && typeof touch.at === 'string';
}

// ── size ceiling (#102) ──────────────────────────────────────────────────────────────────────────

/**
 * A browser drops an oversized cookie **silently** — no exception, no log, nothing in a dashboard —
 * so attribution would simply stop existing. The per-cookie limit is 4096 bytes for the whole
 * `name=value; attributes` string; this budget is the value alone, leaving room for the name, the
 * path, `Max-Age`, `SameSite` and `HttpOnly`.
 */
export const ATTRIBUTION_COOKIE_MAX_BYTES = 3500;

/** What the browser actually stores: the cookie value is percent-encoded, which can triple bytes. */
export function attributionCookieBytes(attribution: Attribution): number {
  return encodeURIComponent(JSON.stringify(attribution)).length;
}

/** Progressively harsher value limits; the last resort keeps only what identifies a campaign. */
const TRUNCATION_STEPS = [MAX_VALUE_LENGTH, 80, 30] as const;

function truncateTouch(touch: AttributionTouch, limit: number): AttributionTouch {
  const cut = (value: string | null): string | null =>
    value === null ? null : value.slice(0, limit);
  return {
    utm_source: cut(touch.utm_source),
    utm_medium: cut(touch.utm_medium),
    utm_campaign: cut(touch.utm_campaign),
    utm_term: cut(touch.utm_term),
    utm_content: cut(touch.utm_content),
    ref: cut(touch.ref),
    referrer: cut(touch.referrer),
    landing_path: touch.landing_path.slice(0, limit),
    at: touch.at,
  };
}

/** Everything that is not needed to credit a campaign, dropped. */
function minimalTouch(touch: AttributionTouch): AttributionTouch {
  return {
    utm_source: touch.utm_source,
    utm_medium: null,
    utm_campaign: touch.utm_campaign,
    utm_term: null,
    utm_content: null,
    ref: touch.ref,
    referrer: null,
    landing_path: '',
    at: touch.at,
  };
}

/**
 * Shrink the attribution until the cookie the browser will be asked to store fits.
 *
 * The order is deliberate: values are truncated on both touches first, and only then is **`last`**
 * reduced — the first touch is what actually acquired the customer, so it is the one that must
 * survive. Reduction is capped at "still identifies a campaign"; nothing here can make the cookie
 * unparseable, because every step returns a well-formed `Attribution`.
 */
export function capAttribution(attribution: Attribution): Attribution {
  const candidates: Attribution[] = [
    attribution,
    ...TRUNCATION_STEPS.slice(1).map((limit) => ({
      first: truncateTouch(attribution.first, limit),
      last: truncateTouch(attribution.last, limit),
      captured_at: attribution.captured_at,
    })),
    {
      first: truncateTouch(attribution.first, TRUNCATION_STEPS[2]),
      last: minimalTouch(attribution.last),
      captured_at: attribution.captured_at,
    },
    {
      first: minimalTouch(attribution.first),
      last: minimalTouch(attribution.last),
      captured_at: attribution.captured_at,
    },
  ];

  return (
    candidates.find(
      (candidate) => attributionCookieBytes(candidate) <= ATTRIBUTION_COOKIE_MAX_BYTES,
    ) ?? candidates[candidates.length - 1]!
  );
}

/**
 * Fold a new touch into what is stored. The first touch is preserved for the life of the cookie;
 * the last is replaced. Returns the same object when nothing changes, so a caller can skip the
 * cookie write on an ordinary page view.
 *
 * The result is always within the cookie budget (#102): an oversized cookie is dropped by the
 * browser without a word, which would lose the attribution entirely rather than partially.
 */
export function mergeAttribution(
  existing: Attribution | null,
  touch: AttributionTouch | null,
): Attribution | null {
  if (touch === null) return existing;
  if (existing === null)
    return capAttribution({ first: touch, last: touch, captured_at: touch.at });
  return capAttribution({ first: existing.first, last: touch, captured_at: touch.at });
}

/**
 * What goes into `cart.metadata`. Kept as its own type so the API shape is one thing, not three.
 *
 * A `type` rather than an `interface` on purpose: the contract declares `metadata` with an index
 * signature (`{ [key: string]: unknown }`), and only a type alias gets the implicit index signature
 * that makes it assignable to one.
 */
export type CartMetadata = {
  attribution: Attribution;
};

export function metadataFor(attribution: Attribution | null): CartMetadata | undefined {
  return attribution === null ? undefined : { attribution };
}
