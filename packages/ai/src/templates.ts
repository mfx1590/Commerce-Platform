// Versioned prompt templates (D8, #605): files in packages/ai/templates/<id>/v<N>.json, generated into
// src/generated/templates.ts. A call names `id@version`; the variable names are typed per template.
import { TEMPLATES, type TemplateVariableNames } from './generated/templates.js';
import { TemplateError } from './errors.js';
import type { Purpose } from './models.js';

export { TEMPLATES };
export type TemplateKey = keyof TemplateVariableNames;
/** A variable's value: text, a number, or a list of strings (rendered one per line). */
export type TemplateValue = string | number | readonly string[];
export type TemplateVariables<K extends TemplateKey> = {
  readonly [V in TemplateVariableNames[K]]: TemplateValue;
};

export interface Template {
  id: string;
  version: number;
  purpose: Purpose;
  description: string;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  system: string;
  user: string;
  variableNames: readonly string[];
}

export function getTemplate(key: string): Template {
  const t = (TEMPLATES as Record<string, Template | undefined>)[key];
  if (!t)
    throw new TemplateError(
      `unknown template ${key} (known: ${Object.keys(TEMPLATES).join(', ')})`,
    );
  return t;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

const asText = (v: TemplateValue): string => (Array.isArray(v) ? v.join('\n') : String(v));

/** Fills the placeholders. The variables must be exactly the declared set (no missing, no extra keys). */
export function renderTemplate(
  t: Template,
  variables: Record<string, TemplateValue>,
): { system: string; user: string } {
  const given = Object.keys(variables);
  const missing = t.variableNames.filter((v) => !(v in variables));
  const extra = given.filter((v) => !t.variableNames.includes(v));
  if (missing.length || extra.length) {
    throw new TemplateError(
      `${t.id}@${t.version}: ${missing.length ? `missing ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `unexpected ${extra.join(', ')}` : ''}`,
    );
  }
  for (const [k, v] of Object.entries(variables)) {
    const ok =
      typeof v === 'string' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok)
      throw new TemplateError(
        `${t.id}@${t.version}: variable ${k} must be text, a number or a list of strings`,
      );
  }
  const fill = (s: string) => s.replace(PLACEHOLDER, (_, name: string) => asText(variables[name]!));
  return { system: fill(t.system), user: fill(t.user) };
}
