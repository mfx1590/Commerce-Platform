# Admin design brief — the Medusa rail (owner idea, 2026-09-08)

Prototype (interactive): https://claude.ai/code/artifact/52e5ceaa-18fb-4519-88e7-e59a312e7696 · source copy: `docs/design/medusa-rail-prototype.html`
Artwork: `docs/design/medusa-hero.jpg` (brand mark, 16:9) · `docs/design/medusa-face.jpg` (rail crop). Motion study: the owner has the clip; the prototype's load sequence is the reference for code.
Owner: window 4 (admin) implements; main window owns this brief. Applies from admin task 2.2 onward; 2.1 screens are retrofitted in 2.6.

## The idea

The product is called Medusa, so the admin's navigation **is** Medusa. The left rail shows her head; her serpents are the sections. Each serpent's head carries one label at its tip. Hover lifts a serpent and lights its gold eye; the active section's serpent stays lifted. **A section the user is not allowed to see never grows a serpent** — the rail is the permission model made visible (the existing nav is already permission-driven from `GET /admin/me`; nothing changes server-side).

Scope switch (Store · HQ) at the top of the rail swaps the serpent set: Store = Catalog, Orders, Customers (support), Promotions, Marketing, Settings (store_admin); HQ = Stores, Users & roles (owner), Finance (finance), Warehouses (operations), Marketing (analyst).

## Tokens (dark, committed — no light theme for the admin)

| Token | Value | Use |
|---|---|---|
| ground | `#0B0F14` | page background, obsidian blue-black |
| surface | `#131A22` · surface-2 `#19222C` | panels, tiles |
| line | `#22303C` | borders, table rules |
| stone | `#8B95A3` | secondary text, labels at rest |
| ink | `#E6EBF0` | primary text |
| verdigris | `#5FD3B9` · deep `#2F8F7C` | serpent scales, active state, primary action |
| gold | `#D9B25F` | serpent eyes, highlights only — never text |
| critical / warn / ok | `#E0566B` · `#D9A04A` · `#5FD3B9` | status pills; semantic, separate from the accent |

Type: **Cinzel** (display: wordmark, page titles only), **IBM Plex Sans** (body), **IBM Plex Mono** (numbers, tabular). Money always integer minor units rendered in the store currency. Status is encoded as pills, not colour alone.

## Motion (the "cinematic" part — spec, not decoration)

1. **Load sequence** (once per session, ~2.5 s, skipped under `prefers-reduced-motion`): the head surfaces from black (opacity + 18 px rise + brightness), then each serpent **draws itself** out of the crown (`stroke-dasharray` reveal, 1.1 s, staggered 160 ms), its head and label arriving as it lands.
2. **At rest**: a slow breathing on the head (7 s), independent sway per serpent (two sine terms, ≤ 9 px), faint teal motes drifting up behind the head (Canvas, 70 particles).
3. **Hover / focus**: the serpent lifts toward the pointer (control point offset), thickens by 2 px, eye pulses (2.4 s), tongue flicks; label turns ink.
4. **Gaze**: the head and the serpents lean a few pixels toward the pointer's vertical position.
5. **Never**: no motion on content panels, no parallax on tables, nothing that moves while the user reads. Motion lives in the rail only.

## Accessibility and fallbacks (non-negotiable)

- Each serpent is a real button (`role="button"`, `tabindex`, `aria-pressed`, visible focus ring at the label). Keyboard users tab through serpents in reading order.
- **List view** toggle (persisted per browser) and automatic list view under `prefers-reduced-motion`: a plain vertical nav with the same items and `aria-current`.
- Contrast: labels at rest `stone` on `ground` ≥ 4.5:1; active `ink`. Gold is never used for text.
- The rail collapses to a 520 px band above the content under 860 px; the list view is the default on touch devices.

## Where it lives in code (window 4)

- `apps/admin/src/components/rail/` — `MedusaRail` (client component: SVG serpents, Canvas motes, load sequence), `RailList` (the plain fallback), `rail.config.ts` (section registry: id, label, permission, path; **plain module, not `'use client'`**).
- The head artwork ships as a static asset (`public/medusa-face.jpg`, ≤ 120 KB); serpents are procedural SVG so labels stay text.
- Sections come from the same permission source as today; the rail receives the already-filtered list. No new API.
- Tokens as CSS variables in the app's global stylesheet; existing primitives (data-table, form, state panels) restyled through the tokens, not rewritten.

## Acceptance (issue for window 4)

See the GitHub issue labelled `window:admin` `phase:2` "Medusa rail". The prototype is the reference for behaviour; pixel parity is not required, the sequence and the fallbacks are.
