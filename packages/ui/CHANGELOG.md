# Changelog — @platform/ui

## 0.4.0 — 2026-09-21

Task [storefront] 2.3 (issue #111).

- New subpath export **`@platform/ui/image-loader`** (`cloudinaryImageLoader`, `transformUrl`,
  `isCloudinaryUrl`), the same functions the root export has carried since 0.3.0. The kit declares no
  `sideEffects`, so importing through the barrel pulled 1.5 kB of first-load JS into every image
  route of the storefront; through the subpath it is 0.2 kB. Measured with the storefront's bundle
  budget. The root export is unchanged.

## 0.3.0 — 2026-09-09

REQUEST #169 (from window 9, search), folded into task [storefront] 2.1. Contracts `contracts-v0.3`.

- `cloudinaryImageLoader`, `transformUrl` and `isCloudinaryUrl` — a `next/image` loader for
  Cloudinary-delivered media, so storefronts derive every size they need from the one URL the core
  stores rather than the core minting a rendition per layout. Inserts
  `c_limit,w_<width>,q_<quality|auto>,f_auto` after `/upload/`, **chained before** any transformation
  already in the URL, so an art-directed crop stored with the asset still runs.
- Deliberately **generic**: no cloud name, account or environment is baked in — the cloud name comes
  from the delivery URL, so one function serves every brand. A `src` that is not a Cloudinary
  delivery URL is returned unchanged, which is what makes it safe as a global `images.loader`:
  `next.config` `remotePatterns` stays the thing that decides which hosts may be optimised.

## 0.2.1 — 2026-09-04

Follow-up while wiring the starter (task [storefront] 1.2, issue #18).

- `parseTheme` accepts the plural group spellings a store theme may use (`colors`, `fonts`,
  `radii`, `shadows`, …) as aliases for the canonical groups, with the canonical name winning if a
  theme sends both. The seeded Brand A theme wrote `colors`, so its brand colour reached the page as
  the kit default before this. CONTRACT CHANGE #41 was accepted on 2026-09-05: `Store.theme` is now
  documented as the `BrandTokens` shape and the examples and seed use the singular names; the
  aliases stay as tolerance through Phase 1 (manager ruling).
- `exports` gained a `default` condition, so CJS-based resolvers (Tailwind loads
  `tailwind.config.ts` through jiti) can resolve `@platform/ui/preset`.

## 0.2.0 — 2026-09-04

Task [storefront] 1.1 (issue #17), contracts `contracts-v0.1`.

- `defaultTokens`: colors, typography scale, spacing, radius, shadows — flattened to
  `--ui-<group>-<name>` CSS custom properties (`cssVarName`, `tokensToCssVars`, `mergeTokens`).
- `ThemeProvider`: applies a brand override at runtime; hook- and context-free, so it renders inside
  a React Server Component. `parseTheme` narrows the free-form `store.theme` from the Store API.
- Primitives: `Button`, `Input`, `Select`, `Card` family, `Dialog` (focus trap) + `DialogFooter`,
  `Badge`, `Price` (+ `formatMoney`, `minorUnitDigits`), `Skeleton`, plus `cn` and `variants`.
- `@platform/ui/preset`: Tailwind preset mapping utilities onto the token variables.
- 35 tests (Vitest + Testing Library, jsdom): `Price` formatting per locale/currency, `Dialog` focus
  trap and Escape handling, keyboard operability of every primitive, theme narrowing.
- Dependencies added: `clsx`, `tailwind-merge`; React 19 as a peer dependency.

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
