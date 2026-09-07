# Cache wiring for CI. Used together with docker-compose.build.yml, never instead of it:
#
#   docker buildx bake -f infra/docker/docker-compose.build.yml -f infra/docker/docker-bake.hcl
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
# One scope per image, deliberately. The `manifests` and `deps` stages are identical across the six
# Dockerfiles, so a single shared scope would store them once — but the six builds run concurrently
# and the GitHub cache is last-write-wins per scope, so they would clobber each other's exports and
# the cache would be unreliable in exactly the case it matters. Separate scopes cost duplicated
# storage (the repo-wide budget is 10 GB; evicted entries only cost a slow build) and buy a cache
# that actually hits.

variable "CACHE_SCOPE" {
  default = "images"
}

# mode=max exports every stage, not just the final one. That is the point here: the expensive layers
# are `deps` (the pnpm install) and `build`, neither of which appears in the runtime image.
function "gha" {
  params = [name]
  result = {
    cache-from = ["type=gha,scope=${CACHE_SCOPE}-${name}"]
    cache-to   = ["type=gha,scope=${CACHE_SCOPE}-${name},mode=max"]
  }
}

target "core" {
  cache-from = gha("core").cache-from
  cache-to   = gha("core").cache-to
}

target "admin" {
  cache-from = gha("admin").cache-from
  cache-to   = gha("admin").cache-to
}

target "storefront-starter" {
  cache-from = gha("storefront-starter").cache-from
  cache-to   = gha("storefront-starter").cache-to
}

target "accounting" {
  cache-from = gha("accounting").cache-from
  cache-to   = gha("accounting").cache-to
}

target "analytics-ingest" {
  cache-from = gha("analytics-ingest").cache-from
  cache-to   = gha("analytics-ingest").cache-to
}

target "notifications" {
  cache-from = gha("notifications").cache-from
  cache-to   = gha("notifications").cache-to
}
