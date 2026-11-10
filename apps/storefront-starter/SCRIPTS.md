# Scripts on storefront pages: inventory and authorisation

Every script that runs in a shopper's browser on a storefront page, with its purpose and how the
Content-Security-Policy authorises it (#782; PCI DSS 4.0 req. 6.4.3-style list). The policy is
built per request in `src/lib/csp.ts` and set by `src/middleware.ts`.

The production `script-src` is `'nonce-<per response>' 'strict-dynamic' https://js.stripe.com`, with
no `'unsafe-inline'` and no `'unsafe-eval'`. A script not on this list does not run.

**Keep this file current:** adding a script without a row here is a review finding. `e2e/csp.spec.ts`
fails on any CSP violation on the pages it visits.

| Script                                                                                                                          | Where                                                     | Purpose                                                 | How it is authorised                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js inline bootstrap and RSC payload (`self.__next_f.push(...)`, the `_R_` webpack loader, streaming boundary scripts)      | every page                                                | hydrates the server-rendered page                       | **nonce**: Next reads it from the request's `Content-Security-Policy` header (forwarded by the middleware) and stamps it on each inline script                                                                                                                                      |
| Next.js chunks `/_next/static/chunks/*.js` (react-dom, the Next runtime, the app's client components, the `noModule` polyfills) | every page                                                | client runtime and client components                    | **nonce** on the `<script src>` tags Next writes; chunks loaded later by webpack via **`'strict-dynamic'`**                                                                                                                                                                         |
| Stripe.js `https://js.stripe.com/v3`                                                                                            | checkout payment step only, when the card option is shown | the Payment Element (card fields, 3-D Secure)           | **`'strict-dynamic'`**: inserted by `loadStripe()` (`@stripe/stripe-js`) from a nonced chunk (`src/components/card-payment.tsx`). The host stays in the list for browsers older than CSP3. Card data is entered in Stripe's own iframes (`frame-src`) and never reaches this origin |
| Scripts inside Stripe's iframes                                                                                                 | inside `js.stripe.com` / `hooks.stripe.com` frames        | Stripe's card and 3-D Secure UI                         | governed by **Stripe's** documents, not this policy; this policy only allows the frames (`frame-src`)                                                                                                                                                                               |
| JSON-LD `<script type="application/ld+json">` (`src/components/json-ld.tsx`)                                                    | home and PDP                                              | organisation / product and breadcrumb data for crawlers | **not executed**: a data block, not script. `script-src` does not apply to it. Its content is escaped by `serializeJsonLd`                                                                                                                                                          |
| Analytics (`src/lib/analytics/track.ts`, #609)                                                                                  | rails on PDP and cart                                     | `recommendation_viewed` / `recommendation_clicked`      | no script of its own: code inside a nonced chunk; pushes to `window.dataLayer` and a DOM event, no network request                                                                                                                                                                  |

**There is none of:**

- `next/script` (`<Script>`);
- third-party analytics, tag manager, CDP, chat or consent-banner snippets. The launch wave's analytics sink (LAUNCH 8.3) and any consent banner (8.2) must be added to this table, loaded from a nonced chunk or with the nonce (`headers().get('x-nonce')`);
- inline event handlers (`onclick="…"`), which a nonce cannot authorise;
- `eval` / `new Function` in client code. `'unsafe-eval'` is development-only for React Refresh. The storefront ships no zod to the client, so window 4's zod JIT probe does not apply.

**A brand** that adds a script (a font loader, a widget, a pixel) adds a row here, and loads it from
a chunk or with the nonce. `'unsafe-inline'` is not an option.

## Frames

What the storefront may frame (`frame-src`, #782), and the residual risk.

| Route                                                                                                           | `frame-src`                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Embed routes**: home, `campaign/*`, `pages/*`, `legal/*` (the only pages that render CMS blocks, so an embed) | `'self'`, Stripe (`js.stripe.com`, `hooks.stripe.com`), and the campaign embed hosts |
| **Every other page**: PLP, PDP, categories, cart, checkout and payment, orders, account, the 404                | `'self'` and Stripe only                                                             |

**The embed hosts** come from window 6's `EMBED_HOSTS` (`@platform/cms`), passed as `CSP_FRAME_HOSTS` and vetted by `parseFrameHosts`:

- bare `https` origins;
- plus `https://*.<domain>` **only** for the site builders in `WILDCARD_EMBED_DOMAINS` (`framer.app`, `framer.website`, `builder.io`).

Any other wildcard, a path, a query, `http`, credentials or anything unparseable is refused, logged once at start (`[csp] CSP_FRAME_HOSTS entry refused (…)`) and never sent to the browser. Adding a wildcard domain is a code change with review in `src/lib/csp.ts`, never an environment setting.

**Residual, stated plainly:**

- **Any site published on those builders can be framed on an embed route.** The wildcard admits every customer's `<site>.framer.app`, not only ours.
- **The editor-side control is window 6's Studio**, which validates an embed URL against `EMBED_HOSTS` before it can be published.
- **A framed document cannot run script in our origin.** It is a cross-origin frame, sandboxed by the embed component, and our script policy is the nonce policy. So the risk is content shown inside a frame, not code running as the storefront.
- **A policy binds to the document it arrived with.** A client-side navigation from an embed route into a strict page keeps the embed route's `frame-src`. No strict page renders an embed, and the nonce script policy is the same on every page, so an injected frame would first need injected script.
