// BACKWARD compatibility of JSON Schemas, offline (issue #532): can a reader with the NEW schema accept every
// document the OLD schema accepted? Operates on inlined schemas (schema-inline.ts). This is the gate; the
// registry's own checker is the second opinion (Redpanda 24.2 judges removals, type changes and enum
// narrowing but accepts an added required property, which this one catches).
//
// Breaking: a required property added; a property removed under a closed content model; a type narrowed;
// an enum / const narrowed or introduced; additionalProperties closed; a numeric, length or item bound
// tightened; a pattern or format introduced or changed; a oneOf/anyOf alternative dropped. Compatible: an
// optional property added, an enum widened, a bound loosened, a property removed from an open model.

export interface Incompatibility {
  /** JSON pointer-ish path into the schema, e.g. `#/properties/amount_minor`. */
  path: string;
  rule:
    | 'REQUIRED_ADDED'
    | 'PROPERTY_REMOVED'
    | 'TYPE_NARROWED'
    | 'ENUM_NARROWED'
    | 'CONST_CHANGED'
    | 'CONTENT_MODEL_CLOSED'
    | 'BOUND_TIGHTENED'
    | 'PATTERN_CHANGED'
    | 'FORMAT_CHANGED'
    | 'ALTERNATIVE_REMOVED'
    | 'ITEMS_NARROWED';
  detail: string;
}

type S = Record<string, unknown>;

const isObject = (v: unknown): v is S => !!v && typeof v === 'object' && !Array.isArray(v);
const types = (s: S): string[] | null =>
  s.type === undefined ? null : Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
const show = (v: unknown) => JSON.stringify(v);

/** Every reason the new schema is not a backward-compatible evolution of the old one; empty = compatible. */
export function backwardIncompatibilities(
  oldSchema: unknown,
  newSchema: unknown,
  path = '#',
): Incompatibility[] {
  const out: Incompatibility[] = [];
  if (!isObject(oldSchema) || !isObject(newSchema)) {
    // booleans schemas: `true` accepts everything, `false` nothing
    if (oldSchema === true && newSchema !== true) {
      out.push({ path, rule: 'TYPE_NARROWED', detail: 'an open schema became constrained' });
    }
    return out;
  }
  const o = oldSchema;
  const n = newSchema;

  // type
  const ot = types(o);
  const nt = types(n);
  if (nt && (!ot || ot.some((t) => !nt.includes(t)))) {
    out.push({
      path,
      rule: 'TYPE_NARROWED',
      detail: `type ${show(o.type ?? 'any')} → ${show(n.type)}`,
    });
  }

  // enum / const
  if (Array.isArray(n.enum)) {
    if (!Array.isArray(o.enum)) {
      if (o.const === undefined) {
        out.push({ path, rule: 'ENUM_NARROWED', detail: `enum introduced ${show(n.enum)}` });
      } else if (!n.enum.some((v) => show(v) === show(o.const))) {
        out.push({
          path,
          rule: 'ENUM_NARROWED',
          detail: `const ${show(o.const)} not in enum ${show(n.enum)}`,
        });
      }
    } else {
      const missing = o.enum.filter((v) => !(n.enum as unknown[]).some((w) => show(w) === show(v)));
      if (missing.length > 0) {
        out.push({ path, rule: 'ENUM_NARROWED', detail: `values removed ${show(missing)}` });
      }
    }
  }
  if (n.const !== undefined) {
    if (o.const === undefined || show(o.const) !== show(n.const)) {
      out.push({
        path,
        rule: 'CONST_CHANGED',
        detail: `const ${show(o.const)} → ${show(n.const)}`,
      });
    }
  }

  // required
  const oReq = new Set((o.required as string[] | undefined) ?? []);
  for (const r of (n.required as string[] | undefined) ?? []) {
    if (!oReq.has(r)) out.push({ path: `${path}/required`, rule: 'REQUIRED_ADDED', detail: r });
  }

  // properties
  const oProps = isObject(o.properties) ? o.properties : {};
  const nProps = isObject(n.properties) ? n.properties : {};
  const nClosed = n.additionalProperties === false;
  for (const [key, oSub] of Object.entries(oProps)) {
    if (!(key in nProps)) {
      if (nClosed) {
        out.push({
          path: `${path}/properties/${key}`,
          rule: 'PROPERTY_REMOVED',
          detail: `${key} is gone and the content model is closed`,
        });
      }
      continue;
    }
    out.push(...backwardIncompatibilities(oSub, nProps[key], `${path}/properties/${key}`));
  }
  if (o.additionalProperties !== false && nClosed) {
    out.push({
      path,
      rule: 'CONTENT_MODEL_CLOSED',
      detail: 'additionalProperties went from open to false',
    });
  }
  if (isObject(o.additionalProperties) && isObject(n.additionalProperties)) {
    out.push(
      ...backwardIncompatibilities(
        o.additionalProperties,
        n.additionalProperties,
        `${path}/additionalProperties`,
      ),
    );
  }

  // bounds
  const tighter = (key: string, cmp: (ov: number | undefined, nv: number) => boolean): void => {
    const nv = n[key];
    if (typeof nv !== 'number') return;
    const ov = o[key];
    if (cmp(typeof ov === 'number' ? ov : undefined, nv)) {
      out.push({ path, rule: 'BOUND_TIGHTENED', detail: `${key} ${show(ov)} → ${show(nv)}` });
    }
  };
  tighter('minimum', (ov, nv) => ov === undefined || nv > ov);
  tighter('exclusiveMinimum', (ov, nv) => ov === undefined || nv > ov);
  tighter('minLength', (ov, nv) => (ov ?? 0) < nv);
  tighter('minItems', (ov, nv) => (ov ?? 0) < nv);
  tighter('minProperties', (ov, nv) => (ov ?? 0) < nv);
  tighter('maximum', (ov, nv) => ov === undefined || nv < ov);
  tighter('exclusiveMaximum', (ov, nv) => ov === undefined || nv < ov);
  tighter('maxLength', (ov, nv) => ov === undefined || nv < ov);
  tighter('maxItems', (ov, nv) => ov === undefined || nv < ov);
  tighter('maxProperties', (ov, nv) => ov === undefined || nv < ov);
  if (n.multipleOf !== undefined && show(o.multipleOf) !== show(n.multipleOf)) {
    out.push({
      path,
      rule: 'BOUND_TIGHTENED',
      detail: `multipleOf ${show(o.multipleOf)} → ${show(n.multipleOf)}`,
    });
  }
  if (n.uniqueItems === true && o.uniqueItems !== true) {
    out.push({ path, rule: 'BOUND_TIGHTENED', detail: 'uniqueItems introduced' });
  }
  if (n.pattern !== undefined && o.pattern !== n.pattern) {
    out.push({ path, rule: 'PATTERN_CHANGED', detail: `${show(o.pattern)} → ${show(n.pattern)}` });
  }
  if (n.format !== undefined && o.format !== n.format) {
    out.push({ path, rule: 'FORMAT_CHANGED', detail: `${show(o.format)} → ${show(n.format)}` });
  }

  // items
  if (n.items !== undefined) {
    if (o.items === undefined) {
      out.push({
        path: `${path}/items`,
        rule: 'ITEMS_NARROWED',
        detail: 'items constraint introduced',
      });
    } else {
      out.push(...backwardIncompatibilities(o.items, n.items, `${path}/items`));
    }
  }

  // oneOf / anyOf: every old alternative must still be accepted by some new alternative
  for (const key of ['oneOf', 'anyOf'] as const) {
    const oAlt = Array.isArray(o[key]) ? (o[key] as unknown[]) : null;
    const nAlt = Array.isArray(n[key]) ? (n[key] as unknown[]) : null;
    if (!nAlt) continue;
    const olds = oAlt ?? [stripAlternatives(o)];
    olds.forEach((alt, i) => {
      const accepted = nAlt.some(
        (cand) => backwardIncompatibilities(alt, cand, `${path}/${key}/${i}`).length === 0,
      );
      if (!accepted) {
        out.push({
          path: `${path}/${key}/${i}`,
          rule: 'ALTERNATIVE_REMOVED',
          detail: `no new alternative accepts ${oAlt ? `old alternative ${i}` : 'the old schema'}`,
        });
      }
    });
  }
  if (!Array.isArray(n.oneOf) && !Array.isArray(n.anyOf)) {
    for (const key of ['oneOf', 'anyOf'] as const) {
      const oAlt = Array.isArray(o[key]) ? (o[key] as unknown[]) : null;
      if (!oAlt) continue;
      oAlt.forEach((alt, i) =>
        out.push(...backwardIncompatibilities(alt, stripAlternatives(n), `${path}/${key}/${i}`)),
      );
    }
  }
  return out;
}

function stripAlternatives(s: S): S {
  const { oneOf: _o, anyOf: _a, ...rest } = s;
  return rest;
}

export const isBackwardCompatible = (oldSchema: unknown, newSchema: unknown): boolean =>
  backwardIncompatibilities(oldSchema, newSchema).length === 0;

export function formatIncompatibilities(list: Incompatibility[]): string {
  return list.map((i) => `${i.rule} at ${i.path}: ${i.detail}`).join('; ');
}
