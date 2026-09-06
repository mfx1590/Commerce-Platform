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

### Fixed

- **The app images build and carry their build output again (issue #59).** Three separate defects, all found
  by building and running the images rather than by reading them:
  1. `pnpm --filter <app> build` does not build the app's workspace dependencies, so `apps/core` compiled
     against `@platform/db` with no `dist/`. Every Dockerfile now runs `pnpm --filter <app>... build`.
  2. `medusa build` cannot load `medusa-config.ts` without `ts-node`, which `apps/core` does not declare —
     `pnpm --filter @platform/core build` fails the same way on a laptop and in CI, not just in Docker. The
     build stage installs it globally until [REQUEST #60](https://github.com/mfx1590/Commerce-Platform/issues/60)
     lands; it never reaches the runtime image. The stage also sets placeholder values for the variables
     `medusa-config.ts` requires, because an image build has no `.env` and the config throws without them.
  3. `pnpm deploy` packs the package the way npm does and skips dot-directories, so `.medusa/server` and
     `.next` — the entire output of `medusa build` and `next build` — were dropped from all three real app
     images. Each Dockerfile now copies its build output across explicitly and asserts it is there.
- `continue-on-error` removed from the CI `images` job: it is a required check again.

### Changed

- `infra/docker/smoke-images.sh` now decides per image what to check, from the deployed `package.json`:
  a scaffold must reach `healthy` and answer `/health`; a real app must run as non-root and carry its build
  output. Real apps are deliberately not booted — `apps/core` and `apps/admin` both refuse to start without a
  database or secrets, which is correct behaviour, and proving a configured app serves traffic belongs to the
  staging deploy. The new check is what caught defect 3 above in `admin` and `storefront-starter`.
- The admin and storefront images use `PORT` 3000 and 3100 to match the `--port` their `start` scripts
  hard-code, so the `HEALTHCHECK` probes the port the app actually listens on
  ([REQUEST #68](https://github.com/mfx1590/Commerce-Platform/issues/68) asks for `$PORT` to be honoured).
- `infra/README.md` "Image contract" now lists what an app must provide for its image to build, with the
  reason behind each entry.

### Notes

- `scripts/check-ownership.sh` is unchanged and remains the first CI job (owned by the main window).
