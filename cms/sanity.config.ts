/**
 * Sanity Studio: one workspace per brand dataset, all sharing the schema registry. Open
 * http://localhost:3333/brand-a (…/brand-b, …/brand-c) after `pnpm --filter @platform/cms studio`.
 *
 * The project id is the only configuration and comes from the environment (`SANITY_PROJECT_ID`
 * in the root `.env`, exported as `SANITY_STUDIO_PROJECT_ID` by `scripts/studio.mjs`). Tokens
 * are never needed here: the Studio authenticates the editor through sanity.io.
 */

import { visionTool } from '@sanity/vision';
import { defineConfig } from 'sanity';
import type { SchemaTypeDefinition } from 'sanity';
import { structureTool } from 'sanity/structure';
import { BRAND_DATASETS, SANITY_API_VERSION, datasetsFromEnv } from './src/datasets.js';
import { schemaTypes } from './src/schema/index.js';

const projectId = process.env['SANITY_STUDIO_PROJECT_ID'] ?? 'unset';

/**
 * The workspaces: the seeded brands, plus any dataset named in `SANITY_DATASETS` (#521) — a brand
 * onboarded from the admin UI, whose dataset is its `store.content_space_id`. `scripts/studio.mjs`
 * exports the variable as `SANITY_STUDIO_DATASETS`; an invalid entry stops the Studio from
 * starting, with the entry named.
 */
const workspaces = [
  ...BRAND_DATASETS.map((brand) => ({ dataset: brand.dataset, title: brand.title })),
  ...datasetsFromEnv(process.env['SANITY_STUDIO_DATASETS']).map((dataset) => ({
    dataset,
    title: dataset,
  })),
];

/**
 * `src/schema/define.ts` mirrors Sanity's definitions structurally (so `src/**` compiles without
 * the Studio package) but not its per-type discriminated union, hence the cast. The schema is
 * still checked for real: `test/sanity-compile.test.ts` compiles exactly this registry with Sanity's
 * own schema compiler, and `test/schema.test.ts` covers the rules our validator relies on.
 */
const types = schemaTypes as unknown as SchemaTypeDefinition[];

export default defineConfig(
  workspaces.map((workspace) => ({
    name: workspace.dataset,
    title: `${workspace.title} content`,
    basePath: `/${workspace.dataset}`,
    projectId,
    dataset: workspace.dataset,
    plugins: [structureTool(), visionTool({ defaultApiVersion: SANITY_API_VERSION })],
    schema: { types },
  })),
);
