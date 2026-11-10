# PCI DSS scope note: SAQ-A

Status on 2026-11-10: **a scoping argument, not an attestation.** The self-assessment questionnaire and the
attestation of compliance are the merchant's (the owner's) to complete with the acquirer or Stripe at launch
(plan D1; see "Owner-only" at the end). The requirement lists below follow SAQ A for PCI DSS v4.0.1; check them
against the current SAQ A document when it is filled in, because the PCI SSC revises it.

## 1. Why the platform is SAQ-A eligible

SAQ A is for card-not-present merchants that have outsourced all account-data functions to a PCI DSS compliant
third party, and whose own systems do not store, process or transmit account data. For e-commerce, every element
of the payment page that takes card data must come directly from the payment service provider.

What the code does:

| Step | What happens | Where |
|---|---|---|
| 1 | The core creates a manual-capture PaymentIntent at Stripe with the cart's amount, currency and ids, and stores Stripe's payment id. | `apps/core/src/modules/payments/provider.ts`, `apps/core/src/modules/payments/stripe-client.ts`, seam `apps/core/src/lib/payment-seam.ts` |
| 2 | The Store API returns the intent's client secret to the storefront's server action, which hands it to the browser. | `apps/storefront-starter/src/lib/actions.ts` ("PaymentIntent's `client_secret` for Stripe's hosted fields") |
| 3 | The browser loads Stripe.js from `js.stripe.com` and mounts the Payment Element. The card number, expiry and CVC are typed into Stripe's iframes. 3-D Secure runs in Stripe's modal. | `apps/storefront-starter/src/components/card-payment.tsx`, loaded lazily by `apps/storefront-starter/src/components/card-payment-lazy.tsx` |
| 4 | The browser confirms the intent with Stripe directly (`api.stripe.com`). Only an authorised intent goes on to `placeOrderAction`. | same component |
| 5 | The core completes the cart: it asks Stripe for the intent's status and records `authorized`. Capture and refunds are server-to-Stripe calls by id. | `apps/core/src/modules/checkout/README.md`, `apps/core/src/modules/payments/capture.ts`, `apps/core/src/modules/payments/refunds.ts` |
| 6 | Stripe notifies `POST /webhooks/stripe/:storeCode`; the signature is verified over the raw body. | `apps/core/src/modules/payments/webhook-receiver.ts`, `apps/core/src/modules/payments/webhook-signature.ts` |

**What our servers receive:** amounts, currencies, our own ids, Stripe's ids (payment intent, charge, balance
transaction), intent status, Stripe Radar's risk level and outcome type (codes), webhook events. **What they never
receive:** the card number, expiry, CVC, or any other account data. There is no database column for them and no
Store API field that carries them (`packages/contracts/openapi/store-api.yaml`).

**Which pages load the PSP script.** Stripe.js is imported only by `card-payment.tsx`, which is mounted on the
checkout review step when the store takes cards. The CSP that allows `https://js.stripe.com` is the same on
every storefront page, because the policy is built once per request for all routes
(`apps/storefront-starter/src/middleware.ts`). The admin loads no Stripe script: its `script-src` is nonce-only
and `connect-src` is `'self'` (`apps/admin/src/lib/security/csp.ts`, #763). Staff issue refunds and captures by
id through the Admin API.

**Where the code enforces it:**

| Enforcement | Evidence |
|---|---|
| Only Stripe's documented hosts are allowed for script, frames and connections; no wildcard | `STRIPE_SCRIPT_HOSTS`, `STRIPE_FRAME_HOSTS`, `STRIPE_CONNECT_HOSTS` in `apps/storefront-starter/src/lib/csp.ts`; pinned by `apps/storefront-starter/test/csp.test.ts` (job `unit tests (with Postgres, RLS)`) |
| The same in each brand | `apps/storefronts/brand-a/src/lib/csp.ts`, `apps/storefronts/brand-b/src/lib/csp.ts`, `apps/storefronts/brand-c/src/lib/csp.ts` and each brand's `test/csp.test.ts` |
| Only a publishable key can reach the browser; a secret key in the wrong variable is refused | `apps/storefront-starter/src/lib/payment-options.ts` |
| The server-side Stripe client sends ids and amounts only, logs nothing, and errors never carry a raw body or a credential | header of `apps/core/src/modules/payments/stripe-client.ts` |
| Providers exchange ids and money, never card data | types in `apps/core/src/lib/payment-seam.ts` |
| Webhooks are authenticated and replay-limited | `apps/core/src/modules/payments/webhooks.test.ts` |
| Nothing may frame the checkout | `frame-ancestors 'none'` in `csp.ts`; `X-Frame-Options: DENY` in `apps/storefront-starter/next.config.mjs` |
| Rule of record | CLAUDE.md "Card data never touches our servers (hosted fields only)"; ADR 0004 |

## 2. Honest state of card payment

- The storefront card step and the core's Stripe provider are **written and merged**, but they have **never run
  against real Stripe test keys**. #358 is open as the gate record ("the code is complete and merged; this issue
  stays open … closes when the gate is recorded here", manager note 2026-10-08) and #361 (the owner's accounts and
  keys) is open.
- `apps/storefront-starter/e2e/card-payment.spec.ts` (and the brand A copy) is the end-to-end proof: an authorised
  card, a 3-D Secure card, a declined card. It **skips, loudly, without a Stripe test publishable key**, so no CI
  run has exercised the Payment Element.
- What CI does prove today: the CSP directives, the remount behaviour with Stripe mocked
  (`apps/storefront-starter/test/card-payment-remount.test.ts`), the core's provider against a fake Stripe
  (`apps/core/src/modules/payments/fake-stripe.ts`, `apps/core/src/modules/payments/payments.test.ts`) and the
  webhook receiver.
- `apps/core/src/modules/payments/stripe-live.test.ts` and `apps/core/src/modules/payments/capture-live.test.ts` exist for the keyed run.
- "Pay on invoice" (the `manual` provider) involves no card and is outside PCI scope.

So: the design is SAQ-A shaped and the code enforces the boundary, but the claim "a card order works and no card
data touched us" has no recorded run. That run is launch-checklist work (`apps/storefronts/brand-a/LAUNCH.md` §4).

## 3. What would break eligibility

Any of these moves the merchant out of SAQ A (to SAQ A-EP or SAQ D). Each is a review rule for windows 3, 7
and 10.

1. Any `<input>` of ours that takes a card number, expiry or CVC, including a "fallback" form or a support tool
   where staff type a card for a customer (that would also be MOTO, a different channel).
2. Calling Stripe's API from our server with raw card details, or with Stripe.js tokenisation of fields we host
   (Stripe's older "direct" integrations).
3. Logging, storing or forwarding a full request body from the payment step to analytics, the CDP, error
   tracking or the AI gateway. The AI redaction masks Luhn-valid numbers (`packages/ai/src/redact.ts`) but that is
   a second guard, not a licence.
4. Serving Stripe.js from our own origin or a bundler copy instead of `js.stripe.com`.
5. A script on the payment page that can read or overlay the iframe's surroundings and redirect the customer to
   a fake form. This is the script-integrity question in section 4.
6. Using a provider or a plugin that is not PCI DSS validated, or adding a second PSP without the same hosted
   pattern.
7. Card data arriving by another channel and being typed into our admin (phone orders, chat). Chatwoot and
   support-draft text may contain a card number a customer pasted: it must not be stored deliberately; the
   redaction and the "no free text in audit" rule limit it, they do not eliminate it.

There is **no automated guard** for items 1–4 (searched for a lint or test that forbids card-named inputs or a
bundled Stripe.js: none). gap: no issue.

## 4. Requirements that still apply, with evidence

### 4.1 Script integrity on the payment page (PCI DSS 4.0.1 requirements 6.4.3 and 11.6.1)

Requirement 6.4.3 asks that every script on a payment page is authorised, has its integrity assured and is
inventoried with a justification. Requirement 11.6.1 asks for a change- and tamper-detection mechanism for the
payment page's scripts and security-impacting headers. Both became mandatory on 2025-03-31.

How SAQ A treats them: the January 2025 revision of SAQ A for v4.0.1 **removed 6.4.3 and 11.6.1 from the
questionnaire** and added an **eligibility criterion** instead: the merchant confirms that its site is not
susceptible to attacks from scripts that could affect the merchant's e-commerce system. PCI SSC guidance says a
merchant with an embedded payment form (an iframe from the PSP) can meet the criterion either by applying
techniques such as those in 6.4.3 and 11.6.1 to its own page, or by obtaining confirmation from the PSP that the
embedded solution, implemented as the PSP instructs, protects the payment form from script attacks.

Where we stand:

| Item | State | Evidence |
|---|---|---|
| Authorised script sources | Partly. Script hosts are limited to our origin and `https://js.stripe.com`. | `apps/storefront-starter/src/lib/csp.ts` |
| Integrity of our own scripts | **Gap.** `script-src` includes `'unsafe-inline'`, so the CSP does not stop an injected inline script on the payment page. The admin already uses nonces; the storefront does not. | same file: "Not XSS protection … removing 'unsafe-inline' needs a nonce threaded through every `<Script>`". gap: no issue |
| Integrity of Stripe.js | Not applicable by hash: Stripe does not support Subresource Integrity for Stripe.js (it is versioned server-side). It must be loaded from `js.stripe.com`, which the code does (`loadStripe`). | `apps/storefront-starter/src/components/card-payment.tsx` |
| Script inventory with justification | **Gap.** No inventory file. Third-party script hosts today: Stripe only; campaign embeds are frames, not scripts. | searched `docs/` and `apps/storefront-starter` for an inventory: none. gap: no issue |
| Change / tamper detection (11.6.1) | **Gap.** Header tests pin the policy in CI, which detects a change in git, not a change in what a browser receives in production. | `apps/storefront-starter/test/csp.test.ts`. gap: no issue |
| PSP confirmation route | Not obtained. Stripe documents the Payment Element as SAQ-A eligible; the written confirmation belongs with the attestation. | owner-only |

Recommended path (smallest that makes the criterion honest): nonce-based `script-src` on the storefront as the
admin has (#763 is the pattern), a one-page script inventory in this folder, and Stripe's confirmation on file.

### 4.2 Other SAQ-A requirements

| Requirement (v4.0.1) | What it asks, for us | Evidence or gap |
|---|---|---|
| 2.2.2 | Vendor default accounts changed or disabled on the systems that serve the shop | Production Keycloak realms have no seeded users, no dev client and no committed secret: `packages/auth-sdk/test/production-realms.test.ts`. Database passwords generated by Terraform (`infra/README.md` "Secrets and state"). Dev defaults are allow-listed by name in `infra/gitleaks.toml` and must not exist outside dev. |
| 3.1.1, 3.2.1 | Policies for account data; none retained | No account data is received (section 1). No written retention policy document: gap, owner. |
| 6.3.1 | Vulnerabilities are identified and ranked | CI job `dependency audit (production)`, `infra/ci/audit-gate.mjs`, threshold `high` in `infra/security/audit-allowlist.json`; Dependabot `.github/dependabot.yml`. Advisory, not required. |
| 6.3.3 | Critical and high patches installed in time (one month for critical) | Allow-list entries carry an owner and `expires` (critical 2026-11-20, others 2026-12-06); an expired entry fails the gate. Base images: Dependabot Dockerfile group. |
| 8.2.x, 8.3.x | Unique ids, strong authentication, password rules for access to the web server and its management | Staff: Keycloak staff realm, OTP REQUIRED and a password policy in the derived production realm (`infra/keycloak/README.md` "Production profile"). GitHub and the future cloud account: the owner's own accounts and MFA, not provable here. |
| 9.4.x | Media with account data | Not applicable: no account data on any media. |
| 11.3.2 | Quarterly external vulnerability scans by an approved scanning vendor | **Gap, owner-only.** Needs a public site. Launch checklist. |
| 12.8.1 – 12.8.5 | A list of service providers with what they handle, written agreements, due diligence, yearly monitoring of their PCI status, and which requirements are theirs | **Gap.** No provider register. Stripe is the only provider that touches account data. Hosting (to be decided, D7) is in scope as the web server host. Launch checklist. |
| 12.10.1 | An incident response plan for a suspected compromise | **Gap.** `infra/README.md` has deploy and secret-rotation runbooks, `infra/dr/RUNBOOK.md` covers restore; nothing covers a suspected card-skimming or account-data incident (who calls Stripe and the acquirer, how the payment page is frozen). gap: no issue |
| TLS (4.2.1 is not in SAQ A, but the redirect to and the frame from the PSP need it) | HTTPS everywhere on the shop | HSTS on the admin (`apps/admin/src/lib/security/static-headers.mjs`); `upgrade-insecure-requests` in the storefront CSP; the Ingress template has no `tls` block (`infra/helm/platform-app/templates/ingress.yaml`), so TLS is unproven until a cluster exists. Launch checklist. |

## 5. Owner-only, for the launch checklist

- Complete SAQ A and the attestation of compliance with the acquirer / Stripe once the shop is public.
- Keep Stripe's attestation of compliance and its written statement on the Payment Element's script protection.
- Run the card journey on Stripe test keys in CI and on the laptop and record it on #358.
- Contract an approved scanning vendor for the quarterly external scans.
