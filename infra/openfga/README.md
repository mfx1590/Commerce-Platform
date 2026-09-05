# infra/openfga — authorization model and seed tuples (window 2, auth)

| File               | Purpose                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `model.fga`        | The authorization model (OpenFGA DSL, schema 1.1). Relation names are frozen by ADR 0002. |
| `tuples.seed.json` | Relationship tuples for the seeded organization, stores and 7 staff users (`SEED_IDS`).   |

Local server: `http://localhost:8081` (HTTP API, `OPENFGA_API_URL`), playground `http://localhost:3001`,
in-memory datastore (everything is gone on container restart, re-run the seed).

## Object and user ids

| Type           | Id                     | Example                                        |
| -------------- | ---------------------- | ---------------------------------------------- |
| `user`         | `staff_user.id` (uuid) | `user:00000000-0000-4000-8000-000000000044`    |
| `organization` | organization slug      | `organization:hq` (the only row in Phases 0–3) |
| `store`        | `store.id` (uuid)      | `store:00000000-0000-4000-8000-000000000031`   |

Why the `staff_user.id` and not the Keycloak `sub`: the id survives an identity-provider change (SSO migration
rotates `sub`), and it is the key of the `role_assignment` mirror table. The scope middleware resolves
`sub → staff_user.id` once per request (task 1.4).

`x-permission` in `packages/contracts/openapi/admin-api.yaml` uses `organization:hq`, `store:{storeId}` and
`store:*` (= any store the caller can view; resolved with ListObjects).

## Model summary (ADR 0002)

```
organization: owner | finance | operations | analyst | support   (each [user] or owner)   → viewer = any of them
store:        organization [organization]
              store_admin  [user] or owner from organization
              store_staff  [user] or store_admin
              support      [user] or support from organization or store_admin
              analyst      analyst from organization
              viewer       store_staff or support or analyst or operations from organization or finance from organization
```

Finance is organization-only by construction: no store relation implies `finance` on `organization:hq`,
however many stores a person administers. That is the Phase 1 gate (task 1.7).

## Seed

```bash
pnpm --filter @platform/auth-sdk fga:seed
```

Creates (or reuses, by name `commerce-platform`) the store on `OPENFGA_API_URL`, writes the model from
`model.fga`, writes every tuple in `tuples.seed.json` that is not already present, and writes
`OPENFGA_STORE_ID=<id>` (and `OPENFGA_MODEL_ID=<id>`) into the repo-root `.env` (created from `.env.example`
when missing). Idempotent: run it after every OpenFGA restart.

Seeded relations (same as `role_assignment` from `pnpm db:seed`):

| user (username) | relation      | object                               |
| --------------- | ------------- | ------------------------------------ |
| owner           | `owner`       | `organization:hq`                    |
| finance         | `finance`     | `organization:hq`                    |
| operations      | `operations`  | `organization:hq`                    |
| support         | `support`     | `organization:hq`                    |
| analyst         | `analyst`     | `organization:hq`                    |
| store-admin     | `store_admin` | `store:<brand-a>`, `store:<brand-b>` |
| store-staff     | `store_staff` | `store:<brand-a>`                    |

plus `organization:hq organization store:<brand-a|b|c>`.

## Tests

`pnpm --filter @platform/auth-sdk test` → `test/openfga-model.test.ts`: static checks (every relation in the
model and the tuples exists in `RELATIONS` from `@platform/contracts` or is `viewer`/`organization`; tuples
match `SEED_IDS`) and, when the docker OpenFGA answers, a throw-away store is created with the model + tuples
and the ADR expectations are checked (store-admin → `store_admin` on brand-a and brand-b only, never `finance`
on `organization:hq`; owner → `viewer` on every store; …). The throw-away store is deleted afterwards.

## Changing the model

A new relation or type = `CONTRACT CHANGE:` issue first (the `RELATIONS` enum in packages/contracts and the
`role_assignment.relation` CHECK constraint must change in the same step). Then edit `model.fga`, run the
tests, run `fga:seed` (writes a new model version; the store id stays).
