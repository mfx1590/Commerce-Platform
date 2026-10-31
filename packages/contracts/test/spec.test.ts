// Static checks on the OpenAPI documents (text-level; js-yaml only for the flow-mapping guard at the end). Runtime checks live in contract.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, RELATIONS } from '../src/index.js';

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
    expect(text).toMatch(/version: 0\.5\.9/);
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

describe('store-api.yaml customer self-service (0.5.6, #482)', () => {
  const text = read('store-api.yaml');
  const ops = operations(text);
  const body = (id: string) => ops.find((o) => o.id === id)!.body;
  const block = (path: string, next: string) =>
    text.slice(text.indexOf(`\n  ${path}:\n`), text.indexOf(`\n  ${next}:\n`));

  it('the four operations exist on the right paths with the right methods', () => {
    expect(ops.length).toBe(31); // 26 at 0.5.6; +getMyConsents / putMyConsents at 0.5.7 (#489); +listMyExports / getMyExport at 0.5.8 (#498); +listProductRecommendations at 0.5.9 (#607)
    const me = block('/store/customers/me', '/store/customers/me/addresses');
    expect(me).toMatch(/^ {4}delete:\n {6}tags: \[customers\]\n {6}operationId: deleteMe$/m);
    const one = block('/store/customers/me/addresses/{addressId}', '/store/customers/me/export');
    expect(one).toMatch(/parameters:\n\s+- \{ \$ref: '#\/components\/parameters\/AddressId' \}/);
    expect(one).toMatch(/^ {4}patch:\n {6}tags: \[customers\]\n {6}operationId: updateMyAddress$/m);
    expect(one).toMatch(
      /^ {4}delete:\n {6}tags: \[customers\]\n {6}operationId: deleteMyAddress$/m,
    );
    const exp = block('/store/customers/me/export', '/store/customers/me/exports');
    expect(exp).toMatch(/^ {4}post:\n {6}tags: \[customers\]\n {6}operationId: requestMyExport$/m);
    expect(exp).not.toMatch(/^ {4}(get|patch|delete):$/m);
    expect(text).toMatch(/AddressId:\n\s+name: addressId\n\s+in: path\n\s+required: true/);
  });

  it('publishable key + customer token, 401 and the resolve-or-provision 409 on each', () => {
    const required =
      /security:\n\s+- publishableKey: \[\]\n\s+customerToken: \[\]\n\s+(responses|requestBody):/;
    for (const id of ['updateMyAddress', 'deleteMyAddress', 'requestMyExport', 'deleteMe']) {
      expect(body(id), id).toMatch(required);
      expect(body(id), `${id} 401`).toContain(`'401':`);
      expect(body(id), `${id} 409`).toMatch(/'409':[\s\S]*code: conflict/);
    }
    for (const id of ['updateMyAddress', 'deleteMyAddress']) {
      expect(body(id), `${id} 404`).toContain(`'404':`);
    }
    expect(body('updateMyAddress')).toContain(`'400':`);
  });

  it('updateMyAddress is a partial PATCH answering the address; deleteMyAddress answers 200 { items }, never 204', () => {
    const update = body('updateMyAddress');
    expect(update).toMatch(/'200':[\s\S]*\$ref: '#\/components\/schemas\/CustomerAddress'/);
    expect(update).not.toMatch(/^\s+required: \[/m);
    for (const f of ['company', 'line2', 'region', 'phone']) {
      expect(update, f).toMatch(new RegExp(`${f}: \\{ type: \\[string, 'null'\\] \\}`));
    }
    const del = body('deleteMyAddress');
    expect(del).toMatch(/'200':[\s\S]*required: \[items\][\s\S]*example:\n\s+items:/);
    expect(del).not.toContain(`'204'`);
    expect(text).not.toMatch(/'204':/);
    for (const id of ['requestMyExport', 'deleteMe']) {
      expect(body(id), id).toMatch(/'202': \{ description: /);
    }
  });
});

describe('admin-api.yaml', () => {
  const text = read('admin-api.yaml');
  const ops = operations(text);

  it('covers the nine areas from the Phase 0 brief plus marketing (0.3.0) and search (0.4.0)', () => {
    expect(text).toMatch(/version: 0\.4\.26/);
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
      'reports',
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

  it('stock pool (0.4.13, #453): listStockItems at viewer and mapVariantToStockItem at operations, both on hq; InventoryLevel requires stock_item_id', () => {
    const op = (id: string) => ops.find((o) => o.id === id);
    const permission = (id: string) =>
      op(id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    expect(op('listStockItems'), 'listStockItems').toBeDefined();
    expect(op('mapVariantToStockItem'), 'mapVariantToStockItem').toBeDefined();
    expect(permission('listStockItems')).toEqual(['viewer', 'organization:hq']);
    expect(permission('mapVariantToStockItem')).toEqual(['operations', 'organization:hq']);
    for (const id of ['listStockItems', 'mapVariantToStockItem']) {
      expect(op(id)!.body, `${id} lacks 401`).toMatch(
        /'401': \{ \$ref: '#\/components\/responses\/Unauthorized' \}/,
      );
      expect(op(id)!.body, `${id} lacks 403`).toMatch(
        /'403': \{ \$ref: '#\/components\/responses\/Forbidden' \}/,
      );
    }
    expect(text).toMatch(/\n {2}\/admin\/stock-items:\n/);
    expect(text).toMatch(/\n {2}\/admin\/stock-items\/\{stockItemId\}\/variants\/\{variantId\}:\n/);
    // the mapping is a state change: it names its outbox event, and refuses with 409 instead of merging quantities
    expect(op('mapVariantToStockItem')!.body).toMatch(/`stock_item\.mapped` v1 outbox event/);
    expect(op('mapVariantToStockItem')!.body).toMatch(/'409':/);
    // InventoryLevel: one row per variant and warehouse carrying the pool's numbers, with the item it maps
    const start = text.indexOf('\n    InventoryLevel:\n');
    expect(start).toBeGreaterThan(0);
    const required = text.slice(
      text.indexOf('\n      required:', start),
      text.indexOf('\n      properties:', start),
    );
    expect(required).toMatch(/\n\s+variant_id,\n\s+stock_item_id,\n\s+sku,/);
    expect(text.slice(start, start + 2000)).toMatch(
      /stock_item_id: \{ type: string, format: uuid \}/,
    );
    expect(text).toMatch(/\n {4}StockItem:\n/);
    expect(text).toMatch(/\n {4}StockLevel:\n/);
  });

  it('cycle counts (0.4.14, #458): list / create / reconcile at operations on hq; superseded is a 409 conflict with details.reason, no new error code', () => {
    const op = (id: string) => ops.find((o) => o.id === id);
    const permission = (id: string) =>
      op(id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
        .slice(1);
    expect(ops.length).toBeGreaterThanOrEqual(120);
    for (const id of ['listCycleCounts', 'createCycleCount', 'reconcileCycleCount']) {
      expect(op(id), id).toBeDefined();
      expect(permission(id), id).toEqual(['operations', 'organization:hq']);
      expect(op(id)!.body, `${id} lacks 401`).toMatch(
        /'401': \{ \$ref: '#\/components\/responses\/Unauthorized' \}/,
      );
      expect(op(id)!.body, `${id} lacks 403`).toMatch(
        /'403': \{ \$ref: '#\/components\/responses\/Forbidden' \}/,
      );
      // the mock answers from the example: each success response carries one
      expect(op(id)!.body, `${id} lacks an example`).toMatch(/\n {14}example:\n/);
    }
    expect(text).toMatch(/\n {2}\/admin\/cycle-counts:\n/);
    expect(text).toMatch(/\n {2}\/admin\/cycle-counts\/\{cycleCountId\}\/reconcile:\n/);
    // a count is never deleted, and nothing but reconcile changes one
    const start = text.indexOf('\n  /admin/cycle-counts:\n');
    const block = text.slice(start, text.indexOf('\n  # ----', start + 1));
    expect(block).not.toMatch(/\n {4}(delete|patch|put):\n/);

    const create = op('createCycleCount')!.body;
    expect(create).toMatch(/'201':/);
    expect(create).toMatch(/required: \[warehouse_id, stock_item_id, counted_quantity\]/);
    expect(create).toMatch(/counted_quantity: \{ type: integer, minimum: 0 \}/);
    // the decision on #458: superseded and a future counted_at reuse the closed list of codes
    expect(create).toMatch(/'409':[\s\S]*code: conflict,[\s\S]*reason: superseded,/);
    expect(create).toMatch(/applied_cycle_count_id: /);
    expect(create).toMatch(
      /'422':[\s\S]*code: validation_error,[\s\S]*details: \{ field: counted_at \}/,
    );
    expect(text).not.toMatch(/code: superseded/);
    const codes = text.match(/description: '(validation_error, [^']+)'/)?.[1] ?? '';
    expect(codes).toMatch(/\bconflict\b/);
    expect(codes).not.toMatch(/superseded/);

    const reconcile = op('reconcileCycleCount')!.body;
    expect(reconcile).toMatch(/approve: \{ type: boolean, default: false \}/);
    expect(reconcile).toMatch(/'200':/);
    expect(reconcile).toMatch(/'404':/);
    expect(reconcile).toMatch(/'409':/);
    // a flagged result is a 200, not an error
    expect(reconcile).toMatch(/status `flagged`, 200/);

    const schema = text.indexOf('\n    CycleCount:\n');
    expect(schema).toBeGreaterThan(text.indexOf('\n    InventoryLevel:\n'));
    const body = text.slice(schema, text.indexOf('\n    ShippingOptionInput:\n', schema));
    expect(body).toMatch(/status: \{ type: string, enum: \[recorded, flagged, applied\] \}/);
    expect(body).toMatch(/source: \{ type: string, enum: \[manual, wms\] \}/);
    expect(body).toMatch(/counted_by: \{ type: \[string, 'null'\], format: uuid/);
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
    expect(text).toMatch(/payment_failed, provider_unsupported, unavailable, expired, internal/); // expired: 0.4.23 (#498); unavailable: 0.4.30 (#603)
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

describe('payment_status voided (contracts 0.4.17, #466)', () => {
  it('both specs list voided in every payment_status enum, after the six existing values', () => {
    for (const file of ['admin-api.yaml', 'store-api.yaml']) {
      const enums = [
        ...read(file).matchAll(/\bpayment_status:\s*\{[^}]*?enum:\s*\[([^\]]*)\]/g),
      ].map((m) => m[1]!.split(',').map((v) => v.trim()));
      expect(enums.length, file).toBeGreaterThanOrEqual(1);
      for (const values of enums) {
        expect(values, file).toEqual([
          'awaiting',
          'authorized',
          'captured',
          'partially_refunded',
          'refunded',
          'failed',
          'voided',
        ]);
      }
    }
  });
});

describe('stock pool reads (contracts 0.4.18, Admin API 0.4.16, #469)', () => {
  const text = read('admin-api.yaml');
  const ops = operations(text);
  const op = (id: string) => ops.find((o) => o.id === id);
  const permission = (id: string) =>
    op(id)!
      .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
      .slice(1);

  it('listStockItemMovements / listStockItemReservations at viewer and previewCycleCountReconcile at operations, all on hq', () => {
    expect(ops.length).toBeGreaterThanOrEqual(123);
    const expected: Record<string, [string, string]> = {
      listStockItemMovements: ['viewer', 'organization:hq'],
      listStockItemReservations: ['viewer', 'organization:hq'],
      previewCycleCountReconcile: ['operations', 'organization:hq'],
    };
    for (const [id, perm] of Object.entries(expected)) {
      expect(op(id), id).toBeDefined();
      expect(permission(id), id).toEqual(perm);
      for (const code of ['200', '401', '403', '404']) {
        expect(op(id)!.body, `${id} lacks ${code}`).toContain(`'${code}':`);
      }
      // the mock answers from the example: each success response carries one
      expect(op(id)!.body, `${id} lacks an example`).toMatch(/\n {14}example:\n/);
    }
    expect(text).toMatch(
      /\n {2}\/admin\/stock-items\/\{stockItemId\}\/movements:\n {4}parameters:[\s\S]*?\n {4}get:\n/,
    );
    expect(text).toMatch(
      /\n {2}\/admin\/stock-items\/\{stockItemId\}\/reservations:\n {4}parameters:[\s\S]*?\n {4}get:\n/,
    );
    // the preview is a safe GET: a lost body can never turn it into a reconcile
    expect(text).toMatch(
      /\n {2}\/admin\/cycle-counts\/\{cycleCountId\}\/reconcile-preview:\n {4}parameters:[\s\S]*?\n {4}get:\n {6}tags: \[inventory\]\n {6}operationId: previewCycleCountReconcile\n/,
    );
    expect(op('previewCycleCountReconcile')!.body).not.toMatch(/requestBody:/);
    expect(op('previewCycleCountReconcile')!.body).toMatch(/takes no lock/);
    expect(op('previewCycleCountReconcile')!.body).toMatch(/'409':/);
    expect(op('listStockItemReservations')!.body).toMatch(
      /enum: \[open, released, all\], default: open/,
    );
  });

  it('StockMovement, StockReservation and CycleCountPreview are components with every property required', () => {
    for (const name of ['StockMovement', 'StockReservation', 'CycleCountPreview']) {
      expect(text, name).toMatch(new RegExp(`\\n {4}${name}:\\n {6}type: object\\n`));
    }
    const schema = (name: string) => {
      const start = text.indexOf(`\n    ${name}:\n`);
      const next = text.slice(start + 1).search(/\n {4}\w+:\n/);
      return text.slice(start, start + 1 + next);
    };
    expect(schema('StockMovement')).toMatch(
      /enum: \[receipt, sale, return, adjustment, transfer_in, transfer_out, cycle_count\]/,
    );
    expect(schema('StockMovement')).toMatch(/store_id:\s*\{\s*type: \[string, 'null'\]/);
    // allocation_rule is a free string (split:<rule>), not an enum
    expect(schema('StockReservation')).toMatch(
      /allocation_rule:\n\s+type: \[string, 'null'\]\n\s+description:/,
    );
    expect(schema('StockReservation')).toMatch(/quantity: \{ type: integer, minimum: 1 \}/);
    expect(schema('CycleCountPreview')).toMatch(
      /would_status: \{ type: string, enum: \[applied, flagged\] \}/,
    );
  });
});

describe('InventoryLevel.warehouse_code (contracts 0.4.19, Admin API 0.4.17, #475)', () => {
  const text = read('admin-api.yaml');

  it('InventoryLevel requires a read-only warehouse_code, and every InventoryLevel example carries it', () => {
    const start = text.indexOf('\n    InventoryLevel:\n');
    expect(start).toBeGreaterThan(0);
    const next = text.slice(start + 1).search(/\n {4}\w+:\n/);
    const schema = text.slice(start, start + 1 + next);
    const required = schema.slice(
      schema.indexOf('\n      required:'),
      schema.indexOf('\n      properties:'),
    );
    expect(required).toMatch(/\n\s+warehouse_id,\n\s+warehouse_code,\n\s+on_hand,/);
    expect(schema).toMatch(
      /\n {8}warehouse_code:\n {10}type: string\n {10}readOnly: true\n {10}description: /,
    );
    // the two operations answering an InventoryLevel: their examples validate (the mock answers from them)
    const ops = operations(text);
    for (const id of ['listInventoryLevels', 'createStockMovement']) {
      const body = ops.find((o) => o.id === id)!.body;
      expect(body, id).toContain("$ref: '#/components/schemas/InventoryLevel'");
      expect(body, id).toMatch(/warehouse_code: wh-eu,/);
    }
    expect(text.split("$ref: '#/components/schemas/InventoryLevel'").length - 1).toBe(2);
  });
});

describe('customer consent ledger (contracts 0.4.21, Store API 0.5.7, Admin API 0.4.18, #489)', () => {
  const store = read('store-api.yaml');
  const admin = read('admin-api.yaml');
  const storeOps = operations(store);
  const adminOps = operations(admin);
  const sbody = (id: string) => storeOps.find((o) => o.id === id)!.body;

  it('getMyConsents / putMyConsents on /store/customers/me/consents, customer-token secured, with the /me 409', () => {
    expect(storeOps.length).toBe(31); // +listMyExports / getMyExport at 0.5.8 (#498); +listProductRecommendations at 0.5.9 (#607)
    const start = store.indexOf('\n  /store/customers/me/consents:\n');
    expect(start).toBeGreaterThan(0);
    const path = store.slice(start, store.indexOf('\n  /store/customers/me/export:\n'));
    expect(path).toMatch(/^ {4}get:\n {6}tags: \[customers\]\n {6}operationId: getMyConsents$/m);
    expect(path).toMatch(/^ {4}put:\n {6}tags: \[customers\]\n {6}operationId: putMyConsents$/m);
    for (const id of ['getMyConsents', 'putMyConsents']) {
      expect(sbody(id), id).toMatch(/security:\n\s+- publishableKey: \[\]\n\s+customerToken: \[\]/);
      expect(sbody(id), id).toContain("$ref: '#/components/schemas/CustomerConsents'");
      expect(sbody(id), id).toMatch(/'401': \{ \$ref: '#\/components\/responses\/Unauthorized' \}/);
      expect(sbody(id), id).toMatch(/'409':[\s\S]*code: conflict/);
      expect(sbody(id), id).toMatch(/'200':[\s\S]*example:/);
    }
    const put = sbody('putMyConsents');
    expect(put).toMatch(/required: \[policy_version, consents\]/);
    expect(put).toMatch(/policy_version: \{ type: string, minLength: 1 \}/);
    expect(put).toMatch(/minItems: 1/);
    expect(put).toMatch(/'400': \{ \$ref: '#\/components\/responses\/BadRequest' \}/);
    // updateMe's one-checkbox shortcut is unchanged in shape and says it writes the ledger
    expect(sbody('updateMe')).toMatch(/marketing_consent: \{ type: boolean \}/);
    expect(sbody('updateMe')).toMatch(/consent ledger/);
  });

  it('CustomerConsent: granted true | false | null (null = never asked), the closed purpose set', () => {
    const start = store.indexOf('\n    CustomerConsent:\n');
    expect(start).toBeGreaterThan(0);
    const schema = store.slice(start, store.indexOf('\n    CustomerConsents:\n'));
    expect(schema).toMatch(/required: \[purpose, granted, source, policy_version, recorded_at\]/);
    expect(schema).toMatch(/purpose: \{ type: string, enum: \[marketing_email\] \}/);
    expect(schema).toMatch(/granted:\n {10}type: \[boolean, 'null'\]/);
    expect(schema).toMatch(/enum: \[storefront, admin, import, null\]/);
  });

  it('listCustomerConsents: store-scoped, support, documents 400/401/403/404, ledger rows are never null', () => {
    expect(admin).toMatch(
      /\n {2}\/admin\/stores\/\{storeId\}\/customers\/\{customerId\}\/consents:\n/,
    );
    const op = adminOps.find((o) => o.id === 'listCustomerConsents')!;
    expect(op).toBeDefined();
    expect(op.body).toMatch(/x-permission: \{ relation: support, object: 'store:\{storeId\}' \}/);
    for (const code of ['400', '401', '403', '404']) expect(op.body, code).toContain(`'${code}':`);
    expect(op.body).toMatch(
      /required: \[id, purpose, granted, source, policy_version, recorded_at\]/,
    );
    expect(op.body).toMatch(/granted: \{ type: boolean \}/);
    expect(op.body).not.toMatch(/'null'/);
    expect(op.body).toMatch(/name: purpose,\s+in: query,\s+required: false/);
  });
});

describe('report operations (contracts 0.4.22, Admin API 0.4.19, #493)', () => {
  const text = read('admin-api.yaml');
  const ops = operations(text);
  const op = (id: string) => ops.find((o) => o.id === id);
  const permission = (id: string) =>
    op(id)!
      .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
      .slice(1);

  it('the four reads exist under the reports tag with their x-permission, responses and examples', () => {
    expect(text).toMatch(/\n {2}- name: search\n {2}- name: reports\n/);
    expect(ops.length).toBe(138); // +draftProductCopy at 0.4.26 (#664); 128 at 0.4.19; +listCustomerExports / getCustomerExport at 0.4.20 (#498); +getCustomerIdentity at 0.4.21 (#504); +4 tax-rate operations at 0.4.23 (#522); +listMetrics / queryMetrics at 0.4.25 (#603)
    const expected: Record<string, { path: string; perm: [string, string]; codes: string[] }> = {
      getStoreSalesReport: {
        path: '/admin/stores/{storeId}/reports/sales',
        perm: ['viewer', 'store:{storeId}'],
        codes: ['200', '400', '401', '403', '404'],
      },
      getStoreStockReport: {
        path: '/admin/stores/{storeId}/reports/stock',
        perm: ['viewer', 'store:{storeId}'],
        codes: ['200', '400', '401', '403', '404'],
      },
      getHqSalesReport: {
        path: '/admin/hq/reports/sales',
        perm: ['analyst', 'organization:hq'],
        codes: ['200', '400', '401', '403'],
      },
      getHqFinanceReport: {
        path: '/admin/hq/reports/finance',
        perm: ['finance', 'organization:hq'],
        codes: ['200', '400', '401', '403'],
      },
    };
    for (const [id, { path, perm, codes }] of Object.entries(expected)) {
      expect(op(id), id).toBeDefined();
      expect(permission(id), id).toEqual(perm);
      const start = text.indexOf(`\n  ${path}:\n`);
      expect(start, path).toBeGreaterThan(0);
      const block = text.slice(start, text.indexOf(`operationId: ${id}\n`, start));
      expect(block, path).toMatch(/\n {4}get:\n {6}tags: \[reports\]\n {6}$/);
      for (const code of codes) expect(op(id)!.body, `${id} lacks ${code}`).toContain(`'${code}':`);
      // the mock answers from the example: each success response carries one
      expect(op(id)!.body, `${id} lacks an example`).toMatch(/\n {14}example:\n/);
      expect(op(id)!.body, id).not.toMatch(/requestBody:/);
    }
    for (const id of ['getStoreSalesReport', 'getHqSalesReport', 'getHqFinanceReport']) {
      for (const p of ['ReportFrom', 'ReportTo', 'ReportCurrency']) {
        expect(op(id)!.body, `${id} ${p}`).toContain(`$ref: '#/components/parameters/${p}'`);
      }
    }
  });

  it('the report components exist, fees are unreconciled, and every $ref resolves', () => {
    expect(text).toMatch(/\n {4}ReportFrom:\n {6}name: from\n {6}in: query\n {6}required: true\n/);
    expect(text).toMatch(/\n {4}ReportTo:\n {6}name: to\n {6}in: query\n {6}required: true\n/);
    expect(text).toMatch(
      /\n {4}ReportCurrency:\n {6}name: currency\n {6}in: query\n {6}required: false\n/,
    );
    for (const name of [
      'SalesFigures',
      'SalesReport',
      'StockPosition',
      'StockReport',
      'FinanceFigures',
      'FinanceReport',
    ]) {
      expect(text, name).toMatch(new RegExp(`\\n {4}${name}:\\n`));
    }
    expect(text).toMatch(/fees_reconciled: \{ type: boolean, const: false \}/);
    for (const m of text.matchAll(/\$ref: '#\/components\/(\w+)\/(\w+)'/g)) {
      const section = text.indexOf(`\n  ${m[1]}:\n`);
      expect(section, m[1]).toBeGreaterThan(0);
      expect(text.indexOf(`\n    ${m[2]}:\n`, section), `${m[1]}/${m[2]}`).toBeGreaterThan(section);
    }
  });
});

describe('customer exports (contracts 0.4.23, Store API 0.5.8, Admin API 0.4.20, #498)', () => {
  const store = read('store-api.yaml');
  const admin = read('admin-api.yaml');
  const storeOps = operations(store);
  const adminOps = operations(admin);
  const sbody = (id: string) => storeOps.find((o) => o.id === id)!.body;
  const abody = (id: string) => adminOps.find((o) => o.id === id)!.body;
  const permission = (id: string) =>
    abody(id)
      .match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
      .slice(1);

  it('versions, and the closed error list gains expired with a shared 410 Gone in both specs', () => {
    expect(store).toMatch(/^ {2}version: 0\.5\.9$/m);
    expect(ERROR_CODES).toContain('expired');
    for (const [name, text] of [
      ['store', store],
      ['admin', admin],
    ] as const) {
      expect(text, name).toMatch(
        /description: '[^']*\bconflict\b[^']*, expired, internal(, ai_[a-z_]+)*'/,
      );
      const start = text.indexOf('\n    Gone:\n');
      expect(start, name).toBeGreaterThan(text.indexOf('\n  responses:\n'));
      const gone = text.slice(start, text.indexOf('\n  schemas:\n', start));
      expect(gone, name).toContain("schema: { $ref: '#/components/schemas/Error' }");
      expect(gone, name).toMatch(/code: expired,/);
      expect(gone, name).toMatch(/details: \{ expires_at: '[^']+' \}/);
      // the summary component exists in both
      expect(text, name).toMatch(
        /\n {4}CustomerExportSummary:\n {6}type: object\n {6}required: \[id, status, requested_at, ready_at, expires_at, size_bytes, reason\]\n/,
      );
      expect(text, name).toMatch(/status: \{ type: string, enum: \[pending, ready, expired\] \}/);
      expect(text, name).toMatch(/enum: \[customer_gone, too_large, null\]/);
    }
  });

  it('listMyExports / getMyExport: customer-token secured, the /me 409, 404 and 410 on the download', () => {
    expect(storeOps.length).toBe(31); // +listProductRecommendations at 0.5.9 (#607)
    const list = store.slice(
      store.indexOf('\n  /store/customers/me/exports:\n'),
      store.indexOf('\n  /store/customers/me/exports/{exportId}:\n'),
    );
    expect(list).toMatch(/^ {4}get:\n {6}tags: \[customers\]\n {6}operationId: listMyExports$/m);
    expect(list).not.toMatch(/^ {4}(post|put|patch|delete):$/m);
    const one = store.slice(
      store.indexOf('\n  /store/customers/me/exports/{exportId}:\n'),
      store.indexOf('\n  /store/customers/me/orders:\n'),
    );
    expect(one).toMatch(/name: exportId, in: path, required: true/);
    expect(one).toMatch(/^ {4}get:\n {6}tags: \[customers\]\n {6}operationId: getMyExport$/m);
    expect(one).not.toMatch(/^ {4}(post|put|patch|delete):$/m);
    for (const id of ['listMyExports', 'getMyExport']) {
      expect(sbody(id), id).toMatch(/security:\n\s+- publishableKey: \[\]\n\s+customerToken: \[\]/);
      expect(sbody(id), id).toMatch(/'401': \{ \$ref: '#\/components\/responses\/Unauthorized' \}/);
      expect(sbody(id), id).toMatch(/'409':[\s\S]*code: conflict/);
    }
    expect(sbody('listMyExports')).toContain("$ref: '#/components/schemas/CustomerExportSummary'");
    expect(sbody('listMyExports')).toMatch(/'200':[\s\S]*example:\n\s+items:/);
    expect(sbody('getMyExport')).toMatch(
      /'404': \{ \$ref: '#\/components\/responses\/NotFound' \}/,
    );
    expect(sbody('getMyExport')).toMatch(/'410': \{ \$ref: '#\/components\/responses\/Gone' \}/);
    expect(sbody('getMyExport')).toMatch(/Content-Disposition:/);
  });

  it('listCustomerExports / getCustomerExport at store_admin; listCustomerConsents documents 400 (#496)', () => {
    expect(adminOps.length).toBe(138); // +draftProductCopy at 0.4.26 (#664); +getCustomerIdentity at 0.4.21 (#504); +4 tax-rate operations at 0.4.23 (#522); +listMetrics / queryMetrics at 0.4.25 (#603)
    expect(admin).toMatch(
      /\n {2}\/admin\/stores\/\{storeId\}\/customers\/\{customerId\}\/exports:\n/,
    );
    expect(admin).toMatch(
      /\n {2}\/admin\/stores\/\{storeId\}\/customers\/\{customerId\}\/exports\/\{exportId\}:\n/,
    );
    for (const id of ['listCustomerExports', 'getCustomerExport']) {
      expect(permission(id), id).toEqual(['store_admin', 'store:{storeId}']);
      for (const code of ['200', '400', '401', '403', '404']) {
        expect(abody(id), `${id} ${code}`).toContain(`'${code}':`);
      }
      expect(abody(id), id).not.toMatch(/requestBody:/);
    }
    expect(abody('getCustomerExport')).toMatch(
      /'410': \{ \$ref: '#\/components\/responses\/Gone' \}/,
    );
    expect(abody('listCustomerExports')).toContain(
      "- $ref: '#/components/schemas/CustomerExportSummary'",
    );
    expect(abody('listCustomerExports')).toMatch(
      /required: \[requested_by, requested_by_type, download_count\]/,
    );
    expect(abody('listCustomerConsents')).toMatch(
      /'400': \{ \$ref: '#\/components\/responses\/BadRequest' \}/,
    );
    for (const text of [store, admin]) {
      for (const m of text.matchAll(/\$ref: '#\/components\/(\w+)\/(\w+)'/g)) {
        const section = text.indexOf(`\n  ${m[1]}:\n`);
        expect(section, m[1]).toBeGreaterThan(0);
        expect(text.indexOf(`\n    ${m[2]}:\n`, section), `${m[1]}/${m[2]}`).toBeGreaterThan(
          section,
        );
      }
    }
  });
});

describe('customer identity (contracts 0.4.24, Admin API 0.4.21, #504)', () => {
  const admin = read('admin-api.yaml');
  const store = read('store-api.yaml');
  const adminOps = operations(admin);
  const abody = (id: string) => adminOps.find((o) => o.id === id)!.body;
  const permission = (id: string) =>
    abody(id)
      .match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
      .slice(1);

  it('getCustomerIdentity: HQ-only (support on organization:hq), ids only, 401 / 403 / 404', () => {
    expect(admin).toMatch(/^ {2}version: 0\.4\.26$/m);
    expect(store).toMatch(/^ {2}version: 0\.5\.9$/m); // Store API unchanged (#504)
    expect(adminOps.length).toBe(138); // +draftProductCopy at 0.4.26 (#664); 130 at 0.4.20; +getCustomerIdentity at 0.4.21 (#504); +4 tax-rate operations at 0.4.23 (#522); +2 metrics operations at 0.4.25 (#603)
    const start = admin.indexOf('\n  /admin/customer-identities/{identityId}:\n');
    expect(start).toBeGreaterThan(0);
    // next to /admin/users
    expect(admin.indexOf('\n  /admin/users:\n')).toBeGreaterThan(start);
    const item = admin.slice(start, admin.indexOf('\n  /admin/users:\n'));
    expect(item).toMatch(/name: identityId, in: path, required: true/);
    expect(item).toMatch(
      /^ {4}get:\n {6}tags: \[customers\]\n {6}operationId: getCustomerIdentity$/m,
    );
    expect(item).not.toMatch(/^ {4}(post|put|patch|delete):$/m);
    expect(permission('getCustomerIdentity')).toEqual(['support', 'organization:hq']);
    const body = abody('getCustomerIdentity');
    for (const code of ['200', '401', '403', '404']) expect(body, code).toContain(`'${code}':`);
    expect(body).not.toMatch(/requestBody:/);
    // condition 4: a store-scoped principal is a 403, an unknown identity a 404
    expect(body).toMatch(/store-scoped principal[\s\S]*403/);
    expect(body).toMatch(/404 means\s+the identity is unknown/);
    // ids only: no hash, no subject, no email in the answer
    expect(body).toMatch(/required: \[id, customers\]/);
    expect(body).toMatch(/required: \[store_id, customer_id\]/);
    const schema = body.slice(body.indexOf("'200':"), body.indexOf("'401':"));
    expect(schema).not.toMatch(/email|subject|hash|identity_id/);
    expect(body).toMatch(/\n {14}example:\n/);
    for (const m of admin.matchAll(/\$ref: '#\/components\/(\w+)\/(\w+)'/g)) {
      const section = admin.indexOf(`\n  ${m[1]}:\n`);
      expect(section, m[1]).toBeGreaterThan(0);
      expect(admin.indexOf(`\n    ${m[2]}:\n`, section), `${m[1]}/${m[2]}`).toBeGreaterThan(
        section,
      );
    }
  });

  it('the Store API carries no identity_id (Store API unchanged)', () => {
    expect(store).not.toMatch(/identity_id/);
  });
});

describe('segment consent never_asked (contracts 0.4.25, Admin API 0.4.22, #508 / #491)', () => {
  const admin = readFileSync(resolve(here, '../openapi/admin-api.yaml'), 'utf8');
  it('the SegmentPredicate consent op gains never_asked; granted and not_granted stay', () => {
    expect(admin).toMatch(/^ {2}version: 0\.4\.26$/m);
    expect(admin).toMatch(/op: \{ type: string, enum: \[granted, not_granted, never_asked\] \}/);
  });
});

describe('store tax rates (contracts 0.4.26, Admin API 0.4.23, #522 / #520)', () => {
  const admin = read('admin-api.yaml');
  const store = read('store-api.yaml');
  const adminOps = operations(admin);
  const abody = (id: string) => adminOps.find((o) => o.id === id)!.body;
  const permission = (id: string) =>
    abody(id)
      .match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
      .slice(1);
  const pathItem = (path: string, next: string) =>
    admin.slice(admin.indexOf(`\n  ${path}:\n`), admin.indexOf(`\n  ${next}:\n`));

  it('the four operations on their paths, after the sales channels, with their x-permission and codes', () => {
    expect(admin).toMatch(/^ {2}version: 0\.4\.26$/m);
    expect(store).toMatch(/^ {2}version: 0\.5\.9$/m); // Store API unchanged (#522)
    expect(adminOps.length).toBe(138); // +draftProductCopy at 0.4.26 (#664); 131 at 0.4.22; +listTaxRates / createTaxRate / updateTaxRate / deleteTaxRate; +listMetrics / queryMetrics at 0.4.25 (#603)
    const list = admin.indexOf('\n  /admin/stores/{storeId}/tax-rates:\n');
    expect(list).toBeGreaterThan(admin.indexOf('\n  /admin/stores/{storeId}/sales-channels:\n'));
    expect(list).toBeLessThan(admin.indexOf('\n  /admin/stores/{storeId}/api-keys:\n'));
    const coll = pathItem(
      '/admin/stores/{storeId}/tax-rates',
      '/admin/stores/{storeId}/tax-rates/{taxRateId}',
    );
    expect(coll).toMatch(/^ {4}get:\n {6}tags: \[registry\]\n {6}operationId: listTaxRates$/m);
    expect(coll).toMatch(/^ {4}post:\n {6}tags: \[registry\]\n {6}operationId: createTaxRate$/m);
    expect(coll).not.toMatch(/^ {4}(put|patch|delete):$/m);
    const one = pathItem(
      '/admin/stores/{storeId}/tax-rates/{taxRateId}',
      '/admin/stores/{storeId}/api-keys',
    );
    expect(one).toMatch(/name: taxRateId, in: path, required: true/);
    expect(one).toMatch(/^ {4}patch:\n {6}tags: \[registry\]\n {6}operationId: updateTaxRate$/m);
    expect(one).toMatch(/^ {4}delete:\n {6}tags: \[registry\]\n {6}operationId: deleteTaxRate$/m);
    expect(one).not.toMatch(/^ {4}(get|post|put):$/m);

    const expected: Record<string, { perm: [string, string]; codes: string[] }> = {
      listTaxRates: { perm: ['viewer', 'store:{storeId}'], codes: ['200', '400', '401', '403'] },
      createTaxRate: {
        perm: ['store_admin', 'store:{storeId}'],
        codes: ['201', '400', '401', '403', '404', '409'],
      },
      updateTaxRate: {
        perm: ['store_admin', 'store:{storeId}'],
        codes: ['200', '400', '401', '403', '404'],
      },
      deleteTaxRate: {
        perm: ['store_admin', 'store:{storeId}'],
        codes: ['204', '401', '403', '404', '409'],
      },
    };
    for (const [id, { perm, codes }] of Object.entries(expected)) {
      expect(permission(id), id).toEqual(perm);
      for (const code of codes) expect(abody(id), `${id} ${code}`).toContain(`'${code}':`);
    }
    expect(abody('listTaxRates')).toContain(
      "items: { type: array, items: { $ref: '#/components/schemas/TaxRate' } }",
    );
    expect(abody('listTaxRates')).toMatch(/- id: 47000000-0000-4000-8000-000000000001\n/);
    expect(abody('createTaxRate')).toMatch(/required: \[country, name, rate_bp\]/);
    expect(abody('createTaxRate')).toMatch(/enforced by the database/);
    expect(abody('createTaxRate')).toMatch(/`details\.tax_rate_id`/);
    expect(abody('updateTaxRate')).toMatch(/minProperties: 1/);
    // the identity (country, region, category) is not editable: the REQUEST body names only name / rate_bp
    // (the 200's example row shows the whole TaxRate, so the check stops at `responses:`)
    expect(abody('updateTaxRate').split('responses:')[0]).not.toMatch(
      /country:|region:|product_category_id:/,
    );
    expect(abody('createTaxRate')).toMatch(/'201':[\s\S]*example:/);
    expect(abody('updateTaxRate')).toMatch(/'200':[\s\S]*example:/);
    expect(abody('deleteTaxRate')).toMatch(/last_rate_of_market_country/);
    for (const id of ['createTaxRate', 'updateTaxRate', 'deleteTaxRate']) {
      expect(abody(id), id).toMatch(/`store\.updated`\s+\(`changed_fields: \[tax_rates\]`\)/);
    }
  });

  it('the TaxRate schema, and activateStore / ActivationBlocked name the tax_rates prerequisite', () => {
    expect(admin).toMatch(
      /\n {4}TaxRate:\n {6}type: object\n {6}required: \[id, country, region, name, rate_bp, product_category_id, created_at, updated_at\]\n/,
    );
    const start = admin.indexOf('\n    TaxRate:\n');
    const schema = admin.slice(start, admin.indexOf('\n    ApiKey:\n', start));
    expect(schema).toMatch(/region: \{ type: \[string, 'null'\] \}/);
    expect(schema).toMatch(/rate_bp: \{ type: integer, minimum: 0, maximum: 10000 \}/);
    expect(schema).toMatch(/product_category_id: \{ type: \[string, 'null'\], format: uuid \}/);
    expect(abody('activateStore')).toMatch(/`details\.missing_tax_countries`/);
    expect(abody('activateStore')).toMatch(/market\s+countries \(`tax_rates`\)/);
    const blocked = admin.slice(
      admin.indexOf('\n    ActivationBlocked:\n'),
      admin.indexOf('\n    InvalidSettings:\n'),
    );
    expect(blocked).toMatch(/missing: \[primary_domain, publishable_key, tax_rates\]/);
    expect(blocked).toMatch(/missing_tax_countries: \[BE, DE\]/);
  });
});

describe('listOrders customer_id filter (contracts 0.4.27, Admin API 0.4.24, #569)', () => {
  const admin = read('admin-api.yaml');
  it('listOrders takes an optional uuid customer_id query parameter; permission unchanged (viewer)', () => {
    const body = operations(admin).find((o) => o.id === 'listOrders')!.body;
    expect(body).toMatch(
      /name: customer_id,\s+in: query,\s+schema: \{ type: string, format: uuid \}/,
    );
    expect(body).toMatch(/x-permission: \{ relation: viewer, object: 'store:\{storeId\}' \}/);
    expect(body).not.toMatch(/name: customer_id,[^}]*required: true/);
  });
});

describe('accounting read API (contracts 0.4.28, accounting 0.1.0, #572 / #551)', () => {
  const text = read('accounting.yaml');
  const ops = operations(text);
  const body = (id: string) => ops.find((o) => o.id === id)!.body;
  const permission = (id: string) =>
    body(id)
      .match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!
      .slice(1);
  const withQuery = [
    'getTrialBalance',
    'listJournalLines',
    'listParkedEvents',
    'listPayouts',
    'getPayout',
  ];
  const withPathId = [
    'getTrialBalance',
    'listJournalLines',
    'listParkedEvents',
    'listPayouts',
    'getPayout',
    'getErpSyncStatus',
  ];

  it('is OpenAPI 3.1, info.version 0.1.0, seven GET operations', () => {
    expect(text.startsWith('openapi: 3.1.0')).toBe(true);
    expect(text).toMatch(/^ {2}version: 0\.1\.0$/m);
    expect(ops.map((o) => o.id).sort()).toEqual(
      [
        'listLegalEntityBooks',
        'getTrialBalance',
        'listJournalLines',
        'listParkedEvents',
        'listPayouts',
        'getPayout',
        'getErpSyncStatus',
      ].sort(),
    );
    // every method key under a path item is `get:`; nothing writes (ADR 0003 item 6)
    const methods = text.match(/^ {4}(get|put|post|patch|delete|head|options|trace):$/gm) ?? [];
    expect(methods.length).toBe(7);
    for (const m of methods) expect(m.trim()).toBe('get:');
  });

  it('every operation is finance on organization:hq and documents 401 / 403 (+400 with query, +404 with a path id)', () => {
    for (const o of ops) {
      expect(permission(o.id), o.id).toEqual(['finance', 'organization:hq']);
      for (const code of ['200', '401', '403']) {
        expect(o.body, `${o.id} ${code}`).toContain(`'${code}':`);
      }
      const has400 = o.body.includes(`'400': { $ref: '#/components/responses/BadRequest' }`);
      expect(has400, `${o.id} 400`).toBe(withQuery.includes(o.id));
      const has404 = o.body.includes(`'404':`);
      expect(has404, `${o.id} 404`).toBe(withPathId.includes(o.id));
    }
    expect(text).toMatch(/\n {4}BadRequest:\n/);
  });

  it('money is integer minor units: no `type: number` anywhere, every *_minor property is an integer', () => {
    expect(text).not.toMatch(/type: number/);
    expect(text).not.toMatch(/type: \[number/);
    const lines = text.split('\n');
    let checked = 0;
    lines.forEach((line, i) => {
      const m = line.match(/^\s+(\w+_minor):\s*(.*)$/);
      if (!m) return;
      const value = m[2]!.trim();
      if (/^-?\d+$/.test(value)) return; // an example value
      const decl = value === '' ? (lines[i + 1] ?? '') : value;
      expect(decl, `${m[1]} (line ${i + 1})`).toMatch(/type: integer\b/);
      checked += 1;
    });
    expect(checked).toBe(13); // TrialBalanceRow 3, TrialBalanceTotal 3, JournalLine 2, Payout 1, PayoutLine 4
  });
});

describe('recommendations (contracts 0.4.29, Store API 0.5.9, #607)', () => {
  const text = read('store-api.yaml');
  const op = operations(text).find((o) => o.id === 'listProductRecommendations');

  it('GET /store/recommendations, tag catalog, publishable-key only (no customer token)', () => {
    expect(op).toBeDefined();
    const start = text.indexOf('\n  /store/recommendations:\n');
    expect(start).toBeGreaterThan(0);
    expect(text.slice(start, start + 120)).toMatch(
      /get:\n {6}tags: \[catalog\]\n {6}operationId: listProductRecommendations/,
    );
    expect(op!.body).not.toMatch(/security:/);
  });

  it('kind, product_id, variant_ids (form, not exploded, max 100), window_days 7|30, limit 1..24, currency', () => {
    const b = op!.body;
    expect(b).toMatch(/enum: \[bought_together, popular\], default: bought_together/);
    expect(b).toMatch(/maxItems: 100/);
    expect(b).toMatch(/explode: false/);
    expect(b).toMatch(/enum: \[7, 30\], default: 30/);
    expect(b).toMatch(/minimum: 1, maximum: 24, default: 8/);
    expect(b).toMatch(/#\/components\/parameters\/Currency/);
    for (const code of ["'200'", "'400'", "'401'", "'404'"]) expect(b).toContain(code);
  });

  it('RecommendationList reuses ProductSummary (no second card shape) and reports the kind served', () => {
    const s = text.slice(
      text.indexOf('\n    RecommendationList:\n'),
      text.indexOf('\n    Product:\n'),
    );
    expect(s).toMatch(/required: \[kind, items\]/);
    expect(s).toMatch(/maxItems: 24/);
    expect(s).toMatch(/\$ref: '#\/components\/schemas\/ProductSummary'/);
  });
});

describe('metrics (contracts 0.4.30, Admin API 0.4.25, #603)', () => {
  const admin = read('admin-api.yaml');
  const ops = operations(admin);
  const body = (id: string) => ops.find((o) => o.id === id)!.body;
  const schema = (name: string) => {
    const start = admin.indexOf(`\n    ${name}:\n`);
    expect(start, name).toBeGreaterThan(admin.indexOf('\n  schemas:\n'));
    const next = admin.slice(start + 1).search(/\n {4}\w+:\n/);
    return admin.slice(start, start + 1 + next);
  };

  it('listMetrics is GET /admin/metrics and queryMetrics is POST /admin/metrics/query, tag reports, viewer on store:*', () => {
    for (const [path, method, id] of [
      ['/admin/metrics', 'get', 'listMetrics'],
      ['/admin/metrics/query', 'post', 'queryMetrics'],
    ] as const) {
      const start = admin.indexOf(`\n  ${path}:\n`);
      expect(start, path).toBeGreaterThan(admin.indexOf('\n  /admin/hq/reports/finance:\n'));
      expect(admin.slice(start, start + 120), path).toMatch(
        new RegExp(`${method}:\\n {6}tags: \\[reports\\]\\n {6}operationId: ${id}\\n`),
      );
      expect(body(id)).toMatch(/x-permission: \{ relation: viewer, object: 'store:\*' \}/);
    }
  });

  it('both document 401 / 403; queryMetrics adds 400 and the shared 503 ServiceUnavailable (code unavailable)', () => {
    for (const id of ['listMetrics', 'queryMetrics']) {
      expect(body(id)).toContain(`'401': { $ref: '#/components/responses/Unauthorized' }`);
      expect(body(id)).toContain(`'403': { $ref: '#/components/responses/Forbidden' }`);
    }
    expect(body('queryMetrics')).toContain(`'400': { $ref: '#/components/responses/BadRequest' }`);
    expect(body('queryMetrics')).toContain(
      `'503': { $ref: '#/components/responses/ServiceUnavailable' }`,
    );
    const start = admin.indexOf('\n    ServiceUnavailable:\n');
    expect(start).toBeGreaterThan(admin.indexOf('\n  responses:\n'));
    expect(start).toBeLessThan(admin.indexOf('\n  schemas:\n'));
    expect(admin.slice(start, start + 400)).toMatch(/code: unavailable/);
    expect(ERROR_CODES).toContain('unavailable');
  });

  it('MetricId is a closed enum that includes the live metrics live_orders and live_placed_minor', () => {
    const s = schema('MetricId');
    for (const id of [
      'orders',
      'bookings_minor',
      'recognised_minor',
      'live_orders',
      'live_placed_minor',
    ])
      expect(s, id).toMatch(new RegExp(`\\b${id},`));
    expect(body('queryMetrics')).toMatch(/LIVE, not bookings/);
  });

  it('queryMetrics 200 answers application/json (MetricResult) and text/csv, with the X-Truncated header', () => {
    const b = body('queryMetrics');
    expect(b).toMatch(/\$ref: '#\/components\/schemas\/MetricResult'/);
    expect(b).toMatch(/\n {12}text\/csv:\n {14}schema:\n {16}type: string\n/);
    expect(b).toMatch(/X-Truncated:/);
    expect(b).toMatch(/Accept: text\/csv/);
  });
});

describe('no flow-mapping value is cut at a comma (2026-10-27)', () => {
  // In a YAML flow mapping `{ a: x, b: y }` an unquoted comma ends the value: "description: one, two" silently
  // becomes description "one" plus a key "two". No parser error and no CI failure flagged it (four Admin API
  // descriptions and one Store API description were truncated). A key with whitespace is the symptom.
  const freeTextKeys =
    /\.(paths|properties|responses|examples|schemas|parameters|mapping|variables)$/;
  for (const file of ['store-api.yaml', 'admin-api.yaml', 'accounting.yaml']) {
    it(file, () => {
      const hits: string[] = [];
      const walk = (v: unknown, path: string): void => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (/\s/.test(k) && !freeTextKeys.test(path)) hits.push(`${path} -> "${k}"`);
            walk(x, `${path}.${k}`);
          }
      };
      walk(parseYaml(read(file)), '');
      expect(hits).toEqual([]);
    });
  }
});

describe('product copy drafts (contracts 0.4.31, Admin API 0.4.26, #664 / #608)', () => {
  const admin = read('admin-api.yaml');
  const ops = operations(admin);
  const body = (id: string) => ops.find((o) => o.id === id)!.body;
  const schema = (name: string) => {
    const start = admin.indexOf(`\n    ${name}:\n`);
    expect(start, name).toBeGreaterThan(admin.indexOf('\n  schemas:\n'));
    const next = admin.slice(start + 1).search(/\n {4}\w+:\n/);
    return admin.slice(start, start + 1 + next);
  };

  it('draftProductCopy is POST …/products/{productId}/copy-drafts, store_staff on the store (as updateProduct)', () => {
    const start = admin.indexOf('\n  /admin/stores/{storeId}/products/{productId}/copy-drafts:\n');
    expect(start).toBeGreaterThan(
      admin.indexOf('\n  /admin/stores/{storeId}/products/{productId}:\n'),
    );
    expect(admin.slice(start, start + 400)).toMatch(
      /post:\n {6}tags: \[catalog\]\n {6}operationId: draftProductCopy\n/,
    );
    expect(body('draftProductCopy')).toMatch(
      /x-permission: \{ relation: store_staff, object: 'store:\{storeId\}' \}/,
    );
    expect(body('updateProduct')).toMatch(
      /x-permission: \{ relation: store_staff, object: 'store:\{storeId\}' \}/,
    );
  });

  it('the body is closed: locale plus a non-empty unique list of known fields', () => {
    const b = body('draftProductCopy');
    expect(b).toMatch(/additionalProperties: false\n\s+required: \[locale, fields\]/);
    expect(b).toMatch(
      /minItems: 1\n\s+uniqueItems: true\n\s+items: \{ type: string, enum: \[title, description, bullets, seo\] \}/,
    );
  });

  it('documents 400/401/403/404 and the AI statuses 422/429/502/503', () => {
    const b = body('draftProductCopy');
    for (const code of ['400', '401', '403', '404', '422', '429', '502', '503'])
      expect(b).toContain(`'${code}':`);
    for (const c of [
      'ai_refused',
      'ai_rate_limited',
      'ai_budget_exceeded',
      'ai_unavailable',
      'ai_invalid_draft',
      'ai_disabled',
    ]) {
      expect(b).toContain(`\`${c}\``);
      expect(ERROR_CODES).toContain(c);
    }
  });

  it('ProductCopyDraft is closed, with the draft limited to the requested fields and the template id + version', () => {
    const s = schema('ProductCopyDraft');
    expect(s).toMatch(
      /required: \[product_id, locale, fields, draft, brand_voice_source, model, template, created_at\]/,
    );
    expect(s).toMatch(/brand_voice_source:\s*\{ type: string, enum: \[settings, default\]/);
    expect(s).toMatch(
      /template:\s*\{\s*type: object,\s*additionalProperties: false,\s*required: \[id, version\]/,
    );
    expect(s).toMatch(/bullets: \{ type: array, maxItems: 5/);
    expect(s).toMatch(/title: \{ type: string, maxLength: 70 \}/);
    expect(s).toMatch(/description: \{ type: string, maxLength: 160 \}/);
  });

  it('MetricQuery filter arrays are non-empty when present (accepted on #604)', () => {
    const s = schema('MetricQuery');
    const filters = s.slice(s.indexOf('\n        filters:\n'));
    const arrays = filters.split('type: array\n').length - 1;
    expect(arrays).toBe(4);
    expect(filters.split('type: array\n              minItems: 1\n').length - 1).toBe(4);
  });
});
