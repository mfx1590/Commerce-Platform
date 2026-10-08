// Static checks on the OpenAPI documents (text-level, dependency-free). Runtime checks live in contract.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELATIONS } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, '../openapi', f), 'utf8');

/** Splits a spec into operation blocks: from one `operationId:` line to the next. */
function operations(text: string): Array<{ id: string; body: string }> {
  const lines = text.split('\n');
  const out: Array<{ id: string; body: string }> = [];
  let current: { id: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^\s+operationId:\s*(\w+)/);
    if (m) {
      if (current) out.push({ id: current.id, body: current.body.join('\n') });
      current = { id: m[1]!, body: [] };
      continue;
    }
    if (/^\s{2}\/|^components:/.test(line) && current) {
      out.push({ id: current.id, body: current.body.join('\n') });
      current = null;
    }
    current?.body.push(line);
  }
  if (current) out.push({ id: current.id, body: current.body.join('\n') });
  return out;
}

describe('store-api.yaml', () => {
  const text = read('store-api.yaml');
  const ops = operations(text);

  it('is OpenAPI 3.1 and covers the storefront journey', () => {
    expect(text.startsWith('openapi: 3.1.0')).toBe(true);
    const ids = ops.map((o) => o.id);
    for (const id of [
      'getStore',
      'listProducts',
      'getProduct',
      'createCart',
      'addLineItem',
      'listShippingOptions',
      'createPaymentSession',
      'completeCart',
      'getOrder',
      'getMe',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every operation declares tags and at least one response with a schema', () => {
    // `tags:` precedes `operationId:` in our layout, so count them per document.
    expect((text.match(/^ {6}tags: \[/gm) ?? []).length).toBe(ops.length);
    for (const o of ops) {
      expect(o.body, o.id).toMatch(/responses:/);
      expect(o.body, o.id).toMatch(/schema:/);
    }
  });

  it('requires the publishable key and never accepts card data', () => {
    expect(text).toMatch(/X-Publishable-Key/);
    expect(text).not.toMatch(/card_number|cvc|pan\b/i);
  });

  it('0.3.1 (#228): price_changed is a stable machine code and completeCart documents it on the 409', () => {
    expect(text).toMatch(/machine code: [^']*price_changed/);
    const complete = ops.find((o) => o.id === 'completeCart')!;
    expect(complete.body).toMatch(/price_changed/);
    expect(complete.body).toMatch(/previous_unit_price_minor/);
  });

  it('0.5.2 (#303 PR B): address default flags on addMyAddress, 400 on updateMe and listMyOrders', () => {
    const body = (id: string) => ops.find((o) => o.id === id)!.body;
    // the flags extend the shared Address in the request only — the shared schema stays as carts use it
    expect(body('addMyAddress')).toMatch(/allOf:\n\s+- \$ref: '#\/components\/schemas\/Address'/);
    expect(body('addMyAddress')).toMatch(/is_default_shipping:\n\s+type: boolean/);
    expect(body('addMyAddress')).toMatch(/is_default_billing:\n\s+type: boolean/);
    // 0.5.3: no schema default — absent on the first address means default, so `default: false` was untrue
    expect(body('addMyAddress')).not.toMatch(
      /is_default_(shipping|billing)[^\n]*\n?[^\n]*default: false/,
    );
    // 0.5.3: createCart documents the 409 of a token whose email belongs to another account
    expect(body('createCart')).toContain(`'409':`);
    expect(body('createCart')).toMatch(/Without a token\s+this operation never answers 409/);
    const address = text.slice(
      text.indexOf('\n    Address:\n'),
      text.indexOf('\n    ', text.indexOf('\n    Address:\n') + 1),
    );
    expect(address).not.toMatch(/is_default/);
    for (const id of ['updateMe', 'listMyOrders']) {
      expect(body(id), `${id} 400`).toContain(`'400':`);
    }
    // listMyAddresses takes no query and no body: no 400, on purpose
    expect(body('listMyAddresses')).not.toContain(`'400':`);
  });

  it('0.5.1 (#303, #310): customer self-service statuses and the optional customer token on cart create/complete', () => {
    const body = (id: string) => ops.find((o) => o.id === id)!.body;
    // registerCustomer: 201 created, 200 the row existed, 400 body email differs from the token's, 409 collision
    for (const status of ['201', '200', '400', '401', '409']) {
      expect(body('registerCustomer'), `registerCustomer ${status}`).toContain(`'${status}':`);
    }
    expect(body('registerCustomer')).toMatch(/always come\s+from the customer token/);
    for (const id of ['getMe', 'updateMe', 'listMyAddresses', 'addMyAddress', 'listMyOrders']) {
      expect(body(id), `${id} 401`).toContain(`'401':`);
      expect(body(id), `${id} 409`).toContain(`'409':`);
    }
    // the token is OPTIONAL on the two cart operations: a key-only alternative is listed first
    const optionalToken =
      /security:\n\s+- publishableKey: \[\]\n\s+- publishableKey: \[\]\n\s+customerToken: \[\]/;
    for (const id of ['createCart', 'completeCart']) {
      expect(body(id), id).toMatch(optionalToken);
      expect(body(id), `${id} 401`).toContain(`'401':`);
      expect(body(id), id).toMatch(
        /A token that is sent but invalid, expired or bound to another store is a 401/,
      );
    }
    expect(body('completeCart')).toMatch(
      /linked to another customer than the token's \(`conflict`\)/,
    );
    const withToken = ops.filter((o) => optionalToken.test(o.body)).map((o) => o.id);
    // getOrder has taken an optional token since 0.2 (a guest reads by key, a customer by token)
    expect(withToken.sort()).toEqual(['completeCart', 'createCart', 'getOrder']);
  });

  it('0.5.0 (#270): the typed review shape — null-average rule, author-PII constraint, read-only listing', () => {
    const op = ops.find((o) => o.id === 'listProductReviews')!;
    expect(op).toBeDefined();
    expect(text).toMatch(/\/store\/products\/\{handle\}\/reviews:/);
    for (const schema of ['Review', 'ReviewSummary', 'ReviewPage']) {
      expect(text, schema).toMatch(new RegExp(`^ {4}${schema}:$`, 'm'));
    }
    // average is null when count is 0 — never 0 ("rated zero out of five" is a defamatory bug)
    expect(text).toMatch(/average: \{ type: \[number, 'null'\], minimum: 1, maximum: 5 \}/);
    // the author field carries the manager's PII constraint in its comment
    expect(text).toMatch(/provided or chosen by the customer AT REVIEW TIME/);
    expect(text).toMatch(/review_summary:/);
  });

  it('0.4.0 (#245): recoverCart is a POST, single-use semantics documented, one 404 for all misses', () => {
    const op = ops.find((o) => o.id === 'recoverCart')!;
    expect(op).toBeDefined();
    expect(text).toMatch(/\/store\/cart-recovery\/\{token\}:/);
    expect(op.body).toMatch(/'404':/);
    expect(op.body).toMatch(/'409':/);
    expect(op.body).toMatch(/SAME 404/);
    // POST, never GET: the path block must not define a get
    const pathBlock = text.slice(
      text.indexOf('/store/cart-recovery/{token}:'),
      text.indexOf('/store/orders/{orderId}:'),
    );
    expect(pathBlock).toMatch(/^ {4}post:$/m);
    expect(pathBlock).not.toMatch(/^ {4}get:$/m);
  });

  it('0.3.0: listProducts and getProduct accept an optional ISO-4217 currency query', () => {
    expect(text).toMatch(/version: 0\.5\.4/);
    expect(text).toMatch(/Currency:\n\s+name: currency\n\s+in: query/);
    expect(text).toMatch(/pattern: '\^\[A-Z\]\{3\}\$'/);
    for (const id of ['listProducts', 'getProduct']) {
      const op = ops.find((o) => o.id === id)!;
      expect(op.body, id).toMatch(/\$ref: '#\/components\/parameters\/Currency'/);
      expect(op.body, id).toMatch(/'400': \{ \$ref: '#\/components\/responses\/BadRequest' \}/);
    }
  });

  it('0.5.4 (#354/#358): optional Store.payment.methods (card | invoice), in the getStore example', () => {
    const start = text.indexOf('\n    Store:\n');
    const store = text.slice(start, text.indexOf('\n    Review:\n', start));
    const required = store.slice(0, store.indexOf('\n      properties:'));
    // optional until the core returns it
    expect(required).not.toMatch(/\bpayment\b/);
    expect(store).toMatch(/^ {8}payment:\n {10}type: object\n {10}required: \[methods\]/m);
    expect(store).toMatch(
      /uniqueItems: true\n\s+items: \{ type: string, enum: \[card, invoice\] \}/,
    );
    expect(store).toMatch(/settings\.payment\.invoice_allowed/);
    expect(text).toMatch(/^ {8}payment: \{ methods: \[card, invoice\] \}$/m);
  });
});

describe('admin-api.yaml', () => {
  const text = read('admin-api.yaml');
  const ops = operations(text);

  it('covers the nine areas from the Phase 0 brief plus marketing (0.3.0) and search (0.4.0)', () => {
    expect(text).toMatch(/version: 0\.4\.12/);
    for (const tag of [
      'registry',
      'catalog',
      'pricing',
      'orders',
      'inventory',
      'fulfillment',
      'customers',
      'roles',
      'audit',
      'marketing',
      'search',
    ]) {
      expect(text, tag).toMatch(new RegExp(`tags: \\[[^\\]]*\\b${tag}\\b`));
    }
    expect(ops.length).toBeGreaterThanOrEqual(45);
  });

  it('merchandising (0.4.0, #162): rules CRUD + publish with store_staff reads and store_admin writes', () => {
    const ids = ops.map((o) => o.id);
    const reads = ['listMerchandisingRules', 'getMerchandisingRule'];
    const writes = [
      'createMerchandisingRule',
      'updateMerchandisingRule',
      'deleteMerchandisingRule',
      'publishMerchandisingRules',
    ];
    for (const id of [...reads, ...writes]) expect(ids, id).toContain(id);
    expect(ops.length).toBeGreaterThanOrEqual(93);
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    for (const id of reads) expect(permission(id), id).toEqual(['store_staff', 'store:{storeId}']);
    for (const id of writes) expect(permission(id), id).toEqual(['store_admin', 'store:{storeId}']);
    // `tags:` precedes `operationId:`, so count the search-tagged operations per document
    expect((text.match(/^ {6}tags: \[search\]$/gm) ?? []).length).toBe(
      reads.length + writes.length,
    );
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/merchandising\/rules:/);
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/merchandising\/rules\/\{ruleId\}:/);
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/merchandising\/publish:/);
    for (const schema of [
      'MerchandisingScope',
      'MerchandisingBoost',
      'MerchandisingRuleInput',
      'MerchandisingRulePatch',
      'MerchandisingRule',
    ]) {
      expect(text, schema).toMatch(new RegExp(`^    ${schema}:$`, 'm'));
    }
    // one rule per scope: create documents 409; publish without an index documents 409
    expect(ops.find((o) => o.id === 'createMerchandisingRule')!.body).toMatch(/'409':/);
    expect(ops.find((o) => o.id === 'publishMerchandisingRules')!.body).toMatch(/'409':/);
  });

  it('product media (0.4.1, #168): signed upload params + per-item operations, viewer reads / store_staff writes', () => {
    const ids = ops.map((o) => o.id);
    const reads = ['listProductMedia'];
    const writes = [
      'createMediaUploadParams',
      'addProductMedia',
      'updateProductMedia',
      'deleteProductMedia',
    ];
    for (const id of [...reads, ...writes]) expect(ids, id).toContain(id);
    expect(ops.length).toBeGreaterThanOrEqual(100);
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    for (const id of reads) expect(permission(id), id).toEqual(['viewer', 'store:{storeId}']);
    for (const id of writes) expect(permission(id), id).toEqual(['store_staff', 'store:{storeId}']);
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/media\/upload-params:/);
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/products\/\{productId\}\/media:/);
    expect(text).toMatch(
      /\/admin\/stores\/\{storeId\}\/products\/\{productId\}\/media\/\{mediaId\}:/,
    );
    for (const schema of [
      'MediaUploadRequest',
      'MediaUploadParams',
      'ProductMediaInput',
      'ProductMediaPatch',
      'ProductMedia',
    ]) {
      expect(text, schema).toMatch(new RegExp(`^    ${schema}:$`, 'm'));
    }
    // alt is required per item; the store without credentials answers 409; the secret never appears
    expect(text).toMatch(/ProductMediaInput:\n\s+type: object\n\s+required: \[url, alt\]/);
    expect(ops.find((o) => o.id === 'createMediaUploadParams')!.body).toMatch(/'409':/);
    expect(text).not.toMatch(/api_secret/);
  });

  it('promotions (0.4.1, #189): buy_x_get_y, stackable / exclusive, get + update operations', () => {
    const ids = ops.map((o) => o.id);
    for (const id of ['getPromotion', 'updatePromotion']) expect(ids, id).toContain(id);
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    expect(permission('getPromotion')).toEqual(['viewer', 'store:{storeId}']);
    expect(permission('updatePromotion')).toEqual(['store_admin', 'store:{storeId}']);
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/promotions\/\{promotionId\}:/);
    expect(text).toMatch(/enum: \[percentage, fixed_amount, free_shipping, buy_x_get_y\]/);
    for (const schema of ['PromotionRules', 'PromotionInput', 'PromotionPatch', 'Promotion']) {
      expect(text, schema).toMatch(new RegExp(`^    ${schema}:$`, 'm'));
    }
    const component = (name: string) =>
      text
        .slice(text.indexOf(`\n    ${name}:\n`) + 1)
        .match(/^ {4}\w+:\n[\s\S]*?(?=^ {4}\w+:\n)/m)![0];
    // the patch never carries the immutable code / type; the response always carries the stacking flags
    const patch = component('PromotionPatch');
    expect(patch).not.toMatch(/^\s{8}code:/m);
    expect(patch).not.toMatch(/^\s{8}type: \{/m);
    expect(patch).toMatch(/^\s{8}stackable:/m);
    expect(component('Promotion')).toMatch(/required:\n[\s\S]*stackable,\n\s+exclusive,/);
    for (const rule of ['buy_quantity', 'get_quantity', 'get_discount_bp']) {
      expect(component('PromotionRules'), rule).toMatch(new RegExp(`^\\s{8}${rule}:`, 'm'));
    }
  });

  it('order line-item edits (0.4.2, #172): patch lowers a quantity, delete cancels a line, store_admin only', () => {
    const ids = ops.map((o) => o.id);
    for (const id of ['updateOrderLineItem', 'cancelOrderLineItem']) expect(ids, id).toContain(id);
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    expect(permission('updateOrderLineItem')).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('cancelOrderLineItem')).toEqual(['store_admin', 'store:{storeId}']);
    expect(text).toMatch(
      /\/admin\/stores\/\{storeId\}\/orders\/\{orderId\}\/line-items\/\{lineItemId\}:/,
    );
    const patch = ops.find((o) => o.id === 'updateOrderLineItem')!.body;
    expect(patch).toMatch(/required: \[quantity\]/);
    expect(patch).toMatch(/minimum: 1/);
    // both answer 409 (fulfilment already started / last line) with the standard error body
    for (const id of ['updateOrderLineItem', 'cancelOrderLineItem']) {
      expect(ops.find((o) => o.id === id)!.body, id).toMatch(/'409':/);
    }
  });

  it('abandoned carts (0.4.5, #245): the recovery report next to the other marketing reports', () => {
    const op = ops.find((o) => o.id === 'getAbandonedCartReport')!;
    expect(op).toBeDefined();
    expect(op.body).toMatch(/x-permission: \{ relation: viewer, object: 'store:\{storeId\}'/);
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/marketing\/reports\/abandoned-carts:/);
    expect(text).toMatch(/^ {4}AbandonedCartReport:$/m);
    for (const f of ['abandoned_count', 'redeemed_count', 'recovered_count', 'recovery_rate']) {
      expect(text, f).toMatch(new RegExp(`${f}:`));
    }
  });

  it('customers additions (0.4.7, #264): addresses read at support, export at store_admin, groups at viewer', () => {
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    expect(permission('listCustomerAddresses')).toEqual(['support', 'store:{storeId}']);
    expect(permission('exportCustomer')).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('listCustomerGroups')).toEqual(['viewer', 'store:{storeId}']);
    expect(ops.find((o) => o.id === 'exportCustomer')!.body).toMatch(/'202':/);
  });

  it('registry settings (0.4.7, #279): revoke with last_live_key, domain primary move, enabled sets', () => {
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    expect(permission('revokeApiKey')).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('updateDomain')).toEqual(['owner', 'organization:hq']);
    expect(ops.find((o) => o.id === 'revokeApiKey')!.body).toMatch(/last_live_key/);
    // the Store response now carries the enabled sets, and the machine-code list names the new code
    expect(text).toMatch(/always contains default_currency/);
    expect(text).toMatch(/always contains default_locale/);
    expect(text).toMatch(/conflict, last_live_key, out_of_stock/);
  });

  it('0.4.8 (#279): Store.currencies and Store.locales are required now that the core returns them', () => {
    const start = text.indexOf('\n    Store:\n');
    const required = text.slice(start, text.indexOf('\n      properties:', start));
    expect(required).toMatch(/\n\s+currencies,\n\s+locales,\n\s+\]/);
    // a malformed key id is a 400, not an undocumented answer
    expect(ops.find((o) => o.id === 'revokeApiKey')!.body).toContain(`'400':`);
  });

  it('segment rules (0.4.4, #239): frozen closed grammar, no flat-shape leftovers', () => {
    const component = (name: string) =>
      text
        .slice(text.indexOf(`\n    ${name}:\n`) + 1)
        .match(/^ {4}\w+:\n[\s\S]*?(?=^ {4}\w+:\n)/m)![0];
    const rules = component('SegmentRules');
    expect(rules).toMatch(/additionalProperties: false/);
    expect(rules).toMatch(/required: \[v, all\]/);
    expect(rules).not.toMatch(/additionalProperties: true/);
    expect(text).toMatch(/^ {4}SegmentPredicate:$/m);
    // the old flat bag is gone everywhere: no rules example carries a bare field key
    expect(text).not.toMatch(/rules:\n\s+total_spent_minor:/);
    // every predicate branch is closed and the country branch names the default-shipping rule
    const predicate = component('SegmentPredicate');
    expect((predicate.match(/additionalProperties: false/g) ?? []).length).toBe(6);
    expect(predicate).toMatch(/DEFAULT SHIPPING address only/);
  });

  it('pick/pack (0.4.3, #225): pick, pack and pick-lists operations, operations-on-hq, widened status enum', () => {
    const ids = ops.map((o) => o.id);
    for (const id of ['pickShipment', 'packShipment', 'listPickLists'])
      expect(ids, id).toContain(id);
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    for (const id of ['pickShipment', 'packShipment', 'listPickLists']) {
      expect(permission(id), id).toEqual(['operations', 'organization:hq']);
    }
    expect(text).toMatch(/\/admin\/shipments\/\{shipmentId\}\/pick:/);
    expect(text).toMatch(/\/admin\/shipments\/\{shipmentId\}\/pack:/);
    expect(text).toMatch(/\/admin\/stores\/\{storeId\}\/pick-lists:/);
    // the response enum carries the two new states; pick/pack answer 409 on an illegal transition
    expect(text).toMatch(/pending,\n\s+picking,\n\s+packed,\n\s+label_created,/);
    for (const id of ['pickShipment', 'packShipment']) {
      expect(ops.find((o) => o.id === id)!.body, id).toMatch(/'409':/);
    }
  });

  it('0.4.9 (#354): capturePayment and buyShipmentLabel — permissions, 200/409/422, honest examples', () => {
    const op = (id: string) => ops.find((o) => o.id === id)!;
    const permission = (id: string) =>
      op(id)
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    const component = (name: string) =>
      text
        .slice(text.indexOf(`\n    ${name}:\n`) + 1)
        .match(/^ {4}\w+:\n[\s\S]*?(?=^ {4}\w+:\n|^ {2}\w+:\n|(?![\s\S]))/m)![0];
    for (const id of ['capturePayment', 'buyShipmentLabel']) expect(op(id), id).toBeDefined();
    expect(text).toMatch(
      /\/admin\/stores\/\{storeId\}\/orders\/\{orderId\}\/payments\/\{paymentId\}\/capture:/,
    );
    expect(text).toMatch(/\/admin\/shipments\/\{shipmentId\}\/label:/);
    expect(permission('capturePayment')).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('buyShipmentLabel')).toEqual(['operations', 'organization:hq']);
    for (const id of ['capturePayment', 'buyShipmentLabel']) {
      for (const code of ['200', '401', '403', '404', '409', '422']) {
        expect(op(id).body, `${id} ${code}`).toMatch(new RegExp(`'${code}':`));
      }
      expect(op(id).body, id).toMatch(
        /'422': \{ \$ref: '#\/components\/responses\/Unprocessable' \}/,
      );
    }
    // capture: optional body, partial amount at least 1, answers the Payment
    const capture = op('capturePayment').body;
    expect(capture).toMatch(/requestBody:\n\s+required: false/);
    expect(capture).toMatch(/amount_minor:\n\s+\{\n\s+type: integer,\n\s+minimum: 1,/);
    expect(capture).toMatch(/schema: \{ \$ref: '#\/components\/schemas\/Payment' \}/);
    // path parameters sit above operationId, so look at the whole document
    expect(text).toMatch(/- \{ \$ref: '#\/components\/parameters\/PaymentId' \}/);
    expect(text).toMatch(/^ {4}PaymentId:\n {6}name: paymentId\n {6}in: path/m);
    // label: no body, answers the Shipment
    const label = op('buyShipmentLabel').body;
    expect(label).not.toMatch(/requestBody:/);
    expect(label).toMatch(/schema: \{ \$ref: '#\/components\/schemas\/Shipment' \}/);
    // the examples are honest: captured payment, label_created shipment with label + tracking set
    const payment = component('PaymentCaptured');
    expect(payment).toMatch(/status: captured\n/);
    expect(payment).not.toMatch(/captured_at: null/);
    const shipment = component('ShipmentLabelCreated');
    expect(shipment).toMatch(/status: label_created\n/);
    for (const f of ['label_url', 'tracking_number', 'tracking_url']) {
      expect(shipment, f).toMatch(new RegExp(`${f}: \\S`));
      expect(shipment, f).not.toMatch(new RegExp(`${f}: null`));
    }
    // the shared 422 and its machine code
    expect(component('Unprocessable')).toMatch(/code: provider_unsupported/);
    expect(text).toMatch(/payment_failed, provider_unsupported, internal/);
  });

  it('0.4.9 (#350): the Order status enum is the documented five-state lifecycle', () => {
    expect(text).toMatch(
      /status:\n\s+\{\n\s+type: string,\n\s+enum: \[pending, confirmed, processing, completed, cancelled\],/,
    );
    const order = text.slice(
      text.indexOf('\n    Order:\n'),
      text.indexOf('\n    InventoryLevel:\n'),
    );
    for (const s of ['pending', 'confirmed', 'processing', 'completed', 'cancelled']) {
      expect(order, s).toMatch(new RegExp(`- \`${s}\` — `));
    }
    for (const e of ['order.confirmed', 'order.updated', 'order.completed', 'cancelOrder']) {
      expect(order, e).toContain(e);
    }
    // a manual-carrier shipment can reach delivered (so an order can reach completed) without a db edit
    expect(text).toMatch(
      /enum: \[label_created, shipped, in_transit, delivered, failed, cancelled\]/,
    );
    expect(ops.find((o) => o.id === 'updateShipment')).toBeDefined();
  });

  it('feeds (0.4.1, #194): ProductFeed is spelled out, so status=error validates; the input cannot claim it', () => {
    const component = (name: string) =>
      text
        .slice(text.indexOf(`\n    ${name}:\n`) + 1)
        .match(/^ {4}\w+:\n[\s\S]*?(?=^ {4}\w+:\n)/m)![0];
    const feed = component('ProductFeed');
    expect(feed).not.toMatch(/^\s+allOf:/m);
    expect(feed).toMatch(/status: \{ type: string, enum: \[draft, active, paused, error\] \}/);
    expect(component('ProductFeedInput')).toMatch(/enum: \[draft, active, paused\],/);
    expect(text).toMatch(/^ {4}FeedGoogleError:$/m);
  });

  it('no allOf[XInput, …] component overrides a property its input branch already defines (#194 sweep)', () => {
    // Under allOf a value must satisfy every branch, so redefining a property (a wider enum, another type)
    // can only ever narrow it. Composition may add properties and required fields, never restate them.
    const componentsText = text.slice(text.indexOf('\ncomponents:\n'));
    const blocks = [
      ...componentsText.matchAll(/^ {4}(\w+):\n([\s\S]*?)(?=^ {4}\w+:\n|^ {2}\w+:\n|(?![\s\S]))/gm),
    ];
    const props = (body: string, indent: number) =>
      [...body.matchAll(new RegExp(`^ {${indent}}(\\w+):`, 'gm'))].map((m) => m[1]!);
    const byName = new Map(blocks.map((b) => [b[1]!, b[2]!]));
    let composed = 0;
    for (const [name, body] of byName) {
      if (!/^ {6}allOf:/m.test(body)) continue;
      for (const ref of body.matchAll(/^ {8}- \$ref: '#\/components\/schemas\/(\w+)'$/gm)) {
        const base = byName.get(ref[1]!);
        if (!base) continue;
        composed++;
        const inherited = new Set(props(base, 8));
        for (const own of props(body, 12)) {
          expect(inherited.has(own), `${name} restates ${own} from ${ref[1]}`).toBe(false);
        }
      }
    }
    expect(composed).toBeGreaterThanOrEqual(6); // PriceList, Promotion, Order, Campaign, Segment, ReferralProgram
  });

  it('every admin operation documents 401 and 403 (#180; getMe has no permission, so 401 only)', () => {
    for (const o of ops) {
      expect(o.body, `${o.id} lacks 401`).toMatch(
        /'401': \{ \$ref: '#\/components\/responses\/Unauthorized' \}/,
      );
      if (o.id === 'getMe') continue;
      expect(o.body, `${o.id} lacks 403`).toMatch(
        /'403': \{ \$ref: '#\/components\/responses\/Forbidden' \}/,
      );
    }
  });

  it('marketing (0.3.0): every path from docs/marketing-scope.md exists with the agreed permissions', () => {
    const ids = ops.map((o) => o.id);
    for (const id of [
      'listCampaigns',
      'createCampaign',
      'getCampaign',
      'updateCampaign',
      'deleteCampaign',
      'launchCampaign',
      'endCampaign',
      'listSegments',
      'createSegment',
      'getSegment',
      'updateSegment',
      'deleteSegment',
      'previewSegment',
      'materializeSegment',
      'listFeeds',
      'createFeed',
      'getFeed',
      'updateFeed',
      'deleteFeed',
      'publishFeed',
      'listFeedItems',
      'listReferralPrograms',
      'createReferralProgram',
      'getReferralProgram',
      'updateReferralProgram',
      'deleteReferralProgram',
      'listReferrals',
      'listReviews',
      'moderateReview',
      'getAttributionReport',
      'getPromotionReport',
      'getMarketingDashboard',
      'listSegmentTemplates',
      'createSegmentTemplate',
      'getSegmentTemplate',
      'updateSegmentTemplate',
      'deleteSegmentTemplate',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(ops.length).toBeGreaterThanOrEqual(87);
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!;
    // reads: store_staff; writes, launch and publish: store_admin; reports: any relation (analyst included)
    expect(permission('listCampaigns').slice(1)).toEqual(['store_staff', 'store:{storeId}']);
    expect(permission('createCampaign').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('launchCampaign').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('publishFeed').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('moderateReview').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('previewSegment').slice(1)).toEqual(['store_staff', 'store:{storeId}']);
    expect(permission('getAttributionReport').slice(1)).toEqual(['viewer', 'store:{storeId}']);
    expect(permission('getPromotionReport').slice(1)).toEqual(['viewer', 'store:{storeId}']);
    expect(permission('getMarketingDashboard').slice(1)).toEqual(['analyst', 'organization:hq']);
    expect(permission('createSegmentTemplate').slice(1)).toEqual(['owner', 'organization:hq']);
    expect(permission('deleteSegmentTemplate').slice(1)).toEqual(['owner', 'organization:hq']);
    // the review text never leaves the API in an event, and the report money is always Money
    expect(text).toMatch(/AttributionReport:/);
    expect(text).toMatch(/PromotionReport:/);
    expect(text).toMatch(/MarketingDashboard:/);
  });

  it('every operation except getMe declares x-permission with a known relation', () => {
    for (const o of ops) {
      if (o.id === 'getMe') continue;
      const m = o.body.match(/x-permission:\s*\{\s*relation:\s*(\w+),\s*object:\s*'([^']+)'/);
      expect(m, `${o.id} lacks x-permission`).not.toBeNull();
      const relation = m![1]!;
      expect([...RELATIONS, 'viewer'], `${o.id}: ${relation}`).toContain(relation);
      expect(m![2], o.id).toMatch(
        /^(organization:hq|store:\{storeId\}|store:\{store_id\}|store:\*)$/,
      );
    }
  });

  it('finance-only surfaces are gated on organization:hq (a store admin can never satisfy them)', () => {
    const le = ops.find((o) => o.id === 'listLegalEntities')!;
    expect(le.body).toMatch(/relation: finance, object: 'organization:hq'/);
  });

  it('money is always { amount_minor, currency }, never a float', () => {
    // recovery_rate (0.4.5, #245) is the one sanctioned `type: number`: a dimensionless 0..1 ratio,
    // not money. Everything else stays integer minor units.
    const withoutRatio = text.replace(/recovery_rate: \{ type: number[^}]*\}/, '');
    expect(withoutRatio).not.toMatch(/type: number/);
    expect(withoutRatio).toMatch(/amount_minor: \{ type: integer/);
  });
});
