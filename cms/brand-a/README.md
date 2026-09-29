# Brand A content (`brand-a` dataset)

The published content for brand A's storefront — window 10's path (`cms/<brand>/**` in
`docs/ownership.md`). The schemas, the Studio and the fetch layer are window 6's
(`@platform/cms`); this folder is only the documents.

## Layout

| File                      | Documents                                                                |
| ------------------------- | ------------------------------------------------------------------------ |
| `content/home.json`       | the `page` with slug `home`, which feeds the storefront's `CmsHome` slot |
| `content/pages.json`      | `about`, `cloth`                                                         |
| `content/legal.json`      | `imprint`, `privacy`, `terms`, `returns`                                 |
| `content/navigation.json` | the `main` navigation                                                    |
| `content/footer.json`     | the footer                                                               |
| `content/campaign.json`   | the `autumn-cloth` campaign landing                                      |

Every document exists in both locales brand A sells in — **`en-GB` and `de-DE`** — and ids follow
`@platform/cms`'s deterministic scheme (`<type>.<locale>.<slug>`), so re-seeding updates in place
instead of duplicating.

Why JSON rather than TypeScript: the seed runner is plain `.mjs`, the storefront's test suite reads
the same files, and it is the shape Sanity itself imports and exports. Correctness comes from
window 6's own `validateDocument` running against these files in both the seed script and the tests,
which is a stronger check than a structural type.

## Seeding

```bash
node cms/brand-a/scripts/seed-content.mjs --dry-run   # validate + print, no credentials needed
node cms/brand-a/scripts/seed-content.mjs             # needs SANITY_PROJECT_ID + SANITY_WRITE_TOKEN
```

Documents are validated **before** anything is sent: a schema violation that reaches the dataset is
visible to editors in the Studio and has to be undone by hand there. Without credentials the script
prints the payload and exits 0, so the content can always be inspected.

This is deliberately not `@platform/cms`'s own `seed` script, which pushes window 6's generic
fixtures. It reuses that package's _pure_ exported helpers (`readSeedEnv`, `missingCredentials`,
`mutateUrl`) rather than reimplementing credential handling.

## Tests

`apps/storefronts/brand-a/test/cms-brand-content.test.ts` reads these files, validates each one, and
renders them through the real route components — no Sanity credentials required, because `CmsReader`
is an interface. Exactly what it renders:

| Route                              | Documents rendered                                                      |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `HomeContent` (the `CmsHome` slot) | `page.{en-GB,de-DE}.home`                                               |
| `pages/[slug]`                     | `about` and `cloth`, both locales                                       |
| `legal/[slug]`                     | all four kinds, both locales                                            |
| `campaign/[slug]`                  | `autumn-cloth`, both locales, with the clock pinned inside its schedule |

It also asserts locale parity, deterministic ids, that no German document is a copy of its English
twin, that every **navigation and footer** link resolves to an authored document or a real app route
(hero and block CTAs are not yet covered — parked), and that no route falls back to its empty state.
An expired campaign is asserted to 404 rather than render.

## ⚠️ The legal documents are not lawyer-reviewed

**`content/legal.json` must be reviewed by a qualified lawyer before this store goes live**, and the
German documents specifically by someone who works in German consumer law. They are written to the
right structure and say what such documents normally say, but that is not the same as being correct
for this company.

Every value only a lawyer or the company can supply is left as a marked placeholder:

```
[[COMPANY_LEGAL_NAME]]  [[REGISTER_COURT]]  [[REGISTER_NUMBER]]  [[VAT_ID]]
[[RESPONSIBLE_PERSON]]  [[SUPERVISORY_AUTHORITY]]  [[ORDER_RETENTION_PERIOD]]  …
```

Nothing here invents a registration number, a VAT identifier, a company name, an address, a phone
number or an email. The tests scan for _anything_ bracket-shaped and require it to be a well-formed
`[[UPPER_SNAKE]]` placeholder — so a degraded `[[Register Court]]` or a `{{VAT_ID}}` fails — pin the
full list of required placeholders per document kind, and reject anything resembling a register
number, a VAT id, an email, a phone number, a street address or a postcode.

The guard is mutation-tested: replacing `[[STREET_ADDRESS]]` with a plausible street, degrading a
placeholder, switching to `{{mustache}}` form, or writing `HRB-12345` each turn the suite red. An
earlier version of this test matched well-formed placeholders and then asserted they were
well-formed — a tautology that could never fail. That is why the mutation check exists.

The statutory content — the fourteen-day withdrawal period, the GDPR legal bases — is stated as the
law requires and is not ours to vary. Brand A's own thirty-day free EU returns are presented as an
_additional_ contractual promise, never as a replacement for the statutory right.
