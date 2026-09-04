# @platform/contracts

OpenAPI contracts for the Store API and Admin API, generated types, and Prism mocks. Owner: main window.
See [CLAUDE.md](./CLAUDE.md) for the public API and frozen conventions.

## Start the mocks

```bash
pnpm mock
```

| Mock      | URL                   | Auth header                  |
| --------- | --------------------- | ---------------------------- |
| Store API | http://localhost:4010 | `X-Publishable-Key: pk_test` |
| Admin API | http://localhost:4011 | `Authorization: Bearer test` |

The mock returns the documented examples (brand-a store, product `classic-tee`, order `#1000`, customer Jane), and
answers 400 on request bodies that violate the schema.

## Use the types

```ts
import type { StoreComponents, AdminOperations } from '@platform/contracts';
type Cart = StoreComponents['schemas']['Cart'];
type ListOrdersQuery = AdminOperations['listOrders']['parameters']['query'];
```

## Change the contract

Feature windows never edit `openapi/*.yaml`. File `CONTRACT CHANGE: <what>` with the exact diff and keep building
against a local override of the mock (Prism accepts a second spec file if you need a stub). The Integrator applies
changes at the phase boundary, bumps `info.version` and `CONTRACTS_VERSION`, regenerates, and tags `contracts-vX.Y`.
