# Scripts on storefront pages: inventory and authorisation

Every script that runs in a shopper's browser on a storefront page, its purpose, and how the
Content-Security-Policy authorises it (#782; a PCI DSS 4.0 req. 6.4.3-style list). The policy is
built per request in `src/lib/csp.ts` and set by `src/middleware.ts`.

The production `script-src` is
`'nonce-<per response>' 'strict-dynamic' https://js.stripe.com https://*.js.stripe.com`, with no
`'unsafe-inline'` and no `'unsafe-eval'`. A script not on this list does not run.

**Keep this file current:** adding a script without a row here is a review finding. `e2e/csp.spec.ts`
fails on any CSP violation on the pages it visits.

| Script                                                                                                                          | Where                                                                                               | Purpose                                                             | How it is authorised                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js inline bootstrap and RSC payload (`self.__next_f.push(...)`, the webpack loader, streaming boundary scripts)            | every page                                                                                          | hydrates the server-rendered page                                   | **nonce**: Next reads it from the request's `Content-Security-Policy` header (forwarded by the middleware) and stamps it on each inline script                                                                                                                                      |
| Next.js chunks `/_next/static/chunks/*.js` (react-dom, the Next runtime, the app's client components, the `noModule` polyfills) | every page                                                                                          | client runtime and client components                                | **nonce** on the `<script src>` tags Next writes; chunks loaded later by webpack via **`'strict-dynamic'`**                                                                                                                                                                         |
| Stripe.js `https://js.stripe.com/v3`                                                                                            | the checkout **review** step, when Card was chosen on the payment step (`checkout/review/page.tsx`) | the Payment Element (card fields, 3-D Secure)                       | **`'strict-dynamic'`**: inserted by `loadStripe()` (`@stripe/stripe-js`) from a nonced chunk (`src/components/card-payment.tsx`). The hosts stay in the list for browsers older than CSP3. Card data is entered in Stripe's own iframes (`frame-src`) and never reaches this origin |
| Scripts inside Stripe's iframes                                                                                                 | inside `js.stripe.com`, `*.js.stripe.com`, `hooks.stripe.com` frames                                | Stripe's card and 3-D Secure UI                                     | governed by **Stripe's** documents, not this policy; this policy only allows the frames (`frame-src`)                                                                                                                                                                               |
| JSON-LD `<script type="application/ld+json">` (`src/components/json-ld.tsx`)                                                    | home and PDP                                                                                        | organisation / product and breadcrumb data for crawlers             | **not executed**: a data block, not script. `script-src` does not apply to it. Its content is escaped by `serializeJsonLd`                                                                                                                                                          |
| Analytics (`src/lib/analytics/track.ts`, #609)                                                                                  | rails on PDP and cart                                                                               | `recommendation_viewed` / `recommendation_clicked`                  | no script of its own: code inside a nonced chunk; pushes to `window.dataLayer` and a DOM event, no network request                                                                                                                                                                  |
| The zone boundary (`src/components/zone-boundary.tsx`)                                                                          | every page                                                                                          | makes entering and leaving checkout a full page load (see "Frames") | no script of its own: a client component inside a nonced chunk                                                                                                                                                                                                                      |

**Stripe's list** is the Stripe.js entry of Stripe's security guide (docs.stripe.com/security/guide,
"Content Security Policy", checked 2026-11-10; the page shows no date).

- **Included:** `js.stripe.com` and `*.js.stripe.com` (script and frame), `hooks.stripe.com` (3-D Secure, frame) and `api.stripe.com` (connect).
- **Not included, because the storefront uses neither:** `maps.googleapis.com` (the Address Element with our own Maps key) and Link's `link.com` hosts.
- **Blind spot:** the Payment Element has not yet been mounted under this policy in an automated run. CI has no Stripe TEST key, so `card-payment.spec.ts` and the Payment Element step of `csp.spec.ts` (which advances to review with Card chosen, where the Element mounts) skip there, and say so. The first core run with a TEST key is the proof.

**There is none of:**

- `next/script` (`<Script>`);
- third-party analytics, tag manager, CDP, chat or consent-banner snippets. The launch wave's analytics sink (LAUNCH 8.3) and any consent banner (8.2) must be added to this table, loaded from a nonced chunk or with the nonce (Next stamps its own scripts; a server component can read the nonce from the request's `Content-Security-Policy` header);
- inline event handlers (`onclick="…"`), which a nonce cannot authorise;
- `eval` / `new Function` in client code. `'unsafe-eval'` is development-only for React Refresh. The storefront ships no zod to the client, so window 4's zod JIT probe does not apply.

**A brand** that adds a script (a font loader, a widget, a pixel) adds a row here, and loads it from
a chunk or with the nonce. `'unsafe-inline'` is not an option.

## Frames

What the storefront may frame (`frame-src`, #782), and the residual. These are the two zones the
manager decided in the #783 review; the earlier per-route scoping broke embeds after a client-side
navigation from a strict page.

| Zone                                                                                                                           | `frame-src`                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Checkout zone**: the checkout steps (where the Payment Element mounts) and the order confirmation (`checkout/*`, `orders/*`) | `'self'` and Stripe (`js.stripe.com`, `*.js.stripe.com`, `hooks.stripe.com`) only |
| **Everything else**: home, PLP, PDP, categories, cart, account, CMS pages, the 404s                                            | `'self'`, Stripe, and the vetted campaign embed hosts                             |

**Crossing between the zones is a full page load, in both directions.** A policy binds to the
document it arrived with, so a client-side navigation would carry one zone's policy into the other.
`ZoneBoundary` (in the root layout) handles it in two layers:

- **Clicks:** a link click whose target is in the other zone becomes `location.assign()` before Next's `<Link>` can turn it into a soft navigation. That covers the cart's "Checkout" button, the checkout header's logo and "Continue shopping", the confirmation's links, and the account's order links, a brand's chrome included.
- **Anything else** (a server-action redirect) that reaches the other zone without a new document reloads the page at that URL.

`e2e/csp.spec.ts` asserts a new document, with the right policy, on entering checkout from the cart
by click and on leaving it, and fails with `ZoneBoundary` removed.

**The embed hosts** come from window 6's `EMBED_HOSTS` (`@platform/cms`), passed as
`CSP_FRAME_HOSTS` and vetted by `parseFrameHosts` against a strict grammar:

- `https://`, a lower-case host of letters, digits, dots and hyphens whose last label starts with a letter, an optional port, nothing else;
- `https://*.<domain>` **only** for the site builders in `WILDCARD_EMBED_DOMAINS` (`framer.app`, `framer.website`, `builder.io`).

The grammar, not `URL`, is the security boundary: `URL` accepts `;` in a host, which would inject a
directive. Anything else is refused, logged once at start (`[csp] CSP_FRAME_HOSTS entry refused (…)`)
and never sent to the browser. Adding a wildcard domain is a code change with review in
`src/lib/csp.ts`, never an environment setting (REQUEST #784 keeps window 6's list in step).

**Residual, stated plainly:**

- **Any site published on those builders can be framed outside the checkout zone.** The wildcard admits every customer's `<site>.framer.app`, not only ours.
- **The editor-side control is window 6's Studio**, which validates an embed URL against `EMBED_HOSTS` before it can be published.
- **A framed site cannot run script in our origin.** It is a cross-origin frame, sandboxed by the embed component (`src/lib/cms/components/embed.tsx`).

**HTML embeds (`srcdoc`) no longer run inline scripts.** An embed given as raw HTML
(`srcDoc`, sandbox `allow-scripts allow-forms allow-popups`) is not a cross-origin document: it
inherits this page's policy. Its inline `<script>` carries no nonce, so it is blocked, and so is any
script loaded by one. Static HTML in such an embed still renders. An editor who needs interactive
content should embed a published Framer or Builder page by URL (a cross-origin frame with its own
policy). Raised with window 6 on REQUEST #784, which owns the Studio's guidance.
