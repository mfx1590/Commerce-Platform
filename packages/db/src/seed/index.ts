import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createOrganizationClient, type Queryable } from '../client.js';

/**
 * Fixed ids used by `pnpm db:seed` and by every window's tests/mocks. Frozen with contracts-v0.1.
 * Pattern: 00000000-0000-4000-8000-0000000000NN for fixed entities; 3S00000K-0000-4000-8000-NNNNNNNNNNNN for
 * generated store data (S = store index 1..3, K = kind).
 */
export const SEED_IDS = {
  organization: '00000000-0000-4000-8000-000000000001',
  legalEntities: {
    brandA: '00000000-0000-4000-8000-000000000011',
    brandB: '00000000-0000-4000-8000-000000000012',
    brandC: '00000000-0000-4000-8000-000000000013',
  },
  warehouses: {
    eu: '00000000-0000-4000-8000-000000000021',
    us: '00000000-0000-4000-8000-000000000022',
  },
  stores: {
    brandA: '00000000-0000-4000-8000-000000000031',
    brandB: '00000000-0000-4000-8000-000000000032',
    brandC: '00000000-0000-4000-8000-000000000033',
  },
  users: {
    owner: '00000000-0000-4000-8000-000000000041',
    finance: '00000000-0000-4000-8000-000000000042',
    operations: '00000000-0000-4000-8000-000000000043',
    storeAdmin: '00000000-0000-4000-8000-000000000044',
    storeStaff: '00000000-0000-4000-8000-000000000045',
    support: '00000000-0000-4000-8000-000000000046',
    analyst: '00000000-0000-4000-8000-000000000047',
  },
  /** Plain publishable keys for local dev (`X-Publishable-Key`). Hashed in the database. */
  publishableKeys: {
    brandA: 'pk_brand-a_dev_00000000000000000000',
    brandB: 'pk_brand-b_dev_00000000000000000000',
    brandC: 'pk_brand-c_dev_00000000000000000000',
  },
} as const;

export interface SeedOptions {
  productsPerStore?: number;
  log?: (msg: string) => void;
}

interface StoreDef {
  key: 'brandA' | 'brandB' | 'brandC';
  index: 1 | 2 | 3;
  code: string;
  name: string;
  legalEntity: { id: string; code: string; name: string; country: string; vat: string };
  currency: string;
  locales: string[];
  country: string;
  timezone: string;
  taxRate: { name: string; rateBp: number; region: string | null };
  shippingCountries: string[];
}

const STORES: StoreDef[] = [
  {
    key: 'brandA',
    index: 1,
    code: 'brand-a',
    name: 'Brand A',
    legalEntity: {
      id: SEED_IDS.legalEntities.brandA,
      code: 'le-brand-a',
      name: 'Brand A B.V.',
      country: 'NL',
      vat: 'NL000000000B01',
    },
    currency: 'EUR',
    locales: ['en-GB', 'de-DE'],
    country: 'NL',
    timezone: 'Europe/Amsterdam',
    taxRate: { name: 'VAT 21%', rateBp: 2100, region: null },
    shippingCountries: ['NL', 'DE', 'BE', 'FR'],
  },
  {
    key: 'brandB',
    index: 2,
    code: 'brand-b',
    name: 'Brand B',
    legalEntity: {
      id: SEED_IDS.legalEntities.brandB,
      code: 'le-brand-b',
      name: 'Brand B Ltd',
      country: 'GB',
      vat: 'GB000000000',
    },
    currency: 'GBP',
    locales: ['en-GB'],
    country: 'GB',
    timezone: 'Europe/London',
    taxRate: { name: 'VAT 20%', rateBp: 2000, region: null },
    shippingCountries: ['GB'],
  },
  {
    key: 'brandC',
    index: 3,
    code: 'brand-c',
    name: 'Brand C',
    legalEntity: {
      id: SEED_IDS.legalEntities.brandC,
      code: 'le-brand-c',
      name: 'Brand C Inc.',
      country: 'US',
      vat: '00-0000000',
    },
    currency: 'USD',
    locales: ['en-US'],
    country: 'US',
    timezone: 'America/New_York',
    taxRate: { name: 'NY sales tax 8.875%', rateBp: 888, region: 'NY' },
    shippingCountries: ['US'],
  },
];

const USERS: Array<{
  id: string;
  key: string;
  email: string;
  name: string;
  relation: string;
  objectType: 'organization' | 'store';
  objectIds: string[];
}> = [
  {
    id: SEED_IDS.users.owner,
    key: 'owner',
    email: 'owner@example.com',
    name: 'Olivia Owner',
    relation: 'owner',
    objectType: 'organization',
    objectIds: [SEED_IDS.organization],
  },
  {
    id: SEED_IDS.users.finance,
    key: 'finance',
    email: 'finance@example.com',
    name: 'Fin Finance',
    relation: 'finance',
    objectType: 'organization',
    objectIds: [SEED_IDS.organization],
  },
  {
    id: SEED_IDS.users.operations,
    key: 'operations',
    email: 'operations@example.com',
    name: 'Otto Operations',
    relation: 'operations',
    objectType: 'organization',
    objectIds: [SEED_IDS.organization],
  },
  {
    id: SEED_IDS.users.storeAdmin,
    key: 'store-admin',
    email: 'store-admin@example.com',
    name: 'Sam StoreAdmin',
    relation: 'store_admin',
    objectType: 'store',
    objectIds: [SEED_IDS.stores.brandA, SEED_IDS.stores.brandB],
  },
  {
    id: SEED_IDS.users.storeStaff,
    key: 'store-staff',
    email: 'store-staff@example.com',
    name: 'Stef StoreStaff',
    relation: 'store_staff',
    objectType: 'store',
    objectIds: [SEED_IDS.stores.brandA],
  },
  {
    id: SEED_IDS.users.support,
    key: 'support',
    email: 'support@example.com',
    name: 'Sue Support',
    relation: 'support',
    objectType: 'organization',
    objectIds: [SEED_IDS.organization],
  },
  {
    id: SEED_IDS.users.analyst,
    key: 'analyst',
    email: 'analyst@example.com',
    name: 'Ana Analyst',
    relation: 'analyst',
    objectType: 'organization',
    objectIds: [SEED_IDS.organization],
  },
];

const CATEGORIES = [
  { handle: 'tops', name: 'Tops', parent: null },
  { handle: 't-shirts', name: 'T-shirts', parent: 'tops' },
  { handle: 'hoodies', name: 'Hoodies', parent: 'tops' },
  { handle: 'bottoms', name: 'Bottoms', parent: null },
  { handle: 'jeans', name: 'Jeans', parent: 'bottoms' },
  { handle: 'shorts', name: 'Shorts', parent: 'bottoms' },
  { handle: 'accessories', name: 'Accessories', parent: null },
  { handle: 'caps', name: 'Caps', parent: 'accessories' },
  { handle: 'bags', name: 'Bags', parent: 'accessories' },
];
const LEAF = ['t-shirts', 'hoodies', 'jeans', 'shorts', 'caps', 'bags'];
const ADJ = [
  'Classic',
  'Relaxed',
  'Slim',
  'Heavy',
  'Light',
  'Organic',
  'Vintage',
  'Everyday',
  'Studio',
  'Coastal',
  'Urban',
  'Alpine',
];
const NOUN: Record<string, string[]> = {
  't-shirts': ['Tee', 'Crew Tee', 'V-neck Tee', 'Long-sleeve Tee'],
  hoodies: ['Hoodie', 'Zip Hoodie', 'Crewneck'],
  jeans: ['Jeans', 'Denim', 'Straight Jeans'],
  shorts: ['Shorts', 'Chino Shorts', 'Swim Shorts'],
  caps: ['Cap', 'Beanie', 'Bucket Hat'],
  bags: ['Tote', 'Backpack', 'Crossbody'],
};
const SIZES: Record<string, string[]> = {
  't-shirts': ['S', 'M', 'L', 'XL'],
  hoodies: ['S', 'M', 'L', 'XL'],
  jeans: ['30', '32', '34'],
  shorts: ['S', 'M', 'L'],
  caps: ['One size'],
  bags: ['One size'],
};
const COLORS = ['Black', 'White', 'Navy', 'Olive', 'Sand', 'Red'];
const MATERIALS = [
  'cotton',
  'organic cotton',
  'linen',
  'wool blend',
  'recycled polyester',
  'denim',
];

/** Deterministic PRNG so every environment gets identical seed data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic uuid: 3S00000K-0000-4000-8000-NNNNNNNNNNNN. */
export function seedId(storeIndex: number, kind: number, n: number): string {
  return `3${storeIndex}00000${kind.toString(16)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
const KIND = {
  category: 1,
  product: 2,
  variant: 3,
  price: 4,
  media: 5,
  channel: 6,
  priceList: 7,
  shipping: 8,
  tax: 9,
  apiKey: 0xa,
  promotion: 0xb,
  inventory: 0xc,
  domain: 0xd,
  locale: 0xe,
  currency: 0xf,
} as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

/** Multi-row insert helper: columns → rows, ON CONFLICT DO NOTHING (idempotent seeds). */
async function bulk(
  tx: Queryable,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunk = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part
      .map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`)
      .join(',');
    await tx.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} ON CONFLICT DO NOTHING`,
      params,
    );
  }
}

export async function seed(pool: Pool, opts: SeedOptions = {}): Promise<void> {
  const productsPerStore = opts.productsPerStore ?? 200;
  const log = opts.log ?? ((m: string) => console.info(`seed: ${m}`));
  const org = SEED_IDS.organization;
  const hq = createOrganizationClient(pool, { organizationId: org });

  await hq.transaction(async (tx) => {
    await bulk(
      tx,
      'organization',
      ['id', 'slug', 'name', 'default_currency'],
      [[org, 'hq', 'HQ', 'EUR']],
    );
    await bulk(
      tx,
      'legal_entity',
      ['id', 'organization_id', 'code', 'name', 'country', 'currency', 'vat_number'],
      STORES.map((s) => [
        s.legalEntity.id,
        org,
        s.legalEntity.code,
        s.legalEntity.name,
        s.legalEntity.country,
        s.currency,
        s.legalEntity.vat,
      ]),
    );
    await bulk(
      tx,
      'warehouse',
      ['id', 'organization_id', 'code', 'name', 'address', 'country', 'priority'],
      [
        [
          SEED_IDS.warehouses.eu,
          org,
          'wh-eu',
          'Rotterdam',
          JSON.stringify({
            line1: 'Waalhaven 1',
            city: 'Rotterdam',
            postal_code: '3089 JH',
            country: 'NL',
          }),
          'NL',
          10,
        ],
        [
          SEED_IDS.warehouses.us,
          org,
          'wh-us',
          'New Jersey',
          JSON.stringify({
            line1: '1 Port St',
            city: 'Newark',
            region: 'NJ',
            postal_code: '07114',
            country: 'US',
          }),
          'US',
          20,
        ],
      ],
    );
    await bulk(
      tx,
      'staff_user',
      ['id', 'organization_id', 'keycloak_subject', 'email', 'display_name'],
      USERS.map((u) => [u.id, org, `seed-${u.key}`, u.email, u.name]),
    );
    await bulk(
      tx,
      'store',
      [
        'id',
        'organization_id',
        'legal_entity_id',
        'code',
        'name',
        'status',
        'default_currency',
        'default_locale',
        'default_country',
        'timezone',
        'content_space_id',
        'search_index',
        'theme',
        'settings',
      ],
      STORES.map((s) => [
        SEED_IDS.stores[s.key],
        org,
        s.legalEntity.id,
        s.code,
        s.name,
        'active',
        s.currency,
        s.locales[0],
        s.country,
        s.timezone,
        s.code,
        `${s.code}_products`,
        JSON.stringify({ colors: { primary: ['#1E40AF', '#047857', '#B91C1C'][s.index - 1] } }),
        JSON.stringify({ support_refund_limit_minor: 5000 }),
      ]),
    );
    await bulk(
      tx,
      'role_assignment',
      ['organization_id', 'staff_user_id', 'relation', 'object_type', 'object_id'],
      USERS.flatMap((u) => u.objectIds.map((o) => [org, u.id, u.relation, u.objectType, o])),
    );
  });
  log('organization, legal entities, warehouses, stores, 7 staff users');

  for (const s of STORES) {
    const storeId = SEED_IDS.stores[s.key];
    const rnd = mulberry32(1000 + s.index);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
    const id = (kind: number, n: number) => seedId(s.index, kind, n);

    await hq.transaction(async (tx) => {
      await bulk(
        tx,
        'store_domain',
        ['id', 'organization_id', 'store_id', 'hostname', 'is_primary'],
        [[id(KIND.domain, 1), org, storeId, `shop.${s.code}.local`, true]],
      );
      await bulk(
        tx,
        'store_locale',
        ['id', 'organization_id', 'store_id', 'locale', 'is_default'],
        s.locales.map((l, i) => [id(KIND.locale, i + 1), org, storeId, l, i === 0]),
      );
      await bulk(
        tx,
        'store_currency',
        ['id', 'organization_id', 'store_id', 'currency', 'is_default'],
        [[id(KIND.currency, 1), org, storeId, s.currency, true]],
      );
      const channelId = id(KIND.channel, 1);
      await bulk(
        tx,
        'sales_channel',
        ['id', 'organization_id', 'store_id', 'code', 'name', 'type'],
        [[channelId, org, storeId, 'web', 'Web', 'web']],
      );
      const plain = SEED_IDS.publishableKeys[s.key];
      await bulk(
        tx,
        'store_api_key',
        [
          'id',
          'organization_id',
          'store_id',
          'name',
          'type',
          'key_prefix',
          'key_hash',
          'sales_channel_id',
        ],
        [
          [
            id(KIND.apiKey, 1),
            org,
            storeId,
            'storefront (dev)',
            'publishable',
            plain.slice(0, 8),
            sha256(plain),
            channelId,
          ],
        ],
      );
      const priceListId = id(KIND.priceList, 1);
      await bulk(
        tx,
        'price_list',
        ['id', 'organization_id', 'store_id', 'code', 'name', 'type', 'currency', 'status'],
        [
          [
            priceListId,
            org,
            storeId,
            `default-${s.currency.toLowerCase()}`,
            `Default ${s.currency}`,
            'default',
            s.currency,
            'active',
          ],
        ],
      );
      await bulk(
        tx,
        'tax_rate',
        ['id', 'organization_id', 'store_id', 'country', 'region', 'name', 'rate_bp'],
        [
          [
            id(KIND.tax, 1),
            org,
            storeId,
            s.country,
            s.taxRate.region,
            s.taxRate.name,
            s.taxRate.rateBp,
          ],
        ],
      );
      await bulk(
        tx,
        'shipping_option',
        [
          'id',
          'organization_id',
          'store_id',
          'code',
          'name',
          'carrier',
          'price_minor',
          'currency',
          'countries',
        ],
        [
          [
            id(KIND.shipping, 1),
            org,
            storeId,
            'standard',
            'Standard (2–4 days)',
            'manual',
            499,
            s.currency,
            s.shippingCountries,
          ],
          [
            id(KIND.shipping, 2),
            org,
            storeId,
            'express',
            'Express (next day)',
            'manual',
            999,
            s.currency,
            s.shippingCountries,
          ],
        ],
      );
      await bulk(
        tx,
        'promotion',
        [
          'id',
          'organization_id',
          'store_id',
          'code',
          'name',
          'type',
          'value',
          'rules',
          'per_customer_limit',
          'status',
        ],
        [
          [
            id(KIND.promotion, 1),
            org,
            storeId,
            'WELCOME10',
            'Welcome 10%',
            'percentage',
            1000,
            JSON.stringify({ first_order_only: true }),
            1,
            'active',
          ],
        ],
      );

      const catId = new Map<string, string>();
      CATEGORIES.forEach((c, i) => catId.set(c.handle, id(KIND.category, i + 1)));
      await bulk(
        tx,
        'product_category',
        ['id', 'organization_id', 'store_id', 'parent_id', 'handle', 'name', 'position'],
        CATEGORIES.map((c, i) => [
          catId.get(c.handle),
          org,
          storeId,
          c.parent ? catId.get(c.parent) : null,
          c.handle,
          c.name,
          i,
        ]),
      );

      const products: unknown[][] = [];
      const options: unknown[][] = [];
      const variants: unknown[][] = [];
      const prices: unknown[][] = [];
      const media: unknown[][] = [];
      const inventory: unknown[][] = [];
      let variantN = 0;
      const handles = new Set<string>();
      for (let p = 1; p <= productsPerStore; p++) {
        const leaf = LEAF[(p - 1) % LEAF.length]!;
        const adj = pick(ADJ);
        const noun = pick(NOUN[leaf]!);
        let title = `${adj} ${noun}`;
        let handle = kebab(title);
        if (handles.has(handle)) {
          title = `${title} ${p}`;
          handle = `${handle}-${p}`;
        }
        handles.add(handle);
        const productId = id(KIND.product, p);
        const material = pick(MATERIALS);
        const basePrice = 900 + Math.floor(rnd() * 120) * 50; // 9.00 … 68.50 in minor units
        const onSale = rnd() < 0.25;
        products.push([
          productId,
          org,
          storeId,
          handle,
          title,
          `${material[0]!.toUpperCase()}${material.slice(1)}`,
          `${title} in ${material}. Seeded product #${p} of ${s.name}.`,
          'published',
          catId.get(leaf),
          s.name,
          [leaf, material.split(' ')[0]],
          JSON.stringify({ material }),
          JSON.stringify({ title, description: `${title} — ${s.name}` }),
          `https://picsum.photos/seed/${s.code}-${p}/800/1000`,
          new Date('2026-09-01T00:00:00Z'),
        ]);
        media.push([
          id(KIND.media, p),
          org,
          storeId,
          productId,
          null,
          `https://picsum.photos/seed/${s.code}-${p}/800/1000`,
          title,
          0,
        ]);
        const sizes = SIZES[leaf]!;
        const colors =
          sizes.length === 1
            ? [pick(COLORS)]
            : [pick(COLORS), pick(COLORS)].filter((c, i, a) => a.indexOf(c) === i);
        options.push([id(KIND.category, 1000 + p * 2), org, storeId, productId, 'Size', sizes, 0]);
        options.push([
          id(KIND.category, 1000 + p * 2 + 1),
          org,
          storeId,
          productId,
          'Color',
          colors,
          1,
        ]);
        let pos = 0;
        for (const size of sizes) {
          for (const color of colors) {
            variantN += 1;
            const variantId = id(KIND.variant, variantN);
            const sku = `${s.code.toUpperCase().replace('-', '')}-${String(p).padStart(4, '0')}-${kebab(size).toUpperCase()}-${color.slice(0, 3).toUpperCase()}`;
            variants.push([
              variantId,
              org,
              storeId,
              productId,
              sku,
              `${size} / ${color}`,
              JSON.stringify({ Size: size, Color: color }),
              true,
              false,
              150 + Math.floor(rnd() * 400),
              'PT',
              pos++,
            ]);
            prices.push([
              id(KIND.price, variantN),
              org,
              storeId,
              priceListId,
              variantId,
              s.currency,
              basePrice,
              onSale ? Math.round(basePrice * 1.25) : null,
            ]);
            const euStock = Math.floor(rnd() * 40);
            const usStock = Math.floor(rnd() * 20);
            inventory.push([
              id(KIND.inventory, variantN * 2 - 1),
              org,
              storeId,
              variantId,
              SEED_IDS.warehouses.eu,
              euStock,
            ]);
            inventory.push([
              id(KIND.inventory, variantN * 2),
              org,
              storeId,
              variantId,
              SEED_IDS.warehouses.us,
              usStock,
            ]);
          }
        }
      }
      await bulk(
        tx,
        'product',
        [
          'id',
          'organization_id',
          'store_id',
          'handle',
          'title',
          'subtitle',
          'description',
          'status',
          'category_id',
          'brand_name',
          'tags',
          'attributes',
          'seo',
          'thumbnail_url',
          'published_at',
        ],
        products,
      );
      await bulk(
        tx,
        'product_option',
        ['id', 'organization_id', 'store_id', 'product_id', 'name', '"values"', 'position'],
        options,
      );
      await bulk(
        tx,
        'product_variant',
        [
          'id',
          'organization_id',
          'store_id',
          'product_id',
          'sku',
          'title',
          'options',
          'manage_inventory',
          'allow_backorder',
          'weight_g',
          'origin_country',
          'position',
        ],
        variants,
      );
      await bulk(
        tx,
        'price',
        [
          'id',
          'organization_id',
          'store_id',
          'price_list_id',
          'variant_id',
          'currency',
          'amount_minor',
          'compare_at_minor',
        ],
        prices,
      );
      await bulk(
        tx,
        'product_media',
        ['id', 'organization_id', 'store_id', 'product_id', 'variant_id', 'url', 'alt', 'position'],
        media,
      );
      await bulk(
        tx,
        'inventory_level',
        ['id', 'organization_id', 'store_id', 'variant_id', 'warehouse_id', 'on_hand'],
        inventory,
      );
      log(
        `${s.code}: ${products.length} products, ${variants.length} variants, ${inventory.length} inventory levels`,
      );
    });
  }
}
