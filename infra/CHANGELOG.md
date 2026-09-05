# infra — changelog

Window 5 (Infra & DevOps). Owned paths: `infra/**`, `.github/workflows/**`, `**/Dockerfile`.

## Unreleased — Phase 2

### Added

- **App images (issue #31, task 2.1).** `apps/<app>/Dockerfile` for all six app scaffolds (`core`, `admin`,
  `storefront-starter`, `accounting`, `analytics-ingest`, `notifications`): multi-stage build over the pnpm
  workspace, `pnpm --filter <app> --prod --legacy deploy` to a pruned package, `node` user (uid 1000),
  `EXPOSE $PORT` and a `HEALTHCHECK` on `/health`. A scaffold image is ~221 MB (`docker images`): node:20-alpine
  plus a 24 MB global pnpm; the app's own layers are ~100 KB, so the size is all base image until the real apps land.
- `infra/docker/entrypoint.sh` — runs `pnpm start` when the app defines one, otherwise the scaffold health
  server. This is what lets the images build and pass their health check today and keep working unchanged when
  windows 1/3/4 replace the scaffolds with Medusa / Next.js.
- `infra/docker/health-server.mjs` — the scaffold `/health` responder.
- `infra/docker/docker-compose.build.yml` — builds all six images from the repo root; `IMAGE_TAG` selects the tag.
- `infra/docker/smoke-images.sh` — asserts every image starts, runs non-root, and reaches `healthy`.
- CI job `images` in `.github/workflows/ci.yml` — builds all six and runs the smoke test on PRs that touch
  `apps/**`, `packages/**`, `infra/docker/**` or the workspace root files. Never pushes.

### Notes

- `scripts/check-ownership.sh` is unchanged and remains the first CI job (owned by the main window).
