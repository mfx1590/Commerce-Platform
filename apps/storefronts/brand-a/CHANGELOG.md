# Changelog — @platform/storefront-brand-a

## 0.1.0 — 2026-09-09 · task 2.1 (#139)

- Generated from `apps/storefront-starter` 0.8.1 (ADR 0004) via the new
  `scripts/sync-from-starter.mjs`: 110 tracked starter files copied; `Dockerfile` (window 5's
  path — REQUEST filed for the image), `README.md`, `CHANGELOG.md` and `CLAUDE.md` excluded.
- Brand A identity: package name, port **3101** (`dev` script, `start.mjs` default — `start`
  still honours `$PORT` for the image contract), `SITE_URL` and `STORE_PUBLISHABLE_KEY`
  (`pk_brand-a_dev_00000000000000000000`, the packages/db seed key) as runtime defaults in
  `next.config.mjs`, Playwright/Lighthouse URLs on :3101. `KEYCLOAK_CLIENT_ID` keeps the
  starter's `storefront-brand-a` default. `/health` inherited.
- The complete diff-against-starter list lives in the README and is enforced by the sync
  script's preserve/exclude sets.
