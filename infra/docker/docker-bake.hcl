# Cache wiring for CI. Used together with docker-compose.build.yml, never instead of it:
#
#   cd infra/docker && docker buildx bake --allow fs=* -f docker-compose.build.yml -f docker-bake.hcl
#
# bake resolves a target's `context` relative to the working directory, not to the file that declares
# it, so every target here takes its context from BAKE_CONTEXT: the default `../..` is the repo root
# when bake runs from THIS directory (the command above). From the repo root, set BAKE_CONTEXT=. — CI
# does, because docker/bake-action 7 has no `workdir` (#767):
#
#   BAKE_CONTEXT=. docker buildx bake -f infra/docker/docker-compose.build.yml -f infra/docker/docker-bake.hcl
#
# (`docker compose build` resolves the context relative to the compose file, which is why the local
# command needs no such care.) `--allow fs=*` is needed when the context escapes the working directory.
#
# The compose file stays the single source of truth for WHICH images exist and how they are built —
# contexts, Dockerfiles, build args, tags. Bake merges same-named targets across files, so this file
# only adds `cache-from` / `cache-to`. `docker compose build` locally is unaffected and needs no
# flags: the GitHub Actions cache backend is unreachable outside a workflow run anyway.
#
# Why bake at all: `type=gha` needs ACTIONS_RUNTIME_TOKEN and ACTIONS_CACHE_URL, which GitHub only
# exposes to actions and not to a plain `run:` step. Reaching them from `docker compose build` needs
# a third-party action to export them into the environment; docker/bake-action is Docker's own and
# does it directly. That is the whole reason CI does not simply call `docker compose build`.
#
# Pull requests read the cache; only pushes to main write it (see CACHE_TO below).
#
# One scope per image, deliberately. The `manifests` and `deps` stages are identical across the six
# Dockerfiles, so a single shared scope would store them once — but the six builds run concurrently
# and the GitHub cache is last-write-wins per scope, so they would clobber each other's exports and
# the cache would be unreliable in exactly the case it matters. Separate scopes cost duplicated
# storage (the repo-wide budget is 10 GB; evicted entries only cost a slow build) and buy a cache
# that actually hits.

# The workspace root, relative to where bake runs (see the header). Overrides the compose file's
# `context: ../..` for every target below: bake merges same-named targets, and this file comes last.
variable "BAKE_CONTEXT" {
  default = "../.."
}

variable "CACHE_SCOPE" {
  default = "images"
}

# Empty on pull requests, set on pushes to main. Exporting the cache cost 60-145s of "preparing
# build cache for export" plus 14-37s of "sending" PER IMAGE — measured on PR #81, where it was the
# largest single component of a 14-minute run. Pull requests therefore only READ the cache; main
# writes it. A PR that changes a dependency pays a slow install once and does not make every other
# PR pay for exporting it.
variable "CACHE_TO" {
  default = ""
}

# mode=max exports every stage, not just the final one. That is the point: the expensive layer is
# `deps` (the pnpm install), which does not appear in the runtime image at all.
function "cache_from" {
  params = [name]
  result = ["type=gha,scope=${CACHE_SCOPE}-${name}"]
}

function "cache_to" {
  params = [name]
  result = equal(CACHE_TO, "") ? [] : ["type=gha,scope=${CACHE_SCOPE}-${name},mode=max"]
}

target "core" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("core")
  cache-to   = cache_to("core")
}

target "admin" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("admin")
  cache-to   = cache_to("admin")
}

target "storefront-starter" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("storefront-starter")
  cache-to   = cache_to("storefront-starter")
}

target "accounting" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("accounting")
  cache-to   = cache_to("accounting")
}

target "analytics-ingest" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("analytics-ingest")
  cache-to   = cache_to("analytics-ingest")
}

target "notifications" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("notifications")
  cache-to   = cache_to("notifications")
}

target "engagement" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("engagement")
  cache-to   = cache_to("engagement")
}

target "feeds" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("feeds")
  cache-to   = cache_to("feeds")
}

target "storefront-brand-a" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("storefront-brand-a")
  cache-to   = cache_to("storefront-brand-a")
}

target "storefront-brand-b" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("storefront-brand-b")
  cache-to   = cache_to("storefront-brand-b")
}

target "storefront-brand-c" {
  context    = BAKE_CONTEXT
  cache-from = cache_from("storefront-brand-c")
  cache-to   = cache_to("storefront-brand-c")
}
