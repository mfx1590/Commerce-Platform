# @platform/admin

Next.js App Router admin application. One app, two views — **HQ** and **Store** — decided by the
relations the signed-in principal holds. Everything the UI shows is derived from `GET /admin/me`;
the Admin API re-checks each operation's `x-permission` server-side, so UI gating is convenience,
never security.

Contracts: `@platform/contracts/admin`, **Admin API 0.2.0**.

## Run it

```bash
pnpm mock                            # Prism Admin API mock on :4011 (repo root)
pnpm compose:up                      # Postgres, Redis, Keycloak (:8180), OpenFGA, Redpanda
pnpm --filter @platform/admin dev    # http://localhost:3000
```

**`.env.local` is required before the first run.** `ADMIN_SESSION_SECRET` has no default — a
constant committed to the repository would be a key everyone has — so copy
[`.env.example`](./.env.example) to `.env.local` and generate one:

```bash
openssl rand -base64 32
```

Everything else has a working default matching the repo-root `.env.example`; set those only to point
somewhere else.

| Variable               | Default                 | Meaning                                                                     |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `KEYCLOAK_URL`         | `http://localhost:8180` | Keycloak base URL                                                           |
| `KEYCLOAK_REALM_STAFF` | `staff`                 | Staff realm (customers live in another one)                                 |
| `ADMIN_OIDC_CLIENT_ID` | `admin-app`             | Public PKCE client                                                          |
| `ADMIN_APP_URL`        | `http://localhost:3000` | Origin used to build the redirect URI                                       |
| `MOCK_ADMIN_API_URL`   | `http://localhost:4011` | Admin API base URL                                                          |
| `ADMIN_SESSION_SECRET` | **none — required**     | Encrypts the session cookie. Startup fails without it, in every environment |

Port 3000 is fixed: the Keycloak client registers `http://localhost:3000/*` as its only redirect URI.

## Checks

```bash
pnpm --filter @platform/admin test       # Vitest
pnpm --filter @platform/admin typecheck  # tsc --noEmit
pnpm --filter @platform/admin build      # next build
```

From the repo root, `pnpm lint && pnpm typecheck && pnpm test --filter @platform/admin` before
finishing a task. (Next's build output no longer trips the root lint and format checks — that was
REQUEST #44, fixed on main.)

## How the auth hook works

Authorization code + PKCE against the Keycloak staff realm. The client is **public** — there is no
client secret anywhere in this app; the code verifier is what binds the callback to the browser
that started sign-in.

1. `src/middleware.ts` gates every page. No session → redirect to `/api/auth/login?returnTo=…`.
2. [`/api/auth/login`](./src/app/api/auth/login/route.ts) generates `state` and a code verifier,
   parks both in short-lived httpOnly cookies and redirects to Keycloak's authorization endpoint
   with `code_challenge_method=S256`.
3. [`/api/auth/callback`](./src/app/api/auth/callback/route.ts) checks `state`, redeems the code
   with the verifier, and seals the token set into the session cookie.
4. [`/api/auth/logout`](./src/app/api/auth/logout/route.ts) clears the cookies and ends the realm
   SSO session, so the next sign-in really asks for credentials.

**Where the tokens live.** The whole token set is AES-GCM encrypted with `ADMIN_SESSION_SECRET` and
stored in an httpOnly, `SameSite=Lax` cookie (`secure` in production). Keycloak tokens exceed the
4 KB per-cookie limit, so the sealed value is split across `admin_session.0`, `admin_session.1`, …
and rejoined on read; a shrinking session clears its stale tail. A cookie that does not decrypt is
simply treated as signed out.

**Where the tokens do not go.** No client component ever receives one. `src/lib/api/admin.ts` is
`import 'server-only'`, so importing it from a `'use client'` file is a build error rather than a
leak. Client components reach the API through server actions and route handlers.

**Refresh.** Only the middleware can still write cookies for the current request, so it is the one
place that refreshes: within 60 s of expiry it redeems the refresh token, updates both the incoming
request and the response, and a failed refresh starts a clean sign-in rather than rendering with a
token the API would reject.

## Two views, one app

Which sections exist is fixed; which of them _you_ see is a pure function of the `Principal` from
`GET /admin/me`. That function lives in [`src/lib/nav/`](./src/lib/nav/) and imports nothing from
`next/*`, so it is unit-tested directly against fixtures for all seven seeded roles.

| View                  | Sections                                                  | Gated on                               |
| --------------------- | --------------------------------------------------------- | -------------------------------------- |
| **HQ** (`(hq)`)       | Stores, Warehouse, Finance, BI, Roles, Onboarding         | relations on `organization:hq`         |
| **Store** (`(store)`) | Catalog, Orders, Customers, Promotions, Content, Settings | relations on the selected `store:{id}` |

`src/lib/nav/sections.ts` is the catalogue, and every entry carries a `why` naming the contract
operation its gate comes from — `Settings` requires `store_admin` because `updateStore` does.
`src/lib/nav/relations.ts` mirrors the OpenFGA model in ADR 0002, so implication works: an
organization `owner` is a store admin everywhere, `store_admin` implies `store_staff`, and any
organization relation makes you a store `viewer`. Finance is organization-only by construction — no
number of stores adds up to it.

**Three gates, not one.** Hiding a nav entry is the weakest of them:

1. the nav does not render the link;
2. the page's `HqSectionGuard` / `StoreSectionGuard` renders a 403 panel if you type the URL anyway,
   and the store layout re-validates the store id against `stores[]` on _every_ request;
3. the Admin API re-checks the operation's `x-permission`. This is the only one that is security.

**The store switcher** lists exactly `stores[]` — nothing inferred. The choice is remembered in the
`admin_selected_store` cookie, but the cookie is only a hint: it is re-validated on every request,
so revoking someone's access to a store takes effect on their next page load rather than at cookie
expiry. Switching keeps you on the same section (Orders on brand-a → Orders on brand-b).

**Adding a section** means one entry in `src/lib/nav/sections.ts` (with its `why`), a folder under
`src/app/(hq)/` or `src/app/(store)/[storeId]/`, and a row in the test matrix in
`test/navigation.test.ts`. Nothing else knows the list.

## Lists: the data-table primitive

Every list screen uses one component, [`DataTable`](./src/components/table/data-table.tsx). It is a
renderer, not a data engine: `manualPagination`, `manualSorting` and `manualFiltering` are all on,
because the contract returns `{ page, limit, total, items }` and the server decides what is in it.

**State lives in the URL, not in React.** `src/lib/table/query-state.ts` parses `?page=2&q=tee` into
a `TableQuery` on the server and serialises it back on every interaction, omitting anything at its
default so `/stores` stays `/stores`. That makes every list linkable, back-button correct and
reproducible from a bug report. A page reads it once and hands it down already parsed, so the first
paint matches the link that was opened:

```tsx
const query = parseTableQuery(params, ['q', 'status']);
const result = await listProducts(storeId, toContractQuery(query));
```

`parseTableQuery` only keeps filter keys you declare, so a hand-added `?injected=1` never reaches the
Admin API as an undeclared parameter.

**Sorting is server-driven, and opt-in per operation.** Admin API 0.2.0 added `sort`/`order` to the
four list operations the admin app renders as tables (CONTRACT CHANGE #56), each with its own enum of
sortable fields. `toContractQuery` therefore still withholds them unless the caller passes
`{ sortable: true }`, so a table built on some other endpoint cannot send a parameter that endpoint
does not define. A screen turns sorting on in two places — `sortableColumns` on the table (the
contract's enum, nothing more) and `{ sortable: true }` on the query — and declares the contract's
own default sort in its `TableQueryDefaults` so the default stays out of the URL. `listStores` sorts
by `code`, `name`, `status`, `created_at`; `listProducts` by `title`, `handle`, `status`,
`created_at`, `updated_at`.

**Selecting a page never selects the rest of the result set.** The header checkbox ticks the rows you
can see. Only once a full page is ticked, and only if more rows match, does the bar offer
"Select all N matching" — a separate, deliberate click that switches the selection into
`all-matching` mode (with an exclusion list, so you can still untick individuals). `describeSelection`
gives a bulk action the exact wording for its confirmation, so "delete selected" is never ambiguous
about whether it means 20 rows or 4 000. The model is pure and lives in
`src/lib/table/selection.ts`.

**Accessibility.** The table carries an `aria-label` and an off-screen `<caption>`; sortable headers
are real `<button>`s inside `<th aria-sort>`, so the sort state is announced rather than only drawn;
the range line is `aria-live="polite"`; the bulk bar is a `role="status"`; and a column that cannot
be sorted never claims it can.

## Forms: `useContractForm`

Every form in this app is built the same way:

```tsx
const { form, submit, formError, isSubmitting } = useContractForm({
  schema: storeCreateSchema,
  action: createStoreAction,
  defaultValues,
});
```

**One schema, both sides.** `src/lib/forms/schemas.ts` holds Zod schemas mirroring the contract
input types. The client validates with them and the server action re-validates with the same object,
so the two cannot disagree about what is valid. They are hand-written rather than generated on
purpose: `admin-api.yaml` marks almost every input property optional because `POST` and `PATCH`
share one schema — `StoreInput` has no `required` list at all — so a generated schema would accept
an empty create form and let the server say no. Each form gets what it actually needs
(`storeCreateSchema` demands what a store cannot exist without; `storeUpdateSchema` is the same
fields, all optional).

The schemas cannot silently rot: a `MatchesContract` type assertion fails the build if a field name
or a value type drifts from `AdminComponents`.

**Server errors land on the control that caused them.** The contract names the offending field —
`400 { code: validation_error, details: { field: 'handle' } }` and `409 { code: conflict, … }` — so
`mapServerError` attaches the message to that input via `setError`, focusing the first one. A field
the form does not render is raised to `formError` with the field name kept in the text, because a
message pinned to an invisible input is a message nobody reads. A `403` is rewritten in terms of the
missing relation; a transport failure says the API is unreachable rather than showing `ECONNREFUSED`.
Server errors are cleared on the next submit, so a stale "handle already exists" never sits under a
handle the user has since changed.

Actions return an `ActionResult` and never throw at the form — `toActionResult(result, knownFields)`
does the mapping server-side, so the browser never has to know the Admin API's error shape:

```ts
'use server';
export async function createStoreAction(values: StoreCreateValues) {
  const parsed = storeCreateSchema.parse(values); // re-validate; the client is not trusted
  return toActionResult(await createStore(parsed), fieldNames(storeCreateSchema));
}
```

**Money is edited as integer minor units.** `MoneyField` shows major units but reports an integer:
what the user types is parsed by string manipulation (`src/lib/forms/money.ts`), never by
multiplying a float, because `12.10 * 100` is `1209.9999999999998` and a cent lost in a price list
is a cent lost in the ledger. It is currency-aware — JPY takes no decimals, EUR two, KWD three — and
accepts a comma as the decimal point while rejecting group separators rather than guessing at
`1,234`.

**Optimistic UI is opt-in.** `useContractForm` takes an `optimistic` callback and runs it only when
one is passed. An admin form that shows a save as done before the server agreed is a form that lies
about whether a price changed.

## The screens

**HQ · Stores** (`registry`). `/stores` lists the registry; `/stores/new` creates one (brand
onboarding step 1, `owner` on `organization:hq`); `/stores/{id}` is the record plus its domains,
sales channels and API keys. The four sub-resources are fetched in parallel and each may fail on its
own — listing API keys needs `store_admin` while reading the store needs only `viewer`, so a viewer
still sees the store rather than an error page.

**The API key shown once.** `createApiKey` is documented as returning the plain key exactly once. It
lives in one component's state and nowhere else: never in the URL, never in storage, never sent back.
The list only ever holds `key_prefix`, so once the panel is dismissed the value is gone — which is
why the reveal carries a warning and a copy button rather than a "show again" control.

**Store · Catalog** (`catalog`). `/{storeId}/catalog` lists products with the contract's own filters
(`q`, `status`) and sort; `/{storeId}/catalog/new` and `/{storeId}/catalog/{id}` are the same form,
which previews the variant matrix as options are typed — `variantMatrix` is a pure function with its
own tests, because 3 sizes × 2 colours must be 6 variants and quietly producing 3 would corrupt a
catalog. Publish and archive render what the server returned (`status`, `published_at`); archive is
behind a confirmation, since `DELETE` is the verb even though the contract archives rather than
hard-deletes. `/{storeId}/catalog/categories` assembles the tree from the flat list, showing an
orphan at the root rather than dropping it.

## How to add a screen

1. **Add a typed call** in [`src/lib/api/admin.ts`](./src/lib/api/admin.ts):

   ```ts
   export async function listStores(page = 1) {
     return adminCall<'listStores'>({ path: '/admin/stores', query: { page, limit: 20 } });
   }
   ```

   The type parameter is the contract `operationId`; `AdminResponse<'listStores'>` is then the exact
   success body from `admin-api.yaml`. For templated paths use
   `buildPath('/admin/stores/{storeId}/products', { storeId })`.

2. **Render it in a server component.** Calls never throw on an HTTP error — they resolve to
   `{ ok: true, data }` or `{ ok: false, status, error }`, so a `403` renders a panel in place
   instead of taking down the route:

   ```tsx
   const result = await listStores();
   if (!result.ok) return <ErrorPanel status={result.status} error={result.error} />;
   ```

   Check the operation's `x-permission` in `admin-api.yaml` to decide which relation should reveal
   the entry point in the navigation.

3. **Keep mutations on the server.** Submit through a server action that calls `adminCall`; never
   `fetch` the Admin API from the browser.

## Layout

| Path                     | What lives there                                                     |
| ------------------------ | -------------------------------------------------------------------- |
| `src/app/(hq)/`          | HQ routes (`/stores`, `/finance`, …)                                 |
| `src/app/(store)/`       | Store routes (`/{storeId}/catalog`, …)                               |
| `src/app/api/auth/`      | The OIDC endpoints                                                   |
| `src/app/actions/`       | Server actions (the store switcher's submit handler)                 |
| `src/middleware.ts`      | The auth gate and the only place that refreshes tokens               |
| `src/lib/env.ts`         | Server-side configuration and defaults                               |
| `src/lib/auth/`          | PKCE, discovery, token exchange, session sealing                     |
| `src/lib/api/`           | Admin API transport (`admin-client.ts`) and typed calls (`admin.ts`) |
| `src/lib/nav/`           | Sections, the relation algebra, and the selected-store cookie        |
| `src/lib/table/`         | URL table state and the row-selection model (both pure)              |
| `src/lib/forms/`         | Contract schemas, server-error mapping, money parsing (all pure)     |
| `src/components/form/`   | `useContractForm`, field chrome, `MoneyField`                        |
| `src/components/table/`  | The `DataTable` primitive                                            |
| `src/components/shell/`  | The frame: header, side nav, store switcher, section guards          |
| `src/components/states/` | The 403 / no-access / error panels                                   |
| `src/components/ui/`     | Presentational primitives (`cn`, Button, Card, Badge)                |
| `test/`                  | Vitest suites; `test/fixtures/principals.ts` holds the role fixtures |

`src/lib/api/admin-client.ts`, `src/lib/auth/session.ts` and everything in `src/lib/nav/` except
`selected-store.ts` avoid `next/*` imports on purpose, so they run unchanged in the Node runtime,
the Edge middleware, and unit tests.

Owner: window 4 (admin). `src/app/(hq)/bi/**` is window 12 (embed only). See CLAUDE.md.
