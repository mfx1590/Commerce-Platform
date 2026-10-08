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

## Media

Images are not URLs in this content. Each one names a **slot** in `media/manifest.json`. The manifest lists the 19 premium stills and the 2 hero loops: their source path in the owner's media folder, which is outside the repo, plus bytes, sha256, aspect, Cloudinary public id and alt text per locale. `scripts/resolve-media.mjs` turns slots into Cloudinary delivery URLs **at seed time**.

```jsonc
{ "_type": "image", "mediaSlot": "home-hero-01" }                          // optional
{ "_type": "image", "mediaSlot": "og-default", "mediaRequired": true }     // required
```

- **Cloud name:** `CLOUDINARY_CLOUD_NAME_BRAND_A`, else `CLOUDINARY_CLOUD_NAME`. The seed reads only that, never the API key or secret.
- **No cloud name** (today: the owner has not created the Cloudinary account): optional images are left out, and an `imageBlock` goes with its image, with **one** warning line giving the count. A `mediaRequired` image is an error.
- **Always errors:** a slot not in the manifest, a video placed as an image, a placed slot without alt text for the document's locale, and proportions that do not fit the placement (hero 3:2, image block 3:2 or 3:4, Open Graph 16:9).
- **Uploading** is the owner's: `node cms/brand-a/scripts/upload-media.mjs --from <media dir> [--yes]`. It checks every file's sha256 against the manifest before sending anything, uses `overwrite=false`, and without credentials or `--yes` it only prints the plan. Note that most 4K stills are over Cloudinary's 10 MB free-plan image limit; the script warns.
- **Not here:** the product matrix and detail shots (the catalogue seed in `packages/db`, the manager's), and the vertical social stills and videos (marketing, not the site). How imagery looks and where it goes is in `apps/storefronts/brand-a/src/brand/DESIGN.md` §7.
- **The hero loops are placed** (#386), each over the still the manifest names as its `poster`: `home-hero-shirt-loop-8s` over `home-hero-02`, `campaign-autumn-hero-loop-8s` over `campaign-autumn-hero`. `resolve-media.mjs` **refuses a loop paired with any other still**, with or without a cloud name, so the two sides cannot be edited apart. A loop carries **no alt text** — it is `aria-hidden` and the poster's alt speaks for the hero. Rendering is window 3's (#330); until it lands a placed loop is not rendered and the poster is the hero.

## Tests

`apps/storefronts/brand-a/test/cms-brand-content.test.ts` reads these files, resolves their media slots with a placeholder cloud name (what the seed sends), validates each one, and
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

`test/brand-media.test.ts` holds the media rules: the manifest's scope and integrity, every referenced slot present with alt text in both locales, the content passing validation both resolved and with images left out, and each refusal above.

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

### What `lastReviewed` means — and does not

Each legal document carries a `lastReviewed` date because window 6's schema requires one, and the
storefront renders it as _"Last reviewed {date}"_. **That wording is the CMS package's, not ours, and
it does not mean a lawyer has seen the document.**

The date records **when the text was last edited in this repository**. Nothing more. It is not a
legal review, it must not be cited as one, and it will keep moving as the copy is edited while the
documents remain unreviewed. When a real review happens, say so here explicitly rather than letting
this field imply it.

The statutory content — the fourteen-day withdrawal period, the GDPR legal bases — is stated as the
law requires and is not ours to vary. Brand A's own thirty-day free EU returns are presented as an
_additional_ contractual promise, never as a replacement for the statutory right.
