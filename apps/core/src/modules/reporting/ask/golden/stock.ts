// The owner's first real question (#869 comment, #871 acceptance): "How is our availability, do we need to order
// anything?". A deterministic stock fixture, the scripted model's answer written from what the tool actually returned,
// and the CHECKS any answer — scripted now, a real model's later — must pass:
//   * every item the tool flagged (stock_out, low, reorder) is named (by its name, never an alias) with its days of
//     cover and its suggested quantity;
//   * the parameters are stated (the sales window, lead time and cover days);
//   * the "incoming is not tracked" sentence is there (the suggestion assumes nothing is on order);
//   * a rate_understated row says sales were limited by stock; a suggestion_partial row says the stock is shared;
//   * no alias is left in the text and no number appears that the tool did not return.
import type { InventoryInputs, MappingRow, PositionRow } from '../../metrics/inventory';
import type { MetricAnswer } from '../ask';

export const STOCK_QUESTION = 'How is our availability, do we need to order anything?';
export const STOCK_NOW = new Date('2026-11-13T15:00:00.000Z');
export const BER = '00000000-0000-4000-8000-0000000000a1';
export const TYO = '00000000-0000-4000-8000-0000000000a2';

const item = (n: number) => `00000000-0000-4000-8000-0000000051${String(n).padStart(2, '0')}`;
const variant = (n: number) => `00000000-0000-4000-8000-0000000052${String(n).padStart(2, '0')}`;

/** The fixture: what HQ sees on 13 November (UTC), before 15:00. */
export function stockFixture(storeA: string, storeB: string): InventoryInputs {
  const pos = (n: number, name: string, wh: string, onHand: number, reserved = 0): PositionRow => ({
    stock_item_id: item(n),
    sku: `MUG-${n}`,
    name,
    warehouse_id: wh,
    warehouse_code: wh === BER ? 'BER' : 'TYO',
    on_hand: onHand,
    reserved,
    available: onHand - reserved,
    incoming: 0,
  });
  const map = (n: number, store: string): MappingRow => ({
    stock_item_id: item(n),
    variant_id: variant(n),
    store_id: store,
    product_id: item(n),
    category_id: null,
  });
  const daily = (n: number, perDay: number) =>
    Array.from({ length: 28 }, (_, i) => ({
      variant_id: variant(n),
      day: new Date(Date.parse('2026-11-13T00:00:00Z') - (i + 1) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      units: perDay,
    }));
  return {
    positions: [
      pos(1, 'Blue mug', BER, 12), // + TYO 8: 20 available, 2 a day → 10 days < lead 14 → low, order 64
      pos(1, 'Blue mug', TYO, 8),
      pos(2, 'Red mug', BER, 2, 5), // −3 available, no sale lately → stock_out, order 3 (the backorder)
      pos(3, 'Teapot', BER, 200), // 1 a day → 200 days → overstock
      pos(4, 'Saucer', BER, 40), // no sale ever → dead
      pos(5, 'Espresso cup', TYO, 30), // 1 a day → 30 < 42 → reorder, order 12; stocked out on 8 Nov
    ],
    mappings: [
      map(1, storeA),
      map(2, storeA),
      map(3, storeA),
      map(4, storeA),
      map(5, storeA),
      { ...map(1, storeB), variant_id: variant(9) },
    ],
    shared: new Set<string>(),
    settings: new Map(),
    sales: {
      byDay: [...daily(1, 2), ...daily(3, 1), ...daily(5, 1)],
      lastSale: new Map([
        [variant(1), '2026-11-12T10:00:00.000Z'],
        [variant(2), '2026-08-01T10:00:00.000Z'],
        [variant(3), '2026-11-12T10:00:00.000Z'],
        [variant(5), '2026-11-12T10:00:00.000Z'],
      ]),
      stockoutDays: new Map([[item(5), ['2026-11-08']]]),
      lastReceipt: new Map(),
      data_as_of: '2026-11-13T14:59:00.000Z',
    },
  };
}

/** What the owner must be told, concretely (the acceptance): item, status, available, cover, suggestion. */
export const EXPECTED_STOCK_ROWS = [
  {
    name: 'Red mug',
    sku: 'MUG-2',
    status: 'stock_out',
    available: -3,
    days_of_cover: 0,
    suggested_reorder_units: 3,
  },
  {
    name: 'Blue mug',
    sku: 'MUG-1',
    status: 'low',
    available: 20,
    days_of_cover: 10,
    suggested_reorder_units: 64,
  },
  {
    name: 'Espresso cup',
    sku: 'MUG-5',
    status: 'reorder',
    available: 30,
    days_of_cover: 30,
    suggested_reorder_units: 12,
  },
] as const;

interface ToolRow {
  item: string;
  available: number;
  days_of_cover: number | null;
  status: string;
  suggested_reorder_units: number | null;
  rate_understated: boolean | null;
  suggestion_partial: boolean;
  parameters: { velocity_days: number; lead_time_days: number; cover_days: number };
}

/** The scripted model's answer, written ONLY from the tool result it received (aliases, as a model would). */
export function stockAnswerFrom(toolContent: string): string {
  const r = JSON.parse(toolContent) as { ref: string; rows: ToolRow[]; incoming_tracked: boolean };
  const p = r.rows[0]?.parameters;
  const lines = r.rows.map((x) => {
    const cover = x.days_of_cover === null ? 'no recent sales' : `${x.days_of_cover} days of cover`;
    const flags = [
      x.rate_understated ? 'sales were limited by stock, so real demand is likely higher' : null,
      x.suggestion_partial ? 'other brands share this stock; the HQ view is the full one' : null,
    ].filter(Boolean);
    return `${x.item}: ${x.status}, ${x.available} available, ${cover}; order ${x.suggested_reorder_units}${flags.length ? ` (${flags.join('; ')})` : ''} [${r.ref}]`;
  });
  return [
    `Yes, ${r.rows.length} items need ordering.`,
    ...lines,
    p
      ? `Based on sales over the last ${p.velocity_days} days, a lead time of ${p.lead_time_days} days and ${p.cover_days} days of cover.`
      : '',
    r.incoming_tracked
      ? ''
      : 'Incoming stock is not tracked yet: the suggestions assume nothing is on order, so subtract what you have already ordered from suppliers.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The checks (#871 e acceptance), for any answer. Empty = passes. */
export function checkStockAnswer(a: MetricAnswer): string[] {
  const problems: string[] = [];
  const call = a.inventory?.[0];
  if (!call?.result) return ['inventory_health was not called (or failed)'];
  const asked = new Set(call.query.status ?? []);
  for (const s of ['stock_out', 'low', 'reorder'])
    if (!asked.has(s as never)) problems.push(`inventory_health not asked for ${s}`);
  const text = a.answer;
  for (const row of call.result.rows) {
    if (!text.includes(row.name)) problems.push(`${row.name} is not named`);
    if (row.days_of_cover !== null && !new RegExp(`\\b${row.days_of_cover} days`).test(text))
      problems.push(`${row.name}: its cover (${row.days_of_cover} days) is not stated`);
    if (
      row.suggested_reorder_units !== null &&
      !new RegExp(`\\b${row.suggested_reorder_units}\\b`).test(text)
    )
      problems.push(
        `${row.name}: its suggested quantity (${row.suggested_reorder_units}) is not stated`,
      );
    if (row.rate_understated && !/limited by stock|stocked out|out of stock/i.test(text))
      problems.push(`${row.name}: the understated rate is not flagged`);
    if (row.suggestion_partial && !/share|shared/i.test(text))
      problems.push(`${row.name}: the shared stock is not flagged`);
  }
  if (
    !call.result.incoming_tracked &&
    !/incoming[^.]*not tracked|not tracked[^.]*incoming/i.test(text)
  )
    problems.push('the "incoming is not tracked" sentence is missing');
  const p = call.result.rows[0]?.parameters;
  if (p && !(text.includes(`${p.velocity_days} days`) && text.includes(`${p.lead_time_days} days`)))
    problems.push('the parameters (sales window, lead time) are not stated');
  if (/\b(?:ch|[pcwi])\d+\b/.test(text)) problems.push('an alias is left in the answer');
  // every number is one the tool returned (or a parameter): no figure from nowhere
  const backed = new Set<string>([String(call.result.rows.length)]);
  for (const r of call.result.rows) {
    for (const v of [
      r.available,
      r.on_hand,
      r.days_of_cover,
      r.suggested_reorder_units,
      r.units_sold,
    ])
      if (v !== null) backed.add(String(v));
    for (const v of Object.values(r.parameters)) backed.add(String(v));
  }
  // the items' own names and skus (MUG-2) are labels, not figures
  let figures = text.replace(/\[h\d+\]/g, ' ');
  for (const r of call.result.rows)
    figures = figures.split(r.sku).join(' ').split(r.name).join(' ');
  for (const m of figures.matchAll(/-?\d+/g))
    if (!backed.has(m[0])) problems.push(`${m[0]} is in no inventory result`);
  return [...new Set(problems)];
}
