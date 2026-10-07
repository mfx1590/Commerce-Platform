# @platform/notifications

The transactional email worker (#360, Integration 2b go-live requirement): consumes `order.placed` and
`shipment.shipped` from the outbox table and sends **one email per event, exactly once**, through a pluggable
transport. Owner: window 17 (marketing). Run/test commands and the public API: `CLAUDE.md`.

Today it sends two emails for brand A in two locales (en-GB, de-DE): the order confirmation and the shipping
notice. The storefront's confirmation page still says nothing about an email — window 3 flips the copy
(#351) once sends are proven real at the 2b gate.

## How it runs

`pnpm --filter @platform/notifications start` (what window 5's image runs — the `start` script is what switched
the Dockerfile from the scaffold health server to the worker). One process serves one organization and the
store codes it is configured for; it polls the outbox every `NOTIFICATIONS_POLL_MS` and answers HTTP on `$PORT`:

| Route                                            | Who            | What                                                                         |
| ------------------------------------------------ | -------------- | ---------------------------------------------------------------------------- |
| `GET /health`                                    | anyone         | `{ status, transport, stores, last_run }` — the last run's per-store counts  |
| `GET /preview/order-confirmation?store=&locale=` | staff (Bearer) | the template on sample data, as HTML; `&format=text` for the plain-text part |
| `GET /preview/shipment-shipped?store=&locale=`   | staff (Bearer) | same for the shipping notice                                                 |

`pnpm --filter @platform/notifications once` runs a single pass and prints the report — the way to drive it
from a script or a test job without a long-lived process.

### Environment

| Variable                               | Default                          | Meaning                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL_APP`                     | —                                | the `platform_app` role (RLS applies; the worker runs an organization-scoped client)                                                                                                       |
| `NOTIFICATIONS_STORE_CODES`            | every store with a brand profile | comma-separated store codes to serve; **required in production**; each needs a profile in `src/brands.ts`                                                                                  |
| `NOTIFICATIONS_ORGANIZATION_ID`        | the seeded HQ                    | the organization this process serves                                                                                                                                                       |
| `NOTIFICATIONS_TRANSPORT`              | `dev`                            | `dev` (files on disk) or `resend`; **`dev` is refused in production**                                                                                                                      |
| `NOTIFICATIONS_DIR`                    | `.notifications`                 | where the dev sink writes (git-ignored; REQUEST filed for the root `.gitignore` row)                                                                                                       |
| `RESEND_API_KEY`                       | —                                | the Resend key, environment only; the adapter refuses to construct without it                                                                                                              |
| `NOTIFICATIONS_POLL_MS`                | `5000`                           | poll interval                                                                                                                                                                              |
| `NOTIFICATIONS_BATCH_SIZE`             | `100`                            | outbox rows claimed / deliveries attempted per run and store                                                                                                                               |
| `NOTIFICATIONS_MAX_ATTEMPTS`           | `5`                              | provider refusals are retried on later runs until this many attempts                                                                                                                       |
| `NOTIFICATIONS_LOOKBACK`               | `500`                            | outbox rows re-read below the cursor on every run (see "Exactly once")                                                                                                                     |
| `NOTIFICATIONS_DEV_TOKENS`             | off                              | `1` accepts `Bearer dev:<keycloak_subject>` on the preview route, like `CORE_DEV_TOKENS`; refused in production                                                                            |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM_STAFF` | `http://localhost:8180`, `staff` | the staff realm for real preview tokens (via `@platform/auth-sdk`)                                                                                                                         |
| `NOTIFICATIONS_<STORE>_<FIELD>`        | profile defaults                 | per-brand overrides: `SENDER`, `REPLY_TO`, `SUPPORT_EMAIL`, `WEBSITE_URL`, `LEGAL_ADDRESS`, `IMPRINT_URL`, `PRIVACY_URL` (`brand-a` → `NOTIFICATIONS_BRAND_A_SENDER="Brand A <orders@…>"`) |
| `PORT`                                 | `4030`                           | HTTP port (the image sets 9005)                                                                                                                                                            |

Locally: `.env` with the DB rows, nothing else, and `pnpm --filter @platform/notifications dev`. Place an
order on the storefront; within a poll interval `.notifications/brand-a/<event_id>.html` appears and the log
says `notifications: sent kind=order_confirmation store=brand-a locale=en-GB event=… order=#1001`.

## Exactly once

Two phases per store and run, in `src/consumer.ts`:

1. **Claim** — one transaction, no network. Read this consumer's position from `marketing_cursor` (name
   `notifications`), read the outbox rows of the two topics after it, insert one `notification_delivery` row
   per event with `ON CONFLICT (event_id) DO NOTHING`, advance the cursor, commit. The unique constraint on the
   **event id** is the replay guard: a re-delivered event, a reset cursor or a re-run from an older position
   inserts nothing and sends nothing. The cursor is only there so a run does not rescan the whole outbox.
2. **Deliver** — after the commit, row by row: load the order (or shipment + order) **from the database**,
   render, stamp the attempt (`attempts + 1`, `attempted_at`), send, mark `sent` or `failed`. A send is never
   inside a transaction: a slow provider holds no lock, and a crash leaves a row that says how far it got.

What the row statuses mean, and what the worker does about them:

| Status    | `attempted_at` | Meaning                                                                      | Next run                                                                                                                    |
| --------- | -------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pending` | null           | claimed, not attempted                                                       | attempts it                                                                                                                 |
| `pending` | set            | **stuck**: the process died between the send and the mark                    | **never resent**; counted on `/health` and a `warn` line — the owner decides, because the email may already be in the inbox |
| `failed`  | set            | the provider refused it (`last_error` = status + error name, never the body) | retried while `attempts < NOTIFICATIONS_MAX_ATTEMPTS`; then reported as `exhausted`                                         |
| `sent`    | set            | the provider accepted it (`provider`, `provider_message_id`)                 | nothing                                                                                                                     |
| `skipped` | null           | the source row was gone (an order deleted before the worker got to it)       | nothing                                                                                                                     |

The **lookback**: the outbox's `seq` is assigned when the producer's transaction inserts, not when it commits,
so a row with a lower `seq` can become visible after a higher one was read and moved the cursor past it. Every
run therefore re-reads `NOTIFICATIONS_LOOKBACK` rows below the cursor; the unique constraint makes re-reading
free. This is deliberately clock-free — a grace window comparing the producer's `occurred_at` with the
database's `now()` fails on ordinary clock skew between the app host and Postgres (the cross-clock trap from
Memory-17). The search sync and the relay have the same gap and no lookback; this consumer cannot afford a
silently missing confirmation.

Ordering: deliveries are attempted in outbox order (`event_seq`), so the confirmation of an order always goes
before its shipping notice.

**One worker per organization.** Two processes serving the same store would both pick the same `pending`
rows; the stamp is per row, not a lease. If that is ever needed the stamp becomes `FOR UPDATE SKIP LOCKED` on
a lease column — not built, not needed for one brand.

## Transports

`Transport { name; send(email, meta) }` in `src/types.ts`. `meta` is `{ eventId, kind, storeCode, locale,
displayId }` — what a log line may know. The address lives in `email.to` and goes to the transport only.

- **`dev`** (`DevSinkTransport`): writes `<dir>/<store_code>/<event_id>.html`, `.txt` (subject + text part) and
  `.json` (the envelope, including the recipient) and returns `dev:<event_id>`. Open the `.html` in a browser.
- **`resend`** (`ResendTransport`): `POST https://api.resend.com/emails` with Node's `fetch`, `Idempotency-Key:
notifications/<event_id>` (Resend de-duplicates for 24 h — a retry after a timeout is not a second email),
  tags `kind`/`store`/`event_id`. A non-2xx answer becomes `TransportError("resend: HTTP <status> <name>")`
  with nothing from the body; 429/5xx are marked retryable, 4xx not (both are retried by the attempt policy —
  the flag is information for the owner). No key, no instance. **Not yet exercised against the real API**: the
  owner's account does not exist; the live send is the 2b gate and closes #360.

## Templates and brands

Templates are TypeScript functions in `src/templates/` — `order-confirmation.ts`, `shipment-shipped.ts` —
over a shared `layout.ts` (table-based HTML with inline styles, and a plain-text alternative) and
`strings.ts` (every user-visible string per locale: en-GB, de-DE). Every value reaching HTML is escaped
(`format.ts`); only absolute http(s) URLs become links. Money is formatted **from minor units by
`Intl.NumberFormat(locale, currency)`** — `10494` EUR is `€104.94` in en-GB and `104,94 €` in de-DE, and a
zero-decimal currency is never divided by a guessed 100. Dates use the store's timezone.

Locale rule (`pickLocale`): the order's locale when a template exists for it; otherwise the first template of
the same language (`de-AT` → `de-DE`, `en-US` → `en-GB`); otherwise the brand's default. A customer who
checked out in German must not get an English confirmation because of a region tag.

Brand profiles (`src/brands.ts`): sender, reply-to, support address, website, default locale and the legal
footer, per store code. The company name and VAT number are read from the **`legal_entity` row** at boot;
the registered address and the real sender domain are placeholders overridable from the environment (table
above) until the owner sets them at go-live. The placeholder is deliberately visible (`[registered address —
set NOTIFICATIONS_BRAND_A_LEGAL_ADDRESS before go-live]`) so a preview shows what is missing. Only brand A has
a profile; the worker refuses to start for a store code without one.

## Preview

`GET /preview/<kind>?store=<code>[&locale=<l>][&format=text]` renders the sample data in
`src/templates/fixtures.ts` — never a real order, so the route never touches a customer. Auth: a staff-realm
JWT (`@platform/auth-sdk`'s verifier) or, with `NOTIFICATIONS_DEV_TOKENS=1` outside production,
`Bearer dev:<keycloak_subject>`; either way the subject must be an **active `staff_user`** — a token is a
claim, the row is the fact. No OpenFGA relation is checked: the route shows sample data, and "is a staff
member of this organization" is the whole question. Unauthenticated callers get 401 before any query
parameter is read.

```
curl -H 'Authorization: Bearer dev:seed-owner' 'http://localhost:4030/preview/order-confirmation?store=brand-a&locale=de-DE'
```

## Schema

`notification_delivery` is `packages/db/migrations/0180_notification_delivery.sql` (db 0.3.3, CONTRACT CHANGE
#393, landed in #397). It travelled the #244 way: proposed as a copy inside this app, applied by the tests to
their throwaway database until the main window landed it, then deleted — the tests now run on the real
migration. It carries no address — a report over it can say how many confirmations went out and how many are
stuck without knowing who any of them went to. The cursor is a `marketing_cursor` row (migration 0170, #244),
which this app may write because it is marketing's table.

## PII

- The address is read from `"order"` at send time and exists in the `RenderedEmail` only; it is never in a
  delivery row, an event, a log line or an error label. `consumer.test.ts` sweeps every log line of the whole
  file for the fixture's address, name and street.
- `last_error` is the HTTP status and the provider's error name; the response body (which may echo the
  recipient) is dropped.
- The dev sink's `.json` envelope does contain the recipient — it is a local file in a git-ignored directory.

## Tests

```
pnpm --filter @platform/notifications exec vitest run      # ~8 s; the consumer file builds its own throwaway DB
pnpm --filter @platform/notifications typecheck            # src and tests
pnpm lint && pnpm typecheck && pnpm test --filter @platform/notifications
```

- `templates/templates.test.ts` — both kinds × both locales, locale formatting, escaping, `pickLocale`,
  brand overrides.
- `transport/transport.test.ts` — the dev sink on a temp dir; Resend against an injected fetch (key in the
  header, idempotency key, body shape, refusal → label only); `resolveConfig`'s production refusals.
- `server.test.ts` — `/health`, 401 before anything, preview per locale and format, 400/404/405.
- `consumer.test.ts` — real `order.placed`/`shipment.shipped` envelopes (validated against the schemas) on a
  seeded database: exactly once (second run, cursor reset), locale fallback, skipped source, both events of
  one order in order, retry and exhaustion, stuck rows never resent, store/topic isolation, the lookback, the
  dev-token path against `staff_user`, and the PII sweep.

## What is not here (and where it is tracked)

- **A live send.** Blocked on the owner's Resend account; proven at the 2b gate, which closes #360.
- The storefront copy ("we have sent…") — window 3, #351.
- A second brand: add a profile in `src/brands.ts` and strings for any new locale.
- SMS/WhatsApp/Slack, Novu, consumer groups — the Phase 4 scope this scaffold was reserved for; the transport
  seam is where a provider would plug in.
