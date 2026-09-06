#!/usr/bin/env bash
# Self-test for check-ownership.sh (runs in CI before the real check). No git needed.
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-ownership.sh"
pass=0; fail=0

expect() { # expect <ok|violation> <branch> <files...>
  local want="$1" br="$2"; shift 2
  local files; files="$(printf '%s\n' "$@")"
  if OWNERSHIP_BRANCH="$br" OWNERSHIP_FILES="$files" bash "$S" >/dev/null 2>&1; then got=ok; else got=violation; fi
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: branch=$br files=[$*] want=$want got=$got"; fi
}

expect ok        core/phase1       apps/core/src/modules/catalog/index.ts packages/db/migrations/0002_x.sql docs/memory/Memory-1-core.md
expect violation core/phase1       packages/contracts/openapi/store-api.yaml
expect violation core/phase1       docs/memory/Memory-2-auth.md
expect violation core/phase1       docs/memory/Memory-main.md
expect ok        auth/phase1       packages/auth-sdk/src/index.ts infra/openfga/model.fga apps/core/src/modules/hq-rbac/index.ts
expect violation auth/phase1       apps/core/src/modules/catalog/index.ts
expect ok        storefront/phase1 apps/storefront-starter/src/app/page.tsx packages/ui/src/index.ts
expect violation storefront/phase1 apps/admin/src/app/page.tsx
expect ok        admin/phase1      apps/admin/src/app/\(hq\)/page.tsx
expect violation admin/phase1      packages/ui/src/index.ts
expect ok        infra/phase2      .github/workflows/ci.yml apps/core/Dockerfile infra/terraform/main.tf
expect ok        infra/phase2      .dockerignore
expect violation infra/phase2      apps/core/src/index.ts
expect ok        cms/phase2        "cms/brand-a/schema.ts" "apps/storefront-starter/src/app/(content)/page.tsx" "apps/storefront-starter/src/lib/cms/client.ts"
expect violation cms/phase2        "apps/storefront-starter/src/app/(shop)/page.tsx"
expect ok        search/phase2     apps/core/src/jobs/index-products.ts apps/core/src/modules/search/index.ts
expect violation search/phase2     apps/core/src/jobs/other.ts
expect ok        brands/phase2     apps/storefronts/brand-a/src/app/page.tsx cms/brand-a/x.ts
expect violation brands/phase2     apps/storefront-starter/src/app/page.tsx
expect ok        data/phase3       data/dbt/models/x.sql "apps/admin/src/app/(hq)/bi/page.tsx"
expect violation data/phase3       "apps/admin/src/app/(hq)/finance/page.tsx"
expect ok        events/phase4     apps/core/src/outbox/relay.ts packages/events/schemas/order.placed/v2.json
expect violation events/phase4     packages/db/migrations/0001.sql
expect ok        main/anything     packages/contracts/openapi/store-api.yaml
expect ok        integration/phase1 packages/db/migrations/0009.sql
expect violation unknown/phase1    README.md
expect ok        core/phase1       .claude/CLAUDE.local.md
expect ok        storefront/phase1 pnpm-lock.yaml apps/storefront-starter/package.json
expect violation storefront/phase1 package.json

echo "check-ownership self-test: $pass passed, $fail failed"
[ $fail -eq 0 ]
